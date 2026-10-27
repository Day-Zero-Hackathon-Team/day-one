// One run from start to finish as structured JSON: the programmatic entry point behind
// `npm run agent` (scripts/run.ts) and POST /api/run. The web app uses the same JobRunner
// through POST /api/jobs and polls instead.

import { join } from "node:path";
import { logFile } from "./log.ts";
import type { JobRunner } from "./pipeline.ts";
import type { Job } from "./types.ts";

export interface RunRequest {
  run_id?: string;
  input: { text?: string; images?: string[] }; // images: data URLs, one per page
  options?: { questions?: string[]; timeout_seconds?: number };
}

export const AGENTS = [
  { name: "Scan", role: "Turns photos or pasted text into numbered lines, page by page; re-reads lines Extract isn't sure of" },
  { name: "Extract", role: "Pulls medicines, diagnoses, warning signs and follow-ups into structured fields, each citing its source line" },
  { name: "Lookup", role: "Checks every medicine and abbreviation in Zetaris and matches the patient's hospital record" },
  { name: "Memory (H-MEM)", role: "Meterless H-MEM engine: stores the papers and the hospital record, flags dose conflicts, recalls facts for Q&A" },
  { name: "Simplify", role: "Rewrites the papers at a grade-6 reading level; every bullet cites a line of the papers" },
  { name: "Safety checker", role: "Checks each bullet against its source line, doses and warning signs; sends problems back (at most 2 retries)" },
  { name: "Q&A", role: "Answers follow-up questions from this patient's papers only, with sources" },
];

const DEFAULT_TIMEOUT_S = Number(process.env.RUN_TIMEOUT_SECONDS ?? 900);

/** Validate a request body. Returns an error message, or null when it's usable. */
export function checkRequest(body: unknown): string | null {
  const r = body as RunRequest;
  if (!r || typeof r !== "object" || !r.input || typeof r.input !== "object") return 'Send {"input": {"text": "..."}} or {"input": {"images": ["data:image/jpeg;base64,..."]}}.';
  const text = typeof r.input.text === "string" ? r.input.text : "";
  const images = Array.isArray(r.input.images) ? r.input.images : [];
  if (!text.trim() && !images.length) return "input.text or input.images is required.";
  if (images.length > 10) return "Up to 10 pages at a time.";
  if (images.some((i) => typeof i !== "string" || !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(i))) return "input.images must be data:image/... base64 URLs.";
  if (r.options?.questions && (!Array.isArray(r.options.questions) || r.options.questions.some((q) => typeof q !== "string"))) return "options.questions must be a list of strings.";
  return null;
}

/** Run the pipeline on one input, wait for it, ask any questions, and return the result or a structured error. */
export async function runToCompletion(runner: JobRunner, req: RunRequest): Promise<Record<string, unknown>> {
  const started = Date.now();
  const timeoutS = req.options?.timeout_seconds ?? DEFAULT_TIMEOUT_S;
  const job = runner.start({ text: req.input.text, images: req.input.images }, req.run_id);
  const base = () => ({ run_id: job.id, trace_id: job.id, log_file: logFile(job.id), audit_dir: join("runs", job.id), execution_time_seconds: Number(((Date.now() - started) / 1000).toFixed(1)) });

  while (job.status === "running") {
    if (Date.now() - started > timeoutS * 1000) {
      return { ...base(), status: "error", error: { type: "RunTimeout", message: `The run didn't finish within ${timeoutS} s. It keeps going in the background; its log shows how far it got.`, recoverable: true } };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (job.status === "failed") return { ...base(), status: "error", error: classify(job.error ?? "unknown error") };
  if (job.status === "needs_rescan") return { ...base(), status: "needs_rescan", rescan: job.rescan, agents: AGENTS };

  const qa = [];
  for (const q of req.options?.questions ?? []) {
    if (q.trim()) qa.push(await runner.ask(job.id, q.trim().slice(0, 500)));
  }
  return { ...base(), status: "success", output: output(job, qa), agents: AGENTS };
}

function output(job: Job, qa: unknown[]): Record<string, unknown> {
  const o = job.output!;
  return {
    patient: o.record.patient,
    matched_hospital_record: o.record.matched_patient,
    safety_check: { pass: o.check.pass, reading_level: o.check.reading_level, issues: o.check.issues },
    summary: o.summary, // sections, med_schedule, call_911_if, questions_for_your_doctor; every bullet cites its source lines
    fallback_sections: o.fallback_sections, // shown as the original text with "Ask your care team"
    medicine_changes: o.record.hospital_record_diff,
    dose_conflicts: o.record.conflicts,
    qa,
    models: o.models, // the model Nightshift routed each call to, with its signed receipt
  };
}

function classify(message: string): { type: string; message: string; recoverable: boolean } {
  if (/reach Meterless Nightshift|unreachable|ECONNREFUSED/i.test(message)) return { type: "NightshiftUnreachable", message, recoverable: true };
  if (/vision/i.test(message)) return { type: "VisionUnavailable", message, recoverable: true };
  if (/Zetaris/i.test(message)) return { type: "ZetarisError", message, recoverable: true };
  if (/SAMPLE_MODE/i.test(message)) return { type: "NoRecordedResponse", message: `${message} (sample mode only has recordings for samples/inputs/)`, recoverable: false };
  return { type: "PipelineError", message, recoverable: false };
}
