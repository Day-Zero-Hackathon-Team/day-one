// Feature test for patient medicine memory on the Meterless H-MEM engine.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PatientMemory } from "./memory.ts";

const fresh = () => new PatientMemory("test-patient", mkdtempSync(join(tmpdir(), "hmem-")));

test("a dose the papers don't explain opens a conflict", () => {
  const m = fresh();
  m.rememberDose({ drug: "carvedilol", dose: "25 mg", source: "record:32", origin: "record", label: "Hospital record" });
  m.rememberDose({ drug: "carvedilol", dose: "12.5 mg", source: "p1:L13", origin: "paper", label: "Continue carvedilol 12.5 mg" });
  const conflicts = m.conflicts();
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].drug, "carvedilol");
  assert.deepEqual([conflicts[0].a.source, conflicts[0].b.source].sort(), ["p1:L13", "record:32"]);
});

test("a change the papers state supersedes the record: no conflict", () => {
  const m = fresh();
  const rec = m.rememberDose({ drug: "lisinopril", dose: "40 mg", source: "record:7", origin: "record", label: "Hospital record" });
  m.rememberDose({ drug: "lisinopril", dose: "20 mg", source: "p1:L12", origin: "paper", label: "Lisinopril decreased to 20 mg", supersedes: rec.id });
  assert.equal(m.conflicts().length, 0);
});

test("different drugs at different doses never conflict", () => {
  const m = fresh();
  m.rememberDose({ drug: "furosemide", dose: "40 mg", source: "p1:L11", origin: "paper", label: "" });
  m.rememberDose({ drug: "clopidogrel", dose: "75 mg", source: "p1:L14", origin: "paper", label: "" });
  m.rememberDose({ drug: "metoprolol succinate", dose: "100 mg", source: "record:3", origin: "record", label: "" });
  assert.equal(m.conflicts().length, 0);
});

test("every memory keeps its source, and the ledger records it", () => {
  const m = fresh();
  m.rememberDose({ drug: "furosemide", dose: "40 mg", source: "p1:L11", origin: "paper", label: "" });
  const trail = m.ledgerFor("p1:L11");
  assert.equal(trail[0].action, "create");
  assert.throws(() => m.hmem.add({ content: "no source", source: "" }), /source/);
});
