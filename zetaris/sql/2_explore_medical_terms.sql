-- Source 2: medical_terms (hand-built glossary of discharge jargon and abbreviations)

-- Q1. What kinds of jargon does the glossary cover?
SELECT category, COUNT(*) AS terms
FROM DAY_ONE.medical_terms
GROUP BY category
ORDER BY terms DESC;

-- Q2. Translate the abbreviations from the heart-failure sample.
SELECT term, meaning, plain_language
FROM DAY_ONE.medical_terms
WHERE upper(term) IN ('BID', 'PRN', 'CHF', 'PO', 'SOB');

-- Q3. Is any term defined twice? (two definitions means the patient could get either one)
SELECT upper(term) AS term, COUNT(*) AS definitions
FROM DAY_ONE.medical_terms
GROUP BY upper(term)
HAVING COUNT(*) > 1;
