// 04 · Simplify. GroundedRecord → PlainSummary at a grade-6 reading level, every bullet sourced.
//
// It writes a first draft, then revises it whenever the Safety checker sends issues back.

import type { AgentContext } from "./context.ts";
import { numberedLines } from "./scan.ts";
import { parseJsonObject } from "../text.ts";
import type { GroundedRecord, Issue, PlainSummary, ScanResult } from "../types.ts";

const SHAPE = `{
  "sections": [{"title": "Why you were in the hospital" | "Your medicines" | "What to do at home" | "Your follow-up visits",
                "bullets": [{"id": "b1", "text": "...", "sources": ["p2:L1", "drug:furosemide"]}]}],
  "med_schedule": [{"drug": "furosemide", "dose": "40 mg", "morning": true, "midday": false, "evening": false, "night": true, "as_needed": false, "note": "", "sources": ["p2:L1"]}],
  "call_911_if": [{"id": "w1", "text": "...", "sources": ["p3:L7"]}],
  "questions_for_your_doctor": ["..."]
}`;

const SYSTEM = `You rewrite a hospital discharge summary for the patient, in plain words at a grade-6 reading level.
Write short sentences (under 15 words). Use everyday words. Explain jargon with the term lookups.
Hard rules:
1. Every bullet lists its sources: line ids (p2:L1), lookup ids (drug:furosemide, term:BID), hospital record ids (record:3) or conflict ids (conflict:conflict-1). Use only ids that appear in the input.
2. Never change a dose, a number or a frequency. Copy each medicine's dose exactly and say how often in plain words.
3. Add no advice that isn't in the summary or the lookups.
4. "Your medicines": one bullet per medicine (new, changed, continued and stopped), with its dose, how often, and what it is for (from its drug lookup).
   For every open conflict, add a bullet that tells the patient to check that dose with their care team before taking it, citing the conflict id and both sources.
   For every hospital-record medicine marked not_on_paper, add a question for the doctor about whether to keep taking it.
5. call_911_if: one item for every warning sign, citing its line. Keep who to contact exactly as the paper says
   ("Call 911 if…", "Go to the ER if…", "Call your surgeon if…"). When the sign sits under a heading line that says
   who to contact, cite that heading line too (e.g. ["p1:L15", "p1:L16"]).
6. med_schedule: one row per medicine the patient should take, from its frequency (BID = morning and night, daily = morning, PRN = as_needed).
Return JSON only, in this shape:
${SHAPE}`;

export function simplifyInput(record: GroundedRecord, scan: ScanResult): string {
  const { lookups, hospital_record_diff, conflicts, ...rest } = record;
  return [
    `Original lines:\n${numberedLines(scan)}`,
    `Extracted record:\n${JSON.stringify({ diagnoses: rest.diagnoses, medications: rest.medications, follow_ups: rest.follow_ups, warning_signs: rest.warning_signs, restrictions: rest.restrictions })}`,
    `Drug lookups:\n${JSON.stringify(lookups.drugs)}`,
    `Term lookups:\n${JSON.stringify(lookups.terms)}`,
    `Hospital record comparison:\n${JSON.stringify(hospital_record_diff)}`,
    `Open conflicts (must be flagged):\n${conflicts.length ? JSON.stringify(conflicts) : "none"}`,
  ].join("\n\n");
}

export async function simplify(ctx: AgentContext, record: GroundedRecord, scan: ScanResult): Promise<PlainSummary> {
  const input = simplifyInput(record, scan);
  const summary = await write(ctx, input, 1, "draft");
  ctx.save("simplify", "draft", { input, output: summary });
  return summary;
}

/** One Simplify call; an unusable answer (cut off, or the wrong shape) is saved and tried once more. */
async function write(ctx: AgentContext, input: string, attempt: number, label: string): Promise<PlainSummary> {
  for (let i = 1; ; i++) {
    const res = await ctx.llm({ agent: "simplify", route: "meterless/text", json: true, maxTokens: 8000, attempt, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: input }] });
    try {
      return normalise(parseJsonObject(res.content));
    } catch (err) {
      ctx.save("simplify", `${label}-unusable${i}`, { output: { error: (err as Error).message, finish: res.finishReason, raw: res.content } });
      if (i >= 2) throw err;
      ctx.say("simplify", "simplify", "info", `My answer was unusable (${(err as Error).message}${res.finishReason === "length" ? ", cut off" : ""}); writing it again.`);
    }
  }
}

export async function revise(ctx: AgentContext, record: GroundedRecord, scan: ScanResult, previous: PlainSummary, issues: Issue[], attempt: number): Promise<PlainSummary> {
  const input = `${simplifyInput(record, scan)}\n\nYour previous summary:\n${JSON.stringify(previous)}\n\nThe safety checker found these problems. Fix every one, keep everything else as it is, and return the COMPLETE summary (every section, call_911_if, med_schedule and questions), not just the changes:\n${issues
    .map((i) => `- [${i.type}]${i.bullet ? ` bullet ${i.bullet}` : ""}${i.section ? ` in "${i.section}"` : ""}: ${i.fix}`)
    .join("\n")}`;
  const summary = await write(ctx, input, attempt + 1, `revision${attempt}`);
  ctx.save("simplify", `revision${attempt}`, { input: { issues }, output: summary });
  return summary;
}

function normalise(input: any): PlainSummary {
  // Models sometimes wrap the answer: {"summary": {...}} or {"revised_summary": {...}}.
  const raw = Array.isArray(input?.sections) ? input : Object.values(input ?? {}).find((v: any) => Array.isArray(v?.sections)) ?? input;
  if (!Array.isArray(raw?.sections) || !raw.sections.length) throw new Error("Simplify returned a summary with no sections");
  const arr = (x: unknown) => (Array.isArray(x) ? x : []);
  const srcs = (x: unknown) => arr(x).map((s) => String(s).trim()).filter(Boolean);
  let n = 0;
  return {
    sections: arr(raw?.sections).map((s: any) => ({
      title: String(s?.title ?? "").trim(),
      bullets: arr(s?.bullets)
        .map((b: any) => ({ id: String(b?.id ?? `b${++n}`), text: String(b?.text ?? "").trim(), sources: srcs(b?.sources) }))
        .filter((b) => b.text),
    })),
    med_schedule: arr(raw?.med_schedule).map((m: any) => ({
      drug: String(m?.drug ?? ""),
      dose: String(m?.dose ?? ""),
      morning: !!m?.morning,
      midday: !!m?.midday,
      evening: !!m?.evening,
      night: !!m?.night,
      as_needed: !!m?.as_needed,
      note: m?.note ? String(m.note) : undefined,
      sources: srcs(m?.sources),
    })),
    call_911_if: arr(raw?.call_911_if)
      .map((w: any, i: number) => ({ id: String(w?.id ?? `w${i + 1}`), text: String(w?.text ?? "").trim(), sources: srcs(w?.sources) }))
      .filter((w) => w.text),
    questions_for_your_doctor: arr(raw?.questions_for_your_doctor).map(String).filter(Boolean),
  };
}
