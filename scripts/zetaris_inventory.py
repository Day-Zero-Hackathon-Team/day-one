#!/usr/bin/env python3
"""List what a local Zetaris Lightning instance holds and flag medical-looking data.

Uses the same REST flow as the platform's verify.sh: POST /api/auth/login, then
POST /api/proxy/query/sql/start. Standard library only.

Usage:
  ZETARIS_EMAIL=... ZETARIS_PASSWORD=... python3 scripts/zetaris_inventory.py
  python3 scripts/zetaris_inventory.py --env ~/zetaris-platform/.env   # reads ZETARIS_ADMIN_EMAIL / _PASSWORD

Writes the full result to zetaris_inventory.json (no credentials are written).
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
import uuid

MEDICAL = re.compile(
    r"drug|medic|pharm|rx|ndc|dose|dosage|patient|diagnos|icd|snomed|loinc|fhir|synthea|"
    r"clinic|hospital|encounter|condition|allerg|immuni|procedure|observation|careplan|"
    r"health|disease|symptom|label|fda|term|abbrev",
    re.I,
)


def read_env(path):
    values = {}
    with open(os.path.expanduser(path)) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def post(url, body, headers=None):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"content-type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


class Zetaris:
    def __init__(self, base, email, password):
        self.base = base.rstrip("/")
        status, body = post(f"{self.base}/api/auth/login", {"username": email, "password": password})
        self.token, self.org = body.get("idToken"), body.get("orgId")
        if status != 200 or not self.token:
            sys.exit(f"Login failed (HTTP {status}): {body.get('message') or body}")

    def sql(self, statement):
        status, body = post(
            f"{self.base}/api/proxy/query/sql/start",
            {"select": statement, "pageLimit": 1000},
            {"authorization": f"Bearer {self.token}", "x-org-id": str(self.org), "x-request-id": str(uuid.uuid4())},
        )
        if status != 200:
            return None, f"HTTP {status}: {body.get('message') or body.get('error') or body}"
        return body.get("records", []), None


def run(z, statement, report):
    rows, error = z.sql(statement)
    report["queries"].append({"sql": statement, "error": error, "rows": rows})
    print(f"\n> {statement}")
    if error:
        print(f"  ERROR {error}")
        return []
    for row in rows[:200]:
        print("  " + " | ".join(f"{k}={v}" for k, v in row.items()))
    if len(rows) > 200:
        print(f"  ... {len(rows) - 200} more rows (see JSON)")
    return rows


def first_value(row, *keys):
    for key in keys:
        if row.get(key):
            return row[key]
    return next(iter(row.values()), None)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default=os.environ.get("ZETARIS_URL", "http://localhost:3000"))
    p.add_argument("--env", help="path to the zetaris-platform .env (reads ZETARIS_ADMIN_EMAIL / ZETARIS_ADMIN_PASSWORD)")
    p.add_argument("--no-describe", action="store_true", help="skip column listing for flagged tables")
    p.add_argument("--out", default="zetaris_inventory.json")
    args = p.parse_args()

    env = read_env(args.env) if args.env else {}
    email = os.environ.get("ZETARIS_EMAIL") or env.get("ZETARIS_ADMIN_EMAIL")
    password = os.environ.get("ZETARIS_PASSWORD") or env.get("ZETARIS_ADMIN_PASSWORD")
    if not email or not password:
        sys.exit("Set ZETARIS_EMAIL and ZETARIS_PASSWORD, or pass --env path/to/zetaris-platform/.env")

    z = Zetaris(args.url, email, password)
    report = {"url": args.url, "queries": [], "tables": [], "flagged": []}

    databases = [first_value(r, "databaseName", "database", "name", "namespace")
                 for r in run(z, "SHOW LIGHTNING DATABASES", report)]
    datasources = [first_value(r, "datasourceName", "datasource", "name")
                   for r in run(z, "SHOW DATASOURCES", report)]

    for ns in [d for d in databases + datasources if d]:
        for row in run(z, f"SHOW NAMESPACES OR TABLES IN {ns}", report):
            table = first_value(row, "tableName", "table", "name", "namespace")
            full = f"{ns}.{table}"
            report["tables"].append(full)
            if MEDICAL.search(full):
                report["flagged"].append({"table": full})

    if not args.no_describe:
        for item in report["flagged"]:
            rows = run(z, f"DESCRIBE {item['table']}", report)
            item["columns"] = [first_value(r, "col_name", "column", "name") for r in rows]
            sample, _ = z.sql(f"SELECT * FROM {item['table']} LIMIT 3")
            item["sample"] = sample

    with open(args.out, "w") as f:
        json.dump(report, f, indent=2, default=str)

    print(f"\n== {len(report['tables'])} tables found, {len(report['flagged'])} look medical:")
    for item in report["flagged"]:
        print(f"  - {item['table']}" + (f"  columns: {', '.join(map(str, item.get('columns') or []))}" if item.get("columns") else ""))
    print(f"\nFull results written to {args.out}")


if __name__ == "__main__":
    main()
