// Small text helpers shared by the agents.

/** Parse the first JSON object in a model answer, tolerating code fences and stray prose. */
export function parseJsonObject<T = any>(raw: string): T {
  const text = raw.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error(`model did not return JSON: ${text.slice(0, 200)}`);
  }
}

/** "40 mg", "0.4 MG/ACTUAT" → the first amount with its unit, lower-cased; null if none. */
export function doseOf(text: string): string | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(mg|mcg|µg|g|ml|units?|iu|meq|%)\b/i);
  return m ? `${m[1]} ${m[2].toLowerCase()}` : null;
}

/** Numbers in a string, for dose comparisons ("1,000" → "1000"). */
export function numbersIn(text: string): string[] {
  return (text.replace(/(\d),(\d{3})/g, "$1$2").match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n)));
}

/** Does `text` mention `name` as a whole word (case-insensitive)? */
export function mentions(text: string, name: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  return new RegExp(`(^|[^a-z])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(text);
}

/** "Metformin ER 500 mg" → "metformin": drop release forms and doses so names match labels and records. */
export function baseDrugName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\d.*$/, "")
    .replace(/\b(er|xr|sr|xl|dr|cr|la|odt|ec|hcl|extended[- ]release|delayed[- ]release)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Ways a summary may name a medicine written on the paper, strictest first:
 * "tiotropium (Spiriva HandiHaler) 18 mcg cap" → strict ["tiotropium (spiriva handihaler) 18 mcg cap", "tiotropium"],
 * loose ["tiotropium"]. "doxycycline hyclate 100 mg cap" → loose ["doxycycline"] (salt left off).
 */
export function drugNameVariants(name: string, generic?: string | null): { strict: string[]; loose: string[] } {
  const base = baseDrugName(name.replace(/\([^)]*\)/g, " "));
  const head = base.split(/\s+/)[0] ?? "";
  // A brand in brackets is a name too: "tiotropium-olodaterol (Stiolto Respimat)" is often written just "Stiolto Respimat".
  // Not "(home, via NC)": a bracket with a comma is a note, not a name.
  const brands = [...name.matchAll(/\(([^),]+)\)/g)].map((m) => baseDrugName(m[1])).filter((b) => b.length >= 4);
  const strict = [...new Set([name, generic, base, ...brands].filter((n): n is string => !!n?.trim()).map((n) => n.toLowerCase().trim()))];
  return { strict, loose: head.length >= 4 && !strict.includes(head) ? [head] : [] };
}

/** Synthea appends digits to names ("Franklin857"); compare names without them. */
export function plainName(s: string): string {
  return s.replace(/[0-9]/g, "").replace(/[^A-Za-z' -]/g, "").trim().toLowerCase();
}

// ── Reading level ─────────────────────────────────────────────────────────────
// Flesch-Kincaid grade level, computed in code (not by a model). Medicine names, numbers and
// units are left out: "furosemide" is unavoidable and would otherwise dominate the score.

export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

export function readingGrade(texts: string[], exclude: string[] = []): number {
  const skip = new Set(exclude.flatMap((e) => e.toLowerCase().split(/\s+/)));
  let words = 0;
  let syl = 0;
  let sentences = 0;
  for (const t of texts) {
    const parts = t.split(/[.!?]+(?:\s|$)|;\s/).map((s) => s.trim()).filter(Boolean);
    sentences += Math.max(1, parts.length);
    for (const raw of t.split(/\s+/)) {
      const w = raw.toLowerCase().replace(/[^a-z'-]/g, "");
      if (!w || skip.has(w) || /^(mg|mcg|ml|g|iu)$/.test(w)) continue;
      words++;
      syl += syllables(w);
    }
  }
  if (!words) return 0;
  return Math.max(0, +(0.39 * (words / sentences) + 11.8 * (syl / words) - 15.59).toFixed(1));
}
