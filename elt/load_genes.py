#!/usr/bin/env python3
"""
etl/load_genes.py  --  Extract, Transform, Load for NCBI gene_info.

Fills your existing tables:
  source_release  one row per load (file, date, checksum)
  species         one row per taxon ID (new taxa only)
  gene            one row per NCBI gene (inserted, or updated on re-run)
  synonym         one row per name: official symbol, locus tag, each synonym

Usage:
  pip install psycopg2-binary
  python etl/load_genes.py data/gene_info.filtered.tsv --dsn "postgresql://user:password@localhost:5432/genes"
  (or set DATABASE_URL instead of passing --dsn)
"""

import argparse
import csv
import datetime
import hashlib
import os
import re
import sys
import tempfile
import unicodedata
from pathlib import Path

import psycopg2

SOURCE_NAME = "NCBI Gene gene_info"

# NCBI gene_info column positions (0-based)
COL_TAX_ID = 0
COL_GENE_ID = 1
COL_SYMBOL = 2
COL_LOCUS_TAG = 3
COL_SYNONYMS = 4
COL_DESCRIPTION = 8
COL_NOMENCLATURE_STATUS = 12   # used for gene.status; set to None to leave status empty


# ---------------------------------------------------------------------------
# Transform helpers
# ---------------------------------------------------------------------------
def normalize(name: str) -> str:
    s = unicodedata.normalize("NFKC", name).lower()    # standard characters, lowercase
    s = s.replace("α", "alpha").replace("β", "beta")   # Greek letters to words
    s = re.sub(r"[-_/.]", " ", s)                      # hyphens, underscores etc. to spaces
    s = re.sub(r"\s+", " ", s).strip()                 # collapse extra spaces
    return s


def clean(value):
    """NCBI uses '-' for missing values. Return None for those."""
    if value is None:
        return None
    value = value.strip()
    return None if value in ("", "-") else value


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def names_for_gene(symbol, locus_tag, synonyms_cell):
    """Yield (name_raw, name_normalized, name_type), de-duplicated per gene."""
    candidates = []
    if symbol:
        candidates.append((symbol, "official"))
    if locus_tag:
        candidates.append((locus_tag, "locus_tag"))
    if synonyms_cell:
        for syn in synonyms_cell.split("|"):
            syn = clean(syn)
            if syn:
                candidates.append((syn, "synonym"))

    seen = set()
    for raw, name_type in candidates:
        norm = normalize(raw)
        if not norm or (norm, name_type) in seen:
            continue
        seen.add((norm, name_type))
        yield raw, norm, name_type


# ---------------------------------------------------------------------------
# Extract + Transform: stream the TSV into two temporary CSV files
# ---------------------------------------------------------------------------
def transform(tsv_path: Path, gene_csv, syn_csv):
    taxa = set()
    seen_genes = set()
    gene_count = syn_count = bad_lines = 0
    gene_writer = csv.writer(gene_csv)
    syn_writer = csv.writer(syn_csv)

    with open(tsv_path, encoding="utf-8", newline="") as f:
        for line_no, line in enumerate(f, start=1):
            if line.startswith("#") or not line.strip():
                continue  # header or blank line

            cols = line.rstrip("\r\n").split("\t")
            if len(cols) <= COL_DESCRIPTION:
                bad_lines += 1
                print(f"  skipping line {line_no}: only {len(cols)} columns", file=sys.stderr)
                continue

            try:
                taxon_id = int(cols[COL_TAX_ID])
                ncbi_gene_id = int(cols[COL_GENE_ID])
            except ValueError:
                bad_lines += 1
                print(f"  skipping line {line_no}: bad tax_id/gene_id", file=sys.stderr)
                continue

            if ncbi_gene_id in seen_genes:
                continue
            seen_genes.add(ncbi_gene_id)

            symbol = clean(cols[COL_SYMBOL])
            locus_tag = clean(cols[COL_LOCUS_TAG])
            synonyms = clean(cols[COL_SYNONYMS])
            description = clean(cols[COL_DESCRIPTION])
            status = None
            if COL_NOMENCLATURE_STATUS is not None and len(cols) > COL_NOMENCLATURE_STATUS:
                status = clean(cols[COL_NOMENCLATURE_STATUS])

            taxa.add(taxon_id)

            # None -> '' -> unquoted empty field -> NULL on COPY
            gene_writer.writerow([ncbi_gene_id, taxon_id, symbol or "", locus_tag or "",
                                  description or "", status or ""])
            gene_count += 1

            for raw, norm, name_type in names_for_gene(symbol, locus_tag, synonyms):
                syn_writer.writerow([ncbi_gene_id, raw, norm, name_type])
                syn_count += 1

            if gene_count % 500_000 == 0:
                print(f"  {gene_count:,} genes processed...")

    gene_csv.flush()
    syn_csv.flush()
    return taxa, gene_count, syn_count, bad_lines


