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

test("a medicine counts as covered under its plain name, not just its full printed name", () => {
  const lines = scanText(["Doxycycline hyclate 100 mg cap PO BID", "Tiotropium (Spiriva HandiHaler) 18 mcg cap STOP", "Oxygen (home, via NC) 2 L/min", "Chest pain"].join("\n"));
  const r = record({
    medications: [
      { name: "doxycycline hyclate 100 mg cap", dose: "100 mg", freq: "BID", status: "new", source: "p1:L1" },
      { name: "tiotropium (Spiriva HandiHaler) 18 mcg cap", dose: "--", freq: "--", status: "stopped", source: "p1:L2" },
      { name: "Oxygen (home, via NC)", dose: "2 L/min", freq: "with exertion", status: "new", source: "p1:L3" },
    ],
    warning_signs: [{ text: "Chest pain", source: "p1:L4" }],
    lookups: { drugs: [], terms: [] },
  });
  const s = (bullets: string[]) =>
    summary("", { sections: [{ title: "Your medicines", bullets: bullets.map((text, i) => ({ id: `b${i}`, text, sources: [`p1:L${i + 1}`] })) }], call_911_if: [{ id: "w1", text: "You have chest pain.", sources: ["p1:L4"] }] });
  assert.deepEqual(codeChecks(s(["Take doxycycline 100 mg two times a day.", "Stop tiotropium (Spiriva). Do not use it.", "Use oxygen at 2 L/min when active."]), r, lines), []);
  // A medicine that really is left out is still caught, and so is a wrong dose under the plain name.
  assert.deepEqual(types(codeChecks(s(["Take doxycycline 50 mg two times a day.", "Use oxygen at 2 L/min when active."]), r, lines)), ["dose_changed", "missing_medication"]);
});

test("a combination inhaler written only by its brand still counts, and its dose is checked on that bullet", () => {
  const lines = scanText(["Tiotropium-olodaterol (Stiolto Respimat) 2.5-2.5 mcg 2 inhalations daily", "Tiotropium (Spiriva HandiHaler) 18 mcg STOP", "Chest pain"].join("\n"));
  const r = record({
    medications: [
      { name: "tiotropium-olodaterol (Stiolto Respimat) 2.5-2.5 mcg/actuation", dose: "2 inhalations", freq: "daily", status: "new", source: "p1:L1" },
      { name: "tiotropium (Spiriva HandiHaler) 18 mcg cap", dose: "--", freq: "--", status: "stopped", source: "p1:L2" },
    ],
    warning_signs: [{ text: "Chest pain", source: "p1:L3" }],
    // Zetaris maps the combination to plain tiotropium, the same generic as the stopped inhaler.
    lookups: { drugs: [{ id: "drug:tiotropium", table: "drug_reference", name: "tiotropium-olodaterol (Stiolto Respimat) 2.5-2.5 mcg/actuation", generic: "tiotropium", plain_purpose: "an inhaler", common_side_effects: [], key_warning: null }], terms: [] },
  });
  const s = summary("", {
    sections: [{ title: "Your medicines", bullets: [
      { id: "b1", text: "Stiolto Respimat 2 inhalations once a day.", sources: ["p1:L1"] },
      { id: "b2", text: "Spiriva HandiHaler (tiotropium) is stopped.", sources: ["p1:L2"] },
    ] }],
    call_911_if: [{ id: "w1", text: "You have chest pain.", sources: ["p1:L3"] }],
  });
  assert.deepEqual(codeChecks(s, r, lines), []);
});

test("checker notes that clear themselves are dropped; real ones are kept", async () => {
  const { selfCleared } = await import("./agents/safety.ts");
  assert.ok(selfCleared('Bullet says "First dose given 10/23." Source says "First dose given 10/23 09:00." That\'s consistent.'));
  assert.ok(selfCleared("Bullet says Last dose was 10/24 at 9:00 AM. Source says exactly that. Good."));
  assert.ok(!selfCleared("The bullet says 2 more days which matches. However, the source also says the last dose is 10/26 PM."));
  assert.ok(!selfCleared("Remove the instruction to avoid OTC PM sleep aids; the source doesn't say it."));
  assert.ok(!selfCleared('Change to "Call your doctor the same day if you cannot urinate."'));
});

test("a verdict at the end of a checker note clears it, even after a hedge", async () => {
  const { selfCleared } = await import("./agents/safety.ts");
  assert.ok(selfCleared("The source says NEW: Furosemide 40 mg PO BID, which matches the bullet, but the drug reference warns about careful dose adjustment; no dose change detected."));
  assert.ok(!selfCleared("No dose change detected, but the bullet adds advice to avoid salt that the source doesn't give."));
});

test("a checker note ending in a negated verdict is kept", async () => {
  const { selfCleared } = await import("./agents/safety.ts");
  assert.ok(!selfCleared("Bullet says 20 mg; source says 40 mg. Not accurate."));
  assert.ok(!selfCleared("The bullet leaves out the fever warning. That isn't correct."));
});

test("a stopped medicine isn't covered by another medicine that shares its first word", () => {
  const lines = scanText(["Metoprolol tartrate 25 mg PO BID STOP", "Metoprolol succinate XL 50 mg PO daily NEW", "Chest pain"].join("\n"));
  const r = record({
    medications: [
      { name: "metoprolol tartrate 25 mg", dose: "--", freq: "--", status: "stopped", source: "p1:L1" },
      { name: "metoprolol succinate XL 50 mg", dose: "50 mg", freq: "daily", status: "new", source: "p1:L2" },
    ],
    warning_signs: [{ text: "Chest pain", source: "p1:L3" }],
    lookups: { drugs: [], terms: [] },
  });
  const s = summary("", {
    sections: [{ title: "Your medicines", bullets: [{ id: "b1", text: "Take metoprolol succinate 50 mg once a day.", sources: ["p1:L2"] }] }],
    call_911_if: [{ id: "w1", text: "You have chest pain.", sources: ["p1:L3"] }],
  });
  assert.deepEqual(types(codeChecks(s, r, lines)), ["missing_medication"]);
});
