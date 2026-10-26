// 05 · Safety checker. Checks the PlainSummary against the original lines before anything
// reaches the patient. Two layers:
//
//   code   sources exist, every dose matches the original line, every medicine and warning
//          sign is covered, every open H-MEM conflict is flagged, reading level (a formula,
//          not a model). If the extracted dose doesn't match its own source line, the problem
//          is upstream: that issue is routed to Extract, not Simplify.
//   model  a separate call on the judge route reads each bullet next to its source text and
//          flags changed meaning or added advice.

import type { AgentContext } from "./context.ts";
import { lineIds, lineText } from "./scan.ts";
import { mentions, numbersIn, parseJsonObject, readingGrade } from "../text.ts";
import type { Bullet, CheckReport, GroundedRecord, Issue, PlainSummary, ScanResult } from "../types.ts";

// Simplify aims for grade 6; a section fails above this. Medicine sections run a little higher
// (purposes like "lowers blood pressure"), so the hard line sits at 8.
export const READING_GRADE_MAX = Number(process.env.READING_GRADE_MAX ?? 8);
// meterless/judge is the natural route, but with only the NVIDIA provider set up Nightshift sent
// it to an endpoint the account can't use (404). The checker is still a separate call, with its
// own scope and instructions, so it never sees Simplify's reasoning.
const SAFETY_ROUTE = process.env.SAFETY_ROUTE ?? "meterless/text";

export async function check(ctx: AgentContext, summary: PlainSummary, record: GroundedRecord, scan: ScanResult, attempt: number): Promise<CheckReport> {
  const issues: Issue[] = [...codeChecks(summary, record, scan)];
  const levels = readingLevels(summary, record);
  for (const [section, grade] of Object.entries(levels)) {
    if (grade > READING_GRADE_MAX) {
      issues.push({ bullet: null, section, type: "too_complex", fix: `Reading level is grade ${grade}; aim for grade 6: shorter sentences, simpler words.`, by: "code" });
    }
  }
  // The meaning check is a model call: retry once, and if Nightshift still can't serve it,
  // say so in the report rather than failing the job (the code checks above still apply).
  let modelChecked = true;
  for (let i = 1; ; i++) {
    try {
      issues.push(...(await modelCheck(ctx, summary, record, scan, attempt)));
      break;
    } catch (err) {
      if (i < 2) continue;
      modelChecked = false;
      ctx.say("safety_checker", "orchestrator", "info", `The AI meaning check couldn't run (${(err as Error).message.slice(0, 100)}). Code checks still applied.`);
      break;
    }
  }
  const all = Object.values(levels);
  const report: CheckReport = {
    pass: issues.length === 0,
    model_checked: modelChecked,
    reading_level: all.length ? Math.max(...all) : 0,
    reading_level_by_section: levels,
    issues,
  };
  ctx.save("safety_checker", `check${attempt}`, { input: { summary }, output: report });
  return report;
}

export function codeChecks(summary: PlainSummary, record: GroundedRecord, scan: ScanResult): Issue[] {
  const issues: Issue[] = [];
  const lines = lineIds(scan);
  const lookupIds = new Set([...record.lookups.drugs.map((d) => d.id), ...record.lookups.terms.map((t) => t.id), ...record.conflicts.map((c) => c.id)]);
  const validSource = (s: string) => lines.has(s.split("-")[0]) || lookupIds.has(s) || /^record:\d+$/.test(s);

  const bullets: (Bullet & { section: string })[] = [
    ...summary.sections.flatMap((s) => s.bullets.map((b) => ({ ...b, section: s.title }))),
    ...summary.call_911_if.map((b) => ({ ...b, section: "Call 911 if" })),
  ];

  // 1. Nothing reaches the patient without a source.
  for (const b of bullets) {
    if (!b.sources.length) issues.push({ bullet: b.id, section: b.section, type: "missing_source", fix: "Add the line ids this bullet comes from.", by: "code" });
    const bad = b.sources.filter((s) => !validSource(s));
    if (bad.length) issues.push({ bullet: b.id, section: b.section, type: "bad_source", fix: `These sources don't exist: ${bad.join(", ")}. Cite only ids from the input.`, by: "code" });
  }

  // 2. Every medicine is covered, with its exact dose.
  const medSection = summary.sections.find((s) => /medicine|medication/i.test(s.title));
  const medBullets = medSection?.bullets ?? [];
  for (const med of record.medications) {
    const generic = record.lookups.drugs.find((d) => d.name.toLowerCase() === med.name.toLowerCase())?.generic;
    const names = [med.name, generic].filter(Boolean) as string[];
    const original = lineText(scan, med.source) ?? "";
    const want = numbersIn(med.dose);

    // The extracted dose must be on the original line; if not, Extract misread it.
    if (want.length && !want.every((n) => numbersIn(original).includes(n))) {
      issues.push({ bullet: null, section: med.source, type: "extract_mismatch", fix: `Extracted ${med.name} dose "${med.dose}" is not on line ${med.source}: "${original}". Re-read the line.`, by: "code" });
      continue;
    }
    const about = medBullets.filter((b) => names.some((n) => mentions(b.text, n)));
    if (!about.length) {
      issues.push({ bullet: null, section: medSection?.title ?? "Your medicines", type: "missing_medication", fix: `Add a bullet for ${med.name} ${med.dose} ${med.freq} (${med.status}), citing ${med.source}.`, by: "code" });
      continue;
    }
    if (med.status !== "stopped" && want.length && !about.some((b) => want.every((n) => numbersIn(b.text).includes(n)))) {
      issues.push({ bullet: about[0].id, section: medSection!.title, type: "dose_changed", fix: `The dose for ${med.name} must be exactly "${med.dose}" (line ${med.source}).`, by: "code" });
    }
  }

  // 3. Every warning sign is in "Call 911 if".
  for (const w of record.warning_signs) {
    const key = w.source.split("-")[0];
    if (!summary.call_911_if.some((c) => c.sources.some((s) => s.split("-")[0] === key))) {
      issues.push({ bullet: null, section: "Call 911 if", type: "missing_warning", fix: `Add "${w.text}" to call_911_if, citing ${w.source}.`, by: "code" });
    }
  }

  // 4. Every open conflict is flagged to the patient.
  for (const c of record.conflicts) {
    if (!bullets.some((b) => b.sources.includes(c.id))) {
      issues.push({ bullet: null, section: medSection?.title ?? "Your medicines", type: "conflict_not_flagged", fix: `Add a bullet telling the patient to check their ${c.drug} dose with their care team before taking it (${c.detail}). Cite ${c.id}.`, by: "code" });
    }
  }
  return issues;
}

