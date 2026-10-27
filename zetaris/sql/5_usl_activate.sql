-- Activate each USL table: bind the business model to the physical sources.
--
-- The activation query is where the semantic work happens, once, instead of in every
-- consumer: Synthea's cryptic column names become business names, the digits Synthea
-- appends to names are stripped, "has a boxed warning" becomes a boolean, glossary terms are
-- normalised to upper case, and each hospital medication is resolved to the openFDA generic
-- name it contains ("24 HR Metformin hydrochloride 500 MG ..." -> metformin).

ACTIVATE USL TABLE lightning.metastore.day_one.discharge_care.patient AS
SELECT Id                               AS patient_id,
       regexp_replace(FIRST, '[0-9]+$', '') AS first_name,
       regexp_replace(LAST, '[0-9]+$', '')  AS last_name,
       BIRTHDATE                        AS birth_date,
       GENDER                           AS gender
FROM DAY_ONE.hospital_records_patients;

ACTIVATE USL TABLE lightning.metastore.day_one.discharge_care.encounter AS
SELECT Id                AS encounter_id,
       PATIENT           AS patient_id,
       ENCOUNTERCLASS    AS encounter_class,
       START             AS started_at,
       STOP              AS ended_at,
       DESCRIPTION       AS description,
       REASONDESCRIPTION AS reason
FROM DAY_ONE.hospital_records_encounters;

ACTIVATE USL TABLE lightning.metastore.day_one.discharge_care.drug AS
SELECT generic_name,
       id             AS openfda_id,
       brand_names,
       route,
       purpose,
       side_effects,
       warnings,
       (boxed_warning IS NOT NULL AND length(boxed_warning) > 0) AS has_boxed_warning
FROM DAY_ONE.drug_reference;

ACTIVATE USL TABLE lightning.metastore.day_one.discharge_care.medication_order AS
SELECT m.PATIENT        AS patient_id,
       m.ENCOUNTER      AS encounter_id,
       m.CODE           AS rxnorm_code,
       m.DESCRIPTION    AS medication,
       r.generic_name,
       m.START          AS started_at,
       m.STOP           AS stopped_at,
       (m.STOP IS NULL) AS is_active
FROM DAY_ONE.hospital_records_medications m
LEFT JOIN (
  -- Longest generic name found as a whole word in the description wins
  -- ("amoxicillin and clavulanate" over "amoxicillin").
  SELECT description, generic_name FROM (
    SELECT md.DESCRIPTION AS description, d.generic_name,
           row_number() OVER (PARTITION BY md.DESCRIPTION ORDER BY length(d.generic_name) DESC, d.generic_name) AS rn
    FROM (SELECT DISTINCT DESCRIPTION FROM DAY_ONE.hospital_records_medications) md
    JOIN DAY_ONE.drug_reference d
      ON lower(md.DESCRIPTION) RLIKE concat('(^|[^a-z])', d.generic_name, '([^a-z]|$)')
  ) ranked
  WHERE rn = 1
) r ON r.description = m.DESCRIPTION;

ACTIVATE USL TABLE lightning.metastore.day_one.discharge_care.medical_term AS
SELECT upper(trim(term)) AS term,
       category,
       meaning,
       plain_language
FROM DAY_ONE.medical_terms;
