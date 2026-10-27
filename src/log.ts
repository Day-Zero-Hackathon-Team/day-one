// Run logs: one readable line per event on stdout, and one JSON object per event in
// logs/trace-<run_id>.jsonl (agent handoffs, critiques, retries, fallbacks, Zetaris and H-MEM
// results, and the model that answered every Nightshift call). The full audit trail, with every
// agent's input and output, stays in runs/<run_id>/. Never pass a secret in here.

import { appendFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "./config.ts";

const LOGS = process.env.LOG_DIR ?? join(ROOT, "logs");
let quiet = false;

/** Stop printing to stdout (the JSON log file is still written). For `npm run agent -- --quiet`. */
export function setQuiet(value: boolean): void {
  quiet = value;
}

/** Where a run's trace goes, relative to the project folder when it's inside it. */
export function logFile(runId: string): string {
  const file = join(LOGS, `trace-${runId}.jsonl`);
  return file.startsWith(ROOT) ? relative(ROOT, file) : file;
}

export interface LogEvent {
  agent_name: string;
  action: string; // handoff | request | reply | critique | escalation | fallback | info | model_call | run_start | run_end
  output_summary: string;
  target_agent?: string;
  model?: string | null;
  receipt_id?: string | null;
  latency_ms?: number;
  status?: "success" | "error";
}

export function log(runId: string, event: LogEvent): void {
  const line = { timestamp: new Date().toISOString(), run_id: runId, status: "success", ...event };
  try {
    mkdirSync(LOGS, { recursive: true });
    appendFileSync(join(LOGS, `trace-${runId}.jsonl`), JSON.stringify(line) + "\n");
  } catch {
    // A full or read-only disk must not stop the run; stdout still has the line.
  }
  if (quiet) return;
  const to = event.target_agent && event.target_agent !== event.agent_name ? ` → ${event.target_agent}` : "";
  console.log(`[${line.status === "error" ? "ERROR" : "INFO"}] run_id=${runId} ${event.agent_name}${to} (${event.action}): ${event.output_summary}`);
}
