-- Queries that show the USL is active: they read only the business model
-- (lightning.metastore.day_one.discharge_care.*), never a physical table.

-- Q1. The layer and its activation state, as Zetaris reports it.
SHOW NAMESPACES OR TABLES IN lightning.metastore.day_one.discharge_care;

-- Q2. A discharged patient's active medicines, explained: hospital record (Synthea) joined to
-- drug labels (openFDA) in one query, in business terms. This is what the Lookup agent needs.
SELECT p.first_name, p.last_name, mo.medication, mo.generic_name,
       d.has_boxed_warning, substr(d.purpose, 1, 80) AS purpose
FROM lightning.metastore.day_one.discharge_care.medication_order mo
JOIN lightning.metastore.day_one.discharge_care.patient p ON p.patient_id = mo.patient_id
LEFT JOIN lightning.metastore.day_one.discharge_care.drug d ON d.generic_name = mo.generic_name
WHERE mo.is_active
  AND mo.patient_id = (SELECT patient_id FROM lightning.metastore.day_one.discharge_care.encounter
                       WHERE encounter_class = 'inpatient' ORDER BY ended_at DESC LIMIT 1)
ORDER BY mo.generic_name;

-- Q3. What changed at each inpatient discharge: medicines started during the stay are "new",
-- medicines that stopped during it are "stopped". The app's med-list diff, as one query.
SELECT e.encounter_id, e.ended_at AS discharged_at, mo.generic_name, mo.medication,
       CASE WHEN mo.started_at >= e.started_at THEN 'new' ELSE 'stopped' END AS change
FROM lightning.metastore.day_one.discharge_care.encounter e
JOIN lightning.metastore.day_one.discharge_care.medication_order mo
  ON mo.patient_id = e.patient_id
 AND ((mo.started_at BETWEEN e.started_at AND e.ended_at)
      OR (mo.stopped_at BETWEEN e.started_at AND e.ended_at))
WHERE e.encounter_class = 'inpatient'
ORDER BY e.ended_at DESC
LIMIT 15;

-- Q4. Which hospital medicines can't be explained yet (no matching drug label)?
-- Drives what to add to data/common_drugs.txt next.
SELECT mo.medication, COUNT(*) AS orders, SUM(CASE WHEN mo.is_active THEN 1 ELSE 0 END) AS active
FROM lightning.metastore.day_one.discharge_care.medication_order mo
WHERE mo.generic_name IS NULL
GROUP BY mo.medication
ORDER BY orders DESC
LIMIT 10;
