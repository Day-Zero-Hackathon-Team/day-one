-- The Unified Semantic Layer (USL): `discharge_care`
--
-- One business model over three physical sources, named the way the app and a care team
-- talk about discharge, not the way each source happens to store it:
--
--   patient, encounter, medication_order  <- hospital_records (Synthea EHR)
--   drug                                  <- drug_reference (openFDA labels)
--   medical_term                          <- medical_terms (glossary CSV)
--
-- The constraints are the model's business rules. Zetaris turns each PRIMARY KEY, UNIQUE and
-- FOREIGN KEY into a data quality check that runs against the live sources (7_data_quality.sql).
-- The cross-source one, medication_order.generic_name -> drug.generic_name, asks "does every
-- medicine in the hospital record have a drug label we can explain it with?"
--
-- Columns are nullable on purpose: Zetaris rejects activating a NOT NULL column from a
-- nullable source column, and the key checks report null keys as invalid anyway.
--
-- The runner treats COMPILE USL as the rest of the file, so it must be the last statement.

-- Start clean so the whole layer can be rebuilt from this file.
-- @ignore-error
REMOVE USL discharge_care NAMESPACE lightning.metastore.day_one;

-- @ignore-error
CREATE NAMESPACE lightning.metastore;

-- @ignore-error
CREATE NAMESPACE lightning.metastore.day_one;

COMPILE USL IF NOT EXISTS discharge_care DEPLOY NAMESPACE lightning.metastore.day_one DDL

CREATE TABLE IF NOT EXISTS patient (
  patient_id   string PRIMARY KEY,
  first_name   string,
  last_name    string,
  birth_date   date,
  gender       string
);

CREATE TABLE IF NOT EXISTS encounter (
  encounter_id     string PRIMARY KEY,
  patient_id       string FOREIGN KEY REFERENCES patient(patient_id),
  encounter_class  string,
  started_at       timestamp,
  ended_at         timestamp,
  description      string,
  reason           string
);

CREATE TABLE IF NOT EXISTS drug (
  generic_name       string PRIMARY KEY,
  openfda_id         string UNIQUE,
  brand_names        string,
  route              string,
  purpose            string,
  side_effects       string,
  warnings           string,
  has_boxed_warning  boolean
);

CREATE TABLE IF NOT EXISTS medication_order (
  patient_id    string FOREIGN KEY REFERENCES patient(patient_id),
  encounter_id  string FOREIGN KEY REFERENCES encounter(encounter_id),
  rxnorm_code   int,
  medication    string,
  generic_name  string FOREIGN KEY REFERENCES drug(generic_name),
  started_at    timestamp,
  stopped_at    timestamp,
  is_active     boolean
);

CREATE TABLE IF NOT EXISTS medical_term (
  term            string PRIMARY KEY,
  category        string,
  meaning         string,
  plain_language  string
)
