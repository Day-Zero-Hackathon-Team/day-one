// Run the agents on one discharge summary from the command line, without the web app.
// Prints each agent step as it happens, then the result as JSON. Exit code 0 means success.
//
//   npm run agent:sample -- samples/inputs/1-heart-failure.txt          (recorded responses, no setup)
//   npm run agent -- samples/inputs/1-heart-failure.txt                 (live: Nightshift + Zetaris)
//   npm run agent -- examples/requests/1-heart-failure.json --quiet     (a JSON request, result only)
//
// Input: a .txt file (the papers' text), a .json request ({"input": {...}, "options": {...}}, the
// same body as POST /api/run), or photos (.jpg/.png/.webp, one per page).
// Options: --ask "question" (repeatable), --run-id <id>, --out <file.json>, --quiet.

import { readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { loadDotEnv } from "../src/config.ts";

loadDotEnv();

const { JobRunner } = await import("../src/pipeline.ts");
const { checkRequest, runToCompletion } = await import("../src/run.ts");
const { setQuiet } = await import("../src/log.ts");
type RunRequest = import("../src/run.ts").RunRequest;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const questions: string[] = [];
for (let q = flag("--ask"); q !== undefined; q = flag("--ask")) questions.push(q);
const runId = flag("--run-id");
const out = flag("--out");
const quiet = args.includes("--quiet");
const files = args.filter((a) => !a.startsWith("--"));
setQuiet(quiet);

if (!files.length) {
  console.error("Usage: npm run agent -- <papers.txt | request.json | page1.jpg page2.jpg ...> [--ask \"question\"] [--run-id id] [--out result.json] [--quiet]");
  process.exit(2);
}

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
let req: RunRequest;
if (extname(files[0]).toLowerCase() === ".json") req = JSON.parse(readFileSync(files[0], "utf-8"));
else if (MIME[extname(files[0]).toLowerCase()]) req = { input: { images: files.map((f) => `data:${MIME[extname(f).toLowerCase()]};base64,${readFileSync(f).toString("base64")}`) } };
else req = { input: { text: readFileSync(files[0], "utf-8") } };
if (runId) req.run_id = runId;
if (questions.length) req.options = { ...req.options, questions: [...(req.options?.questions ?? []), ...questions] };

const problem = checkRequest(req);
if (problem) {
  console.log(JSON.stringify({ status: "error", error: { type: "BadRequest", message: problem, recoverable: false } }, null, 2));
  process.exit(1);
}

const result = await runToCompletion(new JobRunner(), req);
const json = JSON.stringify(result, null, 2);
if (out) writeFileSync(out, json + "\n");
console.log(json);
process.exit(result.status === "success" ? 0 : 1);
