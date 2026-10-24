# day-one — Discharge Summary Agent Pipeline

> **Open Agent Hackathon 2026 · Oct 22–27**

A phone app where a patient **scans their hospital discharge summary** and gets a **plain-language version** they can read or listen to.

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
| + | **Q&A** *(stretch goal)* | AI | Answers follow-up questions like *"Can I shower?"* using only that patient's data. For anything else it says to ask the care team. | — |

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

### Prerequisites

- Docker + Docker Compose
- Java runtime (for the Zetaris JDBC driver in `jdbc/`)
- An API key for the AI model you choose (check the hackathon rules on partner tools first)

### 1. Start Zetaris

```bash
./preflight.sh          # check the machine is ready
docker compose up -d    # start Zetaris
./verify.sh             # confirm it's reachable on port 10000
```

### 2. Load the datasets

Download `drug_reference`, `medical_terms`, and `hospital_records` with `python3 data/download_datasets.py`, then load them into Zetaris. The full walkthrough is in [`data/README.md`](data/README.md).

### 3. Run the pipeline

> 🚧 Coming soon: the orchestrator and agents are being built during the hackathon (see the [build plan](#build-plan)).

**Tip:** Scan, Extract, and Simplify can be developed before Zetaris is up by faking the Lookup responses with the `GroundedRecord` shape above.

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