# ---------------------------------------------------------------------------
# Load: PostgreSQL COPY into staging tables, then INSERT ... SELECT
# ---------------------------------------------------------------------------
def load(conn, taxa, gene_csv_path, syn_csv_path, file_name, checksum,
         release_version, download_date, license_text, force):
    with conn.cursor() as cur:
        # Same file already loaded?
        cur.execute(
            "SELECT source_id, download_date FROM source_release "
            "WHERE source_name = %s AND checksum = %s",
            (SOURCE_NAME, checksum),
        )
        existing = cur.fetchone()
        if existing and not force:
            sys.exit(f"This exact file was already loaded (source_id={existing[0]}, "
                     f"{existing[1]}). Use --force to load it again.")

        # 1. Record the release
        cur.execute(
            "INSERT INTO source_release (source_name, release_version, download_date, checksum, license) "
            "VALUES (%s, %s, %s, %s, %s) RETURNING source_id",
            (SOURCE_NAME, release_version or file_name, download_date, checksum, license_text),
        )
        source_id = cur.fetchone()[0]

        # 2. Species: add any taxon IDs we have not seen before
        cur.executemany(
            "INSERT INTO species (taxon_id) VALUES (%s) ON CONFLICT (taxon_id) DO NOTHING",
            [(t,) for t in sorted(taxa)],
        )

        # 3. Staging tables (dropped automatically at commit)
        cur.execute("""
            CREATE TEMP TABLE gene_stage (
                ncbi_gene_id BIGINT, taxon_id INT,
                symbol TEXT, locus_tag TEXT, description TEXT, status TEXT
            ) ON COMMIT DROP
        """)
        cur.execute("""
            CREATE TEMP TABLE synonym_stage (
                ncbi_gene_id BIGINT, name_raw TEXT, name_normalized TEXT, name_type TEXT
            ) ON COMMIT DROP
        """)

        with open(gene_csv_path, encoding="utf-8") as f:
            cur.copy_expert("COPY gene_stage FROM STDIN WITH (FORMAT csv)", f)
        with open(syn_csv_path, encoding="utf-8") as f:
            cur.copy_expert("COPY synonym_stage FROM STDIN WITH (FORMAT csv)", f)

        # 4. Genes: insert new ones, update existing ones
        cur.execute("""
            INSERT INTO gene (ncbi_gene_id, species_id, official_symbol, locus_tag, description, status)
            SELECT s.ncbi_gene_id, sp.species_id, s.symbol, s.locus_tag, s.description, s.status
            FROM gene_stage s
            JOIN species sp ON sp.taxon_id = s.taxon_id
            ON CONFLICT (ncbi_gene_id) DO UPDATE SET
                species_id      = EXCLUDED.species_id,
                official_symbol = EXCLUDED.official_symbol,
                locus_tag       = EXCLUDED.locus_tag,
                description     = EXCLUDED.description,
                status          = EXCLUDED.status
        """)
        genes_written = cur.rowcount

        # 5. Synonyms: drop names that came from earlier loads of this source
        #    (names from other sources are left alone), then insert fresh ones
        cur.execute("""
            DELETE FROM synonym
            WHERE source_id IN (SELECT source_id FROM source_release WHERE source_name = %s)
              AND source_id <> %s
              AND gene_id IN (SELECT g.gene_id FROM gene g
                              JOIN gene_stage s ON s.ncbi_gene_id = g.ncbi_gene_id)
        """, (SOURCE_NAME, source_id))

        cur.execute("""
            INSERT INTO synonym (gene_id, name_raw, name_normalized, name_type, source_id)
            SELECT g.gene_id, s.name_raw, s.name_normalized, s.name_type, %s
            FROM synonym_stage s
            JOIN gene g ON g.ncbi_gene_id = s.ncbi_gene_id
        """, (source_id,))
        names_written = cur.rowcount

    conn.commit()
    return source_id, genes_written, names_written


def main():
    parser = argparse.ArgumentParser(description="Load NCBI gene_info into PostgreSQL.")
    parser.add_argument("tsv", type=Path, help="path to gene_info.filtered.tsv")
    parser.add_argument("--dsn", default=os.environ.get("DATABASE_URL"),
                        help="PostgreSQL connection string (default: $DATABASE_URL)")
    parser.add_argument("--release-version", default=None,
                        help="label for this release, e.g. 2026-10-01 (default: file name)")
    parser.add_argument("--download-date", default=None,
                        help="YYYY-MM-DD the file was downloaded (default: today)")
    parser.add_argument("--license", default=None, help="license text to store (optional)")
    parser.add_argument("--force", action="store_true",
                        help="load even if a file with the same checksum was already loaded")
    args = parser.parse_args()

    if not args.tsv.is_file():
        sys.exit(f"File not found: {args.tsv}")
    if not args.dsn:
        sys.exit("No database given. Set DATABASE_URL or pass --dsn.")

    download_date = (datetime.date.fromisoformat(args.download_date)
                     if args.download_date else datetime.date.today())

    print(f"Checksumming {args.tsv} ...")
    checksum = sha256_of(args.tsv)

    with tempfile.TemporaryDirectory() as tmp:
        gene_path = Path(tmp) / "gene.csv"
        syn_path = Path(tmp) / "synonym.csv"

        print("Transforming ...")
        with open(gene_path, "w", encoding="utf-8", newline="") as gene_csv, \
             open(syn_path, "w", encoding="utf-8", newline="") as syn_csv:
            taxa, gene_count, syn_count, bad = transform(args.tsv, gene_csv, syn_csv)

        print(f"  species: {len(taxa):,}  genes: {gene_count:,}  names: {syn_count:,}  skipped lines: {bad}")

        print("Loading into PostgreSQL ...")
        conn = psycopg2.connect(args.dsn)
        try:
            source_id, genes_written, names_written = load(
                conn, taxa, gene_path, syn_path, args.tsv.name, checksum,
                args.release_version, download_date, args.license, args.force)
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    print(f"Done. source_id={source_id}, genes written: {genes_written:,}, names written: {names_written:,}")


if __name__ == "__main__":
    main()
