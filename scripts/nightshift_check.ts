// Live check against a running Nightshift: node scripts/nightshift_check.ts
//
// Passes when Auto Detect finds the runtime, a wrong token reads "unauthorized" (not
// "offline"), a text request returns a clean answer from a named model, and a repeated
// question gets no injected memory from the first call.

import { Nightshift, autoDetect } from "../src/nightshift.ts";

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);

const found = await autoDetect();
check("auto detect finds Nightshift", found?.status === "online", found ? `${found.baseUrl} (${found.status})` : "nothing found");

const wrong = new Nightshift({ token: "wrong-token", sampleMode: false });
const wrongStatus = await wrong.status();
check("wrong token reads unauthorized", wrongStatus === "unauthorized", wrongStatus);

const ns = new Nightshift({ sampleMode: false, runsDir: "runs" });
const jobId = `check-${Date.now()}`;
const question = { role: "user" as const, content: "In one short sentence: what is furosemide used for?" };

const first = await ns.chat({ agent: "check", jobId, route: "meterless/text", messages: [question], maxTokens: 300 });
check("text request returns an answer", first.content.length > 0, JSON.stringify(first.content.slice(0, 80)));
check("reasoning is stripped", !first.content.includes("</think>"), "");
check("routed model is named", !!first.routedModel, `${first.routedModel} · receipt ${first.receiptId}`);

const second = await ns.chat({ agent: "check", jobId, route: "meterless/text", messages: [question], maxTokens: 300 });
const { readFileSync } = await import("node:fs");
const lines = readFileSync(`runs/${jobId}/trace.jsonl`, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
check("no memory carried between calls", lines.every((l) => !l.memory_injected), `memory_injected per call: ${lines.map((l) => l.memory_injected).join(", ")}`);
check("trace written", lines.length === 2, `runs/${jobId}/trace.jsonl`);
void second;

for (const [name, ok, detail] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
