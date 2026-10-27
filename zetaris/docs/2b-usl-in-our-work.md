# 2b · Where the USL would help us, and where it wouldn't

> Draft for the team to edit. Each teammate may want to add a paragraph about their own day job.

## Where it helps

**1. A stable contract between the agents and the data.** Our agents shouldn't know that Synthea calls a patient's first name `FIRST` and appends digits to it, or that a medicine is active when `STOP` is empty. Today they do ([2a](2a-time-saved.md#what-the-app-hand-codes-today-that-the-usl-replaces)). If the Lookup agent queried `discharge_care.patient` / `medication_order` / `drug` instead, swapping Synthea for a real EHR would change five activation queries and no application code.

**2. Data quality as a release gate.** We found two problems in data we'd been using all week, in one run of `7_data_quality.sql`:
- the glossary gave **CAP** two meanings, one of which ("capsule") is wrong for our pneumonia patient (fixed the same day: one row now explains both, with a test against repeats);
- **27% of hospital medication orders** (874 of 3,216) can't be explained because no drug label matches them.

For a safety-critical app, "run the DQ suite before a data refresh goes live" is a rule we'd adopt immediately. A rule like `has_drug_label` is also a product metric: it tells us which labels to add next ([`6_usl_queries.sql`](../sql/6_usl_queries.sql) Q4).

**3. One vocabulary for people as well as code.** The pharmacist reviewing our drug mapping, the judge reading this repo and the agent writing SQL all see `medication_order.generic_name`. The physical names are cryptic, and only one of us knew what they meant.

**4. Federation without copying.** The hospital record would really live in the hospital's systems. The USL lets the app join it with public drug labels in place instead of building an ETL copy of patient data, and keeping patient data where it already lives is the privacy posture a hospital will ask for.

## Where it doesn't help (or hurts)

**1. The hardest part of our problem isn't tabular.** Reading a photographed discharge summary, extracting doses correctly and checking an AI rewrite against the source are text and vision problems. The USL makes the *reference* data trustworthy; it does nothing for the discharge papers themselves.

**2. Latency on the request path.** Each lookup from the app runs as a Spark query over JDBC, a few seconds each. That's fine inside our 3-6 minute pipeline, but for the interactive Q&A feature we'd want the USL to materialize the small reference tables (`MATERIALIZE USL TABLE … TO STORAGE`) or cache them in the app.

**3. Overhead at our size.** For five CSVs and one team, a script is faster to write than a semantic layer. The USL pays off with a second consumer, a second source system, or a requirement to prove data quality, and in healthcare you meet all three quickly.

**4. Tooling friction.** The USL DDL couldn't be discovered from inside the product, and errors were vague over JDBC. Until that's fixed ([2c](2c-make-the-usl-stronger.md)), the first USL a team builds will take longer than it should.

## Bonus · A project that would benefit, and the time it would save

**Project: Day One for a regional health network.** Five hospitals, each with a different EHR (for example Epic, Oracle Health/Cerner, Meditech, a FHIR bulk export, and one legacy system), want Day One for their discharged patients. Every hospital stores patients, encounters and medication orders differently, and each needs its own data quality sign-off before go-live.

**Without a USL**, each hospital needs a custom adapter: column mapping, medicine-name normalisation (the `recordDrugName()` problem, once per EHR), the active/stopped logic, re-implemented quality checks, and app fixes wherever physical names leaked through.

**With the USL**, the `discharge_care` model, its constraints and its business rules stay fixed. Each hospital gets five `ACTIVATE USL TABLE` queries, and the existing DQ suite tells us whether the mapping is right.

Forecast, in developer-days. **These are our estimates, not measurements**, based on the effort split we saw building one source here:

| Work item | Hand-coded, per hospital | USL, per hospital |
| --- | --- | --- |
| Map the EHR's tables and columns to our model | 3 | 1.5 (5 activation queries) |
| Medicine-name normalisation for that EHR's format | 1.5 | 0.5 (edit the resolution join) |
| Data quality checks | 2 (adapt and re-test) | 0.5 (re-run the existing suite, fix the mapping) |
| App changes where physical names leak in | 1 | 0 |
| Regression testing | 1.5 | 0.5 |
| **Per hospital** | **9** | **3** |
| One-time cost | — | 4 (design the USL and DQ suite; mostly done in this repo) |
| **Five hospitals** | **45** | **19** |

**Forecast saving: about 26 developer-days (~58%) for five hospitals**, growing with each hospital after that (6 days saved each). The biggest single item isn't in the table: when a hospital's data is wrong, the DQ suite says so before a patient gets a summary built on it.
