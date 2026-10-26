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
import { drugNameVariants, mentions, numbersIn, parseJsonObject, readingGrade } from "../text.ts";
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
    const names = drugNameVariants(med.name, generic);
    const original = lineText(scan, med.source) ?? "";
    const want = numbersIn(med.dose);

    // The extracted dose must be on the original line; if not, Extract misread it.
    if (want.length && !want.every((n) => numbersIn(original).includes(n))) {
      issues.push({ bullet: null, section: med.source, type: "extract_mismatch", fix: `Extracted ${med.name} dose "${med.dose}" is not on line ${med.source}: "${original}". Re-read the line.`, by: "code" });
      continue;
    }
    // The main drug word ("doxycycline" for "doxycycline hyclate 100 mg cap") only when no fuller name matches.
    const by = (list: string[]) => medBullets.filter((b) => list.some((n) => mentions(b.text, n)));
    const strict = by(names.strict);
    const about = strict.length ? strict : by(names.loose);
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

/**
 * The checker model sometimes files an issue and then concludes it's fine ("…Source says exactly that. Good.").
 * Those are dropped; anything that still asks for a change, or hedges with "but"/"however", is kept.
 */
export function selfCleared(fix: string): boolean {
  const t = fix.trim();
  // A verdict at the end wins over any hedge before it: "…but the label warns…; no dose change detected."
  if (/\bno (dose |meaning )?(change|issue|problem|error)s? (detected|found|needed)[.!]?\s*$/i.test(t)) return true;
  if (/\b(however|but|although|change|remove|add|replace|should|must|missing|instead|wrong|incorrect|not (in|on|stated|mentioned|said))\b/i.test(t)) return false;
  return /(\b(consistent|correct|fine|good|ok|okay|accurate|faithful|matches|match)|no (issue|problem|change)s? (needed|here)?)[.!]?\s*$/i.test(t);
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
The "Warning signs" section lists EVERY warning sign in the papers, each with who to contact as its source says. A bullet there that says
"Call your doctor same day if…" (or nurse, surgeon, clinic) because its source says so is correct: never flag it for not saying 911.
Flag it only if it changes who to contact or how soon compared with its source.
Suggesting a question for the doctor is fine.
Return JSON only: {"issues": [{"bullet": "b3", "type": "dose_changed|added_advice|missing_warning", "fix": "one sentence"}]} (empty list if all bullets are faithful).`,
      },
      // Shown as "Warning signs": under a "Call 911 if" label the checker kept flagging the papers' own "call your doctor same day" signs.
      { role: "user", content: JSON.stringify(items.map((b) => (b.section === "Call 911 if" ? { ...b, section: "Warning signs" } : b))) },
    ],
  });
  const out = parseJsonObject<{ issues: { bullet: string; type: string; fix: string }[] }>(res.content);
  const allowed = new Set(["dose_changed", "added_advice", "missing_warning"]);
  const flagged = (out.issues ?? [])
    .filter((i) => allowed.has(i.type) && items.some((b) => b.id === i.bullet) && !selfCleared(String(i.fix ?? "")))
    .map((i) => ({ bullet: i.bullet, section: items.find((b) => b.id === i.bullet)!.section, type: i.type as Issue["type"], fix: i.fix, by: "model" as const }));
  return flagged.length ? confirm(ctx, flagged, items, attempt) : [];
}

/**
 * Second opinion. The whole-summary check above is noisy on a long summary (one run flagged 1
 * bullet, the next 12, with the summary unchanged), and every flag costs a rewrite. Each flagged
 * bullet is looked at again on its own, next to its sources; only flags this confirms are kept.
 * If the second look can't run or is unclear, the flag stands.
 */
async function confirm(ctx: AgentContext, flagged: Issue[], items: { id: string; section: string; text: string; sources: Record<string, string> }[], attempt: number): Promise<Issue[]> {
  const cases = flagged.map((i, n) => ({ case: n + 1, problem: `${i.type}: ${i.fix}`, ...items.find((b) => b.id === i.bullet)!, section: undefined }));
  try {
    const res = await ctx.llm({
      agent: "safety_checker",
      route: SAFETY_ROUTE,
      json: true,
      maxTokens: 1500,
      attempt,
      messages: [
        {
          role: "system",
          content: `Another checker says each bullet below has a problem. Look at each bullet next to the source text it cites, and decide if the problem is real.
Real: the bullet changes a dose, number or timing; tells the patient to do something the sources don't say; or weakens or drops part of a warning sign.
Not real: plain rewording, explaining a term, a drug's purpose from its drug lookup, or keeping who to contact as the source says.
Return JSON only: {"verdicts": [{"case": 1, "real": true|false}]}`,
        },
        { role: "user", content: JSON.stringify(cases) },
      ],
    });
    const verdicts = parseJsonObject<{ verdicts: { case: number; real: boolean }[] }>(res.content).verdicts ?? [];
    const kept = flagged.filter((_, n) => verdicts.find((v) => v.case === n + 1)?.real !== false);
    if (kept.length < flagged.length) ctx.say("safety_checker", "safety_checker", "info", `Second look: ${flagged.length - kept.length} of ${flagged.length} flag(s) weren't real problems.`);
    return kept;
  } catch {
    return flagged;
  }
}
