// 04 · Simplify. GroundedRecord → PlainSummary at a grade-6 reading level, every bullet sourced.
//
// The summary is written in parts, each a small call that finishes well inside Nightshift's
// answer window (about 45 s): one for the hospital stay, home care and follow-ups, one for the
// warning signs, and one per few medicines. Each part sees only the lines it cites. The parts
// run side by side and are merged; a part that still fails is shown as the papers' own lines.
// When the Safety checker sends issues back, only the parts they point at are revised.

import type { AgentContext } from "./context.ts";
import { lineText, numberedLines } from "./scan.ts";
import { parseJsonObject } from "../text.ts";
import type { Bullet, GroundedRecord, Issue, Medication, PlainSummary, ScanResult } from "../types.ts";

export const MEDS_PER_PART = 5;
export const MED_TITLE = "Your medicines";
export const WARN_TITLE = "Call 911 if";

const RULES = `You rewrite part of a hospital discharge summary for the patient, in plain words at a grade-6 reading level.
Write short sentences (under 15 words). Use everyday words. Explain jargon with the term lookups.
Hard rules:
1. Every bullet lists its sources: line ids (p2:L1), lookup ids (drug:furosemide, term:BID), hospital record ids (record:3) or conflict ids (conflict:conflict-1). Use only ids that appear in the input.
2. Never change a dose, a number or a frequency. Copy each dose exactly and say how often in plain words.
3. Add no advice that isn't in the summary or the lookups.`;

const BULLET = `{"id": "b1", "text": "...", "sources": ["p2:L1", "term:BID"]}`;

type Kind = "about" | "warnings" | "meds";
const TASKS: Record<Kind, string> = {
  about: `Write these sections, leaving out any with nothing to say:
- "Why you were in the hospital" from the diagnoses.
- "What to do at home" from the restrictions and instructions.
- "Your follow-up visits": one bullet per follow-up, written as two or three very short sentences: who, then when, then why if the paper says.
  For example: "See Dr. Lee, your heart doctor. Go on Mon 11/2 at 9:00 AM. This visit checks your water pill."
questions_for_your_doctor: up to 3 short questions the patient could ask about this information.
Return JSON only, in this shape:
{"sections": [{"title": "Why you were in the hospital" | "What to do at home" | "Your follow-up visits", "bullets": [${BULLET}]}], "questions_for_your_doctor": ["..."]}`,
  warnings: `call_911_if: one item for every warning sign, citing its line. Keep who to contact exactly as the paper says
("Call 911 if…", "Go to the ER if…", "Call your surgeon if…"). When the sign sits under a heading line that says
who to contact, cite that heading line too (e.g. ["p1:L15", "p1:L16"]).
Return JSON only, in this shape:
{"call_911_if": [${BULLET}]}`,
  meds: `"${MED_TITLE}": one bullet per medicine listed here (new, changed, continued and stopped), with its dose, how often, and what it is for (from its drug lookup).
For every open conflict, add a bullet that tells the patient to check that dose with their care team before taking it, citing the conflict id and both sources.
For every hospital-record medicine marked not_on_paper, add a question for the doctor about whether to keep taking it.
med_schedule: one row per medicine here that the patient should take, from its frequency (BID = morning and night, daily = morning, PRN = as_needed).
Return JSON only, in this shape:
{"sections": [{"title": "${MED_TITLE}", "bullets": [${BULLET}]}],
 "med_schedule": [{"drug": "furosemide", "dose": "40 mg", "morning": true, "midday": false, "evening": false, "night": true, "as_needed": false, "note": "", "sources": ["p2:L1"]}],
 "questions_for_your_doctor": ["..."]}`,
};

const KEYS: Record<Kind, string> = {
  about: `"sections" (each {"title", "bullets"}) and "questions_for_your_doctor"`,
  warnings: `"call_911_if"`,
  meds: `"sections" (one titled "${MED_TITLE}"), "med_schedule" and "questions_for_your_doctor"`,
};

/** One part of the summary: what it was asked, and what came back (null when it failed). */
export interface Part {
  key: string; // about | warnings | meds1, meds2, …
  kind: Kind;
  prefix: string; // bullet ids in this part start with it (a1, w1, m1_1)
  label: string; // the card title when its lines are shown as the original text
  meds: string[]; // the medicine names this part covers
  lines: string[]; // the line ids it was given
  input: string;
  output: PlainSummary | null;
}
export interface Draft {
  summary: PlainSummary;
  parts: Part[];
}

