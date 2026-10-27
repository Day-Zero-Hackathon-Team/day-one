# 1a · Use case and data sources

## The use case

**Day One** turns a patient's hospital discharge papers into a plain-language summary they can read or listen to: what happened, which medicines to take and when, and when to call 911. A pipeline of AI agents does the rewriting, and a separate safety checker verifies every sentence against the original papers before the patient sees it.

The AI can't be trusted to know facts about medicines or to guess what changed in a patient's medicine list. Those facts have to come from data, which is where Zetaris comes in. For every discharge, the Lookup agent needs to answer three questions:

| Question | Why the patient needs it | Data source |
| --- | --- | --- |
| *What is this medicine for, and what should I watch out for?* | "Furosemide 40 mg BID" means nothing to most people; "a water pill, twice a day" does. Boxed warnings must not be dropped. | openFDA drug labels |
| *What does this jargon mean?* | Discharge papers are full of abbreviations (BID, PRN, CHF, CAP) that patients misread. | Medical terms glossary |
| *What changed?* | The most dangerous discharge error is confusion over which medicines are **new**, **stopped** or **changed** compared with what the patient took before. | Hospital records (EHR) |

## The three data sources

| # | Source | What it is | How it gets into Zetaris | Physical tables |
| --- | --- | --- | --- | --- |
| 1 | **openFDA drug labels** ([open.fda.gov](https://open.fda.gov/apis/drug/label/)) | Public FDA label data for the ~200 most common discharge drugs: generic and brand names, purpose, side effects, warnings, boxed warnings, route | `data/download_datasets.py` pulls the labels from the openFDA API → CSV → Lightning filestore table | `DAY_ONE.drug_reference` (204 rows) |
| 2 | **Medical terms glossary** | Hand-built, because no good free dataset exists: abbreviation, category, clinical meaning, plain-language meaning | `data/medical_terms.csv` → Lightning filestore table | `DAY_ONE.medical_terms` (197 rows) |
| 3 | **Hospital records** ([Synthea](https://synthetichealth.github.io/synthea/)) | A synthetic EHR: patients, encounters (inpatient stays, ER visits…), medication orders with start and stop dates. It stands in for the enterprise system and means the demo never touches real patient data. | Synthea sample CSVs → three Lightning filestore tables | `DAY_ONE.hospital_records_patients` (111), `_encounters` (5,059), `_medications` (3,216) |

The three sources come from different origins, are owned by different parties, use different vocabularies, and change at different rates:

| | openFDA | Glossary | Hospital records |
| --- | --- | --- | --- |
| Owner | FDA (public) | Our team | The hospital |
| Names a medicine as | `furosemide` | — | `10 ML Furosemide 10 MG/ML Injection` |
| Naming style | lower-case generic | upper-case abbreviation | `Id`, `FIRST`, `BIRTHDATE`, digits appended to names |
| Changes | when labels are revised | by hand | every admission |

Joining them is the hard part, and that is the work the Unified Semantic Layer does ([1c](../README.md#1c--the-usl)).

## Where it's used in the app

`src/agents/lookup.ts` → `src/zetaris.ts` runs fixed, allowlisted lookups against these tables over JDBC, and the results feed the Simplify agent (plain-language explanations) and the Safety checker (warnings that must not be dropped). See the [architecture diagram](../../README.md#how-it-works).
