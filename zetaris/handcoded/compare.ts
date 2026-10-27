// The hand-coded approach, for comparison with the USL (zetaris/docs/2a-time-saved.md).
//
// Does by hand a slice of what zetaris/sql/4-7 do declaratively: rename the Synthea columns,
// resolve each hospital medicine to an openFDA generic name, and run four of the data quality
// checks (glossary key, encounter -> patient key, stop-after-start, has a drug label). It reads
// the CSVs straight from data/out/, so it needs no Zetaris, and prints the same counts the USL
// reports, so the two can be checked against each other.
//
//   node --experimental-transform-types --no-warnings zetaris/handcoded/compare.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../src/config.ts";

type Row = Record<string, string>;

// openFDA labels contain quoted, multi-line fields with escaped quotes, so split(",") won't do.
function readCsv(path: string): Row[] {
  const text = readFileSync(join(ROOT, "data", "out", path), "utf-8");
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { record.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      if (record.some((f) => f !== "")) records.push(record);
      record = [];
      field = "";
    } else field += ch;
  }
  if (field || record.length) { record.push(field); records.push(record); }
  const [header, ...rows] = records;
  return rows.map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ""])));
}

const drugs = readCsv("drug_reference.csv");
const terms = readCsv("medical_terms.csv");
const patients = readCsv("hospital_records/patients.csv");
const encounters = readCsv("hospital_records/encounters.csv");
const meds = readCsv("hospital_records/medications.csv");

// Semantic mapping, by hand: the same renames and derivations as 5_usl_activate.sql.
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const generics = drugs.map((d) => d.generic_name).sort((a, b) => b.length - a.length || a.localeCompare(b));
const matchers = generics.map((g) => [g, new RegExp(`(^|[^a-z])${escape(g)}([^a-z]|$)`)] as const);
const resolved = new Map<string, string | null>();
const resolve = (description: string) => {
  if (!resolved.has(description)) {
    const lower = description.toLowerCase();
    resolved.set(description, matchers.find(([, re]) => re.test(lower))?.[0] ?? null);
  }
  return resolved.get(description)!;
};
const medicationOrders = meds.map((m) => ({
  patient_id: m.PATIENT,
  encounter_id: m.ENCOUNTER,
  medication: m.DESCRIPTION,
  generic_name: resolve(m.DESCRIPTION),
  started_at: m.START ? new Date(m.START) : null,
  stopped_at: m.STOP ? new Date(m.STOP) : null,
}));
const glossary = terms.map((t) => ({ ...t, term: t.term.trim().toUpperCase() }));

// Data quality, by hand.
function primaryKey(rows: Row[], key: string) {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r[key], (counts.get(r[key]) ?? 0) + 1);
  const invalid = rows.filter((r) => !r[key] || counts.get(r[key])! > 1).length;
  return { total: rows.length, valid: rows.length - invalid, invalid };
}
function check<T>(rows: T[], ok: (r: T) => boolean) {
  const invalid = rows.filter((r) => !ok(r)).length;
  return { total: rows.length, valid: rows.length - invalid, invalid };
}
const patientIds = new Set(patients.map((p) => p.Id));

console.table({
  "term (primary key)": primaryKey(glossary, "term"),
  "encounter.patient_id (foreign key)": check(encounters, (e) => patientIds.has(e.PATIENT)),
  stop_not_before_start: check(medicationOrders, (m) => !m.stopped_at || !m.started_at || m.stopped_at >= m.started_at),
  has_drug_label: check(medicationOrders, (m) => m.generic_name !== null),
});
const dupes = glossary.filter((t, _, all) => all.filter((u) => u.term === t.term).length > 1);
console.log("Invalid glossary records:", dupes.map((t) => `${t.term} = ${t.meaning}`).join("; ") || "none");
