// Patient medicine memory, built on the Meterless H-MEM engine (engines/hmem, Apache 2.0).
//
// Every medicine fact the agents learn is written to H-MEM with its source: a line of the
// discharge paper (p2:L1) or a Zetaris hospital-record row (record:3). H-MEM then gives us
// three things the safety rules need:
//   - add() rejects a memory with no source, by construction.
//   - conflict detection flags two similar facts with different numbers: the paper says
//     furosemide 40 mg, the hospital record says 20 mg. When the paper itself says the dose
//     changed, the paper memory `supersedes` the record one and H-MEM treats it as an intended
//     replacement, not a conflict.
//   - the append-only trust ledger is the audit trail behind "Where does this come from?".
//
// Domain rule on top of the spec: medicine conflicts are never auto-resolved (H-MEM would
// let a confident source win at >= 0.70). They stay open for the care team.
//
// Memory is kept per patient, so a second discharge is compared with the first.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { HMEM } from "../engines/hmem/reference/src/index.ts";
import type { MemoryRecord } from "../engines/hmem/reference/src/index.ts";
import { ROOT } from "./config.ts";

export interface MedConflict {
  id: string;
  drug: string;
  a: { id: string; content: string; source: string };
  b: { id: string; content: string; source: string };
  reason: string;
  confidence: number;
}

export class PatientMemory {
  readonly hmem: HMEM;
  readonly key: string;
  private readonly mine = new Set<string>(); // memory ids written or reused by this job

  readonly dir: string; // where H-MEM persists this patient's memories and ledger

  constructor(patientKey: string, baseDir = process.env.MEMORY_DIR ?? join(ROOT, "data", "memory"), dir?: string) {
    this.key = createHash("sha256").update(patientKey).digest("hex").slice(0, 16);
    this.dir = dir ?? join(baseDir, this.key);
    this.hmem = new HMEM({ persistDir: this.dir, actor: "day-one" });
  }

  /** Reopen a patient's memory from its folder (e.g. for Q&A after a server restart). */
  static open(dir: string): PatientMemory {
    return new PatientMemory("", undefined, dir);
  }

  /**
   * Remember "<drug> dose <amount>" from one source. The drug name is written twice on
   * purpose: H-MEM's similarity then separates drugs clearly (0.30 between different drugs,
   * 0.89 for the same drug at another dose), so its numeric-conflict rule fires only on the
   * same medicine.
   */
  rememberDose(o: { drug: string; dose: string; source: string; origin: "paper" | "record"; label: string; supersedes?: string }): MemoryRecord {
    const drug = o.drug.toLowerCase();
    const content = `${drug} — ${drug} dose ${o.dose}`;
    const existing = this.hmem.store.all().find((r) => r.content === content && r.source === o.source);
    if (existing) {
      this.mine.add(existing.id);
      return existing;
    }
    const rec = this.hmem.add({
      content,
      source: o.source,
      type: "factual",
      confidence: o.origin === "paper" ? 0.9 : 0.8,
      tags: [`med:${drug}`, `from:${o.origin}`],
      provenance: { origin: "document", learnedAt: Date.now(), label: o.label },
      supersedes: o.supersedes,
    });
    this.mine.add(rec.id);
    return rec;
  }

  /** Remember any other sourced fact from the papers (diagnosis, instruction, follow-up, warning sign). */
  rememberFact(o: { text: string; source: string; kind: "diagnosis" | "instruction" | "follow_up" | "warning_sign" }): MemoryRecord {
    const existing = this.hmem.store.all().find((r) => r.content === o.text && r.source === o.source);
    if (existing) {
      this.mine.add(existing.id);
      return existing;
    }
    const rec = this.hmem.add({
      content: o.text,
      source: o.source,
      type: "factual",
      confidence: 0.9,
      tags: [`kind:${o.kind}`, "from:paper"],
      provenance: { origin: "document", learnedAt: Date.now(), label: `Discharge paper ${o.source}` },
    });
    this.mine.add(rec.id);
    return rec;
  }

  /** H-MEM retrieval (hybrid ranking + reinjection block) over this patient's memories. */
  recall(question: string, topN = 6): { context: string; sources: string[]; strategy: string } {
    const r = this.hmem.query(question, { topN, threshold: 0.05 });
    return { context: r.context, sources: r.memories.map((m) => m.memory.source), strategy: r.trace.strategy };
  }

  /** Open medicine conflicts that involve this job's memories (same drug only, never auto-resolved). */
  conflicts(): MedConflict[] {
    const out: MedConflict[] = [];
    for (const c of this.hmem.conflicts.scan()) {
      if (!this.mine.has(c.memoryA) && !this.mine.has(c.memoryB)) continue;
      const a = this.hmem.store.get(c.memoryA)!;
      const b = this.hmem.store.get(c.memoryB)!;
      const drugA = a.tags.find((t) => t.startsWith("med:"));
      if (!drugA || !b.tags.includes(drugA)) continue;
      out.push({
        id: c.id,
        drug: drugA.slice(4),
        a: { id: a.id, content: a.content, source: a.source },
        b: { id: b.id, content: b.content, source: b.source },
        reason: c.reason,
        confidence: +c.confidence.toFixed(2),
      });
    }
    return out;
  }

  /** The trust-ledger history of every memory that came from `source`. */
  ledgerFor(source: string): { memory: string; action: string; ts: number; details?: unknown }[] {
    return this.hmem.store
      .all()
      .filter((r) => r.source === source)
      .flatMap((r) => this.hmem.ledger.history(r.id).map((e) => ({ memory: `${r.id}: ${r.content}`, action: e.action, ts: e.timestamp, details: e.details })));
  }

  get size(): number {
    return this.hmem.store.all().length;
  }
}
