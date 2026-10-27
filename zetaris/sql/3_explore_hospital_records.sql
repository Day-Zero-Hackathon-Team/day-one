-- Source 3: hospital_records (Synthea synthetic EHR: patients, encounters, medications)

-- Q1. How big is the hospital record, and how many medicines are still active?
SELECT (SELECT COUNT(*) FROM DAY_ONE.hospital_records_patients) AS patients,
       (SELECT COUNT(*) FROM DAY_ONE.hospital_records_encounters) AS encounters,
       COUNT(*) AS medication_orders,
       SUM(CASE WHEN STOP IS NULL THEN 1 ELSE 0 END) AS active_orders
FROM DAY_ONE.hospital_records_medications;

-- Q2. Which encounters are hospital stays that end in a discharge?
SELECT ENCOUNTERCLASS, COUNT(*) AS encounters
FROM DAY_ONE.hospital_records_encounters
GROUP BY ENCOUNTERCLASS
ORDER BY encounters DESC;

-- Q3. What are the most-prescribed medicines? (the names Lookup must match to a drug label)
SELECT DESCRIPTION, COUNT(*) AS orders
FROM DAY_ONE.hospital_records_medications
GROUP BY DESCRIPTION
ORDER BY orders DESC
LIMIT 10;

-- Q4. Medication history for one inpatient (what new / stopped / changed is computed from)
SELECT m.START, m.STOP, m.DESCRIPTION
FROM DAY_ONE.hospital_records_medications m
WHERE m.PATIENT = (SELECT PATIENT FROM DAY_ONE.hospital_records_encounters WHERE ENCOUNTERCLASS = 'inpatient' ORDER BY START DESC LIMIT 1)
ORDER BY m.START DESC
LIMIT 10;
