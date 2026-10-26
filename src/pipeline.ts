// The orchestrator: plain code, not an AI. It routes work between the agents, keeps the shared
// board (job.messages), and saves every agent's input and output under runs/<job>/.
//
// The flow is not a straight line. Agents send work back to each other:
//
//   Scan ──► Extract ──► Lookup ──► Memory (H-MEM) ──► Simplify ──► Safety checker ──► done
//    ▲          │ ▲        │                              ▲             │
//    └─re-read──┘ └─verify─┘                              ├──revise─────┤  (at most 2 retries)
//                 ▲                                       │             │
//                 └────────── re-check a misread dose ────┴─────────────┘
//
//   - Extract flags lines it can't read with confidence → Scan re-reads them from the photo.
//   - Lookup can't find a medicine in Zetaris → Extract re-checks the name on its line.
//   - H-MEM finds the paper and the hospital record disagree → the Safety checker must see
//     that conflict flagged in the summary.
//   - Safety checker finds a problem in the summary → Simplify revises.
//   - Safety checker finds the extracted dose isn't on its own line → Extract re-reads it,
//     the record is re-grounded, and Simplify writes again.
//   - A section that still fails after the retries shows the original text and
//     "Ask your care team" instead.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentContext } from "./agents/context.ts";
import { checkSources, extract, verify, type VerifyRequest } from "./agents/extract.ts";
import { ground, lookup } from "./agents/lookup.ts";
import { answer, type QaAnswer } from "./agents/qa.ts";
import { check } from "./agents/safety.ts";
import { lineText, rereadLines, scanImages, scanText } from "./agents/scan.ts";
import { revise, simplify, unwritten, verbatimWarnings, type Draft } from "./agents/simplify.ts";
import { ROOT, sampleMode } from "./config.ts";
import { PatientMemory } from "./memory.ts";
import { Nightshift, NightshiftError } from "./nightshift.ts";
import type { AgentMessage, AgentName, CheckReport, FinalOutput, Issue, Job, PlainSummary, ScanLine, StepState } from "./types.ts";

export const MAX_RETRIES = 2;
const RUNS = process.env.RUNS_DIR ?? join(ROOT, "runs");

export interface JobInput {
  text?: string;
  images?: string[]; // data: URLs, one per page
}

const STEPS: [AgentName, string][] = [
  ["scan", "Scan"],
  ["extract", "Extract"],
  ["lookup", "Lookup (Zetaris)"],
  ["memory", "Patient memory (H-MEM)"],
  ["simplify", "Simplify"],
  ["safety_checker", "Safety checker"],
];

export class JobRunner {
  readonly jobs = new Map<string, Job>();
  private readonly live = new Map<string, { ctx: AgentContext; memory: PatientMemory }>(); // for Q&A
  constructor(private readonly ns = new Nightshift({ runsDir: RUNS })) {}

  /** A job from this session, or one saved in runs/ before a restart. */
  get(id: string): Job | undefined {
    if (this.jobs.has(id)) return this.jobs.get(id);
    const file = join(RUNS, id, "job.json");
    if (!/^[\w-]+$/.test(id) || !existsSync(file)) return undefined;
    const job: Job = JSON.parse(readFileSync(file, "utf-8"));
    job.qa ??= [];
    // Sample and recording runs keep their memory inside the run folder.
    const local = join(RUNS, id, "memory");
    if (!job.memoryDir && existsSync(local)) job.memoryDir = readdirSync(local).map((d) => join(local, d))[0];
    this.jobs.set(id, job);
    return job;
  }

  /** Q&A on a finished job, from this patient's data only. */
  async ask(id: string, question: string): Promise<QaAnswer> {
    const job = this.get(id);
    if (!job?.output) throw new Error("This summary isn't ready for questions.");
    if (!this.live.has(id) && job.memoryDir && existsSync(job.memoryDir)) {
      const runDir = join(RUNS, id);
      const ctx = new AgentContext(this.ns, id, runDir, (m: AgentMessage) => {
        job.messages.push(m);
        appendFileSync(join(runDir, "messages.jsonl"), JSON.stringify(m) + "\n");
      });
      this.live.set(id, { ctx, memory: PatientMemory.open(job.memoryDir) });
    }
    const live = this.live.get(id);
    if (!live) throw new Error("This summary isn't ready for questions.");
    live.ctx.say("qa", "memory", "request", `Patient asks: "${question}"`);
    const a = await answer(live.ctx, job.output, live.memory, question);
    live.ctx.say("qa", "patient", "reply", a.answered ? `${a.answer} (${a.sources.join(", ")})` : a.answer);
    job.qa.push(a);
    persist(job);
    return a;
  }

