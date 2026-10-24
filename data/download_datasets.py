#!/usr/bin/env python3
"""Download and prepare the three datasets the Lookup agent queries in Zetaris.

    python3 data/download_datasets.py            # all three
    python3 data/download_datasets.py --only drugs
    python3 data/download_datasets.py --only terms
    python3 data/download_datasets.py --only synthea

Output goes to data/out/:

    drug_reference.csv            openFDA drug labels, one row per drug in common_drugs.txt
    medical_terms.csv             copy of the hand-made data/medical_terms.csv
    hospital_records/patients.csv     Synthea sample data
    hospital_records/encounters.csv
    hospital_records/medications.csv

Standard library only. Set OPENFDA_API_KEY to raise openFDA's rate limit (optional).
"""

import argparse
import csv
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
DOWNLOADS = os.path.join(HERE, "downloads")

OPENFDA_LABEL_URL = "https://api.fda.gov/drug/label.json"
SYNTHEA_URLS = [
    "https://synthetichealth.github.io/synthea-sample-data/downloads/latest/synthea_sample_data_csv_latest.zip",
    "https://synthetichealth.github.io/synthea-sample-data/downloads/synthea_sample_data_csv_apr2020.zip",
]
SYNTHEA_TABLES = ["patients.csv", "encounters.csv", "medications.csv"]

# Long label sections are cut to this many characters so the CSV stays small.
MAX_TEXT = 2000

DRUG_COLUMNS = [
    "id", "generic_name", "brand_names", "purpose", "side_effects",
    "warnings", "boxed_warning", "route", "openfda_set_id",
]


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "day-one-hackathon/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def section(label, *keys):
    """Return the first non-empty label section among keys, joined and trimmed."""
    for key in keys:
        value = label.get(key)
        if value:
            text = " ".join(value) if isinstance(value, list) else str(value)
            text = " ".join(text.split())
            return text[:MAX_TEXT]
    return ""


def label_score(label):
    """Prefer labels that have the sections the Simplify agent needs."""
    return sum(bool(label.get(k)) for k in (
        "indications_and_usage", "purpose", "adverse_reactions",
        "warnings", "warnings_and_cautions", "boxed_warning",
    ))


def label_to_row(name, label):
    ofda = label.get("openfda", {})
    return {
        "id": "drug:" + name.lower().replace(" ", "_"),
        "generic_name": name.lower(),
        "brand_names": "; ".join(sorted(set(ofda.get("brand_name", [])))),
        "purpose": section(label, "indications_and_usage", "purpose"),
        "side_effects": section(label, "adverse_reactions"),
        "warnings": section(label, "warnings_and_cautions", "warnings", "warnings_and_precautions"),
        "boxed_warning": section(label, "boxed_warning"),
        "route": "; ".join(ofda.get("route", [])),
        "openfda_set_id": label.get("set_id", ""),
    }


def read_drug_list():
    path = os.path.join(HERE, "common_drugs.txt")
    with open(path, encoding="utf-8") as f:
        return [line.strip() for line in f if line.strip() and not line.startswith("#")]


def download_drugs():
    names = read_drug_list()
    api_key = os.environ.get("OPENFDA_API_KEY")
    rows, missing = [], []
    print(f"[drugs] looking up {len(names)} drugs in openFDA ...")
    for i, name in enumerate(names, 1):
        params = {"search": f'openfda.generic_name:"{name}"', "limit": "10"}
        if api_key:
            params["api_key"] = api_key
        url = OPENFDA_LABEL_URL + "?" + urllib.parse.urlencode(params)
        try:
            results = json.loads(fetch(url)).get("results", [])
        except urllib.error.HTTPError as e:
            results = []
            if e.code != 404:  # 404 just means no match
                print(f"  ! {name}: HTTP {e.code}")
        except urllib.error.URLError as e:
            sys.exit(f"[drugs] cannot reach openFDA: {e.reason}")
        if results:
            rows.append(label_to_row(name, max(results, key=label_score)))
        else:
            missing.append(name)
        if i % 25 == 0:
            print(f"  {i}/{len(names)}")
        time.sleep(0.05 if api_key else 0.3)  # stay under 240 requests/minute

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "drug_reference.csv")
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=DRUG_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    print(f"[drugs] wrote {len(rows)} rows to {path}")
    if missing:
        print(f"[drugs] no openFDA label found for {len(missing)}: {', '.join(missing)}")


def copy_terms():
    os.makedirs(OUT, exist_ok=True)
    src = os.path.join(HERE, "medical_terms.csv")
    dst = os.path.join(OUT, "medical_terms.csv")
    shutil.copyfile(src, dst)
    with open(dst, encoding="utf-8") as f:
        count = sum(1 for _ in f) - 1
    print(f"[terms] wrote {count} rows to {dst}")


def download_synthea():
    os.makedirs(DOWNLOADS, exist_ok=True)
    zip_path = os.path.join(DOWNLOADS, "synthea_sample_data_csv.zip")
    if not os.path.exists(zip_path):
        for url in SYNTHEA_URLS:
            print(f"[synthea] downloading {url} ...")
            try:
                data = fetch(url, timeout=600)
            except urllib.error.URLError as e:
                print(f"  ! failed: {getattr(e, 'reason', e)}")
                continue
            with open(zip_path, "wb") as f:
                f.write(data)
            break
        else:
            sys.exit("[synthea] could not download the sample data; see data/README.md for a manual link")

    dest = os.path.join(OUT, "hospital_records")
    os.makedirs(dest, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        members = {os.path.basename(n).lower(): n for n in z.namelist()}
        for table in SYNTHEA_TABLES:
            if table not in members:
                sys.exit(f"[synthea] {table} not found in {zip_path}")
            with z.open(members[table]) as src, open(os.path.join(dest, table), "wb") as dst:
                shutil.copyfileobj(src, dst)
            with open(os.path.join(dest, table), encoding="utf-8") as f:
                count = sum(1 for _ in f) - 1
            print(f"[synthea] wrote {count} rows to {os.path.join(dest, table)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", choices=["drugs", "terms", "synthea"], help="prepare just one dataset")
    args = parser.parse_args()

    steps = {"drugs": download_drugs, "terms": copy_terms, "synthea": download_synthea}
    for name, step in steps.items():
        if args.only in (None, name):
            step()
    print(f"\nDone. Files are in {OUT}")


if __name__ == "__main__":
    main()
