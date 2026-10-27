# Datasets

The Lookup agent queries three datasets in Zetaris. Every teammate prepares them on their own laptop and loads them into their own Zetaris instance.

| Dataset | Source | Licence | Notes |
| --- | --- | --- | --- |
| `drug_reference` | [openFDA](https://open.fda.gov/apis/drug/label/) drug labels | Public domain ([CC0 1.0](https://open.fda.gov/license/)) | Generic and brand names, purpose, side effects, and warnings. Filtered to the ~200 common discharge drugs in [`common_drugs.txt`](common_drugs.txt). |
| `medical_terms` | Hand-made [`medical_terms.csv`](medical_terms.csv) (~200 terms: BID, PRN, CHF, …) | Written by the team for this project | No good free dataset exists. Columns: `term, category, meaning, plain_language`. Add terms as you find them. |
| `hospital_records` | [Synthea](https://synthetichealth.github.io/synthea/) sample CSVs (`patients`, `encounters`, `medications`) | [Apache 2.0](https://github.com/synthetichealth/synthea/blob/master/LICENSE); fully synthetic, no real patients | Synthetic patients with medication start and stop dates, which is what new / stopped / changed / continued needs. |

All of it is downloaded or built automatically by [`download_datasets.py`](download_datasets.py), with no login (see below). The three sample discharge summaries in [`samples/inputs/`](../samples/inputs/) and the PDF in [`samples/pdf/`](../samples/pdf/) are synthetic, written by the team for Synthea patients. No real patient data is used anywhere.

---

## Step 1 · Get the latest code

```bash
git clone https://github.com/Day-Zero-Hackathon-Team/day-one.git   # first time only
cd day-one
git pull
```

## Step 2 · Download the datasets (≈ 6 min)

You only need **Python 3** (no `pip install`).

```bash
python3 data/download_datasets.py
```

On Windows, use `py data\download_datasets.py`.

> **Mac: `CERTIFICATE_VERIFY_FAILED`?** Python from python.org ships without security certificates, so every download fails. Fix it once by double-clicking **Install Certificates.command** in `/Applications/Python 3.x/` (the folder for your version), then run the script again.

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

From your Zetaris folder (the unzipped `zetaris-platform`, not `day-one`):

```bash
./preflight.sh
docker compose up -d
./verify.sh        # all checks should PASS
```

On a Mac with 8 GB of RAM, `preflight.sh` fails until Docker has at least 6 GB: Docker Desktop → Settings → Resources → Memory → 7 GB, and turn on Rosetta under Settings → General.

## Step 4 · Load the data into Zetaris

Back in `day-one`:

```bash
scripts/load_to_zetaris.sh
```

It needs Java 11+ (`java -version`). It finds your Zetaris folder (next to `day-one`, in your home folder, or in `~/Downloads`; otherwise set `ZETARIS_DIR=/path/to/zetaris-platform`) and reads the login from that folder's `.env`. If you changed the admin password in the web interface, set `ZETARIS_PASSWORD` first.

It registers each CSV the same way Zetaris registers its own sample data: as a Lightning filestore table that reads the file directly. It finishes by comparing every table's row count with its CSV. It is safe to re-run after downloading new data.

**Tables live in the Lightning database `DAY_ONE`, so always write `DAY_ONE.<table>`.** Zetaris does not resolve bare names, even after `USE DAY_ONE`.

| CSV | Table |
| --- | --- |
| `drug_reference.csv` | `DAY_ONE.drug_reference` |
| `medical_terms.csv` | `DAY_ONE.medical_terms` |
| `hospital_records/patients.csv` | `DAY_ONE.hospital_records_patients` |
| `hospital_records/encounters.csv` | `DAY_ONE.hospital_records_encounters` |
| `hospital_records/medications.csv` | `DAY_ONE.hospital_records_medications` |

Spot checks (any SQL works the same way):

```bash
scripts/load_to_zetaris.sh sql \
  "SELECT * FROM DAY_ONE.drug_reference WHERE generic_name = 'furosemide'" \
  "SELECT * FROM DAY_ONE.medical_terms WHERE term IN ('BID', 'PRN', 'CHF')" \
  "SELECT * FROM DAY_ONE.hospital_records_medications LIMIT 5"
```

## Step 5 · Check off your laptop

When every row count says `OK` and the spot checks return rows, post ✅ in the team chat.
