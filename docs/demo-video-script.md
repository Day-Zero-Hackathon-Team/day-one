# Demo video script · 1:30 · safety story

Voice-over for the submission video. About 215 words, which is 90 seconds at a relaxed pace (~2.4 words a second). Record it first; the video gets cut to the audio.

**Demo input:** sample 1 (heart failure). Its papers say *continue carvedilol 12.5 mg*, but the Zetaris hospital record says 25 mg and nothing explains the change. That conflict is the spine of the story.

---

| Time | On screen | Voice-over |
| --- | --- | --- |
| **0:00–0:07** | Close-up of sample 1's raw text. Highlight `CHF`, `BID`, `PRN`, `12.5 mg`. | Leaving the hospital, you get pages like this. CHF. BID. PRN. Misread one dose, and you could end up right back in the hospital. |
| **0:07–0:14** | Landing page: *"Understand your hospital papers."* | Day One turns discharge papers into plain language, and it checks itself for safety before the patient reads a word. |
| **0:14–0:27** | Paste sample 1 → **Make it plain** → progress screen with the step list and agent conversation ticking (sped up). | Paste the text or upload the PDF. Agents take it from there. Scan numbers every line, Extract pulls out each medicine, and Lookup checks them against live hospital data in Zetaris. |
| **0:27–0:40** | Zetaris overlay: the three tables (`drug_reference`, `medical_terms`, `hospital_records`). Then a split: the paper line *Carvedilol 12.5 mg* vs the record row *25 mg*. | Zetaris joins FDA drug labels, a medical-terms list and the hospital record. And here's the catch. The papers say carvedilol, 12.5 milligrams. The record says 25. Nothing explains why. |
| **0:40–0:55** | Agent conversation: H-MEM's conflict message and the escalation to the Safety checker. Cut to the summary bullet *"Check this dose with your care team"* and the red **Check with care team** tag in the hospital-record table. | Our patient memory, built on the Meterless H-MEM engine, flags that conflict, and it never auto-resolves a dose. So the summary tells the patient: check this dose with your care team. |
| **0:55–1:10** | Pipeline diagram: Simplify → Safety checker, with the red *fail → retry ≤ 2* loop animating, then the fallback card *"Ask your care team about this part"*. End on the green safety banner and its reading grade. | Then a separate safety checker tests every bullet against its source: changed doses, missing warning signs, advice that isn't in the papers. If a bullet fails, it goes back for a rewrite. Still failing? The patient sees the original text instead. |
| **1:10–1:22** | Open **"Where does this come from?"** on a medicine bullet (source line + FDA label). Scroll to **How we made this**: Nemotron 3 Ultra per agent, receipt ids. | Every line answers "where does this come from?" And every model call runs through Meterless Nightshift on NVIDIA Nemotron, with a signed receipt naming the model. |
| **1:22–1:30** | Press **Read aloud** (words highlight). Ask *"Can I drink alcohol?"*, answer with sources. End card: Day One logo + team. | Plain words, read aloud, and nothing that isn't on your papers. Day One. Understand your hospital papers. |

---

## The voice-over on its own (for recording)

> Leaving the hospital, you get pages like this. CHF. BID. PRN. Misread one dose, and you could end up right back in the hospital.
>
> Day One turns discharge papers into plain language, and it checks itself for safety before the patient reads a word.
>
> Paste the text or upload the PDF. Agents take it from there. Scan numbers every line, Extract pulls out each medicine, and Lookup checks them against live hospital data in Zetaris.
>
> Zetaris joins FDA drug labels, a medical-terms list and the hospital record. And here's the catch. The papers say carvedilol, 12.5 milligrams. The record says 25. Nothing explains why.
>
> Our patient memory, built on the Meterless H-MEM engine, flags that conflict, and it never auto-resolves a dose. So the summary tells the patient: check this dose with your care team.
>
> Then a separate safety checker tests every bullet against its source: changed doses, missing warning signs, advice that isn't in the papers. If a bullet fails, it goes back for a rewrite. Still failing? The patient sees the original text instead.
>
> Every line answers "where does this come from?" And every model call runs through Meterless Nightshift on NVIDIA Nemotron, with a signed receipt naming the model.
>
> Plain words, read aloud, and nothing that isn't on your papers. Day One. Understand your hospital papers.

## Recording tips

- Pause about half a second at each paragraph break; those pauses become the cuts.
- Slow down on the numbers: *"twelve point five milligrams"* … *"twenty-five."* That's the moment the video holds on.
- Don't chase the timings. If the read runs to 1:35, the visuals are trimmed to fit.
- A quiet room and a phone held 15–20 cm away is fine. Export as WAV or high-quality M4A.

## Accuracy notes (so the claims hold up for judges)

- **Photos aren't claimed.** Photo reading needs a vision model in Nightshift that isn't set up yet, so the script says "paste the text or upload the PDF". If vision gets turned on before recording, change that line to "snap a photo".
- **The retry loop is shown as a diagram, not live.** In the recorded sample 1 run, the summary passes on the first try; the checker did flag one carvedilol bullet as added advice, and a second, focused look ruled it a false alarm. The "rewrite, then fall back to the original" behaviour is real code (`src/pipeline.ts`), but it doesn't fire in this sample.
- **Lisinopril vs carvedilol.** Lisinopril also differs from the record (40 mg → 20 mg), but the papers say it was decreased, so it isn't a conflict. Only the unexplained carvedilol change is flagged, which is why it's the example.
- **Read-aloud** uses the browser's voice, not Nightshift's speech route; the script doesn't claim otherwise.