  start(input: JobInput): Job {
    const id = `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${randomUUID().slice(0, 6)}`;
    const job: Job = {
      id,
      createdAt: new Date().toISOString(),
      status: "running",
      steps: STEPS.map(([agent, label]) => ({ agent, label, status: "waiting" })),
      messages: [],
      qa: [],
    };
    this.jobs.set(id, job);
    run(this.ns, job, input, (ctx, memory) => this.live.set(id, { ctx, memory })).catch((err) => {
      job.status = "failed";
      job.error = friendlyError(err);
      for (const s of job.steps) if (s.status === "running") s.status = "failed";
      persist(job);
    });
    return job;
  }
}

async function run(ns: Nightshift, job: Job, input: JobInput, keep: (ctx: AgentContext, memory: PatientMemory) => void): Promise<void> {
  const runDir = join(RUNS, job.id);
  mkdirSync(runDir, { recursive: true });
  const ctx = new AgentContext(ns, job.id, runDir, (m: AgentMessage) => {
    job.messages.push(m);
    appendFileSync(join(runDir, "messages.jsonl"), JSON.stringify(m) + "\n");
  });
  const step = (agent: AgentName, status: StepState["status"], detail?: string) => {
    const s = job.steps.find((x) => x.agent === agent)!;
    s.status = status;
    if (detail !== undefined) s.detail = detail;
  };
  const images = input.images ?? [];

  // 1 · Scan
  step("scan", "running");
  const scan = images.length ? await scanImages(ctx, images) : scanText(input.text ?? "");
  const unreadable = scan.pages.filter((p) => !p.readable);
  if (!scan.pages.length || unreadable.length) {
    job.status = "needs_rescan";
    job.rescan = unreadable.map((p) => ({ page: p.page, problem: p.problem ?? "too hard to read" }));
    if (!scan.pages.length) job.rescan = [{ page: 1, problem: "no text found" }];
    step("scan", "failed", "page needs a rescan");
    ctx.say("scan", "patient", "request", `Please scan again: ${job.rescan.map((r) => `page ${r.page} (${r.problem})`).join("; ")}.`);
    return persist(job);
  }
  const lineCount = scan.pages.reduce((n, p) => n + p.lines.length, 0);
  step("scan", "done", `${scan.pages.length} page(s), ${lineCount} lines`);
  ctx.say("scan", "extract", "handoff", `ScanResult: ${scan.pages.length} page(s), ${lineCount} numbered lines.`);

  // 2 · Extract (+ Scan re-reads what Extract couldn't read with confidence)
  step("extract", "running");
  let record = await extract(ctx, scan);
  if (scan.source === "image" && record.uncertain.length) {
    ctx.say("extract", "scan", "request", `Please re-read ${record.uncertain.map((u) => `${u.source} (${u.reason})`).join("; ")}.`);
    const changed = await rereadLines(ctx, scan, images, record.uncertain);
    ctx.say("scan", "extract", "reply", changed ? `Re-read ${record.uncertain.length} line(s); ${changed} changed.` : `Re-read ${record.uncertain.length} line(s); the text is the same.`);
    if (changed) record = await extract(ctx, scan);
  } else if (record.uncertain.length) {
    ctx.say("extract", "safety_checker", "info", `Lines that may be mistyped: ${record.uncertain.map((u) => `${u.source} (${u.reason})`).join("; ")}.`);
  }
  const dropped = checkSources(record, scan);
  if (dropped.length) ctx.say("orchestrator", "extract", "critique", `Dropped ${dropped.length} item(s) whose source line doesn't exist: ${dropped.join("; ")}.`);
  step("extract", "done", `${record.medications.length} medicines, ${record.warning_signs.length} warning signs`);
  ctx.say("extract", "lookup", "handoff", `DischargeRecord: ${record.medications.length} medicines, ${record.diagnoses.length} diagnoses, ${record.unknown_terms.length} terms to explain.`);

  // 3 · Lookup (+ Extract re-checks names Zetaris doesn't know)
  step("lookup", "running");
  let look = await lookup(ctx, record);
  if (look.notFound.length) {
    const requests: VerifyRequest[] = look.notFound.map((n) => ({
      source: n.source,
      medication: n.name,
      question: `"${n.name}" is not in the drug reference. Is the name read correctly?`,
      from: "lookup",
    }));
    ctx.say("lookup", "extract", "request", `Not in Zetaris drug_reference: ${look.notFound.map((n) => `${n.name} (${n.source})`).join(", ")}. Please re-check those lines.`);
    const notes = await verify(ctx, scan, record, requests);
    ctx.say("extract", "lookup", "reply", notes.join(" ") || "No changes.");
    // Corrected names are looked up again; confirmed ones are probably brands → ask for the ingredient.
    const unresolved = look.notFound.map((n) => record.medications.find((m) => m.source === n.source)?.name ?? n.name);
    look = await lookup(ctx, record, unresolved);
    const still = look.notFound.map((n) => n.name);
    ctx.say("lookup", "simplify", "info", still.length ? `Still not in the drug reference: ${still.join(", ")}. Simplify will explain them from the papers only.` : "All medicines found on the second try.");
  }
  step("lookup", "done", `${look.drugs.length} drug labels, ${look.terms.length} terms${look.patient ? ", record matched" : ", no record match"}`);

  // 4 · Patient memory (H-MEM): compare paper and record, open conflicts
  step("memory", "running");
  // Recording and replaying samples start from empty memory, so replayed prompts match exactly.
  const memDir = sampleMode() || process.env.NIGHTSHIFT_RECORD === "true" ? join(runDir, "memory") : undefined;
  const memory = new PatientMemory(look.patient?.id ?? `${record.patient.name}|${record.patient.birthdate}|${job.id}`, memDir);
  job.memoryDir = memory.dir;
  let grounded = ground(ctx, record, look, memory);
  for (const c of grounded.conflicts) ctx.say("memory", "safety_checker", "escalation", `Open conflict on ${c.drug}: ${c.detail}. The summary must tell the patient to check this dose.`);
  const changes = grounded.hospital_record_diff.filter((d) => d.change !== "continued").map((d) => `${d.drug}: ${d.change}`);
  step("memory", "done", `${memory.size} memories, ${grounded.conflicts.length} open conflict(s)`);
  ctx.say("memory", "simplify", "handoff", `GroundedRecord: ${changes.length ? changes.join(", ") : "no differences from the hospital record"}.`);

  // 5 · Simplify ⇄ Safety checker
  step("simplify", "running");
  let draft: Draft;
  try {
    draft = await simplify(ctx, grounded, scan);
  } catch (err) {
    // No usable draft at all: the patient gets their original papers, never an error page.
    // The warning signs Extract found still go in the 911 box, in the papers' own words.
    ctx.say("simplify", "patient", "fallback", `Couldn't write a plain version (${(err as Error).message.slice(0, 100)}). Showing your original papers with "Ask your care team".`);
    step("simplify", "failed", "no usable draft");
    step("safety_checker", "skipped");
    const original = scan.pages.flatMap((p) => p.lines);
    const empty: PlainSummary = { sections: [], med_schedule: [], call_911_if: verbatimWarnings(grounded, scan), questions_for_your_doctor: [] };
    const report: CheckReport = { pass: false, model_checked: false, reading_level: 0, reading_level_by_section: {}, issues: [] };
    job.output = { summary: empty, check: report, fallback_sections: [{ title: "Your discharge papers", original }], record: grounded, scan, ledger: {}, models: ctx.models };
    job.status = "done";
    keep(ctx, memory);
    return persist(job);
  }
  let summary = draft.summary;
  const missing = draft.parts.filter((p) => !p.output).length;
  step("simplify", "done", `${draft.parts.length - missing} of ${draft.parts.length} parts written`);
  ctx.say("simplify", "safety_checker", "handoff", `PlainSummary: ${summary.sections.reduce((n, s) => n + s.bullets.length, 0)} bullets, ${summary.call_911_if.length} warning items${missing ? ` (${missing} part(s) not written)` : ""}.`);

  let report: CheckReport;
  for (let attempt = 1; ; attempt++) {
    step("safety_checker", "running", `check ${attempt}`);
    report = await check(ctx, summary, grounded, scan, attempt);
    if (report.pass) {
      ctx.say("safety_checker", "orchestrator", "info", `Pass on check ${attempt}. Reading level: grade ${report.reading_level}.`);
      break;
    }
    if (attempt > MAX_RETRIES) {
      ctx.say("safety_checker", "orchestrator", "critique", `Still ${report.issues.length} issue(s) after ${MAX_RETRIES} retries.`);
      break;
    }
    const mismatches = report.issues.filter((i) => i.type === "extract_mismatch");
    const previous = draft;
    try {
      if (mismatches.length) {
        // The problem is upstream: Extract misread a dose. Fix the record, then rewrite.
        ctx.say("safety_checker", "extract", "escalation", mismatches.map((i) => i.fix).join(" "));
        step("extract", "running", "re-checking a dose");
        const requests = mismatches.map((i) => ({ source: i.section!, question: i.fix, from: "safety_checker" as const }));
        const notes = await verify(ctx, scan, record, requests);
        step("extract", "done");
        ctx.say("extract", "memory", "reply", notes.join(" ") || "No changes.");
        grounded = ground(ctx, record, look, memory);
        step("simplify", "running", `rewrite ${attempt}`);
        draft = await simplify(ctx, grounded, scan);
      } else {
        ctx.say("safety_checker", "simplify", "critique", `Check ${attempt} failed: ${describe(report.issues)}. Revise.`);
        step("simplify", "running", `revision ${attempt}`);
        draft = await revise(ctx, grounded, scan, draft, report.issues, attempt);
      }
      summary = draft.summary;
    } catch (err) {
      // A failed rewrite never sinks the job: keep the last checked draft and fall back.
      draft = previous;
      summary = draft.summary;
      step("simplify", "done", `revision ${attempt} failed`);
      ctx.say("simplify", "orchestrator", "fallback", `Revision ${attempt} failed (${(err as Error).message.slice(0, 120)}). Keeping the last checked draft.`);
      break;
    }
    step("simplify", "done", `revision ${attempt}`);
  }
  step("safety_checker", report.pass ? "done" : "done", report.pass ? `passed, grade ${report.reading_level}` : `${report.issues.length} issue(s) left → fallback`);

  // 6 · Fall back to the original text for any section that still fails, or was never written.
  const fallback = fallbackSections(summary, report, scan);
  for (const f of fallback) ctx.say("orchestrator", "patient", "fallback", `"${f.title}" shows the original text with "Ask your care team": it didn't pass the safety check.`);
  for (const u of unwritten(draft)) {
    const original = scan.pages.flatMap((p) => p.lines).filter((l) => u.lines.includes(l.id));
    const same = fallback.find((f) => f.title === u.title);
    if (same) same.original.push(...original.filter((l) => !same.original.some((o) => o.id === l.id)));
    else fallback.push({ title: u.title, original });
    ctx.say("orchestrator", "patient", "fallback", `"${u.title}" shows the original text with "Ask your care team": it couldn't be written in plain words.`);
  }

  const cited = new Set([...summary.sections.flatMap((s) => s.bullets.flatMap((b) => b.sources)), ...summary.call_911_if.flatMap((b) => b.sources)]);
  const ledger: FinalOutput["ledger"] = {};
  for (const s of cited) {
    const entries = memory.ledgerFor(s);
    if (entries.length) ledger[s] = entries.map((e) => ({ action: `${e.action} · ${e.memory}`, ts: e.ts, details: e.details }));
  }
  for (const c of grounded.conflicts) ledger[c.id] = [{ action: `conflict_detected · ${c.detail}`, ts: Date.now() }];

  job.output = { summary, check: report, fallback_sections: fallback, record: grounded, scan, ledger, models: ctx.models };
  job.status = "done";
  keep(ctx, memory);
  persist(job);
}

