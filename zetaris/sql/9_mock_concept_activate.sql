-- MOCK, part 2: activate and measure the synonym-aware layer (see 8_mock_concept_resolution.sql).

ACTIVATE USL TABLE lightning.metastore.day_one.discharge_care_concepts.drug AS
SELECT generic_name, brand_names FROM DAY_ONE.drug_reference;

-- Synonyms: every openFDA brand name, plus a curated crosswalk for names the hospital record
-- uses that openFDA doesn't (the feature would let a clinician maintain this list in the USL).
ACTIVATE USL TABLE lightning.metastore.day_one.discharge_care_concepts.drug_synonym AS
SELECT lower(trim(brand)) AS alias, generic_name, 'openfda brand' AS origin
FROM DAY_ONE.drug_reference LATERAL VIEW explode(split(brand_names, ',')) b AS brand
WHERE brand_names IS NOT NULL AND length(trim(brand)) > 0
UNION ALL
SELECT alias, generic_name, 'curated' AS origin
FROM VALUES ('alendronic acid', 'alendronate'),
            ('vitamin b12', 'cyanocobalamin'),
            ('sulfamethoxazole', 'sulfamethoxazole and trimethoprim') AS crosswalk(alias, generic_name);

-- Resolution: a generic name in the description wins, then the longest synonym.
ACTIVATE USL TABLE lightning.metastore.day_one.discharge_care_concepts.medication_order AS
SELECT m.PATIENT AS patient_id, m.DESCRIPTION AS medication, r.generic_name, r.resolved_by
FROM DAY_ONE.hospital_records_medications m
LEFT JOIN (
  SELECT description, generic_name, resolved_by FROM (
    SELECT md.DESCRIPTION AS description, c.generic_name, c.resolved_by,
           row_number() OVER (PARTITION BY md.DESCRIPTION ORDER BY c.priority, length(c.phrase) DESC, c.phrase) AS rn
    FROM (SELECT DISTINCT DESCRIPTION FROM DAY_ONE.hospital_records_medications) md
    JOIN (
      SELECT generic_name AS phrase, generic_name, 'generic name' AS resolved_by, 1 AS priority FROM DAY_ONE.drug_reference
      UNION ALL
      SELECT lower(trim(brand)), generic_name, 'openfda brand', 2
      FROM DAY_ONE.drug_reference LATERAL VIEW explode(split(brand_names, ',')) b AS brand
      WHERE brand_names IS NOT NULL AND length(trim(brand)) > 3
      UNION ALL
      SELECT alias, generic_name, 'curated synonym', 2
      FROM VALUES ('alendronic acid', 'alendronate'),
                  ('vitamin b12', 'cyanocobalamin'),
                  ('sulfamethoxazole', 'sulfamethoxazole and trimethoprim') AS crosswalk(alias, generic_name)
    ) c ON lower(md.DESCRIPTION) RLIKE concat('(^|[^a-z0-9])', c.phrase, '([^a-z0-9]|$)')
  ) ranked
  WHERE rn = 1
) r ON r.description = m.DESCRIPTION;

-- @ignore-error
REMOVE DQ has_drug_label TABLE lightning.metastore.day_one.discharge_care_concepts.medication_order;
REGISTER DQ has_drug_label TABLE lightning.metastore.day_one.discharge_care_concepts.medication_order AS
generic_name IS NOT NULL;

-- Before (discharge_care) vs. after (discharge_care_concepts): same rule, same records.
RUN DQ has_drug_label TABLE lightning.metastore.day_one.discharge_care.medication_order;
RUN DQ has_drug_label TABLE lightning.metastore.day_one.discharge_care_concepts.medication_order;

-- How each order was resolved, and what is left: a coverage gap, not a naming gap.
SELECT coalesce(resolved_by, 'unresolved: no drug label') AS resolved_by, COUNT(*) AS orders
FROM lightning.metastore.day_one.discharge_care_concepts.medication_order
GROUP BY resolved_by
ORDER BY orders DESC;

-- Is any synonym ambiguous (one name, two drugs)?
RUN DQ alias TABLE lightning.metastore.day_one.discharge_care_concepts.drug_synonym;
SHOW DQ INVALID RECORD alias TABLE lightning.metastore.day_one.discharge_care_concepts.drug_synonym;
