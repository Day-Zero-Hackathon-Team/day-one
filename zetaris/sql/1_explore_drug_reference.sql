-- Source 1: drug_reference (openFDA drug labels, ~200 common discharge drugs)
-- Exploratory questions the Lookup agent depends on.

-- Q1. How complete is the label data? (every drug needs a purpose to explain "what it's for")
SELECT COUNT(*) AS drugs,
       COUNT(DISTINCT generic_name) AS distinct_generics,
       SUM(CASE WHEN purpose IS NULL OR length(purpose) = 0 THEN 1 ELSE 0 END) AS missing_purpose,
       SUM(CASE WHEN boxed_warning IS NOT NULL AND length(boxed_warning) > 0 THEN 1 ELSE 0 END) AS with_boxed_warning
FROM DAY_ONE.drug_reference;

-- Q2. What does the furosemide label give us? (heart-failure sample case)
SELECT generic_name, brand_names, route, substr(purpose, 1, 120) AS purpose
FROM DAY_ONE.drug_reference
WHERE generic_name = 'furosemide';

-- Q3. Can a brand name on the papers be resolved to a generic? (patients often see "Lasix")
-- Finding: mostly not. Most labels we pulled are generic manufacturers' labels, so their
-- "brand" is just the generic name again; "Lasix", "Eliquis" and "Coumadin" match nothing.
SELECT SUM(CASE WHEN lower(brand_names) LIKE concat(generic_name, '%') THEN 1 ELSE 0 END) AS brand_is_just_the_generic,
       SUM(CASE WHEN lower(brand_names) NOT LIKE concat(generic_name, '%') THEN 1 ELSE 0 END) AS real_brand_name,
       SUM(CASE WHEN lower(brand_names) RLIKE 'lasix|eliquis|coumadin' THEN 1 ELSE 0 END) AS lasix_eliquis_coumadin_found
FROM DAY_ONE.drug_reference;

-- Q4. Which routes are covered? (oral vs. injection changes the plain-language wording)
SELECT route, COUNT(*) AS drugs
FROM DAY_ONE.drug_reference
GROUP BY route
ORDER BY drugs DESC
LIMIT 10;
