-- Run once as the admin user. Safe to run again.

-- Lets "contains" searches (names with the typed text anywhere inside) use an index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_syn_norm_trgm
    ON synonym USING gin (name_normalized gin_trgm_ops);

-- Speeds up "show all names of this gene" (gene panel and synonym counts).
CREATE INDEX IF NOT EXISTS idx_syn_gene ON synonym (gene_id);

-- Speeds up "which old IDs became this gene" and cross-reference lookups.
CREATE INDEX IF NOT EXISTS idx_hist_current ON gene_history (current_gene_id);
CREATE INDEX IF NOT EXISTS idx_xref_gene ON cross_reference (gene_id);

-- Speeds up browsing a species in symbol order.
CREATE INDEX IF NOT EXISTS idx_gene_species_symbol ON gene (species_id, official_symbol);

ANALYZE;
