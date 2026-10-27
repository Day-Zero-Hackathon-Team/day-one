# 2c · Product requirement: Concept columns for the USL

**Author:** Day One team (written as a PM requirement for Zetaris) · **Status:** Proposed · **Mock:** [`zetaris/sql/8_mock_concept_resolution.sql`](../sql/8_mock_concept_resolution.sql), [`9_mock_concept_activate.sql`](../sql/9_mock_concept_activate.sql), results in [`zetaris/results/9_mock_concept_activate.md`](../results/9_mock_concept_activate.md)

## Problem

A semantic layer is meant to make different systems agree on what things *are*. Today the USL makes them agree on **column names**, but not on **values**.

In our layer, the hospital record says `Alendronic acid 10 MG Oral Tablet`, and the FDA drug label says `alendronate`. They are the same medicine, but the USL can't join them, so **874 of 3,216 medication orders (27%) fail our `has_drug_label` rule.** The same problem appears in every domain with a vocabulary:

- **Healthcare:** generic vs. brand vs. salt names (*Fosamax*, *alendronate sodium*, *alendronic acid*); ICD-10 vs. SNOMED; abbreviations with two meanings (our glossary had **CAP** = *capsule* **and** *community-acquired pneumonia*, until a DQ rule caught it).
- **Retail:** product codes that differ between ERP, e-commerce and supplier catalogues.
- **Finance:** counterparty names across trading, risk and KYC systems.

The workaround today is the one we wrote in [`5_usl_activate.sql`](../sql/5_usl_activate.sql): a hand-written, regex-based, window-ranked join, copied into every activation query that needs it. It's hard to write and review, and it's invisible to data quality: an unmatched value is just a `NULL`, and you can't tell "spelled differently" from "genuinely missing".

## The requirement

> **A USL column can be declared as a *concept*: a reference to a governed vocabulary. Zetaris resolves raw source values to that concept through declared synonyms at query time, records how each value was resolved, and reports anything unresolved or ambiguous as a data quality result.**

### Proposed DDL

```sql
COMPILE USL discharge_care DEPLOY NAMESPACE lightning.metastore.day_one DDL

CREATE TABLE drug (
  generic_name string PRIMARY KEY,
  brand_names  string
);

-- A vocabulary: governed synonyms for a concept. Rows can come from a source (here, every
-- openFDA brand name) and from curators, and each synonym must be unambiguous.
CREATE VOCABULARY drug_names FOR drug(generic_name) (
  SYNONYMS FROM drug EXPLODE brand_names,
  SYNONYMS ('alendronic acid' -> 'alendronate', 'vitamin b12' -> 'cyanocobalamin'),
  MATCH WHOLE WORD IGNORE CASE PREFER LONGEST
);

CREATE TABLE medication_order (
  patient_id   string FOREIGN KEY REFERENCES patient(patient_id),
  medication   string,
  -- New: the column's value is resolved from `medication` through the vocabulary.
  generic_name string CONCEPT drug_names RESOLVE FROM medication
);
```

`ACTIVATE` is unchanged: it supplies `medication`, and Zetaris fills `generic_name`.

### Behaviour

1. **Resolution at query time.** Matching runs in the engine, so it's pushed down and cached instead of being re-implemented in each activation query.
2. **Lineage per value.** Every concept column gets a hidden companion `<column>__resolved_by` (`exact`, `synonym:<source>`, `unresolved`), which can be queried.
3. **Automatic data quality.** Declaring a concept registers two rules, visible in `LIST DQ`:
   - `<column>_resolved`: the share of rows that resolved (our 874 → 692 below);
   - `<vocabulary>_unambiguous`: no synonym maps to two concepts (this is how CAP would have been caught at definition time).
4. **Unresolved values are actionable.** `SHOW DQ INVALID RECORD generic_name_resolved TABLE …` groups the unresolved values by frequency, giving curators a work queue.

### Success metrics

- A concept-resolved join takes **1 line of DDL** instead of a ~15-line ranking join in every activation query.
- Unresolved values are split into **naming gaps** (fixable with a synonym) and **coverage gaps** (missing reference data). Today they're the same `NULL`.
- No ambiguous synonym can reach a deployed USL.

## The mock (bonus)

We built the outcome of this feature with today's Zetaris: a second USL, `discharge_care_concepts`, with a synonym table and the resolution logic written by hand. Results from the live instance ([full output](../results/9_mock_concept_activate.md)):

| `has_drug_label` on the same 3,216 orders | Valid | Invalid |
| --- | --- | --- |
| Before: `discharge_care` (exact generic name only) | 2,342 | **874** |
| After: `discharge_care_concepts` (generic + 207 synonyms) | 2,524 | **692** |

| How each order resolved | Orders |
| --- | --- |
| generic name | 2,342 |
| curated synonym (just 3 of them) | 182 |
| unresolved: no drug label exists | 692 |

Three curated synonyms fixed 182 orders. What's left is now visibly a **coverage** gap: the remaining medicines (sodium fluoride gel, NPH insulin, tropicamide drops…) have no label in our 204-drug reference set. That's a different fix (add labels), and before this change the two problems looked identical. The synonym table passes its uniqueness rule (207/207). With the real feature, that rule and the resolution rule would exist without anyone writing them.

## Smaller requirements we hit along the way

These are not the headline, but each one cost us real time ([2a](2a-time-saved.md#what-cost-us-time)):

| # | Requirement | What happened to us |
| --- | --- | --- |
| R1 | **Return the full error over JDBC.** | `ACTIVATE` returned only `Schema mismatch for table …`. The useful part (`Column 'Id': nullable -> NOT NULL`, with a suggested `COALESCE` fix) was only in the driver container's log. |
| R2 | **Name the token in DDL errors.** | A reserved column name failed the whole compile with `Invalid DDL statement`, with no line or word given. |
| R3 | **Fix `RUN DQ` on `UNIQUE` constraints.** | `RUN DQ openfda_id TABLE …drug` → `java.util.NoSuchElementException: None.get`. PK and FK checks work. |
| R4 | **Document the USL SQL in the knowledge base.** | `COMPILE USL`, `ACTIVATE USL TABLE`, `REGISTER DQ`, `SHOW DQ INVALID RECORD` aren't in the Zetaris SQL manual; we found them in the open-source Lightning Catalog docs and the parser grammar. |
| R5 | **Column descriptions in DDL** (`COMMENT '…'`). | A semantic layer should carry definitions ("`is_active`: no stop date in the hospital record"); today they can only live in SQL comments. |
| R6 | **`SHOW DDL` for a USL.** | The grammar has it, but `SHOW DDL lightning.metastore.day_one.discharge_care` failed to parse, so the deployed model can't be round-tripped back to source. |
| R7 | **Nullable-by-default guidance.** | Declaring business keys `NOT NULL` (the natural thing to do) makes activation fail against almost any file source. Let `NOT NULL` be enforced as a DQ rule instead of a type check. |
