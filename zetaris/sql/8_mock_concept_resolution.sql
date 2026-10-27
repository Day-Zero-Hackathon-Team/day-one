-- MOCK of the improvement proposed in zetaris/docs/2c-make-the-usl-stronger.md: concept
-- columns that resolve synonyms. Built with today's Zetaris, as a second USL, to show the
-- outcome the feature would give.
--
-- The proposal is one line of DDL:
--
--   generic_name string CONCEPT drug RESOLVE FROM medication USING SYNONYMS drug_synonym
--
-- Today the same thing takes a synonym table plus a hand-written ranking join in every
-- activation query that needs it (below). The result: has_drug_label failures split into
-- "naming mismatch" (fixed by a synonym) and "no reference data" (needs a new drug label),
-- and an ambiguous synonym fails the synonym table's primary key, the way CAP once failed
-- the glossary's.

-- @ignore-error
REMOVE USL discharge_care_concepts NAMESPACE lightning.metastore.day_one;

COMPILE USL IF NOT EXISTS discharge_care_concepts DEPLOY NAMESPACE lightning.metastore.day_one DDL

CREATE TABLE IF NOT EXISTS drug (
  generic_name  string PRIMARY KEY,
  brand_names   string
);

CREATE TABLE IF NOT EXISTS drug_synonym (
  alias         string PRIMARY KEY,
  generic_name  string FOREIGN KEY REFERENCES drug(generic_name),
  origin        string
);

CREATE TABLE IF NOT EXISTS medication_order (
  patient_id    string,
  medication    string,
  generic_name  string FOREIGN KEY REFERENCES drug(generic_name),
  resolved_by   string
)