export function planParts(record: GroundedRecord, scan: ScanResult): Part[] {
  const { lookups, hospital_record_diff, conflicts } = record;
  const terms = `Term lookups:\n${JSON.stringify(lookups.terms)}`;
  const parts: Part[] = [];
  const add = (key: string, kind: Kind, prefix: string, label: string, sources: string[], data: string[], meds: string[] = [], withHeadings = false) => {
    const lines = linesFor(scan, sources, withHeadings);
    const input = [`Original lines:\n${numberedLines(scan, new Set(lines))}`, ...data, terms].join("\n\n");
    parts.push({ key, kind, prefix, label, meds, lines, input, output: null });
  };

  const about = { diagnoses: record.diagnoses, restrictions: record.restrictions, follow_ups: record.follow_ups };
  if (about.diagnoses.length || about.restrictions.length || about.follow_ups.length) {
    // Plain lines, not a JSON record: given JSON here, the model kept echoing it back instead of writing.
    const list = (title: string, items: string[]) => (items.length ? `${title}:\n${items.map((t) => `- ${t}`).join("\n")}` : `${title}: none`);
    add("about", "about", "a", "About your stay and follow-up", [...about.diagnoses, ...about.restrictions, ...about.follow_ups].map((x) => x.source), [
      list("Diagnoses", about.diagnoses.map((d) => `${d.text} (${d.source})`)),
      list("Instructions for home", about.restrictions.map((r) => `${r.text} (${r.source})`)),
      list("Follow-up visits", about.follow_ups.map((f) => `${f.who}, ${f.when} (${f.source})`)),
    ]);
  }
  if (record.warning_signs.length) {
    add("warnings", "warnings", "w", WARN_TITLE, record.warning_signs.map((w) => w.source), [`Warning signs:\n${JSON.stringify(record.warning_signs)}`], [], true);
  }
  // Medicines in small groups. Conflicts and hospital-record-only medicines go with the group
  // that has that drug, or with the first group.
  const groups: Medication[][] = [];
  for (let i = 0; i < record.medications.length; i += MEDS_PER_PART) groups.push(record.medications.slice(i, i + MEDS_PER_PART));
  if (!groups.length && hospital_record_diff.some((d) => d.change === "not_on_paper")) groups.push([]);
  const groupOf = (drug: string) => Math.max(0, groups.findIndex((g) => g.some((m) => sameDrug(m.name, drug, record))));
  groups.forEach((meds, g) => {
    const names = meds.map((m) => m.name);
    const mine = (drug: string) => groupOf(drug) === g;
    const diff = hospital_record_diff.filter((d) => mine(d.drug));
    const open = conflicts.filter((c) => mine(c.drug));
    // Its own card title: the page swaps a section for a fallback of the same title, and other groups may have worked.
    add(`meds${g + 1}`, "meds", `m${g + 1}_`, "Medicines we couldn't rewrite", meds.map((m) => m.source), [
      `Medicines:\n${JSON.stringify(meds)}`,
      `Drug lookups:\n${JSON.stringify(lookups.drugs.filter((d) => names.some((n) => sameDrug(n, d.name, record) || sameDrug(n, d.generic, record))))}`,
      `Hospital record comparison:\n${JSON.stringify(diff)}`,
      `Open conflicts (must be flagged):\n${open.length ? JSON.stringify(open) : "none"}`,
    ], names);
  });
  return parts;
}

export async function simplify(ctx: AgentContext, record: GroundedRecord, scan: ScanResult): Promise<Draft> {
  const parts = planParts(record, scan);
  await Promise.all(parts.map((p) => writePart(ctx, p, p.input, 1, "draft")));
  // A part that failed both tries gets one more round now: the Safety checker can't flag a part
  // that isn't there, so nothing later would ask for it again.
  await Promise.all(parts.filter((p) => !p.output).map((p) => writePart(ctx, p, p.input, 1, "draft-again")));
  return finish(ctx, record, scan, parts, "draft");
}

/** Rewrites only the parts the issues point at; the rest stay as they were checked. */
export async function revise(ctx: AgentContext, record: GroundedRecord, scan: ScanResult, draft: Draft, issues: Issue[], attempt: number): Promise<Draft> {
  const parts = draft.parts.map((p) => ({ ...p }));
  const todo = new Map<Part, Issue[]>();
  for (const issue of issues) for (const p of partsFor(issue, parts)) todo.set(p, [...(todo.get(p) ?? []), issue]);
  if (!todo.size) return draft;
  await Promise.all(
    [...todo].map(([p, mine]) => {
      // A part that failed before is simply written again from its own input.
      const input = p.output
        ? `${p.input}\n\nYour previous answer:\n${JSON.stringify(p.output)}\n\nThe safety checker found these problems. Fix every one, keep everything else as it is, and return your COMPLETE answer in the same shape, not just the changes:\n${mine
            .map((i) => `- [${i.type}]${i.bullet ? ` bullet ${i.bullet}` : ""}${i.section ? ` in "${i.section}"` : ""}: ${i.fix}`)
            .join("\n")}\n\nOutput only the corrected JSON object in the shape given above. No notes, no explanation, no other keys.`
        : p.input;
      return writePart(ctx, p, input, attempt + 1, `revision${attempt}`, p.output);
    }),
  );
  return finish(ctx, record, scan, parts, `revision${attempt}`, { issues });
}