export function readingLevels(summary: PlainSummary, record: GroundedRecord): Record<string, number> {
  const exclude = [...record.medications.map((m) => m.name), ...record.lookups.drugs.map((d) => d.generic), ...record.lookups.terms.map((t) => t.term)];
  const out: Record<string, number> = {};
  for (const s of summary.sections) if (s.bullets.length) out[s.title] = readingGrade(s.bullets.map((b) => b.text), exclude);
  if (summary.call_911_if.length) out["Call 911 if"] = readingGrade(summary.call_911_if.map((b) => b.text), exclude);
  return out;
}

async function modelCheck(ctx: AgentContext, summary: PlainSummary, record: GroundedRecord, scan: ScanResult, attempt: number): Promise<Issue[]> {
  const sourceText = (s: string) =>
    lineText(scan, s) ??
    JSON.stringify(record.lookups.drugs.find((d) => d.id === s) ?? record.lookups.terms.find((t) => t.id === s) ?? record.conflicts.find((c) => c.id === s) ?? s);
  const items = [...summary.sections.flatMap((s) => s.bullets.map((b) => ({ ...b, section: s.title }))), ...summary.call_911_if.map((b) => ({ ...b, section: "Call 911 if" }))].map((b) => ({
    id: b.id,
    section: b.section,
    text: b.text,
    sources: Object.fromEntries(b.sources.map((s) => [s, sourceText(s)])),
  }));
  const res = await ctx.llm({
    agent: "safety_checker",
    route: SAFETY_ROUTE,
    json: true,
    maxTokens: 3000,
    attempt,
    messages: [
      {
        role: "system",
        content: `You are a patient-safety checker. Each bullet of a plain-language discharge summary is shown with the source text it cites.
Flag a bullet only when:
- dose_changed: a dose, number, frequency or timing differs from its source;
- added_advice: it tells the patient to do something its sources don't say;
- missing_warning: it weakens or leaves out part of a warning sign written in the patient's papers (a line id source).
  FDA drug-label warnings (drug: sources) are optional background: never require them.
Plain-language rewording, explaining jargon, and the purpose of a drug from its drug lookup are fine.
A bullet citing a conflict id MUST tell the patient to check that dose with their care team: that is required, not added advice.
Suggesting a question for the doctor is fine.
Return JSON only: {"issues": [{"bullet": "b3", "type": "dose_changed|added_advice|missing_warning", "fix": "one sentence"}]} (empty list if all bullets are faithful).`,
      },
      { role: "user", content: JSON.stringify(items) },
    ],
  });
  const out = parseJsonObject<{ issues: { bullet: string; type: string; fix: string }[] }>(res.content);
  const allowed = new Set(["dose_changed", "added_advice", "missing_warning"]);
  return (out.issues ?? [])
    .filter((i) => allowed.has(i.type) && items.some((b) => b.id === i.bullet))
    .map((i) => ({ bullet: i.bullet, section: items.find((b) => b.id === i.bullet)!.section, type: i.type as Issue["type"], fix: i.fix, by: "model" as const }));
}
