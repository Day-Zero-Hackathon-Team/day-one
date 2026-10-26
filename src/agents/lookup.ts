// 03 · Lookup. Grounds the record in Zetaris, then in patient memory (H-MEM).
//
//   plan       model: brand names → generic names, which abbreviations to look up
//   zetaris    code: the fixed lookups (drug labels, terms, patient by birth date, medication history)
//   interpret  model: label text → a plain purpose, a few side effects, the key warning
//   ground     code + H-MEM: compare the paper with the hospital record; conflicts that the
//              paper doesn't explain stay open for the Safety checker
//
// A medicine Zetaris doesn't know is often a misread name, so it goes back to Extract as a
// request rather than being silently dropped.

import type { AgentContext } from "./context.ts";
import type { PatientMemory } from "../memory.ts";
import { baseDrugName, parseJsonObject, doseOf, mentions, plainName } from "../text.ts";
import { lookupAll, patientMeds, type Row } from "../zetaris.ts";
import type { DischargeRecord, DrugLookup, GroundedRecord, RecordDiff, TermLookup } from "../types.ts";

export interface LookupResult {
  drugs: DrugLookup[];
  terms: TermLookup[];
  generics: Record<string, string>; // name as written → generic
  notFound: { name: string; source: string }[];
  patient: { id: string; label: string; how: string } | null;
  recordMeds: Row[];
}

/**
 * `unresolved`: names a previous attempt couldn't find, which Extract has since confirmed are
 * read correctly. The plan is then asked for their active ingredient (a brand like Tylenol).
 */