/** Which parts an issue belongs to: the part that wrote the bullet, else by section and medicine name. */
function partsFor(issue: Issue, parts: Part[]): Part[] {
  if (issue.bullet) {
    const owner = parts.find((p) => p.output && [...p.output.sections.flatMap((s) => s.bullets), ...p.output.call_911_if].some((b) => b.id === issue.bullet));
    if (owner) return [owner];
  }
  if (issue.section === WARN_TITLE) return parts.filter((p) => p.kind === "warnings");
  if (issue.section && /medicine|medication/i.test(issue.section)) {
    const meds = parts.filter((p) => p.kind === "meds");
    const named = meds.filter((p) => p.meds.some((m) => issue.fix.toLowerCase().includes(m.toLowerCase())));
    if (named.length) return named;
    return issue.type === "too_complex" ? meds : meds.slice(0, 1);
  }
  return parts.filter((p) => p.kind === "about");
}

/** One part's call; an unusable answer (cut off, empty, or the wrong shape) is saved and tried once more. */
async function writePart(ctx: AgentContext, part: Part, input: string, attempt: number, label: string, keep: PlainSummary | null = null): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      // A retry adds a reminder: the usual bad answer repeats the input data or the notes back as JSON.
      const nudge = i > 1 ? [{ role: "user" as const, content: `Do not repeat the input. Reply with only your plain-language JSON, with the keys ${KEYS[part.kind]}.` }] : [];
      const res = await ctx.llm({ agent: "simplify", route: "meterless/text", json: true, maxTokens: 4000, attempt, messages: [{ role: "system", content: `${RULES}\n${TASKS[part.kind]}` }, { role: "user", content: input }, ...nudge] });
      try {
        part.output = normalise(parseJsonObject(res.content), part);
        return;
      } catch (err) {
        ctx.save("simplify", `${label}-${part.key}-unusable${i}`, { output: { error: (err as Error).message, finish: res.finishReason, raw: res.content } });
        throw err;
      }
    } catch (err) {
      if (i < 2) {
        ctx.say("simplify", "simplify", "info", `My ${describePart(part)} was unusable (${(err as Error).message.slice(0, 100)}); writing it again.`);
        continue;
      }
      // Keep the last good version of this part, if there was one.
      part.output = keep;
      ctx.say("simplify", "orchestrator", "fallback", `Couldn't write ${describePart(part)} (${(err as Error).message.slice(0, 100)}).${keep ? " Keeping the previous version." : ""}`);
      return;
    }
  }
}

function describePart(p: Part): string {
  return p.kind === "meds" ? `medicines part (${p.meds.length ? p.meds.join(", ") : "hospital record"})` : p.kind === "warnings" ? "warning signs" : "stay and follow-up part";
}

/** Merges the parts. Nothing written at all is an error; the caller shows the original papers. */
function finish(ctx: AgentContext, record: GroundedRecord, scan: ScanResult, parts: Part[], label: string, extra: object = {}): Draft {
  if (!parts.some((p) => p.output)) throw new Error(parts.length ? "no part of the summary could be written" : "nothing to summarise");
  const summary = merge(record, scan, parts);
  ctx.save("simplify", label, { input: { parts: parts.map((p) => ({ key: p.key, lines: p.lines.length, written: !!p.output })), ...extra }, output: summary });
  return { summary, parts };
}

export function merge(record: GroundedRecord, scan: ScanResult, parts: Part[]): PlainSummary {
  const done = parts.filter((p) => p.output).map((p) => p.output!);
  const sections = new Map<string, Bullet[]>();
  for (const s of done.flatMap((o) => o.sections)) sections.set(s.title, [...(sections.get(s.title) ?? []), ...s.bullets]);
  const warnings = parts.find((p) => p.kind === "warnings");
  return {
    sections: [...sections].map(([title, bullets]) => ({ title, bullets })),
    med_schedule: done.flatMap((o) => o.med_schedule),
    // If the warning signs couldn't be rewritten, the box still lists them, in the papers' own words.
    call_911_if: warnings?.output ? warnings.output.call_911_if : verbatimWarnings(record, scan),
    questions_for_your_doctor: [...new Set(done.flatMap((o) => o.questions_for_your_doctor))],
  };
}

