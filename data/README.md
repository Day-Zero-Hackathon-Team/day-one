# Datasets

The Lookup agent queries three datasets in Zetaris. Every teammate prepares them on their own laptop and loads them into their own Zetaris instance.

| Dataset | Source | Notes |
| --- | --- | --- |
| `drug_reference` | [openFDA](https://open.fda.gov/apis/drug/label/) drug labels | Generic and brand names, purpose, side effects, and warnings. Filtered to the ~200 common discharge drugs in [`common_drugs.txt`](common_drugs.txt). |
| `medical_terms` | Hand-made [`medical_terms.csv`](medical_terms.csv) (~200 terms: BID, PRN, CHF, …) | No good free dataset exists. Columns: `term, category, meaning, plain_language`. Add terms as you find them. |
| `hospital_records` | [Synthea](https://synthetichealth.github.io/synthea/) sample CSVs (`patients`, `encounters`, `medications`) | Synthetic patients with medication start and stop dates, which is what new / stopped / changed / continued needs. |

---

## Step 1 · Get the latest code

```bash
git clone https://github.com/Day-Zero-Hackathon-Team/day-one.git   # first time only
cd day-one
git pull
```

## Step 2 · Download the datasets (≈ 2 min)

You only need **Python 3** (no `pip install`).

```bash
python3 data/download_datasets.py
```

On Windows, use `py data\download_datasets.py`.

When it finishes you should have:

```
data/out/
├── drug_reference.csv          ~200 rows
├── medical_terms.csv           ~200 rows
└── hospital_records/
    ├── patients.csv
    ├── encounters.csv
    └── medications.csv
```

It's fine if the script says a few drugs had no openFDA label (mostly supplements like *multivitamin*). To redo just one dataset, run `--only drugs`, `--only terms`, or `--only synthea`.

<details>
<summary>If the Synthea download fails</summary>

Download the CSV sample zip by hand from the [Synthea sample data page](https://synthetichealth.github.io/synthea-sample-data/), save it as `data/downloads/synthea_sample_data_csv.zip`, and run `python3 data/download_datasets.py --only synthea` again.
</details>

`data/out/` and `data/downloads/` are git-ignored, so nobody commits the large files by accident.

## Step 3 · Make sure Zetaris is running

```bash
./preflight.sh
docker compose up -d
./verify.sh        # should confirm port 10000 is reachable
```

## Step 4 · Ask Claude to load the data into Zetaris

Open **Claude Code (or the Claude desktop app with Claude Code) in the `day-one` folder on your laptop**, so it can reach your local Zetaris. Then paste this prompt:

```text
Load our hackathon datasets into my local Zetaris instance.

- Zetaris is running locally (docker compose) and accepts JDBC on localhost:10000.
  The JDBC driver jar is in jdbc/. Check verify.sh / docker-compose.yml for the
  connection details and credentials.
- The data is in data/out/ (produced by data/download_datasets.py):
    data/out/drug_reference.csv               -> table drug_reference
    data/out/medical_terms.csv                -> table medical_terms
    data/out/hospital_records/patients.csv    -> table hospital_records_patients
    data/out/hospital_records/encounters.csv  -> table hospital_records_encounters
    data/out/hospital_records/medications.csv -> table hospital_records_medications
- All CSVs have a header row. Keep the column names as they are.
- Use whatever load method Zetaris supports best (e.g. registering the CSVs as a
  file data source, or CREATE TABLE + INSERT over JDBC). Write any helper script
  you create into scripts/ so teammates can reuse it.

When done, run a SELECT COUNT(*) on each table and compare it with the CSV row
counts, then run these spot checks and show me the results:
  SELECT * FROM drug_reference WHERE generic_name = 'furosemide';
  SELECT * FROM medical_terms WHERE term IN ('BID', 'PRN', 'CHF');
  SELECT * FROM hospital_records_medications LIMIT 5;
```

Claude will ask before running commands. Approve the ones that read files or talk to `localhost:10000`.

## Step 5 · Check off your laptop

When the spot checks return rows, post ✅ in the team chat. If the load script Claude wrote works, commit it (`scripts/`) so the next person can just run it.
