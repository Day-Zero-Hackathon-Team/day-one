// Data contracts between agents (README "Data contracts"), plus the shared job state.
//
// Source ids: pN:LX is page N, line X of the scanned document (pN:LX-Y for a range);
// drug:<name>, term:<abbr> and record:<n> point at Zetaris rows; conflict:<id> at an H-MEM
// conflict record.

// ── Scan → Extract ──────────────────────────────────────────────────────────
export interface ScanLine {
  id: string; // p1:L4
  text: string;
  unclear?: boolean; // the scanner could not read this line with confidence
}
export interface ScanPage {
  page: number;
  lines: ScanLine[];
  readable: boolean;
  problem?: string; // why the page needs a rescan
}
export interface ScanResult {
  pages: ScanPage[];
  source: "text" | "image";
}

// ── Extract → Lookup ────────────────────────────────────────────────────────
export type MedStatus = "new" | "changed" | "stopped" | "continued" | "unclear";
export interface Medication {
  name: string;
  dose: string;
  freq: string;
  status: MedStatus;
  instructions?: string;
  source: string;
}
export interface Sourced {
  text: string;
  source: string;
}
export interface DischargeRecord {
  patient: { name: string | null; birthdate: string | null; source: string | null };
  diagnoses: Sourced[];
  medications: Medication[];
  follow_ups: { who: string; when: string; source: string }[];
  warning_signs: Sourced[];
  restrictions: Sourced[];
  unknown_terms: string[];
  uncertain: { source: string; reason: string }[]; // lines Extract wants Scan to re-read
}

// ── Lookup → Simplify ───────────────────────────────────────────────────────
export interface DrugLookup {
  id: string; // drug:furosemide
  table: "drug_reference";
  name: string; // as written on the paper
  generic: string;
  plain_purpose: string;
  common_side_effects: string[];
  key_warning: string | null;
}
export interface TermLookup {
  id: string; // term:BID
  table: "medical_terms";
  term: string;
  plain: string;
}
// not_on_record: on the paper, never in the hospital record. not_on_paper: active in the
// hospital record, but the paper doesn't mention it (ask whether to keep taking it).
export type RecordChange = "new" | "changed" | "stopped" | "continued" | "not_on_record" | "not_on_paper";
export interface RecordDiff {
  drug: string;
  change: RecordChange;
  paper: string | null; // dose on the discharge paper
  record: string | null; // dose in the hospital record
  source: string; // paper line, or record:<n>
  conflict: string | null; // H-MEM conflict id when the sources disagree without explanation
}
export interface GroundedRecord extends DischargeRecord {
  lookups: { drugs: DrugLookup[]; terms: TermLookup[] };
  hospital_record_diff: RecordDiff[];
  matched_patient: { id: string; label: string; how: string } | null;
  conflicts: { id: string; drug: string; detail: string }[]; // open H-MEM conflicts
}

// ── Simplify → Safety checker ───────────────────────────────────────────────
export interface Bullet {
  id: string;
  text: string;
  sources: string[];
}
export interface Section {
  title: string;
  bullets: Bullet[];
}
export interface PlainSummary {
  sections: Section[];
  med_schedule: { drug: string; dose: string; morning: boolean; midday: boolean; evening: boolean; night: boolean; as_needed: boolean; note?: string; sources: string[] }[];
  call_911_if: Bullet[];
  questions_for_your_doctor: string[];
}

// ── Safety checker → Simplify / Extract / done ─────────────────────────────
export type IssueType =
  | "missing_source"
  | "bad_source"
  | "dose_changed"
  | "missing_medication"
  | "added_advice"
  | "missing_warning"
  | "conflict_not_flagged"
  | "too_complex"
  | "extract_mismatch"; // the extracted record disagrees with the original line → Extract
export interface Issue {
  bullet: string | null;
  section: string | null;
  type: IssueType;
  fix: string;
  by: "code" | "model";
}
export interface CheckReport {
  pass: boolean;
  model_checked: boolean; // false when the AI meaning check couldn't run (code checks still did)
  reading_level: number;
  reading_level_by_section: Record<string, number>;
  issues: Issue[];
}

// ── Shared job state ────────────────────────────────────────────────────────
export type AgentName = "orchestrator" | "scan" | "extract" | "lookup" | "memory" | "simplify" | "safety_checker" | "qa";

/** One message on the agents' shared board. The UI shows these as the agent conversation. */
export interface AgentMessage {
  ts: string;
  from: AgentName;
  to: AgentName | "patient";
  kind: "handoff" | "request" | "reply" | "critique" | "escalation" | "fallback" | "info";
  text: string;
}

export interface StepState {
  agent: AgentName;
  label: string;
  status: "waiting" | "running" | "done" | "failed" | "skipped";
  detail?: string;
}

export interface FinalOutput {
  summary: PlainSummary;
  check: CheckReport;
  fallback_sections: { title: string; original: ScanLine[] }[]; // shown as original text + "Ask your care team"
  record: GroundedRecord;
  scan: ScanResult;
  ledger: Record<string, { action: string; ts: number; details?: unknown }[]>; // H-MEM trust ledger per source memory
  models: { agent: string; model: string | null; receipt: string | null }[];
}

export interface Job {
  id: string;
  createdAt: string;
  status: "running" | "done" | "failed" | "needs_rescan";
  steps: StepState[];
  messages: AgentMessage[];
  error?: string;
  rescan?: { page: number; problem: string }[];
  output?: FinalOutput;
  memoryDir?: string; // the patient's H-MEM folder, so Q&A works after a restart
  qa: { question: string; answer: string; sources: string[]; answered: boolean; recalled: string[] }[];
}
