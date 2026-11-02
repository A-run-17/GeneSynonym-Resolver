<?php
declare(strict_types=1);
require_once __DIR__ . '/../../src/db.php';
require_once __DIR__ . '/../../src/Resolver.php';

const MAX_BATCH    = 500;   // most names allowed in one batch request
const MAX_NAME_LEN = 200;   // longest allowed name or search text
const MAX_PER_PAGE = 100;   // most rows allowed on one page of results

// ---------- helpers ----------
function send_json($data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(int $status, string $message): void
{
    send_json(['error' => $message], $status);
}

// Stops spreadsheet programs from running text like "=1+1" as a formula.
function csv_safe($value): string
{
    $v = (string) $value;
    return ($v !== '' && strpos("=+-@\t\r", $v[0]) !== false) ? "'" . $v : $v;
}

function send_csv(array $results): void
{
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="resolved.csv"');
    $out = fopen('php://output', 'w');
    fputcsv($out, [
        'input_name', 'normalized_name', 'species', 'taxon_id', 'ncbi_gene_id',
        'official_symbol', 'match_tier', 'confidence_probability',
        'confidence_label', 'ambiguity_flag', 'candidate_count',
        'alternative_candidates', 'explanation',
    ]);
    foreach ($results as $r) {
        $sel = $r['selected'];
        fputcsv($out, array_map('csv_safe', [
            $r['input_name'],
            $r['normalized_name'],
            $r['species'],
            $r['taxon_id'] ?? '',
            $sel['ncbi_gene_id'] ?? '',
            $sel['official_symbol'] ?? '',
            $r['match_tier'] ?? '',
            $r['confidence_probability'] ?? 'n/a',
            $r['confidence_label'] ?? 'n/a',
            implode(';', $r['ambiguity_flag']),
            $r['candidate_count'],
            implode(';', array_map(
                fn($a) => $a['official_symbol'] . ' (' . $a['ncbi_gene_id'] . ')',
                $r['alternative_candidates']
            )),
            $r['explanation'] ?? '',
        ]));
    }
    fclose($out);
    exit;
}

// Looks up a species by taxon ID. A missing name is replaced by "taxon NNNN".
function find_species(PDO $pdo, $taxon): ?array
{
    if (!ctype_digit((string) $taxon) || strlen((string) $taxon) > 9) {
        return null;
    }
    $st = $pdo->prepare(
        "SELECT taxon_id, COALESCE(scientific_name, 'taxon ' || taxon_id::text) AS scientific_name
         FROM species WHERE taxon_id = :t"
    );
    $st->execute([':t' => (int) $taxon]);
    return $st->fetch() ?: null;
}

// In SQL LIKE, % and _ are wildcards. This makes them ordinary characters.
function like_escape(string $s): string
{
    return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $s);
}

// Reads ?page= and ?per_page= safely. Returns [page, per_page, offset].
function paging(int $defaultPer): array
{
    $page = max(1, (int) ($_GET['page'] ?? 1));
    $per  = (int) ($_GET['per_page'] ?? $defaultPer);
    $per  = min(MAX_PER_PAGE, max(1, $per));
    return [$page, $per, ($page - 1) * $per];
}

