// 02 · Extract. Numbered lines → DischargeRecord, every field tied to the line it came from.
//
// Extract also answers requests from other agents: Lookup asks it to re-check a medicine
// name Zetaris doesn't know, and the Safety checker asks it to re-check a dose that doesn't
// match the original line. It flags lines it can't read with confidence, so Scan can re-read
// them.

import type { AgentContext } from "./context.ts";
import { lineIds, numberedLines } from "./scan.ts";
import { parseJsonObject } from "../text.ts";
import type { DischargeRecord, Medication, ScanResult } from "../types.ts";

const SCHEMA = `{
  "patient": {"name": "full name or null", "birthdate": "YYYY-MM-DD or null", "source": "line id or null"},
  "diagnoses": [{"text": "...", "source": "p1:L4"}],
  "medications": [{"name": "drug name as written", "dose": "amount and unit exactly as written, e.g. 40 mg", "freq": "as written, e.g. BID",
                   "status": "new|changed|stopped|continued|unclear", "instructions": "e.g. take with food, or empty", "source": "p2:L1"}],
  "follow_ups": [{"who": "...", "when": "...", "source": "p3:L2"}],
  "warning_signs": [{"text": "...", "source": "p3:L7"}],
  "restrictions": [{"text": "...", "source": "p3:L5"}],
  "unknown_terms": ["BID", "CHF"],
  "uncertain": [{"source": "p2:L3", "reason": "dose looks smudged: 40 or 10?"}]
}`;

const SYSTEM = `You extract structured fields from a hospital discharge summary. Lines are given as "<line id> | <text>".
Rules:
- Every item must carry the line id it came from in "source" (use "p1:L4-6" for a range). Never invent an id.
- Copy doses and frequencies exactly as written. Never convert, round or guess a dose.
- status: "new" if the paper says new/started, "changed" if it says increased/decreased/changed, "stopped" if it says stop/discontinue/hold, "continued" if it says continue or gives no change, "unclear" otherwise.
- warning_signs: every symptom the paper says to call 911, go to the ER, or call the doctor about.
- unknown_terms: abbreviations and medical jargon a patient might not know (BID, PRN, CHF, PO...).
- uncertain: only lines marked [unclear] or that look misread (odd spelling of a drug, impossible dose).
- Leave out anything the paper does not say. Return JSON only, in this shape:
${SCHEMA}`;

export async function extract(ctx: AgentContext, scan: ScanResult): Promise<DischargeRecord> {
  const input = numberedLines(scan);
  const res = await ctx.llm({ agent: "extract", route: "meterless/text", json: true, maxTokens: 4000, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: input }] });
  const record = normalise(parseJsonObject(res.content));
  ctx.save("extract", "record", { input, output: record });
  return record;
}

export interface VerifyRequest {
  source: string;
  medication?: string;
  question: string;
  from: "lookup" | "safety_checker";
}

/**
 * Re-check specific medication lines and correct the record in place. Returns a short note
 * per request for the board.
 */
export async function verify(ctx: AgentContext, scan: ScanResult, record: DischargeRecord, requests: VerifyRequest[]): Promise<string[]> {
  const ids = new Set(requests.map((r) => r.source.split("-")[0]));
  const lines = numberedLines(scan, ids);
  const current = record.medications.filter((m) => ids.has(m.source.split("-")[0]));
  const prompt = `Original lines:\n${lines}\n\nWhat was extracted from them:\n${JSON.stringify(current, null, 1)}\n\nQuestions from other agents:\n${requests
    .map((r) => `- ${r.source}${r.medication ? ` (${r.medication})` : ""}: ${r.question}`)
    .join("\n")}`;
  const res = await ctx.llm({
    agent: "extract",
    route: "meterless/text",
    json: true,
    maxTokens: 2000,
    messages: [
      {
        role: "system",
        content: `You re-check medicines extracted from a discharge summary against the original lines, to answer other agents' questions.
For each question, read the line again. Correct the name, dose, frequency or status only if the original line says something different; keep the source id.
Return JSON only: {"answers": [{"source": "p2:L1", "name": "...", "dose": "...", "freq": "...", "status": "...", "changed": true, "note": "one short sentence"}]}`,
      },
      { role: "user", content: prompt },
    ],
  });
  const out = parseJsonObject<{ answers: (Partial<Medication> & { source: string; changed?: boolean; note?: string })[] }>(res.content);
  const notes: string[] = [];
  for (const a of out.answers ?? []) {
    const med = record.medications.find((m) => m.source.split("-")[0] === a.source?.split("-")[0]);
    if (!med) continue;
    if (a.changed) {
      const before = `${med.name} ${med.dose} ${med.freq}`;
      Object.assign(med, pick(a, ["name", "dose", "freq", "status"]));
      notes.push(`${a.source}: corrected "${before}" → "${med.name} ${med.dose} ${med.freq}". ${a.note ?? ""}`.trim());
    } else {
      notes.push(`${a.source}: confirmed "${med.name} ${med.dose} ${med.freq}". ${a.note ?? ""}`.trim());
    }
  }
  ctx.save("extract", "verify", { input: { requests, lines }, output: out });
  return notes;
}

