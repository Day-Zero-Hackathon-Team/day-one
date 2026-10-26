// The Safety checker's code rules: no model involved, so these run offline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { codeChecks } from "./agents/safety.ts";
import { scanText } from "./agents/scan.ts";
import { readingGrade } from "./text.ts";
import type { GroundedRecord, PlainSummary } from "./types.ts";

const scan = scanText(["DISCHARGE MEDICATIONS", "Furosemide 40 mg PO BID", "CALL 911 IF", "Chest pain"].join("\n"));

const record = (over: Partial<GroundedRecord> = {}): GroundedRecord => ({
  patient: { name: null, birthdate: null, source: null },
  diagnoses: [],
  medications: [{ name: "Furosemide", dose: "40 mg", freq: "BID", status: "new", source: "p1:L2" }],
  follow_ups: [],
  warning_signs: [{ text: "Chest pain", source: "p1:L4" }],
  restrictions: [],
  unknown_terms: [],
  uncertain: [],
  lookups: { drugs: [{ id: "drug:furosemide", table: "drug_reference", name: "Furosemide", generic: "furosemide", plain_purpose: "a water pill", common_side_effects: [], key_warning: null }], terms: [] },
  hospital_record_diff: [],
  matched_patient: null,
  conflicts: [],
  ...over,
});

const summary = (medText: string, over: Partial<PlainSummary> = {}): PlainSummary => ({
  sections: [{ title: "Your medicines", bullets: [{ id: "b1", text: medText, sources: ["p1:L2", "drug:furosemide"] }] }],
  med_schedule: [],
  call_911_if: [{ id: "w1", text: "You have chest pain.", sources: ["p1:L4"] }],
  questions_for_your_doctor: [],
  ...over,
});

const types = (issues: { type: string }[]) => issues.map((i) => i.type).sort();

test("a faithful summary passes the code checks", () => {
  assert.deepEqual(codeChecks(summary("Take furosemide 40 mg two times a day."), record(), scan), []);
});

test("a changed dose is caught", () => {
  assert.deepEqual(types(codeChecks(summary("Take furosemide 20 mg two times a day."), record(), scan)), ["dose_changed"]);
});

test("a dose that isn't on its own line goes back to Extract", () => {
  const misread = record({ medications: [{ name: "Furosemide", dose: "10 mg", freq: "BID", status: "new", source: "p1:L2" }] });
  assert.deepEqual(types(codeChecks(summary("Take furosemide 10 mg two times a day."), misread, scan)), ["extract_mismatch"]);
});

test("a missing warning sign and an invented source are caught", () => {
  const s = summary("Take furosemide 40 mg two times a day.", { call_911_if: [{ id: "w1", text: "Chest pain.", sources: ["p9:L1"] }] });
  assert.deepEqual(types(codeChecks(s, record(), scan)), ["bad_source", "missing_warning"]);
});

test("an open H-MEM conflict must be flagged to the patient", () => {
  const r = record({ conflicts: [{ id: "conflict:conflict-1", drug: "furosemide", detail: "paper 40 mg, record 20 mg" }] });
  assert.deepEqual(types(codeChecks(summary("Take furosemide 40 mg two times a day."), r, scan)), ["conflict_not_flagged"]);
});

test("reading level: short plain sentences score low, jargon scores high", () => {
  assert.ok(readingGrade(["Take one pill in the morning.", "Call us if you feel sick."]) < 4);
  assert.ok(readingGrade(["Administer the pharmacological intervention concomitantly with nutritional consumption to ameliorate gastrointestinal intolerance."]) > 12);
});

test("drug names match without release forms or doses", async () => {
  const { baseDrugName } = await import("./text.ts");
  assert.equal(baseDrugName("Metformin ER"), "metformin");
  assert.equal(baseDrugName("Metoprolol succinate XL 50 mg"), "metoprolol succinate");
  assert.equal(baseDrugName("Furosemide"), "furosemide");
});
