// Offline tests for the Nightshift client (no runtime needed): node --test src/
// The live check against a running Nightshift is scripts/nightshift_check.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Nightshift, NightshiftError, classifyModelsResponse, normalizeBaseUrl, stripReasoning } from "./nightshift.ts";

test("normalizeBaseUrl accepts any pasted form and never doubles /v1", () => {
  const want = "http://127.0.0.1:8088/v1";
  for (const raw of [
    "127.0.0.1:8088",
    "http://127.0.0.1:8088",
    "http://127.0.0.1:8088/",
    "http://127.0.0.1:8088/v1",
    "http://127.0.0.1:8088/v1/",
    "http://127.0.0.1:8088/v1/chat/completions",
    "http://127.0.0.1:8088/v1/models",
    "http://127.0.0.1:8088/healthz",
  ]) {
    assert.equal(normalizeBaseUrl(raw), want, raw);
  }
  assert.equal(normalizeBaseUrl("[::1]:8090"), "http://[::1]:8090/v1");
});

test("stripReasoning keeps only the answer", () => {
  assert.equal(stripReasoning("The user wants OK.</think>OK"), "OK");
  assert.equal(stripReasoning("<think>plan</think>\nAnswer"), "Answer");
  assert.equal(stripReasoning("plain answer"), "plain answer");
  assert.equal(stripReasoning("a</think>b</think> final"), "final");
});

test("status: 401 is unauthorized, an empty Ollama is offline, meterless ids are online", () => {
  assert.equal(classifyModelsResponse(401, null), "unauthorized");
  assert.equal(classifyModelsResponse(403, null), "unauthorized");
  assert.equal(classifyModelsResponse(200, { object: "list", data: null }), "offline"); // Ollama on 11434
  assert.equal(classifyModelsResponse(200, { data: [{ id: "llama3" }] }), "offline");
  assert.equal(classifyModelsResponse(200, { data: [{ id: "meterless/auto" }] }), "online");
  assert.equal(classifyModelsResponse(500, null), "offline");
});

// A fake runtime that records each request and answers like Nightshift does.
function fakeRuntime(reply: (n: number) => { status: number; body: unknown }) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null });
    const { status, body } = reply(calls.length);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const answer = (content: string) => ({
  status: 200,
  body: {
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 10, completion_tokens: 3 },
    meterless: { routed_model: "nvidia/nemotron-3-ultra-550b-a55b", receipt_id: "rcpt_test", phases: [] },
  },
});

function client(fetchImpl: typeof fetch, extra: object = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ns-test-"));
  const ns = new Nightshift({ baseUrl: "127.0.0.1:8088", token: "t0k", fetchImpl, sampleMode: false, record: false, runsDir: join(dir, "runs"), samplesDir: join(dir, "samples"), ...extra });
  return { ns, dir };
}

test("chat sends the contract headers and a fresh scope per call", async () => {
  const { calls, fetchImpl } = fakeRuntime(() => answer("thinking</think>Water pill."));
  const { ns, dir } = client(fetchImpl);
  const req = { agent: "simplify", jobId: "job-1", route: "meterless/text", messages: [{ role: "user" as const, content: "hi" }] };
  const a = await ns.chat(req);
  await ns.chat(req);

  assert.equal(a.content, "Water pill.");
  assert.equal(a.routedModel, "nvidia/nemotron-3-ultra-550b-a55b");
  assert.equal(a.receiptId, "rcpt_test");
  assert.equal(calls[0].url, "http://127.0.0.1:8088/v1/chat/completions");
  assert.equal(calls[0].headers.authorization, "Bearer t0k");
  assert.equal(calls[0].headers["meterless-app"], "day-one");
  assert.equal(calls[0].headers["meterless-tier-split"], "off");
  assert.match(calls[0].headers["meterless-scope"], /^day-one\.job-1\.simplify\.[0-9a-f]{8}$/);
  assert.notEqual(calls[0].headers["meterless-scope"], calls[1].headers["meterless-scope"]);

  const trace = readFileSync(join(dir, "runs", "job-1", "trace.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(trace.length, 2);
  assert.equal(trace[0].model, "nvidia/nemotron-3-ultra-550b-a55b");
  assert.equal(trace[0].agent, "simplify");
  assert.equal(trace[0].status, "ok");
});

test("chat retries a 500 at most twice, then fails with the error traced", async () => {
  const { calls, fetchImpl } = fakeRuntime(() => ({ status: 500, body: { error: { message: "upstream" } } }));
  const { ns, dir } = client(fetchImpl);
  await assert.rejects(ns.chat({ agent: "scan", jobId: "job-2", route: "meterless/vision", messages: [] }), NightshiftError);
  assert.equal(calls.length, 3);
  const trace = JSON.parse(readFileSync(join(dir, "runs", "job-2", "trace.jsonl"), "utf-8").trim());
  assert.equal(trace.status, "error");
});

test("chat does not retry a wrong token", async () => {
  const { calls, fetchImpl } = fakeRuntime(() => ({ status: 401, body: { error: "unauthorized" } }));
  const { ns } = client(fetchImpl);
  await assert.rejects(ns.chat({ agent: "extract", jobId: "job-3", route: "meterless/text", messages: [] }), /unauthorized/);
  assert.equal(calls.length, 1);
});

test("a recorded response replays in SAMPLE_MODE with no network", async () => {
  const { fetchImpl } = fakeRuntime(() => answer("</think>Recorded answer."));
  const { ns, dir } = client(fetchImpl, { record: true });
  const req = { agent: "extract", jobId: "job-4", route: "meterless/text", messages: [{ role: "user" as const, content: "same input" }] };
  await ns.chat(req);

  const offline = new Nightshift({
    baseUrl: "127.0.0.1:1",
    sampleMode: true,
    runsDir: join(dir, "runs"),
    samplesDir: join(dir, "samples"),
    fetchImpl: (() => { throw new Error("network used in sample mode"); }) as typeof fetch,
  });
  const replay = await offline.chat(req);
  assert.equal(replay.content, "Recorded answer.");
  assert.equal(replay.mode, "sample");
  assert.equal(replay.routedModel, "nvidia/nemotron-3-ultra-550b-a55b");
});
