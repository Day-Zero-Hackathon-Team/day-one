// The medical terms glossary (data/medical_terms.csv): checks that run offline, before the
// file is loaded into Zetaris.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.ts";

const [header, ...rows] = readFileSync(join(ROOT, "data", "medical_terms.csv"), "utf-8")
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l) => l.split(","));

test("every row has term, category, meaning and plain language, with no stray quotes", () => {
  assert.deepEqual(header, ["term", "category", "meaning", "plain_language"]);
  for (const row of rows) {
    assert.equal(row.length, 4, `wrong number of fields: ${row.join(",")}`);
    assert.ok(row.every((f) => f.trim() && !f.includes('"')), `empty field or quote: ${row.join(",")}`);
  }
});

// Lookup matches terms case-insensitively (upper(term) in src/zetaris.ts), so "cap" and "CAP"
// would both come back and the AI would be handed two meanings. That is how "capsule" sat
// next to "community-acquired pneumonia" for the pneumonia patient. A term that really has
// two meanings gets one row that explains both.
test("no term is defined twice, ignoring case", () => {
  const seen = new Map<string, string>();
  for (const [term] of rows) {
    const key = term.trim().toUpperCase();
    assert.ok(!seen.has(key), `"${term}" duplicates "${seen.get(key)}"`);
    seen.set(key, term);
  }
});

test("CAP explains pneumonia first, and the capsule reading only for doses", () => {
  const cap = rows.find(([t]) => t === "CAP");
  assert.ok(cap, "CAP is missing");
  assert.match(cap[2], /^community-acquired pneumonia/);
  assert.match(cap[3], /^a lung infection/);
  assert.match(cap[3], /capsule/);
});
