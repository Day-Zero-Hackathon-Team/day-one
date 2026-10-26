// Zetaris data layer: the fixed lookups the Lookup agent may call. The agent never writes SQL;
// every value that reaches a query is checked against a strict character allowlist first.
//
// Queries run through scripts/ZetarisJson.java over Zetaris's JDBC driver (one JVM per
// batch). With ZETARIS_RECORD=true each result is saved to samples/zetaris/, and with
// SAMPLE_MODE=true those recordings are replayed, so the app runs without Zetaris.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, sampleMode, zetarisSettings } from "./config.ts";

const DB = process.env.ZETARIS_DB ?? "DAY_ONE";
const SAMPLES = join(ROOT, "samples", "zetaris");
const TIMEOUT_MS = 120_000;

export type Row = Record<string, string | null>;

export class ZetarisError extends Error {}

/** Run statements in one JDBC session; one row list per statement. */
export async function query(statements: string[]): Promise<Row[][]> {
  if (!statements.length) return [];
  const keys = statements.map((s) => createHash("sha256").update(s).digest("hex").slice(0, 16));
  if (sampleMode()) {
    return keys.map((k, i) => {
      const file = join(SAMPLES, `${k}.json`);
      if (!existsSync(file)) throw new ZetarisError(`SAMPLE_MODE: no recorded Zetaris result for: ${statements[i]}`);
      return JSON.parse(readFileSync(file, "utf-8")).rows as Row[];
    });
  }
  const results = await runJava(statements);
  if (process.env.ZETARIS_RECORD === "true") {
    mkdirSync(SAMPLES, { recursive: true });
    results.forEach((rows, i) => writeFileSync(join(SAMPLES, `${keys[i]}.json`), JSON.stringify({ sql: statements[i], rows }, null, 1)));
  }
  return results;
}

function runJava(statements: string[]): Promise<Row[][]> {
  const z = zetarisSettings();
  if (!z) throw new ZetarisError("Zetaris isn't set up: set ZETARIS_DIR to your zetaris-platform folder (see README).");
  return new Promise((resolve, reject) => {
    const child = spawn("java", ["-cp", z.jar, join(ROOT, "scripts", "ZetarisJson.java"), ...statements], {
      env: { ...process.env, ZETARIS_URL: z.url, ZETARIS_USER: z.user, ZETARIS_PASSWORD: z.password },
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ZetarisError(`could not start Java (needed for the Zetaris driver): ${e.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      const lines = out.split(/\r?\n/).filter((l) => l.startsWith("{"));
      const parsed = lines.map((l) => JSON.parse(l));
      const fatal = parsed.find((p) => p.fatal);
      if (fatal) return reject(new ZetarisError(`Zetaris: ${fatal.fatal}`));
      if (parsed.length !== statements.length) {
        const hint = err.split(/\r?\n/).filter((l) => l && !/^(SLF4J|log4j)/.test(l)).slice(-3).join(" ");
        return reject(new ZetarisError(`Zetaris returned ${parsed.length} of ${statements.length} results. ${hint}`));
      }
      const failed = parsed.find((p) => p.error);
      if (failed) return reject(new ZetarisError(`Zetaris query failed: ${failed.error}`));
      resolve(parsed.map((p) => p.rows.map((r: (string | null)[]) => Object.fromEntries(p.columns.map((c: string, j: number) => [c, r[j]])))));
    });
  });
}

// ── Allowlisted values ────────────────────────────────────────────────────────

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const drugName = (s: string) => s.toLowerCase().replace(/[^a-z0-9 \-]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
const termName = (s: string) => s.replace(/[^A-Za-z0-9 /.\-]/g, "").trim().slice(0, 20);
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

// ── The fixed lookups ─────────────────────────────────────────────────────────

export interface Lookups {
  drugs: Row[];
  terms: Row[];
  patients: Row[];
  meds: Row[];
}

/**
 * One round trip for everything the Lookup agent asked for: drug labels by generic or brand
 * name, abbreviations, candidate patients by birth date, and (when a patient id is given)
 * that patient's medication history.
 */
export async function lookupAll(req: { drugs: string[]; terms: string[]; birthdate?: string | null; patientId?: string | null }): Promise<Lookups> {
  const drugs = [...new Set(req.drugs.map(drugName).filter(Boolean))];
  const terms = [...new Set(req.terms.map(termName).filter(Boolean))];
  const statements: string[] = [];
  const slots: (keyof Lookups)[] = [];

  if (drugs.length) {
    const brandLike = drugs.map((d) => `lower(brand_names) LIKE ${lit(`%${d}%`)}`).join(" OR ");
    statements.push(
      `SELECT id, generic_name, brand_names, purpose, side_effects, warnings, boxed_warning, route FROM ${DB}.drug_reference ` +
        `WHERE generic_name IN (${drugs.map(lit).join(", ")}) OR ${brandLike}`,
    );
    slots.push("drugs");
  }
  if (terms.length) {
    statements.push(`SELECT term, category, meaning, plain_language FROM ${DB}.medical_terms WHERE upper(term) IN (${terms.map((t) => lit(t.toUpperCase())).join(", ")})`);
    slots.push("terms");
  }
  if (req.birthdate && isDate(req.birthdate)) {
    statements.push(`SELECT Id, FIRST, LAST, BIRTHDATE, GENDER FROM ${DB}.hospital_records_patients WHERE BIRTHDATE = ${lit(req.birthdate)}`);
    slots.push("patients");
  }
  if (req.patientId && isUuid(req.patientId)) {
    statements.push(medsSql(req.patientId));
    slots.push("meds");
  }
  const results = await query(statements);
  const out: Lookups = { drugs: [], terms: [], patients: [], meds: [] };
  slots.forEach((slot, i) => (out[slot] = results[i]));
  return out;
}

export async function patientMeds(patientId: string): Promise<Row[]> {
  if (!isUuid(patientId)) return [];
  const [rows] = await query([medsSql(patientId)]);
  return rows;
}

function medsSql(patientId: string): string {
  return `SELECT START, STOP, DESCRIPTION, CODE FROM ${DB}.hospital_records_medications WHERE PATIENT = ${lit(patientId)} ORDER BY START`;
}

/** Is Zetaris reachable? Used by the status panel. */
export async function ping(): Promise<{ ok: boolean; detail: string }> {
  try {
    const [rows] = await query([`SELECT COUNT(*) AS n FROM ${DB}.drug_reference`]);
    return { ok: true, detail: `${Object.values(rows[0] ?? {})[0]} drugs in ${DB}.drug_reference` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
