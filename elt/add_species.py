"""
Adds ONE species to the database from its NCBI gene_info file.
Use it for Homo sapiens now, and for any species you add later.

What it does
  1. creates (or updates) the species row, with its names
  2. loads the genes, with chromosome, map location and gene type
  3. loads every name of each gene (official symbol, synonyms, locus tag),
     cleaned with the same rules as the website
  4. loads the cross-references from the dbXrefs column (Ensembl, HGNC ...)
  5. optionally loads retired and replaced Gene IDs for that species
  6. records each source file in source_release (name, date, checksum)

It refuses to run if the species already has genes, so nothing is duplicated.

Example (run from the project folder, the one holding docker-compose.yml):

    export POSTGRES_PASSWORD=your_admin_password          (Git Bash / Mac / Linux)
    $env:POSTGRES_PASSWORD="your_admin_password"          (Windows PowerShell)

    python etl/add_species.py data/raw/gene_info/Homo_sapiens.gene_info.gz 9606 "Homo sapiens" "human" vertebrate --history data/raw/gene_history.gz

Needs:  pip install psycopg2-binary
"""
import argparse
import csv
import gzip
import hashlib
import io
import os
import re
import sys
import unicodedata
from datetime import date, datetime

import psycopg2


# ---------- must give the same result as normalize_name() in web/src/normalize.php ----------
def normalize(name):
    s = unicodedata.normalize("NFKC", name).lower()
    s = s.replace("α", "alpha").replace("β", "beta")
    s = re.sub(r"[-_/.]", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def clean(value):
    """NCBI writes '-' for 'nothing here'."""
    value = value.strip()
    return "" if value == "-" else value


def open_text(path):
    if path.endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8")
    return open(path, encoding="utf-8")


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def add_source(cur, name, path):
    modified = datetime.fromtimestamp(os.path.getmtime(path)).date().isoformat()
    cur.execute(
        """INSERT INTO source_release (source_name, release_version, download_date, checksum, license)
           VALUES (%s, %s, %s, %s, %s) RETURNING source_id""",
        (name, f"file dated {modified}", date.today(), sha256_of(path), "NCBI public data"),
    )
    return cur.fetchone()[0]


# ---------- command line ----------
ap = argparse.ArgumentParser(description="Add one species from an NCBI gene_info file.")
ap.add_argument("gene_info", help="path to the species' .gene_info.gz file")
ap.add_argument("taxon_id", type=int, help="NCBI taxon ID, for example 9606")
ap.add_argument("scientific_name", help='for example "Homo sapiens"')
ap.add_argument("common_name", help='for example "human"')
ap.add_argument("clade", help="for example vertebrate, invertebrate, plant, fungus, protist")
ap.add_argument("--history", help="optional path to gene_history.gz (loads retired IDs for this species)")
args = ap.parse_args()

for path in [args.gene_info] + ([args.history] if args.history else []):
    if not os.path.exists(path):
        sys.exit(f"Cannot find {path}. Run this from the project folder.")

conn = psycopg2.connect(
    host=os.environ.get("DB_HOST", "localhost"),
    port=int(os.environ.get("DB_PORT", "5432")),
    dbname=os.environ.get("POSTGRES_DB", "resolver"),
    user=os.environ.get("POSTGRES_USER", "resolver_admin"),
    password=os.environ["POSTGRES_PASSWORD"],
)
cur = conn.cursor()

# ---------- make sure the tables and columns exist ----------
cur.execute("""
    ALTER TABLE gene
      ADD COLUMN IF NOT EXISTS chromosome TEXT,
      ADD COLUMN IF NOT EXISTS map_location TEXT,
      ADD COLUMN IF NOT EXISTS type_of_gene TEXT
""")
cur.execute("""
    CREATE TABLE IF NOT EXISTS cross_reference (
      xref_id SERIAL PRIMARY KEY,
      gene_id INT REFERENCES gene(gene_id),
      external_database TEXT,
      external_id TEXT,
      source_id INT REFERENCES source_release(source_id)
    )
""")
cur.execute("CREATE INDEX IF NOT EXISTS idx_gene_ncbi ON gene (ncbi_gene_id)")
cur.execute("CREATE INDEX IF NOT EXISTS idx_syn_gene ON synonym (gene_id)")
cur.execute("CREATE INDEX IF NOT EXISTS idx_xref_gene ON cross_reference (gene_id)")
cur.execute("CREATE INDEX IF NOT EXISTS idx_hist_old ON gene_history (old_gene_id)")

# ---------- 1. the species row ----------
cur.execute(
    """INSERT INTO species (taxon_id, scientific_name, common_name, clade)
       VALUES (%s, %s, %s, %s)
       ON CONFLICT (taxon_id) DO UPDATE
         SET scientific_name = EXCLUDED.scientific_name,
             common_name = EXCLUDED.common_name,
             clade = EXCLUDED.clade
       RETURNING species_id""",
    (args.taxon_id, args.scientific_name, args.common_name, args.clade),
)
species_id = cur.fetchone()[0]

cur.execute("SELECT COUNT(*) FROM gene WHERE species_id = %s", (species_id,))
if cur.fetchone()[0] > 0:
    conn.rollback()
    sys.exit(f"{args.scientific_name} already has genes in the database, so nothing was changed.")

source_id = add_source(cur, f"NCBI Gene gene_info (taxon {args.taxon_id})", args.gene_info)

# ---------- 2. read the gene_info file ----------
gene_buf, syn_buf, xref_buf = io.StringIO(), io.StringIO(), io.StringIO()
gene_w, syn_w, xref_w = csv.writer(gene_buf), csv.writer(syn_buf), csv.writer(xref_buf)
n_genes = n_names = n_xrefs = skipped = 0

with open_text(args.gene_info) as f:
    for line in f:
        if line.startswith("#"):
            continue
        p = line.rstrip("\n").split("\t")
        if len(p) < 10:
            continue
        if p[0] != str(args.taxon_id):
            skipped += 1
            continue

        gid = p[1]
        symbol, locus_tag = clean(p[2]), clean(p[3])
        gene_w.writerow([gid, symbol, locus_tag, clean(p[8]), clean(p[6]), clean(p[7]), clean(p[9])])
        n_genes += 1

        # every name once: official first, then locus tag, then synonyms
        names = {}
        if symbol:
            names[symbol] = "official"
        if locus_tag and locus_tag not in names:
            names[locus_tag] = "locus_tag"
        for syn in clean(p[4]).split("|"):
            syn = syn.strip()
            if syn and syn != "-" and syn not in names:
                names[syn] = "synonym"
        for raw, kind in names.items():
            norm = normalize(raw)
            if norm:
                syn_w.writerow([gid, raw, norm, kind])
                n_names += 1

        for item in clean(p[5]).split("|"):
            if ":" in item:
                db, ext_id = item.split(":", 1)       # "HGNC:HGNC:11998" -> HGNC, HGNC:11998
                if db and ext_id:
                    xref_w.writerow([gid, db, ext_id])
                    n_xrefs += 1

if n_genes == 0:
    conn.rollback()
    sys.exit(
        f"No rows with taxon ID {args.taxon_id} were found in {args.gene_info} "
        f"({skipped} rows had a different taxon ID). Check the taxon ID."
    )

# ---------- 3. load everything ----------
cur.execute("""CREATE TEMP TABLE tmp_gene (ncbi_gene_id BIGINT, symbol TEXT, locus_tag TEXT,
               description TEXT, chromosome TEXT, map_location TEXT, type_of_gene TEXT)""")
cur.execute("CREATE TEMP TABLE tmp_syn (ncbi_gene_id BIGINT, name_raw TEXT, name_norm TEXT, name_type TEXT)")
cur.execute("CREATE TEMP TABLE tmp_xref (ncbi_gene_id BIGINT, db TEXT, ext_id TEXT)")
for buf in (gene_buf, syn_buf, xref_buf):
    buf.seek(0)
cur.copy_expert("COPY tmp_gene FROM STDIN WITH (FORMAT csv, NULL '')", gene_buf)
cur.copy_expert("COPY tmp_syn FROM STDIN WITH (FORMAT csv, NULL '')", syn_buf)
cur.copy_expert("COPY tmp_xref FROM STDIN WITH (FORMAT csv, NULL '')", xref_buf)

cur.execute(
    """INSERT INTO gene (ncbi_gene_id, species_id, official_symbol, locus_tag, description,
                         chromosome, map_location, type_of_gene)
       SELECT ncbi_gene_id, %s, symbol, locus_tag, description, chromosome, map_location, type_of_gene
       FROM tmp_gene
       ON CONFLICT (ncbi_gene_id) DO NOTHING""",
    (species_id,),
)
genes_added = cur.rowcount

cur.execute(
    """INSERT INTO synonym (gene_id, name_raw, name_normalized, name_type, source_id)
       SELECT g.gene_id, s.name_raw, s.name_norm, s.name_type, %s
       FROM tmp_syn s JOIN gene g ON g.ncbi_gene_id = s.ncbi_gene_id AND g.species_id = %s""",
    (source_id, species_id),
)
names_added = cur.rowcount

cur.execute(
    """INSERT INTO cross_reference (gene_id, external_database, external_id, source_id)
       SELECT g.gene_id, x.db, x.ext_id, %s
       FROM tmp_xref x JOIN gene g ON g.ncbi_gene_id = x.ncbi_gene_id AND g.species_id = %s""",
    (source_id, species_id),
)
xrefs_added = cur.rowcount

# ---------- 4. retired and replaced Gene IDs (optional) ----------
history_added = 0
if args.history:
    history_source = add_source(cur, f"NCBI Gene gene_history (taxon {args.taxon_id})", args.history)
    hist_buf = io.StringIO()
    hist_w = csv.writer(hist_buf)
    with open_text(args.history) as f:
        for line in f:
            if line.startswith("#"):
                continue
            p = line.rstrip("\n").split("\t")
            if len(p) < 5 or p[0] != str(args.taxon_id):
                continue
            hist_w.writerow([clean(p[2]), clean(p[1]), clean(p[4])])   # old ID, current ID, date
    cur.execute("CREATE TEMP TABLE tmp_hist (old_id BIGINT, new_id BIGINT, d TEXT)")
    hist_buf.seek(0)
    cur.copy_expert("COPY tmp_hist FROM STDIN WITH (FORMAT csv, NULL '')", hist_buf)
    cur.execute(
        """INSERT INTO gene_history (old_gene_id, current_gene_id, species_id, change_type, change_date, source_id)
           SELECT h.old_id, h.new_id, %s,
                  CASE WHEN h.new_id IS NULL THEN 'discontinued' ELSE 'replaced' END,
                  CASE WHEN h.d ~ '^[0-9]{8}$' THEN to_date(h.d, 'YYYYMMDD') END,
                  %s
           FROM tmp_hist h
           WHERE h.old_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM gene_history x
                             WHERE x.old_gene_id = h.old_id AND x.species_id = %s)""",
        (species_id, history_source, species_id),
    )
    history_added = cur.rowcount

# the website logs in with a read-only user: make sure it can read the new table
cur.execute("""
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'web_ro') THEN
        GRANT SELECT ON cross_reference TO web_ro;
      END IF;
    END $$
""")
conn.commit()

cur.execute("ANALYZE gene")
cur.execute("ANALYZE synonym")
conn.commit()

print(f"Species: {args.scientific_name} (taxon {args.taxon_id})")
print(f"Genes added:            {genes_added}")
print(f"Names added:            {names_added}")
print(f"Cross-references added: {xrefs_added}")
if args.history:
    print(f"Retired IDs added:      {history_added}")
print("Done.")
