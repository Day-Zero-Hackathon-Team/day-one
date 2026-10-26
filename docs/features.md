# Day One · feature inventory (for design)

Everything the working prototype does, screen by screen, with the data behind each element. The current page in `public/` is a functional skeleton with no design applied. Use this list to design the real screens in Figma; the API and data shapes stay the same.

All data comes from `GET /api/jobs/:id` (shapes in `src/types.ts`).

---

## Global

| Element | What it shows | Data |
| --- | --- | --- |
| App header | Name, tagline | static |
| Service status pills | Meterless Nightshift online / unauthorized / offline · Zetaris connected / offline · Photo reading on / off · Sample mode | `GET /api/status` → `{nightshift, zetaris: {ok, detail}, vision, sampleMode}` |
| Disclaimer | "Prototype, not medical advice; follow your care team" | static |

---

## Screen 1 · Add your discharge summary

| Element | Behaviour | Notes |
| --- | --- | --- |
| Photo / Text tabs | Switch input mode | |
| Photo picker | Take or choose 1–10 photos (one per page). Opens the camera on phones. | Photos are shrunk to 1800 px in the browser before upload |
| Page thumbnails | One per selected photo, labelled "Page N" | |
| Vision-off notice | Shown when photo reading isn't available | `status.vision === false` |
| Text box | Paste or type the summary | `--- page 2 ---` or a form feed starts a new page |
| Sample picker | Fills the text box with a sample | `GET /api/samples` → `[{name, text}]` |
| "Make it plain" button | Starts a job | `POST /api/jobs {text}` or `{images}` → `{id}` |
| Error message | Empty input, upload too large, server error, **"please rescan page N (reason)"** | `job.status === "needs_rescan"` → `job.rescan[]` |

---

## Screen 2 · Working on it (live, polls every ~1 s)

| Element | Behaviour | Data |
| --- | --- | --- |
| Step list | Six steps: Scan, Extract, Lookup (Zetaris), Patient memory (H-MEM), Simplify, Safety checker. States: waiting, running, done, failed. A step can run again (e.g. "revision 1", "re-checking a dose"). | `job.steps[] = {agent, label, status, detail}` |
| Agent conversation | Live feed of messages between agents. Kinds: handoff, request, reply, critique, escalation, fallback, info. **This is the "agents work together" story: design it to be readable.** | `job.messages[] = {ts, from, to, kind, text}` |

Typical length: 3–6 minutes (cloud models through Nightshift).

---

## Screen 3 · Your summary

| Element | Behaviour | Data |
| --- | --- | --- |
| Safety banner | Passed ("every line traces back to your papers"), or partial (some sections show the original text). Shows reading grade. | `output.check.pass`, `output.check.reading_level`, `output.fallback_sections` |
| Read aloud / Stop | Reads every bullet in order, highlighting the current bullet and word | Browser speech (works offline) |
| Start over | Back to screen 1 | |
| Sections | Up to four: Why you were in the hospital · Your medicines · What to do at home · Your follow-up visits | `output.summary.sections[] = {title, bullets[]}` |
| Bullet | Plain sentence + **"Where does this come from?"** toggle | `bullet = {id, text, sources[]}` |
| Source panel (per bullet) | One row per source: the original line from the papers · the FDA drug label summary · the meaning of a term · the hospital record entry · a memory conflict. Plus H-MEM ledger entries (created, conflict detected) | `sources[]` ids: `p1:L4`, `drug:x`, `term:X`, `record:N`, `conflict:…`; `output.scan`, `output.record.lookups`, `output.ledger[id]` |
| Fallback section | Replaces a section that failed the safety check: "Ask your care team about this part" + the original text | `output.fallback_sections[] = {title, original[]}` |
| When to get help | Red card: each warning sign with who to contact (911, the ER, your surgeon), and the same source toggle | `output.summary.call_911_if[]` |
| Medicine schedule | Table: medicine + dose, Morning, Midday, Evening, Bedtime, If needed, note | `output.summary.med_schedule[]` |
| Compared with your hospital record | Table: medicine, dose on papers, dose in record, tag: New · Changed · Stopped · Same as before · Not in hospital record · Not on your papers · **Check with care team** (open conflict) | `output.record.hospital_record_diff[]`, `output.record.matched_patient` |
| Questions to ask your doctor | List | `output.summary.questions_for_your_doctor[]` |
| Ask about your papers (Q&A) | Text box + Ask. Each answer shows the question, a plain answer (max 3 sentences) and a "Where does this come from?" toggle. If the papers don't cover it: "Your papers don't say. Please ask your care team." (styled as a caution). Takes ~10–30 s per question. | `POST /api/jobs/:id/ask {question}` → `{question, answer, sources[], answered, recalled[]}`; past answers in `job.qa[]` |
| How we made this | Models per agent (via Nightshift) with signed receipt ids · Zetaris data used · H-MEM conflicts · safety-check results and reading level by section · job id | `output.models[]`, `output.record`, `output.check` |
| Agent conversation (final) | The full message log | `job.messages[]` |

---

## States to design

- Nightshift offline or unauthorized (status pill + job error "Can't reach Meterless Nightshift…")
- Zetaris offline (no hospital-record comparison; drug and term explanations missing)
- Photo reading off (notice on the Photo tab; photo jobs fail with "paste the text instead")
- Page needs a rescan (back on screen 1 with the page number and reason)
- No hospital record matched ("We couldn't compare with a hospital record")
- Open conflict (a "check this dose with your care team" bullet + red tag in the comparison table)
- Safety check partial (banner + fallback section cards)
- Long running (progress screen for several minutes)

## Not built yet

- Read-aloud through Nightshift's `meterless/speech` (the browser voice is used now)
- Saving or sharing a summary; a history of past discharges (H-MEM already remembers them per patient)
