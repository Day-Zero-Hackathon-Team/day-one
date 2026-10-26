# day-one — Discharge Summary Agent Pipeline

> **Open Agent Hackathon 2026 · Oct 22–27**

A web app (it works on a phone too) where a patient **uploads a photo or the text of their hospital discharge summary** and gets a **plain-language version** they can read or listen to.

Discharge papers are dense with jargon, abbreviations, and dosing instructions that are easy to misread at exactly the moment a patient is tired, stressed, and going home. This project turns those papers into a short, sourced, grade-6 summary with a daily medicine schedule, a clear "call 911 if" list, and read-aloud audio, and it checks itself for safety before anything reaches the patient.

---

## Table of contents

- [How it works](#how-it-works)
- [The agents](#the-agents)
- [Where Zetaris fits](#where-zetaris-fits)
- [Data contracts](#data-contracts)
- [Safety rules](#safety-rules)
- [Getting started](#getting-started)
- [Build plan](#build-plan)
- [Team](#team)

---

## How it works

A plain script (not an AI) runs the steps below in order. It tracks each job's progress and **saves every agent's input and output**, which gives a full audit trail.

```mermaid
flowchart TD
    CAM["📷 Phone camera<br/><small>patient photographs each page</small>"]
    SCAN["1 · Scan<br/><small>photos → text, split into sections</small>"]
    EXT["2 · Extract<br/><small>text → structured fields + sources</small>"]
    LOOK["3 · Lookup<br/><small>drugs, terms, med-list changes</small>"]
    SIMP["4 · Simplify<br/><small>grade-6 rewrite, every bullet sourced</small>"]
    SAFE["5 · Safety checker<br/><small>bullets vs. source, doses, warnings</small>"]
    TTS["6 · Read-aloud<br/><small>text-to-speech per section</small>"]
    APP["📱 App<br/><small>summary, play button, med schedule</small>"]
    Z[("Zetaris<br/>drug_reference<br/>medical_terms<br/>hospital_records")]

    CAM -- photos --> SCAN
    SCAN -- ScanResult --> EXT
    EXT -- DischargeRecord --> LOOK
    LOOK <-- SQL --> Z
    LOOK -- GroundedRecord --> SIMP
    SIMP -- PlainSummary --> SAFE
    SAFE -. "fail · CheckReport · retry ≤ 2" .-> SIMP
    SAFE -- "pass → PlainSummary" --> TTS
    TTS -- "audio + word timings" --> APP

    classDef ai fill:#e3eef9,stroke:#2b5d8a,color:#111;
    classDef check fill:#fbe4df,stroke:#b5432f,color:#111;
    classDef code fill:#fff,stroke:#555,stroke-dasharray:4 3,color:#111;
    classDef data fill:#dff1ea,stroke:#2f7a62,color:#111;
    class SCAN,EXT,LOOK,SIMP ai;
    class SAFE check;
    class CAM,TTS,APP code;
    class Z data;
```

| Legend | Meaning |
| --- | --- |
| 🟦 AI agent | Scan, Extract, Lookup, Simplify |
| 🟥 AI safety check | Safety checker (a separate model call) |
| ⬜ Plain code | Camera capture, Read-aloud, App |
| 🟩 Zetaris | Data layer the Lookup agent queries |

---

## The agents

| # | Agent | Type | What it does | Passes on |
| --- | --- | --- | --- | --- |
| 01 | **Scan** | AI · reads images | Turns the photos into text and splits it into sections: diagnosis, medicines, instructions, follow-up, warning signs. If a photo is too blurry to read, it asks the patient to scan that page again. | `ScanResult` |
| 02 | **Extract** | AI | Turns the text into structured fields. Every field keeps the exact line of the original it came from, so anything later can be traced back. | `DischargeRecord` |
| 03 | **Lookup** | AI · calls Zetaris | Looks up each medicine and unknown term, and compares the medicine list with the hospital record. Calls fixed lookups such as `lookup_drug(name)` and `get_patient_meds(id)` instead of writing its own SQL. | `GroundedRecord` |
| 04 | **Simplify** | AI | Rewrites everything at a grade-6 reading level. Builds a daily medicine schedule, a "call 911 if" list, and questions to ask the doctor. Every bullet points back to its sources. | `PlainSummary` |
| 05 | **Safety checker** | AI · separate call | Checks every bullet against its source. Fails the summary for a dropped or changed dose, advice that isn't in the original, a missing warning sign, or a reading level that's too high. The reading level comes from a formula in code, not from the AI. A fail goes back to Simplify, at most twice. | `CheckReport` |
| 06 | **Read-aloud** | Plain code · TTS | Makes audio for each section, plus word timings so the text highlights as it's read. | audio files + timings |
| + | **Q&A** | AI · H-MEM recall | Answers follow-up questions like *"Can I shower?"* using only that patient's data, recalled through H-MEM, with sources. For anything else it says to ask the care team. | answer + sources |

---

## Where Zetaris fits

The hackathon asks for agents that work on **live enterprise data**, so [Zetaris](https://www.zetaris.com/) is the data layer the Lookup agent queries. It runs SQL across several sources as if they were one database. Our code connects over **JDBC on port `10000`** using the driver jar in `jdbc/`.

| Dataset | Source | Used for |
| --- | --- | --- |
| `drug_reference` | [openFDA](https://open.fda.gov/) drug labels, [MedlinePlus](https://medlineplus.gov/) (both public) | Explaining each medicine in plain words: what it's for, common side effects, warnings |
| `medical_terms` | A CSV we put together (BID, PRN, CHF, …) | Translating jargon and abbreviations |
| `hospital_records` | [Synthea](https://synthetichealth.github.io/synthea/) (synthetic patients) | Comparing against the summary to label each medicine **new**, **stopped**, or **changed** |

> 🔒 The synthetic hospital records are our enterprise-data angle, and they mean the demo **never touches real patient data**.

---

## Data contracts

Agree on these shapes first. Then each teammate can build their agent against fake inputs without waiting on the others.

### Extract → Lookup · `DischargeRecord`

```json
{
  "diagnoses":     [{ "text": "CHF exacerbation", "source": "p1:L4-5" }],
  "medications":   [{ "name": "furosemide", "dose": "40 mg", "freq": "BID",
                      "status": "new|changed|stopped|continued", "source": "p2:L1" }],
  "follow_ups":    [{ "who": "cardiology", "when": "1 week", "source": "p3:L2" }],
  "warning_signs": [{ "text": "weight gain >2 lb/day", "source": "p3:L7" }],
  "restrictions":  [{ "text": "no lifting over 10 lb", "source": "p3:L5" }],
  "unknown_terms": ["BID", "CHF"]
}
```

### Lookup → Simplify · `GroundedRecord`

Everything in `DischargeRecord`, plus:

```json
{
  "lookups": [{ "id": "drug:furosemide", "table": "drug_reference",
                "plain_purpose": "water pill", "common_side_effects": ["..."] }],
  "hospital_record_diff": [{ "drug": "furosemide", "change": "new" }]
}
```

### Simplify → Safety checker · `PlainSummary`

```json
{
  "sections": [{
    "title": "Your medicines",
    "bullets": [{ "id": "b3",
                  "text": "Take furosemide 40 mg twice a day. It's a water pill.",
                  "sources": ["p2:L1", "drug:furosemide"] }]
  }],
  "med_schedule": [{ "drug": "furosemide", "morning": true, "night": true }],
  "call_911_if": ["..."],
  "questions_for_your_doctor": ["..."]
}
```

### Safety checker → Simplify or done · `CheckReport`

```json
{
  "pass": false,
  "reading_level": 7.8,
  "issues": [{ "bullet": "b3",
               "type": "dose_changed|added_advice|missing_warning|too_complex",
               "fix": "..." }]
}
```

**Source IDs:** `pN:LX` means page *N*, line *X* of the scanned document (`pN:LX-Y` for a range); `drug:<name>` / `term:<abbr>` point at a Zetaris lookup row.

---

## Safety rules

These two rules are non-negotiable and are central to the pitch.

1. **Nothing reaches the patient without a source.**
   Every bullet carries its `sources`, so the app can show *"Where does this come from?"* next to it.

2. **Fall back to the original.**
   If a section still fails the safety check after two retries, the app shows the **original text** with *"Ask your care team"* instead of a simplification we can't trust.

> ⚠️ This is a hackathon prototype for helping patients understand their own paperwork. It is **not** a medical device and does not give medical advice.

---

## Getting started

Day One is a local web app. It runs on **macOS and Windows** with Node 24 and has no npm dependencies.

> **New to the project?** [`docs/HANDOFF.md`](docs/HANDOFF.md) walks through the whole setup (Zetaris, Nightshift, the NVIDIA key), what's built, what's left, and how to continue the design in Figma.

### Prerequisites

| Need | Why | Check |
| --- | --- | --- |
| [Node.js 24+](https://nodejs.org/) | Runs the server and agents (TypeScript, no build step) | `node --version` |
| Java 11+ | The Zetaris JDBC driver | `java -version` |
| Docker + the Zetaris platform | Data layer: drug labels, terms, hospital records | `./verify.sh` in your `zetaris-platform` folder |
| [Meterless Nightshift](https://meterless.ai/Nightshift/WIN/) (Windows) or the Mac edition | The app's AI provider. Add your NVIDIA API key in Nightshift's **Providers** tab, and switch off any NVIDIA model your key can't use in **Compute sources** (see `docs/meterless-integration.md`). | `npm run nightshift:check` |

### 1. Load the data into Zetaris (once)

```bash
python3 data/download_datasets.py      # Windows: py data\download_datasets.py
scripts/load_to_zetaris.sh             # needs Zetaris running; see data/README.md
```

### 2. Configure

```bash
cp .env.example .env
```

On the machine running Nightshift, the token is read from Nightshift's own folder automatically. Set `ZETARIS_DIR` if your `zetaris-platform` folder isn't next to this repo, in your home folder or in Downloads.

### 3. Run

```bash
npm start
```

Open <http://localhost:3100>, pick a sample (or paste your own text, or upload photos), and press **Make it plain**. A run takes 3 to 6 minutes. Every agent's input and output, the agent conversation, and a trace of every model call (with the model that answered and Nightshift's signed receipt) are saved in `runs/<job>/`.

**No Nightshift or Zetaris?** `npm run sample` replays recorded responses for the three sample cases (`SAMPLE_MODE=true`); H-MEM still runs for real. Recorded Q&A questions: *"Can I drink alcohol?"* (sample 1), *"When should I see my doctor again?"* (sample 2), *"Can I take a bath?"* (sample 3). Any other question in sample mode gets "ask your care team". To re-record after changing a prompt, set `NIGHTSHIFT_RECORD=true` and `ZETARIS_RECORD=true`, delete `samples/nightshift/` and `samples/zetaris/`, and run the three samples live.

### Known gaps (prototype)

- **Photos** need a vision model in Nightshift; until one is set up, photo uploads ask the patient to paste the text.
- **Q&A answers** must cite a line of the papers, but they don't go through the full safety checker, so an answer can add a little context the papers don't state.
- **Nightshift routing:** NVIDIA models your key can't use cost about 2 minutes each before the client retries; switch them off in Nightshift's Compute sources.
- **Read-aloud** uses the browser's voice, not Nightshift's `meterless/speech`.

### Tests

```bash
npm test                  # Nightshift client unit tests (offline)
npm run test:hmem         # Meterless H-MEM engine conformance suite (13 checks)
npm run nightshift:check  # live check against a running Nightshift
```

### How the code is laid out

| Path | What |
| --- | --- |
| `src/server.ts` | Web server and job API |
| `src/pipeline.ts` | Orchestrator: routes work between agents, including the feedback loops |
| `src/agents/` | Scan, Extract, Lookup, Simplify, Safety checker |
| `src/memory.ts` | Patient medicine memory on the Meterless **H-MEM** engine (`engines/hmem/`, Apache 2.0) |
| `src/zetaris.ts`, `scripts/ZetarisJson.java` | Fixed Zetaris lookups over JDBC |
| `src/nightshift.ts` | Meterless Nightshift client (the only AI provider) |
| `public/` | The web page (unstyled skeleton; design brief in `docs/features.md`) |
| `samples/inputs/` | Three sample discharge summaries for real synthetic patients |
| `docs/meterless-integration.md` | How Meterless, Nightshift and NVIDIA are used |
| `docs/HANDOFF.md` | Setup from scratch, status, what's left, Figma workflow |

### How the agents work together

The orchestrator is plain code; the agents send work back to each other instead of running once in a line:

- **Extract → Scan:** lines Extract can't read with confidence in a photo are re-read.
- **Lookup → Extract:** a medicine Zetaris doesn't know is sent back to be re-checked (often a misread name).
- **H-MEM → Safety checker:** when the papers and the hospital record disagree on a dose and the papers don't say it changed, the conflict is escalated and the summary must tell the patient to check with their care team.
- **Safety checker → Simplify:** problems found in the summary are sent back for revision (at most 2 retries).
- **Safety checker → Extract:** a dose that isn't on its own source line means Extract misread it; Extract re-reads, the record is re-grounded, and Simplify rewrites.
- **Fallback:** a section that still fails shows the original text with "Ask your care team".

---

## Build plan

| Day | Date | Goal |
| --- | --- | --- |
| 1 | Oct 22 | Get Zetaris running (`./preflight.sh`, `docker compose up -d`, `./verify.sh`) and load the three datasets |
| 2 | Oct 23 | Scan and Extract agents, tested on 3–4 fake discharge summaries |
| 3 | Oct 24 | Lookup agent and Simplify agent |
| 4 | Oct 25 | Safety checker, retry loop, and read-aloud |
| 5 | Oct 26 | Phone app screens: scan, summary, play button, medicine schedule |
| 6 | Oct 27 | Demo video: show one case where the checker catches a wrong dose |

Days 2 and 3 can run alongside Day 1 if the Zetaris lookups are faked at first.

---

## Team

**Day Zero Hackathon Team**: built for the Open Agent Hackathon 2026.