// ---------- routing ----------
try {
    $pdo    = db();
    $path   = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?? '/';
    $route  = '/' . trim(preg_replace('#^/api(/index\.php)?#', '', $path), '/');
    $method = $_SERVER['REQUEST_METHOD'];
    $format = $_GET['format'] ?? 'json';

    // --- list species ---
    if ($method === 'GET' && $route === '/species') {
        $rows = $pdo->query(
            "SELECT taxon_id, COALESCE(scientific_name, 'taxon ' || taxon_id::text) AS scientific_name,
                    common_name, clade
             FROM species ORDER BY scientific_name"
        )->fetchAll();
        send_json($rows);
    }

    // --- database totals for the Overview page ---
    if ($method === 'GET' && $route === '/stats') {
        send_json([
            'species_count' => (int) $pdo->query('SELECT COUNT(*) FROM species')->fetchColumn(),
            'gene_count'    => (int) $pdo->query('SELECT COUNT(*) FROM gene')->fetchColumn(),
            'name_count'    => (int) $pdo->query('SELECT COUNT(*) FROM synonym')->fetchColumn(),
            'release_count' => (int) $pdo->query('SELECT COUNT(*) FROM source_release')->fetchColumn(),
        ]);
    }

    // --- release history ---
    if ($method === 'GET' && $route === '/releases') {
        $rows = $pdo->query(
            'SELECT source_name, release_version, download_date, license
             FROM source_release ORDER BY download_date DESC'
        )->fetchAll();
        send_json($rows);
    }

    // --- SEARCH: find genes by any part of a name, symbol, synonym or gene ID ---
    if ($method === 'GET' && $route === '/search') {
        $q = trim((string) ($_GET['q'] ?? ''));
        if (mb_strlen($q) < 2 || mb_strlen($q) > MAX_NAME_LEN) {
            fail(400, 'Type between 2 and ' . MAX_NAME_LEN . ' characters.');
        }
        $norm = normalize_name($q);
        if ($norm === '') {
            fail(400, 'Type at least one letter or number.');
        }
        $mode = $_GET['mode'] ?? 'contains';
        if (!in_array($mode, ['contains', 'starts', 'exact'], true)) {
            fail(400, 'Unknown match mode. Use contains, starts or exact.');
        }
        $esc     = like_escape($norm);
        $pattern = $mode === 'exact' ? $esc : ($mode === 'starts' ? $esc . '%' : '%' . $esc . '%');

        // A number can also be a Gene ID, so match that as well.
        $isId   = ctype_digit($q) && strlen($q) <= 18;
        $where  = $isId
            ? '(s.name_normalized LIKE :pat OR g.ncbi_gene_id = :gid2)'
            : 's.name_normalized LIKE :pat';
        $whereParams = [':pat' => $pattern];
        if ($isId) {
            $whereParams[':gid2'] = (int) $q;
        }
        if (($_GET['species'] ?? '') !== '') {
            $sp = find_species($pdo, $_GET['species']);
            if (!$sp) {
                fail(400, 'Unknown species. See /api/species for valid taxon IDs.');
            }
            $where .= ' AND sp.taxon_id = :taxon';
            $whereParams[':taxon'] = (int) $sp['taxon_id'];
        }

        [$page, $per, $offset] = paging(25);
        $from = 'FROM synonym s
                 JOIN gene g     ON g.gene_id = s.gene_id
                 JOIN species sp ON sp.species_id = g.species_id';

        $st = $pdo->prepare("SELECT COUNT(DISTINCT g.gene_id) $from WHERE $where");
        $st->execute($whereParams);
        $total = (int) $st->fetchColumn();

        // rank 0 = typed a Gene ID, 1 = exact name, 2 = starts with, 3 = contains
        $sql = "SELECT g.ncbi_gene_id, g.official_symbol, g.description,
                       sp.taxon_id,
                       COALESCE(sp.scientific_name, 'taxon ' || sp.taxon_id::text) AS species,
                       MIN(CASE WHEN g.ncbi_gene_id = :gid1        THEN 0
                                WHEN s.name_normalized = :n1       THEN 1
                                WHEN s.name_normalized LIKE :n2    THEN 2
                                ELSE 3 END) AS rank,
                       string_agg(DISTINCT s.name_raw, ' | ') AS matched
                $from
                WHERE $where
                GROUP BY g.gene_id, g.ncbi_gene_id, g.official_symbol, g.description,
                         sp.species_id, sp.taxon_id, sp.scientific_name
                ORDER BY rank, g.official_symbol, g.ncbi_gene_id
                LIMIT " . (int) $per . ' OFFSET ' . (int) $offset;
        $params = $whereParams + [
            ':gid1' => $isId ? (int) $q : -1,
            ':n1'   => $norm,
            ':n2'   => $esc . '%',
        ];
        $st = $pdo->prepare($sql);
        $st->execute($params);

        $results = [];
        foreach ($st->fetchAll() as $r) {
            $results[] = [
                'ncbi_gene_id'    => (int) $r['ncbi_gene_id'],
                'official_symbol' => $r['official_symbol'],
                'description'     => $r['description'],
                'taxon_id'        => (int) $r['taxon_id'],
                'species'         => $r['species'],
                'match_rank'      => (int) $r['rank'],
                'matched'         => array_slice(explode(' | ', (string) $r['matched']), 0, 5),
            ];
        }
        send_json([
            'query'      => $q,
            'normalized' => $norm,
            'mode'       => $mode,
            'total'      => $total,
            'page'       => $page,
            'per_page'   => $per,
            'pages'      => max(1, (int) ceil($total / $per)),
            'results'    => $results,
        ]);
    }

    // --- BROWSE: list the genes of one species, one first letter at a time ---
    if ($method === 'GET' && $route === '/browse') {
        $sp = find_species($pdo, $_GET['species'] ?? '');
        if (!$sp) {
            fail(400, 'Choose a species. See /api/species for valid taxon IDs.');
        }
        $taxon = (int) $sp['taxon_id'];

        // How many genes start with each letter? (everything else goes under "#")
        $st = $pdo->prepare(
            "SELECT CASE WHEN upper(left(COALESCE(g.official_symbol, ''), 1)) ~ '^[A-Z]\$'
                         THEN upper(left(g.official_symbol, 1)) ELSE '#' END AS letter,
                    COUNT(*) AS n
             FROM gene g JOIN species sp ON sp.species_id = g.species_id
             WHERE sp.taxon_id = :t
             GROUP BY 1"
        );
        $st->execute([':t' => $taxon]);
        $letters = [];
        foreach ($st->fetchAll() as $r) {
            $letters[(string) $r['letter']] = (int) $r['n'];
        }
        uksort($letters, fn($a, $b) => (($a === '#') <=> ($b === '#')) ?: strcmp((string) $a, (string) $b));

        $letter = strtoupper(trim((string) ($_GET['letter'] ?? '')));
        if ($letter === '' || !isset($letters[$letter])) {
            $letter = (string) (array_key_first($letters) ?? '');
        }

        [$page, $per, $offset] = paging(50);
        $total   = $letters[$letter] ?? 0;
        $results = [];

        if ($total > 0) {
            // $letter is always A-Z or # here, because it came from the list above.
            $cond   = $letter === '#'
                ? "NOT (upper(left(COALESCE(g.official_symbol, ''), 1)) ~ '^[A-Z]\$')"
                : 'upper(left(g.official_symbol, 1)) = :l';
            $params = [':t' => $taxon];
            if ($letter !== '#') {
                $params[':l'] = $letter;
            }
            $st = $pdo->prepare(
                "SELECT g.ncbi_gene_id, g.official_symbol, g.description,
                        (SELECT COUNT(*) FROM synonym s WHERE s.gene_id = g.gene_id) AS synonym_count
                 FROM gene g JOIN species sp ON sp.species_id = g.species_id
                 WHERE sp.taxon_id = :t AND $cond
                 ORDER BY g.official_symbol, g.ncbi_gene_id
                 LIMIT " . (int) $per . ' OFFSET ' . (int) $offset
            );
            $st->execute($params);
            foreach ($st->fetchAll() as $r) {
                $results[] = [
                    'ncbi_gene_id'    => (int) $r['ncbi_gene_id'],
                    'official_symbol' => $r['official_symbol'],
                    'description'     => $r['description'],
                    'taxon_id'        => $taxon,
                    'species'         => $sp['scientific_name'],
                    'synonym_count'   => (int) $r['synonym_count'],
                ];
            }
        }

        $letterList = [];
        foreach ($letters as $l => $n) {
            $letterList[] = ['letter' => (string) $l, 'count' => $n];
        }
        send_json([
            'species'  => $sp['scientific_name'],
            'letter'   => $letter,
            'letters'  => $letterList,
            'total'    => $total,
            'page'     => $page,
            'per_page' => $per,
            'pages'    => max(1, (int) ceil($total / $per)),
            'results'  => $results,
        ]);
    }

    // --- resolve one name ---
    if ($method === 'GET' && $route === '/resolve') {
        $name = trim((string) ($_GET['name'] ?? ''));
        if ($name === '' || mb_strlen($name) > MAX_NAME_LEN) {
            fail(400, 'Provide a name between 1 and ' . MAX_NAME_LEN . ' characters.');
        }
        $sp = find_species($pdo, $_GET['species'] ?? '');
        if (!$sp) {
            fail(400, 'Unknown species. See /api/species for valid taxon IDs.');
        }
        $context = trim((string) ($_GET['context'] ?? ''));
        $result = resolve_one($pdo, (int) $sp['taxon_id'], $sp['scientific_name'], $name, mb_substr($context, 0, 5000));
        if ($format === 'csv') {
            send_csv([$result]);
        }
        send_json($result);
    }

    // --- resolve one name in EVERY species with ONE request ---
    // The search page used to send one request per species (16+ at once), which
    // tripped the nginx rate limit. Now one database query covers every species.
    if ($method === 'GET' && $route === '/resolve/all') {
        $name = trim((string) ($_GET['name'] ?? ''));
        if ($name === '' || mb_strlen($name) > MAX_NAME_LEN) {
            fail(400, 'Provide a name between 1 and ' . MAX_NAME_LEN . ' characters.');
        }
        $speciesCount = (int) $pdo->query('SELECT COUNT(*) FROM species')->fetchColumn();

        $matches = [];
        $context = mb_substr(trim((string) ($_GET['context'] ?? '')), 0, 5000);
        foreach (resolve_all_species($pdo, $name, $context) as $r) {
            $found = $r['selected'] ? [$r['selected']] : [];
            foreach ($r['alternative_candidates'] as $alt) {
                $found[] = $alt;
            }
            foreach ($found as $c) {
                $matches[] = $c + [
                    'taxon_id'        => $r['taxon_id'],
                    'scientific_name' => $r['species'],
                    'flags'           => $r['ambiguity_flag'],
                ];
            }
        }
        send_json([
            'input_name'       => $name,
            'normalized_name'  => normalize_name($name),
            'species_searched' => $speciesCount,
            'match_count'      => count($matches),
            'matches'          => $matches,
        ]);
    }

    // --- resolve many names ---
    if ($method === 'POST' && $route === '/resolve/batch') {
        $body = json_decode(file_get_contents('php://input'), true);
        if (!is_array($body) || !isset($body['names']) || !is_array($body['names'])) {
            fail(400, 'Send JSON like {"species": 9913, "names": ["HSP70"]}.');
        }
        // Optional free text (pathway, tissue, abstract) used to choose between genes that share a name.
        $context = trim((string) ($body['context'] ?? ''));
        if (mb_strlen($context) > 5000) {
            fail(400, 'Context is too long (maximum 5000 characters).');
        }

        // "all" (or 0) means: look every name up in every species.
        $allSpecies = (($body['species'] ?? '') === 'all');
        $sp = null;
        if (!$allSpecies) {
            $sp = find_species($pdo, $body['species'] ?? '');
            if (!$sp) {
                fail(400, 'Unknown species. See /api/species for valid taxon IDs.');
            }
        }
        $names = [];
        foreach ($body['names'] as $n) {
            if (is_string($n) && trim($n) !== '') {
                $names[] = trim($n);
            }
        }
        if (count($names) === 0) {
            fail(400, 'No names were provided.');
        }
        if (count($names) > MAX_BATCH) {
            fail(413, 'Too many names. The maximum per request is ' . MAX_BATCH . '.');
        }
        $results = [];
        foreach ($names as $n) {
            if (mb_strlen($n) > MAX_NAME_LEN) {
                fail(400, 'A name is longer than ' . MAX_NAME_LEN . ' characters.');
            }
            if ($allSpecies) {
                // One row per species that has the name; one "no match" row if none does.
                $found = resolve_all_species($pdo, $n, $context);
                if (!$found) {
                    $found = [build_result([], 'All species', null, $n)];
                }
                foreach ($found as $row) {
                    $results[] = $row;
                }
            } else {
                $results[] = resolve_one($pdo, (int) $sp['taxon_id'], $sp['scientific_name'], $n, $context);
            }
        }
        if ($format === 'csv') {
            send_csv($results);
        }
        send_json([
            'species'   => $allSpecies ? 'all' : $sp['scientific_name'],
            'count'     => count($names),     // names submitted
            'row_count' => count($results),   // rows returned (more than count when several species match)
            'context_used' => $context !== '',
            'results'   => $results,
        ]);
    }

    // --- gene details: names, previous IDs and cross-references ---
    if ($method === 'GET' && preg_match('#^/gene/(\d{1,18})$#', $route, $m)) {
        $st = $pdo->prepare(
            "SELECT g.gene_id, g.ncbi_gene_id, g.official_symbol, g.locus_tag,
                    g.description, g.status, sp.taxon_id,
                    COALESCE(sp.scientific_name, 'taxon ' || sp.taxon_id::text) AS scientific_name
             FROM gene g JOIN species sp ON sp.species_id = g.species_id
             WHERE g.ncbi_gene_id = :id"
        );
        $st->execute([':id' => (int) $m[1]]);
        $gene = $st->fetch();
        if (!$gene) {
            // Not a current gene. Maybe NCBI retired or replaced this ID.
            try {
                $st = $pdo->prepare(
                    'SELECT old_gene_id, current_gene_id, change_type, change_date
                     FROM gene_history WHERE old_gene_id = :id
                     ORDER BY change_date DESC NULLS LAST LIMIT 1'
                );
                $st->execute([':id' => (int) $m[1]]);
                $h = $st->fetch();
                if ($h) {
                    send_json([
                        'retired'         => true,
                        'old_gene_id'     => (int) $h['old_gene_id'],
                        'current_gene_id' => $h['current_gene_id'] !== null ? (int) $h['current_gene_id'] : null,
                        'change_type'     => $h['change_type'],
                        'change_date'     => $h['change_date'],
                    ]);
                }
            } catch (Throwable $e) {
                error_log('retired-ID lookup skipped: ' . $e->getMessage());
            }
            fail(404, 'Gene not found.');
        }
        $internalId = $gene['gene_id'];
        unset($gene['gene_id']);

        // Optional extra columns (chromosome, gene type...) are shown only if the database has them.
        try {
            $st = $pdo->prepare('SELECT to_jsonb(g) FROM gene g WHERE g.ncbi_gene_id = :id');
            $st->execute([':id' => (int) $m[1]]);
            $extra = json_decode((string) $st->fetchColumn(), true);
            if (is_array($extra)) {
                foreach (['chromosome', 'map_location', 'type_of_gene', 'protein_length', 'summary'] as $k) {
                    if (isset($extra[$k]) && $extra[$k] !== '') {
                        $gene[$k] = $extra[$k];
                    }
                }
            }
        } catch (Throwable $e) {
            error_log('extra gene fields skipped: ' . $e->getMessage());
        }

        $st = $pdo->prepare(
            'SELECT name_raw, name_type FROM synonym WHERE gene_id = :g ORDER BY name_type, name_raw'
        );
        $st->execute([':g' => $internalId]);
        $gene['synonyms'] = $st->fetchAll();

        // Earlier IDs and cross-references are extras. If their tables are missing
        // or empty, the panel still opens and simply leaves those parts out.
        $gene['previous_ids'] = [];
        try {
            $st = $pdo->prepare(
                'SELECT old_gene_id, change_type, change_date
                 FROM gene_history WHERE current_gene_id = :id ORDER BY change_date DESC NULLS LAST'
            );
            $st->execute([':id' => (int) $m[1]]);
            $gene['previous_ids'] = $st->fetchAll();
        } catch (Throwable $e) {
            error_log('gene_history lookup skipped: ' . $e->getMessage());
        }

        $gene['cross_references'] = [];
        try {
            $st = $pdo->prepare(
                'SELECT external_database, external_id FROM cross_reference
                 WHERE gene_id = :g ORDER BY external_database, external_id'
            );
            $st->execute([':g' => $internalId]);
            $gene['cross_references'] = $st->fetchAll();
        } catch (Throwable $e) {
            error_log('cross_reference lookup skipped: ' . $e->getMessage());
        }

        send_json($gene);
    }

    fail(404, 'Unknown endpoint.');

} catch (Throwable $e) {
    error_log($e->getMessage());               // details go to the server log...
    fail(500, 'Internal server error.');      // ...visitors see only this
}