/** Drop items whose source isn't a real line; report them so the board shows what was dropped. */
export function checkSources(record: DischargeRecord, scan: ScanResult): string[] {
  const ids = lineIds(scan);
  const ok = (s: string | null | undefined) => !!s && ids.has(s.split("-")[0]);
  const dropped: string[] = [];
  const keep = <T extends { source: string }>(items: T[], what: string) =>
    items.filter((i) => {
      if (ok(i.source)) return true;
      dropped.push(`${what} with unknown source "${i.source}"`);
      return false;
    });
  record.diagnoses = keep(record.diagnoses, "diagnosis");
  record.medications = keep(record.medications, "medication");
  record.follow_ups = keep(record.follow_ups, "follow-up");
  record.warning_signs = keep(record.warning_signs, "warning sign");
  record.restrictions = keep(record.restrictions, "restriction");
  record.uncertain = record.uncertain.filter((u) => ok(u.source));
  if (record.patient.source && !ok(record.patient.source)) record.patient.source = null;
  return dropped;
}

function normalise(raw: any): DischargeRecord {
  const arr = (x: unknown) => (Array.isArray(x) ? x : []);
  const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");
  const statuses = ["new", "changed", "stopped", "continued", "unclear"];
  return {
    patient: {
      name: str(raw?.patient?.name) || null,
      birthdate: /^\d{4}-\d{2}-\d{2}$/.test(str(raw?.patient?.birthdate)) ? str(raw.patient.birthdate) : null,
      source: str(raw?.patient?.source) || null,
    },
    diagnoses: arr(raw?.diagnoses).map((d: any) => ({ text: str(d?.text), source: str(d?.source) })).filter((d) => d.text),
    medications: arr(raw?.medications)
      .map((m: any) => ({
        name: str(m?.name),
        dose: str(m?.dose),
        freq: str(m?.freq),
        status: (statuses.includes(m?.status) ? m.status : "unclear") as Medication["status"],
        instructions: str(m?.instructions) || undefined,
        source: str(m?.source),
      }))
      .filter((m) => m.name),
    follow_ups: arr(raw?.follow_ups).map((f: any) => ({ who: str(f?.who), when: str(f?.when), source: str(f?.source) })).filter((f) => f.who || f.when),
    warning_signs: arr(raw?.warning_signs).map((w: any) => ({ text: str(w?.text), source: str(w?.source) })).filter((w) => w.text),
    restrictions: arr(raw?.restrictions).map((r: any) => ({ text: str(r?.text), source: str(r?.source) })).filter((r) => r.text),
    unknown_terms: [...new Set(arr(raw?.unknown_terms).map(str).filter(Boolean))] as string[],
    uncertain: arr(raw?.uncertain).map((u: any) => ({ source: str(u?.source), reason: str(u?.reason) })).filter((u) => u.source),
  };
}

function pick<T extends object>(o: T, keys: string[]): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => keys.includes(k) && typeof v === "string" && v.trim())) as Partial<T>;
}