export async function lookup(ctx: AgentContext, record: DischargeRecord, unresolved: string[] = []): Promise<LookupResult> {
  // 1. Plan which lookups to make.
  const planInput = {
    medications: record.medications.map((m) => m.name),
    unknown_terms: record.unknown_terms,
  };
  const ask = (retry: boolean) => ctx.llm({
    agent: "lookup",
    route: "meterless/text",
    json: true,
    maxTokens: 1500,
    messages: [
      {
        role: "system",
        content: `You plan database lookups for medicines and abbreviations from a discharge summary.
For each medicine, give its generic name in lower case (brand → generic, e.g. Lasix → furosemide; keep salt forms that are part of the usual name, e.g. "metoprolol succinate").
For terms, list the abbreviations and jargon to look up, as written (BID, PRN, CHF...). Also add any abbreviation that appears inside a medicine's frequency.
Return JSON only: {"drugs": [{"as_written": "Lasix", "generic": "furosemide"}], "terms": ["BID"]}${
          unresolved.length
            ? `
Last time these names were not found in the drug reference, and the discharge paper confirms them as written: ${unresolved.join(", ")}. They are probably brand names: give each one's active ingredient as its generic name (e.g. Tylenol → acetaminophen).`
            : ""
        }`,
      },
      { role: "user", content: JSON.stringify({ ...planInput, frequencies: record.medications.map((m) => m.freq) }) },
      ...(retry ? [{ role: "user" as const, content: 'Reply with only the JSON object {"drugs": [...], "terms": [...]}. Keep it short: one entry per medicine, terms as written.' }] : []),
    ],
  });
  // A cut-off plan is asked once more; if that fails too, every medicine is looked up by its own
  // name and only Extract's terms are used, rather than failing the whole job.
  type Plan = { drugs: { as_written: string; generic: string }[]; terms: string[] };
  let plan: Plan = { drugs: [], terms: [] };
  for (let i = 1; i <= 2; i++) {
    try {
      plan = parseJsonObject<Plan>((await ask(i > 1)).content);
      break;
    } catch (err) {
      ctx.say("lookup", "lookup", "info", i < 2 ? `My lookup plan was unusable (${(err as Error).message.slice(0, 60)}); planning again.` : "Planning failed twice; looking medicines up by the names on the paper.");
    }
  }
  const generics: Record<string, string> = {};
  for (const d of plan.drugs ?? []) if (d?.as_written && d?.generic) generics[d.as_written.toLowerCase()] = baseDrugName(d.generic) || d.generic.toLowerCase().trim();
  for (const m of record.medications) generics[m.name.toLowerCase()] ??= generics[baseDrugName(m.name)] ?? baseDrugName(m.name);
  const terms = [...new Set([...(plan.terms ?? []), ...record.unknown_terms])];
  ctx.say("lookup", "lookup", "info", `Looking up ${Object.keys(generics).length} medicines and ${terms.length} terms in Zetaris.`);

  // 2. Zetaris: labels, terms and candidate patients in one round trip.
  const z = await lookupAll({ drugs: [...Object.values(generics), ...Object.keys(generics)], terms, birthdate: record.patient.birthdate });
  ctx.save("lookup", "zetaris", { input: { generics, terms, birthdate: record.patient.birthdate }, output: { drugs: z.drugs.map((d) => d.generic_name), terms: z.terms, patients: z.patients } });

  // 3. Match the patient: same birth date and the same name once Synthea's digits are removed.
  let patient: LookupResult["patient"] = null;
  let recordMeds: Row[] = [];
  if (record.patient.name && z.patients.length) {
    const want = plainName(record.patient.name).split(/\s+/);
    const hit = z.patients.find((p) => {
      const have = `${plainName(p.FIRST ?? "")} ${plainName(p.LAST ?? "")}`;
      return want.every((w) => have.includes(w));
    });
    if (hit) {
      patient = { id: hit.Id!, label: `${plainName(hit.FIRST ?? "")} ${plainName(hit.LAST ?? "")} (born ${hit.BIRTHDATE})`, how: "name + birth date" };
      recordMeds = await patientMeds(hit.Id!);
    }
  }
  ctx.say(
    "lookup",
    "memory",
    "info",
    patient ? `Matched hospital record: ${patient.label}, ${recordMeds.length} medication entries.` : `No hospital record matched ${record.patient.name ?? "this patient"}; medicines can't be compared with a record.`,
  );

  // 4. Interpret the labels in plain words.
  const rowFor = (written: string) => {
    const g = generics[written.toLowerCase()] ?? baseDrugName(written);
    const exact = z.drugs.find((d) => d.generic_name === g || d.generic_name === baseDrugName(written));
    const brand = z.drugs.find((d) => (d.brand_names ?? "").toLowerCase().split(/;\s*/).includes(written.toLowerCase()));
    // "docusate sodium" ↔ "docusate": the shortest label whose name contains the other (never a combination product).
    const near = z.drugs
      .filter((d) => !/ and |,/.test(d.generic_name ?? "") && (mentions(g, d.generic_name ?? "") || mentions(d.generic_name ?? "", g)))
      .sort((a, b) => (a.generic_name ?? "").length - (b.generic_name ?? "").length)[0];
    return exact ?? brand ?? near;
  };
  const found = record.medications.map((m) => ({ med: m, row: rowFor(m.name) }));
  const notFound = found.filter((f) => !f.row && f.med.status !== "stopped").map((f) => ({ name: f.med.name, source: f.med.source }));
  const rows = [...new Map(found.filter((f) => f.row).map((f) => [f.row!.generic_name, f.row!])).values()];
  let drugs: DrugLookup[] = [];
  if (rows.length) {
    const labels = rows.map((r) => ({
      generic: r.generic_name,
      purpose: (r.purpose ?? "").slice(0, 700),
      side_effects: (r.side_effects ?? "").slice(0, 600),
      warnings: (r.warnings ?? "").slice(0, 500),
      boxed_warning: (r.boxed_warning ?? "").slice(0, 300),
    }));
    // An empty or short answer (the model sometimes returns {"drugs": []}) is asked again once,
    // naming the drugs it left out; the better of the two answers is kept.
    for (let i = 1; i <= 2 && drugs.length < rows.length; i++) {
      const missing = rows.filter((r) => !drugs.some((d) => d.generic === r.generic_name)).map((r) => r.generic_name);
      const messages = [
        {
          role: "system" as const,
          content: `You turn FDA drug label text into plain words for a patient (grade 5 reading level).
Use only what the label text says. For each drug give: plain_purpose (one short sentence, e.g. "a water pill that helps your body get rid of extra fluid"),
common_side_effects (up to 4, a few words each), key_warning (the single most important warning in one short sentence, or null).
Return JSON only: {"drugs": [{"generic": "...", "plain_purpose": "...", "common_side_effects": ["..."], "key_warning": "..."}]}`,
        },
        { role: "user" as const, content: JSON.stringify(labels) },
        ...(i > 1 ? [{ role: "user" as const, content: `Your last answer left out: ${missing.join(", ")}. Return one entry for every one of the ${rows.length} drugs above, with "generic" exactly as given.` }] : []),
      ];
      let got: DrugLookup[] = [];
      try {
        const res = await ctx.llm({ agent: "lookup", route: "meterless/text", json: true, maxTokens: 3000, messages });
        const out = parseJsonObject<{ drugs: Omit<DrugLookup, "id" | "table" | "name">[] }>(res.content);
        got = (out.drugs ?? [])
          .filter((d) => d?.generic && d.plain_purpose && rows.some((r) => r.generic_name === d.generic))
          .map((d) => ({
            id: `drug:${d.generic.replace(/\s+/g, "_")}`,
            table: "drug_reference" as const,
            name: found.find((f) => f.row?.generic_name === d.generic)?.med.name ?? d.generic,
            generic: d.generic,
            plain_purpose: d.plain_purpose,
            common_side_effects: (d.common_side_effects ?? []).slice(0, 4),
            key_warning: d.key_warning ?? null,
          }));
      } catch (err) {
        ctx.say("lookup", "lookup", "info", `Plain-word drug labels failed (${(err as Error).message.slice(0, 100)}).`);
      }
      if (got.length > drugs.length) drugs = got;
      if (drugs.length < rows.length && i < 2) ctx.say("lookup", "lookup", "info", `Plain-word drug labels came back for ${drugs.length} of ${rows.length} drugs; asking again.`);
    }
    if (drugs.length < rows.length) ctx.say("lookup", "simplify", "info", `No plain-word label for ${rows.length - drugs.length} drug(s); Simplify will explain them from the papers only.`);
  }
  const termRows: TermLookup[] = z.terms.map((t) => ({ id: `term:${t.term}`, table: "medical_terms", term: t.term!, plain: t.plain_language ?? t.meaning ?? "" }));
  const result = { drugs, terms: termRows, generics, notFound, patient, recordMeds };
  ctx.save("lookup", "result", { input: planInput, output: { ...result, recordMeds: recordMeds.length } });
  return result;
}

const isActive = (r: Row) => !r.STOP;
const isOral = (r: Row) => /\boral\b|tablet|capsule/i.test(r.DESCRIPTION ?? "");

/** The drug name in a Synthea description: "24 HR metoprolol succinate 100 MG ..." → "metoprolol succinate". */
function recordDrugName(desc: string): string {
  return desc
    .replace(/^\s*\d+\s*(HR|DAY|ACTUAT|ML)\s+/i, "")
    .split(/\s\d/)[0]
    .replace(/\b(hydrochloride|sodium|potassium|calcium)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Compare the paper with the hospital record, through H-MEM. Re-run after Extract corrects
 * the record, so the diff and the conflicts always match the latest reading.
 */
export function ground(ctx: AgentContext, record: DischargeRecord, look: LookupResult, memory: PatientMemory): GroundedRecord {
  const active = look.recordMeds.map((r, i) => ({ r, id: `record:${i + 1}` })).filter((x) => isActive(x.r));
  const diff: RecordDiff[] = [];
  const explained = new Set<string>(); // drugs whose change the paper states itself

  for (const med of record.medications) {
    const g = look.generics[med.name.toLowerCase()] ?? med.name.toLowerCase();
    const paperDose = doseOf(med.dose) ?? (med.dose || "?");
    // Most recent active record entry for this drug.
    const rec = active.filter((x) => mentions(x.r.DESCRIPTION ?? "", g) || mentions(x.r.DESCRIPTION ?? "", med.name)).sort((a, b) => String(b.r.START).localeCompare(String(a.r.START)))[0];
    const recordDose = rec ? doseOf(rec.r.DESCRIPTION ?? "") : null;
    const recMem = rec && recordDose ? memory.rememberDose({ drug: g, dose: recordDose, source: rec.id, origin: "record", label: `Hospital record: ${rec.r.DESCRIPTION}` }) : null;
    const statesChange = med.status === "changed" || med.status === "new" || med.status === "stopped";
    if (statesChange) explained.add(g);
    memory.rememberDose({
      drug: g,
      dose: paperDose,
      source: med.source,
      origin: "paper",
      label: `Discharge paper ${med.source}: ${med.name} ${med.dose} ${med.freq}`,
      supersedes: statesChange && recMem ? recMem.id : undefined, // an intended change, not a conflict
    });

    let change: RecordDiff["change"];
    if (med.status === "stopped") change = "stopped";
    // No matched patient means no record to compare with: keep what the paper says rather than
    // calling every medicine "not on your record" (Simplify turns that into doctor questions).
    else if (!rec) change = med.status === "new" ? "new" : !look.patient ? (med.status === "changed" ? "changed" : "continued") : "not_on_record";
    else if (recordDose && recordDose === paperDose) change = "continued";
    else change = "changed";
    diff.push({ drug: g, change, paper: med.status === "stopped" ? null : paperDose, record: recordDose, source: med.source, conflict: null });
  }

  // Active hospital medicines the paper never mentions.
  const onPaper = record.medications.map((m) => look.generics[m.name.toLowerCase()] ?? m.name.toLowerCase());
  const seen = new Set<string>();
  for (const x of active.filter((x) => isOral(x.r))) {
    const name = recordDrugName(x.r.DESCRIPTION ?? "");
    if (!name || seen.has(name) || onPaper.some((p) => mentions(name, p) || mentions(p, name))) continue;
    seen.add(name);
    diff.push({ drug: name, change: "not_on_paper", paper: null, record: doseOf(x.r.DESCRIPTION ?? ""), source: x.id, conflict: null });
  }

  // The rest of the papers goes into memory too, for Q&A recall later.
  for (const d of record.diagnoses) memory.rememberFact({ text: d.text, source: d.source, kind: "diagnosis" });
  for (const r of record.restrictions) memory.rememberFact({ text: r.text, source: r.source, kind: "instruction" });
  for (const f of record.follow_ups) memory.rememberFact({ text: `Follow-up: ${f.who}, ${f.when}`, source: f.source, kind: "follow_up" });
  for (const w of record.warning_signs) memory.rememberFact({ text: `Warning sign to get help for: ${w.text}`, source: w.source, kind: "warning_sign" });

  // H-MEM conflicts the paper doesn't explain stay open (never auto-resolved).
  const conflicts = memory.conflicts().filter((c) => !explained.has(c.drug));
  for (const c of conflicts) {
    const d = diff.find((x) => x.drug === c.drug);
    if (d) d.conflict = `conflict:${c.id}`;
  }

  const grounded: GroundedRecord = {
    ...record,
    lookups: { drugs: look.drugs, terms: look.terms },
    hospital_record_diff: diff,
    matched_patient: look.patient,
    conflicts: conflicts.map((c) => ({
      id: `conflict:${c.id}`,
      drug: c.drug,
      detail: `${c.a.source} says "${c.a.content}"; ${c.b.source} says "${c.b.content}" (${c.reason}, confidence ${c.confidence})`,
    })),
  };
  ctx.save("memory", "ground", { input: { medications: record.medications, recordMeds: active.length }, output: { diff, conflicts: grounded.conflicts, memories: memory.size } });
  return grounded;
}