/** The warning signs as the source lines say them, so a heading like "Call your doctor same day for:" stays with its signs. */
export function verbatimWarnings(record: GroundedRecord, scan: ScanResult): Bullet[] {
  return record.warning_signs.map((w, i) => ({ id: `w${i + 1}`, text: lineText(scan, w.source) ?? w.text, sources: [w.source] }));
}

/** The parts that never got written, as original lines for "Ask your care team". Warning signs are always shown. */
export function unwritten(draft: Draft): { title: string; lines: string[] }[] {
  const out = new Map<string, string[]>();
  for (const p of draft.parts) if (!p.output && p.kind !== "warnings") out.set(p.label, [...(out.get(p.label) ?? []), ...p.lines]);
  return [...out].map(([title, lines]) => ({ title, lines }));
}

/** The line ids behind some sources. For warning signs, the two lines above each one too (a "Call 911 if:" heading). */
function linesFor(scan: ScanResult, sources: string[], withHeadings: boolean): string[] {
  const all = scan.pages.flatMap((p) => p.lines.map((l) => l.id));
  const ids = new Set<string>();
  for (const s of sources) {
    const m = s.match(/^p(\d+):L(\d+)(?:-L?(\d+))?$/);
    if (!m) continue;
    const from = Number(m[2]) - (withHeadings ? 2 : 0);
    const to = m[3] ? Number(m[3]) : Number(m[2]);
    for (let n = Math.max(1, from); n <= to; n++) ids.add(`p${m[1]}:L${n}`);
  }
  return all.filter((id) => ids.has(id));
}

function sameDrug(a: string, b: string, record: GroundedRecord): boolean {
  const norm = (s: string) => s.toLowerCase().trim();
  if (norm(a) === norm(b)) return true;
  const generic = (s: string) => record.lookups.drugs.find((d) => norm(d.name) === norm(s))?.generic ?? s;
  const [x, y] = [norm(generic(a)), norm(generic(b))];
  return x === y || x.split(/\W+/)[0] === y.split(/\W+/)[0];
}

const isPlaceholder = (t: string) => /^[.\s…]*$/.test(t);

function normalise(input: any, part: Part): PlainSummary {
  // Models sometimes wrap the answer: {"summary": {...}} or {"revised_summary": {...}}.
  const want = part.kind === "warnings" ? "call_911_if" : "sections";
  const raw = Array.isArray(input?.[want]) ? input : Object.values(input ?? {}).find((v: any) => Array.isArray(v?.[want])) ?? input;
  const arr = (x: unknown) => (Array.isArray(x) ? x : []);
  const srcs = (x: unknown) => arr(x).map((s) => String(s).trim()).filter(Boolean);
  let n = 0;
  const id = () => `${part.prefix}${++n}`;
  const bullets = (x: unknown) =>
    arr(x)
      .map((b: any) => ({ id: "", text: String(b?.text ?? "").trim(), sources: srcs(b?.sources) }))
      .filter((b) => !isPlaceholder(b.text))
      .map((b) => ({ ...b, id: id() }));
  const out: PlainSummary = {
    sections:
      part.kind === "warnings"
        ? []
        : arr(raw?.sections)
            .map((s: any) => ({ title: part.kind === "meds" ? MED_TITLE : String(s?.title ?? "").trim(), bullets: bullets(s?.bullets) }))
            .filter((s) => s.title && s.bullets.length),
    med_schedule:
      part.kind !== "meds"
        ? []
        : arr(raw?.med_schedule)
            .map((m: any) => ({
              drug: String(m?.drug ?? ""),
              dose: String(m?.dose ?? ""),
              morning: !!m?.morning,
              midday: !!m?.midday,
              evening: !!m?.evening,
              night: !!m?.night,
              as_needed: !!m?.as_needed,
              note: m?.note ? String(m.note) : undefined,
              sources: srcs(m?.sources),
            }))
            .filter((m) => m.drug),
    call_911_if: part.kind === "warnings" ? bullets(raw?.call_911_if) : [],
    questions_for_your_doctor: arr(raw?.questions_for_your_doctor).map(String).filter((q) => !isPlaceholder(q)),
  };
  if (part.kind === "warnings" ? !out.call_911_if.length : !out.sections.length && !(part.kind === "meds" && !part.meds.length && out.questions_for_your_doctor.length)) {
    throw new Error(part.kind === "warnings" ? "no warning signs written" : "no sections written");
  }
  return out;
}
