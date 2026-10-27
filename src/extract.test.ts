// Extract's re-check of lines other agents ask about. The model is faked, so these run offline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { verify, type VerifyRequest } from "./agents/extract.ts";
import type { AgentContext } from "./agents/context.ts";
import { scanText } from "./agents/scan.ts";
import type { DischargeRecord } from "./types.ts";

const scan = scanText(["MEDICATIONS", "Doxycyline 100 mg PO BID x 5 days"].join("\n"));
const fresh = (): DischargeRecord => ({
  patient: { name: null, birthdate: null, source: null },
  diagnoses: [],
  medications: [{ name: "Doxycyline", dose: "100 mg", freq: "BID", status: "new", source: "p1:L2" }],
  follow_ups: [],
  warning_signs: [],
  restrictions: [],
  unknown_terms: [],
  uncertain: [],
});
const requests: VerifyRequest[] = [{ source: "p1:L2", medication: "Doxycyline", question: "Not in the drug reference. Is the name read correctly?", from: "lookup" }];
const cutOff = `{ "scratchpad": "We need to verify each extracted medicine name against the original lines`;
const fixed = JSON.stringify({ answers: [{ source: "p1:L2", name: "Doxycycline", changed: true, note: "Spelling." }] });

/** A fake model that gives the answers in order, one per call. */
function fakeCtx(answers: string[]) {
  const calls: { maxTokens?: number }[] = [];
  const ctx = {
    say() {},
    save() {},
    async llm(req: { maxTokens?: number }) {
      calls.push({ maxTokens: req.maxTokens });
      return { content: answers[calls.length - 1], finishReason: "stop" };
    },
  };
  return { ctx: ctx as unknown as AgentContext, calls };
}

test("a cut-off re-check is asked again with more room, and its answer is used", async () => {
  const { ctx, calls } = fakeCtx([cutOff, fixed]);
  const record = fresh();
  const notes = await verify(ctx, scan, record, requests);
  assert.deepEqual(calls.map((c) => c.maxTokens), [2000, 4000]);
  assert.equal(record.medications[0].name, "Doxycycline");
  assert.match(notes[0], /corrected/);
});

test("a re-check that fails twice keeps the first extraction instead of failing the job", async () => {
  const { ctx, calls } = fakeCtx([cutOff, "not json at all"]);
  const record = fresh();
  const notes = await verify(ctx, scan, record, requests);
  assert.equal(calls.length, 2);
  assert.deepEqual(record.medications, fresh().medications);
  assert.match(notes[0], /keeping what was first read/);
});
