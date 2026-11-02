CREATE TABLE source_release (
  source_id SERIAL PRIMARY KEY,
  source_name TEXT, release_version TEXT,
  download_date DATE, checksum TEXT, license TEXT
);

CREATE TABLE species (
  species_id SERIAL PRIMARY KEY,
  taxon_id INT UNIQUE, scientific_name TEXT,
  common_name TEXT, clade TEXT
);

CREATE TABLE gene (
  gene_id SERIAL PRIMARY KEY,
  ncbi_gene_id BIGINT UNIQUE,
  species_id INT REFERENCES species(species_id),
  official_symbol TEXT, locus_tag TEXT,
  description TEXT, status TEXT
);

CREATE TABLE synonym (
  synonym_id SERIAL PRIMARY KEY,
  gene_id INT REFERENCES gene(gene_id),
  name_raw TEXT,          -- exactly as written in the source
  name_normalized TEXT,   -- cleaned version used for matching
  name_type TEXT,         -- official, synonym, or locus_tag
  source_id INT REFERENCES source_release(source_id)
);

CREATE TABLE gene_history (
  old_gene_id BIGINT, current_gene_id BIGINT,
  species_id INT, change_type TEXT, change_date DATE,
  source_id INT REFERENCES source_release(source_id)
);

-- Indexes make lookups fast, like a book index
CREATE INDEX idx_syn_norm ON synonym(name_normalized);
CREATE INDEX idx_gene_ncbi ON gene(ncbi_gene_id);
CREATE INDEX idx_gene_species ON gene(species_id);
