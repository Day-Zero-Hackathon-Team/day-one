// Simplify in parts: how the work is split, merged and revised. The model is faked, so these run offline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MEDS_PER_PART, planParts, revise, simplify, unwritten } from "./agents/simplify.ts";
import type { AgentContext } from "./agents/context.ts";
import { scanText } from "./agents/scan.ts";
import type { GroundedRecord, Medication } from "./types.ts";

const meds: Medication[] = Array.from({ length: 7 }, (_, i) => ({ name: `Drug${i + 1}`, dose: `${(i + 1) * 10} mg`, freq: "daily", status: "new", source: `p1:L${i + 3}` }));
const lines = ["DIAGNOSIS", "Pneumonia", ...meds.map((m) => `${m.name} ${m.dose} PO daily`), "Follow up with PCP in 1 week", "CALL 911 IF:", "Chest pain"];
const scan = scanText(lines.join("\n"));

const record: GroundedRecord = {
  patient: { name: null, birthdate: null, source: null },
  diagnoses: [{ text: "Pneumonia", source: "p1:L2" }],
  medications: meds,
  follow_ups: [{ who: "PCP", when: "1 week", source: "p1:L10" }],
  warning_signs: [{ text: "Chest pain", source: "p1:L12" }],
  restrictions: [],
  unknown_terms: [],
  uncertain: [],
  lookups: { drugs: [], terms: [] },
  hospital_record_diff: [],
  matched_patient: null,
  conflicts: [],
};

/** A fake model: answers each part by its prompt, and fails the parts `fail` picks. */
function fakeCtx(fail: (system: string, user: string) => boolean = () => false) {
  const calls: { system: string; user: string }[] = [];
  const ctx = {
    say() {},
    save() {},
    async llm(req: { messages: { content: string }[] }) {
      const [system, user] = [req.messages[0].content, req.messages.at(-1)!.content];
      calls.push({ system, user });
      if (fail(system, user)) return { content: "{}", finishReason: "stop" };
      if (system.includes("call_911_if:")) return { content: JSON.stringify({ call_911_if: [{ id: "x", text: "Call 911 if you have chest pain.", sources: ["p1:L11", "p1:L12"] }] }), finishReason: "stop" };
      if (system.includes("med_schedule:")) {
        const mine = meds.filter((m) => user.includes(`"name":"${m.name}"`));
        return { content: JSON.stringify({ sections: [{ title: "Your medicines", bullets: mine.map((m) => ({ id: "x", text: `Take ${m.name} ${m.dose} every morning.`, sources: [m.source] })) }], med_schedule: [] }), finishReason: "stop" };
      }
      return { content: JSON.stringify({ sections: [{ title: "Why you were in the hospital", bullets: [{ id: "x", text: "You had a lung infection.", sources: ["p1:L2"] }] }] }), finishReason: "stop" };
    },
  };
  return { ctx: ctx as unknown as AgentContext, calls };
}

test("the summary is split into small parts that each see only their own lines", () => {
  const parts = planParts(record, scan);
  assert.deepEqual(parts.map((p) => p.key), ["about", "warnings", "meds1", "meds2"]);
  assert.equal(parts.find((p) => p.key === "meds1")!.meds.length, MEDS_PER_PART);
  assert.ok(parts.find((p) => p.key === "about")!.input.includes("p1:L2 | Pneumonia"));
  assert.ok(!parts.find((p) => p.key === "about")!.input.includes("Drug1"));
  // Warning signs also get the heading line above them ("CALL 911 IF:").
  assert.deepEqual(parts.find((p) => p.key === "warnings")!.lines, ["p1:L10", "p1:L11", "p1:L12"]);
});

test("the parts merge into one summary with unique bullet ids", async () => {
  const { ctx } = fakeCtx();
  const draft = await simplify(ctx, record, scan);
  const medSection = draft.summary.sections.find((s) => s.title === "Your medicines")!;
  assert.equal(medSection.bullets.length, meds.length);
  const ids = draft.summary.sections.flatMap((s) => s.bullets.map((b) => b.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(draft.summary.call_911_if[0].id, "w1");
  assert.deepEqual(unwritten(draft), []);
});

test("a part that fails twice shows its lines as written; failed warnings fall back to the papers' words", async () => {
  const { ctx } = fakeCtx((system, user) => system.includes("call_911_if:") || user.includes('"name":"Drug6"'));
  const draft = await simplify(ctx, record, scan);
  assert.equal(draft.summary.sections.find((s) => s.title === "Your medicines")!.bullets.length, MEDS_PER_PART);
  assert.deepEqual(unwritten(draft), [{ title: "Medicines we couldn't rewrite", lines: ["p1:L8", "p1:L9"] }]);
  assert.deepEqual(draft.summary.call_911_if, [{ id: "w1", text: "Chest pain", sources: ["p1:L12"] }]); // line 12 as written
});

test("nothing written at all is an error, so the pipeline shows the original papers", async () => {
  const { ctx } = fakeCtx(() => true);
  await assert.rejects(simplify(ctx, record, scan), /no part of the summary could be written/);
});

test("a revision only rewrites the parts its issues point at", async () => {
  const { ctx, calls } = fakeCtx();
  const draft = await simplify(ctx, record, scan);
  calls.length = 0;
  const bullet = draft.summary.sections.find((s) => s.title === "Why you were in the hospital")!.bullets[0].id;
  await revise(ctx, record, scan, draft, [
    { bullet, section: "Why you were in the hospital", type: "too_complex", fix: "Simpler words.", by: "code" },
    { bullet: null, section: "Your medicines", type: "missing_medication", fix: "Add a bullet for Drug7 70 mg daily (new), citing p1:L9.", by: "code" },
  ], 1);
  assert.equal(calls.length, 2);
  assert.ok(calls.some((c) => c.user.includes("Simpler words.") && c.user.includes("Pneumonia")));
  assert.ok(calls.some((c) => c.user.includes("Drug7 70 mg") && c.user.includes('"name":"Drug6"')));
});
