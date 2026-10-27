# 2a · How the USL saved us time vs. a hand-coded approach

> Draft for the team to edit into their own words; the numbers and file references are from this repo.

## Short answer

Building the USL took about as many lines as hand-coding the same slice. The time saving comes from what we got without writing more: **data quality checks generated from the model, one set of business names for every consumer, and results computed on the live sources instead of a snapshot.** We lost time to USL syntax that isn't documented, which [2c](2c-make-the-usl-stronger.md) turns into product requirements.

## The comparison we actually ran

We built the same slice of work both ways and checked that they agree (bonus):

- **USL:** [`zetaris/sql/4_usl_ddl.sql`](../sql/4_usl_ddl.sql), [`5_usl_activate.sql`](../sql/5_usl_activate.sql), [`7_data_quality.sql`](../sql/7_data_quality.sql)
- **Hand-coded:** [`zetaris/handcoded/compare.ts`](../handcoded/compare.ts), plain TypeScript over the raw CSVs

| Check | USL (`RUN DQ`) | Hand-coded |
| --- | --- | --- |
| Glossary term is unique (`medical_term.term`) | 198 total · 196 valid · **2 invalid** (before the fix; 197 · 197 · 0 after) | 198 · 196 · **2** (197 · 197 · 0 after) |
| Encounter points at a real patient | 5,059 · 5,059 · 0 | 5,059 · 5,059 · 0 |
| Medicine doesn't stop before it starts | 3,216 · 3,216 · 0 | 3,216 · 3,216 · 0 |
| Hospital medicine has a drug label | 3,216 · 2,342 · **874** | 3,216 · 2,342 · **874** |

The numbers are identical, so each approach checks the other. Both found the same two real problems: the glossary defined **CAP** twice (*capsule* and *community-acquired pneumonia*, which is the diagnosis in our pneumonia sample; since fixed), and **874 hospital medication orders** have no drug label to explain them with.

## Where the time went

| | Hand-coded | USL |
| --- | --- | --- |
| Model + mapping (rename columns, strip Synthea's digits, resolve medicine → generic name) | ~45 lines of TS, including a CSV parser for openFDA's multi-line quoted fields | 5 `CREATE TABLE`s + 5 `ACTIVATE` queries (~110 lines of SQL) |
| Key and reference checks | Written per check (`primaryKey()`, `check()`); we wrote 2 | **8 generated from the DDL** (`LIST DQ` shows every PK, UNIQUE and FK), 0 extra lines |
| Business rules | A lambda each | One `REGISTER DQ … AS <expression>` each |
| Seeing *which* rows failed | More code | `SHOW DQ INVALID RECORD <rule> TABLE <t>` |
| Runs against | A CSV snapshot in `data/out/` | The live sources, through Zetaris |
| Reuse by the next consumer | Copy the code | Query `discharge_care.*` |

The hand-coded version wins on raw speed for one-off checks: it runs in under a second, where each Zetaris statement takes a few seconds. It loses as soon as the work has to be repeated: every new consumer, every new check, or a source that isn't a local CSV.

## What the app hand-codes today that the USL replaces

The production Lookup path ([`src/zetaris.ts`](../../src/zetaris.ts), [`src/agents/lookup.ts`](../../src/agents/lookup.ts)) is a hand-coded approach, and it shows the cost:

- Physical Synthea column names (`Id`, `FIRST`, `BIRTHDATE`, `PATIENT`, `START`, `STOP`) are hard-coded into SQL strings and TypeScript.
- `recordDrugName()` is a hand-written regex that turns `"24 HR metoprolol succinate 100 MG …"` into a drug name. The USL resolves it once, in `medication_order.generic_name`, for everyone.
- "Is this medicine active?" is `!r.STOP` in TS; in the USL it's the column `is_active`.
- The new / stopped diff is ~30 lines of TS in `ground()`. [`6_usl_queries.sql`](../sql/6_usl_queries.sql) Q3 gets the hospital side of it in one query.
- None of the data quality findings above were visible from the app code. The CAP duplicate was silently passing both meanings to the AI until the DQ rule caught it.

## What cost us time

We'd be overstating the saving if we left these out:

- **The USL syntax is not in the Zetaris knowledge base.** `COMPILE USL`, `ACTIVATE USL TABLE`, `REGISTER DQ` and `SHOW DQ INVALID RECORD` came from the open-source Lightning Catalog docs and from reading the parser grammar in the driver jar.
- **`ACTIVATE` failed with "Schema mismatch" and no detail over JDBC.** The real cause (a `NOT NULL` column fed from a nullable source) was only in the driver container's log.
- **A reserved column name (`synonym` or `source`) failed the whole compile** with "Invalid DDL statement" and no position.
- **`RUN DQ` on a `UNIQUE` constraint crashes** (`NoSuchElementException: None.get`).

Once we knew the syntax, rebuilding the whole layer and re-running every check became one command: `npm run zetaris:usl`.
