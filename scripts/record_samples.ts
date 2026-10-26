// Re-record sample mode: node scripts/record_samples.ts   (or npm run samples:record)
//
// Runs the three sample cases in samples/inputs/ live against Nightshift and Zetaris with
// recording on, asks each one its recorded Q&A question, and saves every response into
// samples/nightshift/ and samples/zetaris/. Old recordings are cleared first so nothing stale
// is left behind. Needs Nightshift and Zetaris running. Then it replays all three offline, the
// way `npm run sample` will. Exits non-zero if a case doesn't pass the safety check or its
// question goes unanswered, live or replayed.
//
//   npm run samples:record -- --replay   only check the recordings already there (offline)

import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

process.env.NIGHTSHIFT_RECORD = "true";
process.env.ZETARIS_RECORD = "true";
process.env.SAMPLE_MODE = "false";

const { ROOT, loadDotEnv } = await import("../src/config.ts");
loadDotEnv();
const { JobRunner } = await import("../src/pipeline.ts");

// The Q&A question recorded for each sample (README "No Nightshift or Zetaris?"), and whether its
// papers answer it. Sample 1's papers never mention alcohol: it shows the "ask your care team" path.
const QUESTIONS: Record<string, { q: string; answered: boolean }> = {
  "1-heart-failure.txt": { q: "Can I drink alcohol?", answered: false },
  "2-pneumonia.txt": { q: "When should I see my doctor again?", answered: true },
  "3-knee-replacement.txt": { q: "Can I take a bath?", answered: true },
};

// --replay: only check the recordings already in samples/ (offline); --keep: record without clearing first.
const replayOnly = process.argv.includes("--replay");
if (!replayOnly) {
  // Check both services before clearing anything: with either one down, every case would fail and the old recordings would be gone.
  const { Nightshift } = await import("../src/nightshift.ts");
  const { lookupAll } = await import("../src/zetaris.ts");
  const ns = await new Nightshift().status();
  const zetaris = await lookupAll({ drugs: ["furosemide"], terms: [] }).then(() => "online", (err: Error) => `offline (${err.message.slice(0, 120)})`);
  if (ns !== "online" || zetaris !== "online") {
    console.error(`Not recording: Nightshift is ${ns}, Zetaris is ${zetaris}. The recordings in samples/ are unchanged.`);
    process.exit(1);
  }
}
if (!replayOnly && !process.argv.includes("--keep")) {
  for (const dir of ["nightshift", "zetaris"]) rmSync(join(ROOT, "samples", dir), { recursive: true, force: true });
}

const inputs = join(ROOT, "samples", "inputs");
const files = readdirSync(inputs).filter((f) => f.endsWith(".txt")).sort();

/** Runs every sample and its question; returns how many failed. */
async function runAll(label: string): Promise<number> {
  const runner = new JobRunner();
  let failed = 0;
  for (const file of files) {
    const started = Date.now();
    const job = runner.start({ text: readFileSync(join(inputs, file), "utf-8") });
    while (job.status === "running") await new Promise((r) => setTimeout(r, 500));
    const o = job.output;
    let ok = job.status === "done" && !!o?.check.pass && !o.fallback_sections.length;
    let qa = "";
    if (o && QUESTIONS[file]) {
      // An answer where the papers have none, or "ask your care team" where they do, is a bad recording.
      const want = QUESTIONS[file];
      const a = await runner.ask(job.id, want.q);
      qa = ` · Q&A ${a.answered ? `answered: "${a.answer}"` : "ask your care team"}${a.answered === want.answered ? "" : " (WRONG)"}`;
      ok &&= a.answered === want.answered;
    }
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${file}  ${job.id}  ${Math.round((Date.now() - started) / 1000)} s${o ? ` · ${o.check.issues.length} issue(s) left` : ` · ${job.status}: ${job.error ?? ""}`}${qa}`);
    if (!ok) failed++;
  }
  return failed;
}

let failed = replayOnly ? 0 : await runAll("live");
// Then replay what was just recorded, offline, the way `npm run sample` will.
if (!failed) {
  process.env.SAMPLE_MODE = "true";
  process.env.NIGHTSHIFT_RECORD = "false";
  process.env.ZETARIS_RECORD = "false";
  failed = await runAll("replay");
}
process.exit(failed ? 1 : 0);
