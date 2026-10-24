#!/usr/bin/env bash
#
# Load the day-one datasets (data/out/) into a local Zetaris, one table per CSV.
#
#   scripts/load_to_zetaris.sh                    # load all five tables, then compare row counts
#   scripts/load_to_zetaris.sh sql "SELECT ..."   # run any SQL and print the result
#
# Before running: python3 data/download_datasets.py, and Zetaris up (./verify.sh passes).
#
# How it loads: Zetaris's native way, the same one its NY_TAXI sample data uses. Each CSV is
# copied into the platform's shared data volume and registered as a Lightning filestore
# table, so Zetaris reads the file directly (no row-by-row inserts). Tables go in the
# Lightning database DAY_ONE, so query them as DAY_ONE.<table>:
#
#   SELECT * FROM DAY_ONE.drug_reference WHERE generic_name = 'furosemide'
#
# Safe to re-run: files are replaced in place and existing tables keep pointing at them.
#
# Settings (all optional):
#   ZETARIS_DIR   your zetaris-platform folder. Otherwise ../zetaris-platform next to this
#                 repo, ~/zetaris-platform and ~/Downloads/zetaris-platform are tried.
#   ZETARIS_DB    Lightning database name (default DAY_ONE)
#   ZETARIS_USER / ZETARIS_PASSWORD  login; read from ZETARIS_DIR/.env by default. Set these
#                 if you changed the admin password in the web interface.

set -euo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$REPO/data/out"
DB="${ZETARIS_DB:-DAY_ONE}"

if [ -z "${ZETARIS_DIR:-}" ]; then
    for d in "$REPO/../zetaris-platform" "$HOME/zetaris-platform" "$HOME/Downloads/zetaris-platform"; do
        [ -f "$d/docker-compose.yml" ] && { ZETARIS_DIR="$(cd "$d" && pwd)"; break; }
    done
fi
[ -n "${ZETARIS_DIR:-}" ] || { echo "ERROR: can't find your Zetaris folder; set ZETARIS_DIR=/path/to/zetaris-platform" >&2; exit 1; }

JAR=$(ls "$ZETARIS_DIR"/jdbc/*driver*.jar 2>/dev/null | head -1 || true)
[ -n "$JAR" ] || { echo "ERROR: no JDBC driver jar in $ZETARIS_DIR/jdbc/" >&2; exit 1; }
command -v java >/dev/null || { echo "ERROR: Java 11+ is needed (macOS: brew install --cask corretto@11)" >&2; exit 1; }

# Read only the values needed; sourcing .env would execute it.
envval() { sed -n "s/^$1=//p" "$ZETARIS_DIR/.env" 2>/dev/null | tail -1; }
export ZETARIS_USER="${ZETARIS_USER:-$(envval ZETARIS_ADMIN_EMAIL)}"
export ZETARIS_PASSWORD="${ZETARIS_PASSWORD:-$(envval ZETARIS_ADMIN_PASSWORD)}"
: "${ZETARIS_USER:=admin@zetaris.com}"
port="$(envval DRIVER_PORT)"
export ZETARIS_URL="${ZETARIS_URL:-jdbc:zetaris:lightning@localhost:${port:-10000}}"

# The JDBC jar logs SLF4J/log4j start-up noise to stderr; hide just that.
sql() { java -cp "$JAR" "$REPO/scripts/ZetarisSql.java" "$@" 2> >(grep -vE '^(SLF4J|log4j):' >&2); }

if [ "${1:-}" = "sql" ]; then shift; sql "$@"; exit; fi

# table name                    CSV under data/out/
TABLES=(
    "drug_reference               drug_reference.csv"
    "medical_terms                medical_terms.csv"
    "hospital_records_patients    hospital_records/patients.csv"
    "hospital_records_encounters  hospital_records/encounters.csv"
    "hospital_records_medications hospital_records/medications.csv"
)

for t in "${TABLES[@]}"; do
    read -r table csv <<<"$t"
    [ -f "$OUT/$csv" ] || { echo "ERROR: data/out/$csv is missing -- run python3 data/download_datasets.py" >&2; exit 1; }
done

dc() { (cd "$ZETARIS_DIR" && docker compose "$@"); }
if [ -z "$(dc ps -q driver 2>/dev/null)" ]; then
    echo "ERROR: the Zetaris driver container isn't running. In $ZETARIS_DIR run: docker compose up -d, then ./verify.sh" >&2
    exit 1
fi

# Where the driver keeps files it is allowed to read. Copying through `exec` (rather than
# `docker cp`) writes them as the container's own user, so ownership matches the rest.
ROOT=$(dc exec -T driver bash -c 'printf %s "$ZETARIS_LOCAL_FILE_SYTEM_ROOT_PATH"')
[ -n "$ROOT" ] || ROOT=/home/zetaris/customer-data/shared
DEST="$ROOT/day_one"

echo "== Copying CSVs into Zetaris ($DEST)"
for t in "${TABLES[@]}"; do
    read -r table csv <<<"$t"
    dc exec -T driver bash -c "umask 002 && mkdir -p '$DEST/$table' && cat > '$DEST/$table/$table.csv'" < "$OUT/$csv"
    printf '  %-30s <- data/out/%s\n' "$table" "$csv"
done

# Run a CREATE; "already exists" is fine (the table already points at the file just replaced).
create() {
    local out
    if out=$(sql "$1" 2>&1); then echo "created"
    elif grep -qiE 'already exist|already registered|duplicate' <<<"$out"; then echo "already registered (data refreshed)"
    else echo "FAILED"; echo "$out" | grep -E '^ERROR' >&2; return 1
    fi
}

echo "== Registering tables in Lightning database $DB"
printf '  %-30s %s\n' "$DB (database)" \
    "$(create "CREATE LIGHTNING DATABASE $DB DESCRIBE BY \"Day One hackathon datasets\" OPTIONS ()")"
for t in "${TABLES[@]}"; do
    read -r table csv <<<"$t"
    printf '  %-30s %s\n' "$DB.$table" "$(create "CREATE LIGHTNING FILESTORE TABLE $table FROM $DB FORMAT csv OPTIONS (path \"file://$DEST/$table\", header \"true\", inferSchema \"true\", multiLine \"true\", escape \"\\\"\")")"
done

echo "== Row counts (CSV data rows vs. Zetaris)"
status=0
for t in "${TABLES[@]}"; do
    read -r table csv <<<"$t"
    want=$(python3 -c 'import csv,sys; print(sum(1 for _ in csv.reader(open(sys.argv[1], newline="", encoding="utf-8")))-1)' "$OUT/$csv")
    got=$(ZETARIS_QUIET=1 sql "SELECT COUNT(*) FROM $DB.$table" 2>/dev/null | tail -1 || true)
    if [ "$want" = "$got" ]; then mark=OK; else mark=MISMATCH; status=1; fi
    printf '  %-30s csv=%-7s zetaris=%-7s %s\n' "$DB.$table" "$want" "${got:-error}" "$mark"
done
exit $status
