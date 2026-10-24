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


def label_score(name, label):
    """Rank candidate labels for one drug; the highest tuple wins.

    openFDA's generic_name search also returns combination products and kits (searching
    "furosemide" finds "FUROSEMIDE, BENZALKONIUM CHLORIDE", a medicated kit with no route),
    so section count alone picks the wrong product. In order of priority, prefer:
      1. the drug on its own: an exact generic-name match first, then a single-ingredient
         salt form ("verapamil hydrochloride"), then anything else (combinations),
      2. a label that states a route (kits and devices often don't),
      3. not a kit (brand name containing "kit"),
      4. an oral product -- the usual form for a patient's take-home medications,
      5. then the label with more of the sections the Simplify agent needs.
    """
    ofda = label.get("openfda", {})
    want = name.strip().lower()
    generics = [g.strip().lower() for g in ofda.get("generic_name", [])]
    if want in generics:
        match = 2
    elif any(g.startswith(want + " ") and "," not in g and " and " not in g for g in generics):
        match = 1
    else:
        match = 0
    routes = {r.strip().upper() for r in ofda.get("route", [])}
    is_kit = any("kit" in b.lower().split() for b in ofda.get("brand_name", []))
    sections = sum(bool(label.get(k)) for k in (
        "indications_and_usage", "purpose", "adverse_reactions",
        "warnings", "warnings_and_cautions", "boxed_warning",
    ))
    return (match, bool(routes), not is_kit, "ORAL" in routes, sections)


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
        # 25 candidates, not 10: a phrase search matches combination products too, and a
        # wider pool makes it likelier a single-ingredient label is among them.
        params = {"search": f'openfda.generic_name:"{name}"', "limit": "25"}
        if api_key:
            params["api_key"] = api_key
        url = OPENFDA_LABEL_URL + "?" + urllib.parse.urlencode(params)
        results = []
        for attempt in range(3):
            try:
                results = json.loads(fetch(url)).get("results", [])
                break
            except urllib.error.HTTPError as e:
                # openFDA returns the odd 500 or 429; retry those instead of dropping the drug.
                if (e.code >= 500 or e.code == 429) and attempt < 2:
                    time.sleep(2 * (attempt + 1))
                    continue
                if e.code != 404:  # 404 just means no match
                    print(f"  ! {name}: HTTP {e.code}")
                break
            except urllib.error.URLError as e:
                sys.exit(f"[drugs] cannot reach openFDA: {e.reason}")
        if results:
            rows.append(label_to_row(name, max(results, key=lambda lb: label_score(name, lb))))
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
