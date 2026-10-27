-- Data quality on the USL.
--
-- Two kinds: the constraints declared in the DDL (PRIMARY KEY, UNIQUE, FOREIGN KEY), which
-- Zetaris registers automatically, and business rules written as SQL expressions. Each RUN DQ
-- executes against the live sources and reports valid / invalid record counts.

-- Every rule registered on the layer (the DDL constraints appear here without any extra step).
LIST DQ USL lightning.metastore.day_one.discharge_care;

-- Business rules. Removed first so this file can be re-run.
-- @ignore-error
REMOVE DQ drug_explains_purpose TABLE lightning.metastore.day_one.discharge_care.drug;
REGISTER DQ drug_explains_purpose TABLE lightning.metastore.day_one.discharge_care.drug AS
purpose IS NOT NULL AND length(trim(purpose)) > 0;

-- @ignore-error
REMOVE DQ term_has_plain_language TABLE lightning.metastore.day_one.discharge_care.medical_term;
REGISTER DQ term_has_plain_language TABLE lightning.metastore.day_one.discharge_care.medical_term AS
plain_language IS NOT NULL AND length(trim(plain_language)) > 0;

-- @ignore-error
REMOVE DQ stop_not_before_start TABLE lightning.metastore.day_one.discharge_care.medication_order;
REGISTER DQ stop_not_before_start TABLE lightning.metastore.day_one.discharge_care.medication_order AS
stopped_at IS NULL OR stopped_at >= started_at;

-- @ignore-error
REMOVE DQ has_drug_label TABLE lightning.metastore.day_one.discharge_care.medication_order;
REGISTER DQ has_drug_label TABLE lightning.metastore.day_one.discharge_care.medication_order AS
generic_name IS NOT NULL;

LIST DQ USL lightning.metastore.day_one.discharge_care;

-- Run them. Business rules:
RUN DQ drug_explains_purpose TABLE lightning.metastore.day_one.discharge_care.drug;
RUN DQ term_has_plain_language TABLE lightning.metastore.day_one.discharge_care.medical_term;
RUN DQ stop_not_before_start TABLE lightning.metastore.day_one.discharge_care.medication_order;
RUN DQ has_drug_label TABLE lightning.metastore.day_one.discharge_care.medication_order;

-- Constraints from the DDL:
RUN DQ patient_id TABLE lightning.metastore.day_one.discharge_care.patient;
RUN DQ patient_id TABLE lightning.metastore.day_one.discharge_care.encounter;
RUN DQ generic_name TABLE lightning.metastore.day_one.discharge_care.drug;
RUN DQ generic_name TABLE lightning.metastore.day_one.discharge_care.medication_order;
RUN DQ term TABLE lightning.metastore.day_one.discharge_care.medical_term;
-- (RUN DQ openfda_id, the UNIQUE constraint on drug, fails inside Zetaris 2.4.3.1 with
-- "java.util.NoSuchElementException: None.get"; see zetaris/docs/2c-make-the-usl-stronger.md.)

-- Drill into the failures: which records broke the rule?
-- This found CAP defined twice (capsule / community-acquired pneumonia); now fixed, so 0 rows.
SHOW DQ INVALID RECORD term TABLE lightning.metastore.day_one.discharge_care.medical_term;

-- Hospital medicines with no drug label, e.g. "Alendronic acid" where openFDA says "alendronate".
SHOW DQ INVALID RECORD has_drug_label TABLE lightning.metastore.day_one.discharge_care.medication_order;