/** Sections with issues left after the retries are replaced by the original lines they cite. */
function fallbackSections(summary: PlainSummary, report: CheckReport, scan: Parameters<typeof lineText>[0]): FinalOutput["fallback_sections"] {
  if (report.pass) return [];
  const failing = new Set(report.issues.map((i) => (i.type === "extract_mismatch" ? summary.sections.find((s) => /medicine/i.test(s.title))?.title : i.section)).filter(Boolean) as string[]);
  const out: FinalOutput["fallback_sections"] = [];
  const all = [...summary.sections, { title: "Call 911 if", bullets: summary.call_911_if }];
  for (const s of all.filter((s) => failing.has(s.title))) {
    const ids = [...new Set(s.bullets.flatMap((b) => b.sources).filter((x) => /^p\d+:L\d+/.test(x)))];
    const original: ScanLine[] = [];
    for (const id of ids) {
      const page = Number(id.match(/^p(\d+)/)![1]);
      const [from, to] = (id.split(":L")[1] ?? "").split("-").map((n) => Number(n.replace("L", "")));
      for (const l of scan.pages.find((p) => p.page === page)?.lines ?? []) {
        const n = Number(l.id.split(":L")[1]);
        if (n >= from && n <= (to || from) && !original.some((o) => o.id === l.id)) original.push(l);
      }
    }
    out.push({ title: s.title, original });
  }
  return out;
}

function describe(issues: Issue[]): string {
  const counts = new Map<string, number>();
  for (const i of issues) counts.set(i.type, (counts.get(i.type) ?? 0) + 1);
  return [...counts].map(([t, n]) => `${n} × ${t}`).join(", ");
}

function persist(job: Job): void {
  const dir = join(RUNS, job.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "job.json"), JSON.stringify(job, null, 2));
}

function friendlyError(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  if (err instanceof NightshiftError && /vision|cannot serve|no lane|unavailable/i.test(msg)) {
    return "Reading photos isn't available on this Nightshift yet (no vision model is set up). Paste the text of your discharge summary instead.";
  }
  if (err instanceof NightshiftError && /unreachable|fetch failed|ECONNREFUSED/i.test(msg)) {
    return "Can't reach Meterless Nightshift. Start Nightshift, or run with SAMPLE_MODE=true.";
  }
  return msg;
}
