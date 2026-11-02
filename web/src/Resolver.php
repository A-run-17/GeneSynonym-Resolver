<?php
declare(strict_types=1);
require_once __DIR__ . '/normalize.php';

/* ============================================================
   CONFIDENCE SCORING
   A transparent, rule-based score between 0 and 1 for every candidate.
   Two ideas are combined:
     1. How trustworthy is this KIND of match?   (tier_base)
     2. How much competition does the gene have? (share of the total weight)
   score = tier_base x share
   ============================================================ */

/** How reliable a match of this kind is, on its own. */
function tier_base(array $c): float
{
    $base = match ($c['match_tier']) {
        1       => 0.98,                                 // exact official symbol
        2       => 0.90,                                 // exact synonym / alias / locus tag
        default => !empty($c['case_only']) ? 0.92 : 0.80 // cleaned-up match (3)
    };
    if ($c['matched_as'] === 'retired_symbol') {
        $base *= 0.75;                                   // an old name is less certain
    }
    return $base;
}

/** How strongly this candidate competes with the others for the same name. */
function tier_weight(array $c): float
{
    $w = match ($c['match_tier']) {
        1       => 1.0,
        2       => 0.4,
        default => !empty($c['case_only']) ? 0.3 : 0.2
    };
    if ($c['matched_as'] === 'retired_symbol') {
        $w *= 0.4;
    }
    return $w;
}

function confidence_label(?float $p): ?string
{
    if ($p === null) return null;
    if ($p >= 0.85) return 'high';
    if ($p >= 0.60) return 'medium';
    return 'low';
}

/* ============================================================
   CONTEXT (optional)
   The user can paste a few words about their experiment, such as a pathway,
   a tissue or an abstract. When several genes share one name, we count how many
   of those words also appear in each gene's description. The gene with more
   matching words wins the tie and gets a higher score.
   ============================================================ */

/** Splits free text into a set of lower-case keywords (word => true). */
function context_tokens(string $text): array
{
    $stop = array_flip([
        'the','and','for','with','from','that','this','are','was','were','has','have','had','not','but','can',
        'its','into','than','then','their','there','these','those','which','while','also','using','used',
        'use','may','our','all','any','one','two','between','during','after','before','over','under','about',
        'gene','genes','protein','proteins','study','studies','expression','analysis','data','result','results'
    ]);
    preg_match_all('/[\p{L}\p{N}]+/u', mb_strtolower($text, 'UTF-8'), $m);

    $out = [];
    foreach ($m[0] as $w) {
        if (mb_strlen($w) < 3 || isset($stop[$w])) {
            continue;
        }
        // very light singular/plural handling: kinases -> kinase, ligaments -> ligament
        if (mb_strlen($w) > 4 && str_ends_with($w, 'ies')) {
            $w = mb_substr($w, 0, -3) . 'y';
        } elseif (mb_strlen($w) > 3 && str_ends_with($w, 's') && !str_ends_with($w, 'ss')) {
            $w = mb_substr($w, 0, -1);
        }
        $out[$w] = true;
    }
    return $out;
}

/** Each matching word adds half a point, up to 4 words. */
function context_boost(array $c): float
{
    return 1.0 + 0.5 * min(count($c['context_hits'] ?? []), 4);
}

/** Adds confidence_probability and confidence_label to every candidate. */
function score_candidates(array $cands): array
{
    $total = 0.0;
    foreach ($cands as $c) {
        $total += tier_weight($c) * context_boost($c);
    }
    foreach ($cands as &$c) {
        $share = $total > 0 ? (tier_weight($c) * context_boost($c)) / $total : 1.0;
        $p = max(0.01, min(0.99, tier_base($c) * $share));
        $c['confidence_probability'] = round($p, 2);
        $c['confidence_label']       = confidence_label($p);
    }
    unset($c);
    return $cands;
}

/** One plain-English sentence saying why this result was chosen. */
function explain(array $c, int $candidateCount, bool $tie, string $contextNote = '', bool $sameLevel = false): string
{
    $kind = match ($c['match_tier']) {
        1       => 'the exact official symbol',
        2       => $c['matched_as'] === 'locus_tag' ? 'the exact locus tag' : 'an exact synonym',
        default => !empty($c['case_only'])
                     ? 'the official name written with different capital letters'
                     : 'a match after ignoring capitals, hyphens and spaces',
    };
    if ($c['matched_as'] === 'retired_symbol') {
        $kind = 'a retired symbol';
    }
    $text = "The input is {$kind} of this gene.";
    if ($tie) {
        $text .= " $candidateCount genes match equally well, so none was chosen automatically.";
    } elseif ($sameLevel) {
        $text .= " $candidateCount genes use this exact name.";
    } elseif ($candidateCount > 1) {
        $text .= ' Other genes share the name at a weaker match level.';
    } else {
        $text .= ' No other gene in this species uses this name.';
    }
    if ($contextNote !== '') {
        $text .= ' ' . $contextNote;
    }
    return $text;
}

/* ============================================================
   FINDING CANDIDATES
   ============================================================ */

/**
 * All name rows that match, in one species ($taxon) or in every species (null).
 * The :placeholders keep user text separate from the SQL command.
 */
function fetch_name_rows(PDO $pdo, ?int $taxon, string $input): array
{
    $norm = normalize_name($input);

    $sql = "SELECT g.ncbi_gene_id, g.official_symbol, g.description,
                   s.name_raw, s.name_type, sp.taxon_id,
                   COALESCE(sp.scientific_name, 'taxon ' || sp.taxon_id::text) AS scientific_name
            FROM synonym s
            JOIN gene g     ON g.gene_id = s.gene_id
            JOIN species sp ON sp.species_id = g.species_id
            WHERE s.name_normalized = :norm";
    $args = [':norm' => $norm];
    if ($taxon !== null) {
        $sql .= ' AND sp.taxon_id = :taxon';
        $args[':taxon'] = $taxon;
    }
    $st = $pdo->prepare($sql);
    $st->execute($args);
    return $st->fetchAll();
}

/** Keeps each gene once (its best tier), scores it, and sorts best first. */
function rank_rows(array $rows, string $input, array $ctx = []): array
{
    $best = [];
    foreach ($rows as $r) {
        $exact    = ($r['name_raw'] === $input);
        $caseOnly = !$exact && mb_strtolower($r['name_raw'], 'UTF-8') === mb_strtolower($input, 'UTF-8');

        if ($exact && $r['name_type'] === 'official') {
            $tier = 1;
        } elseif ($exact) {
            $tier = 2;
        } else {
            $tier = 3;
        }
        $id = (int) $r['ncbi_gene_id'];
        if (!isset($best[$id]) || $tier < $best[$id]['match_tier']) {
            $best[$id] = [
                'ncbi_gene_id'    => $id,
                'official_symbol' => $r['official_symbol'],
                'description'     => $r['description'],
                'matched_name'    => $r['name_raw'],
                'matched_as'      => $r['name_type'],
                'match_tier'      => $tier,
                'case_only'       => $caseOnly,
            ];
            if ($ctx) {
                $desc = context_tokens((string) $r['description']);
                $best[$id]['context_hits'] = array_keys(array_intersect_key($ctx, $desc));
            }
        }
    }

    $list = score_candidates(array_values($best));
    usort($list, fn($a, $b) =>
        [$a['match_tier'], -$a['confidence_probability'], $a['official_symbol']]
        <=> [$b['match_tier'], -$b['confidence_probability'], $b['official_symbol']]);
    return $list;
}

/** All genes in one species that have this name (any tier). Best first. */
function find_candidates(PDO $pdo, int $taxon, string $input, array $ctx = []): array
{
    return rank_rows(fetch_name_rows($pdo, $taxon, $input), $input, $ctx);
}

/** Turns a ranked candidate list into the full answer object. */
function build_result(array $cands, string $speciesName, ?int $taxon, string $input, bool $hasContext = false): array
{
    $flags    = [];
    $selected = null;
    $tier     = null;
    $tie      = false;
    $prob     = null;
    $why      = 'No gene in this species has this name, even after cleaning it up.';
    $ctxWords = [];

    if (count($cands) === 0) {
        $flags[] = 'no_match';
    } else {
        $tier      = $cands[0]['match_tier'];
        $atTopList = array_values(array_filter($cands, fn($c) => $c['match_tier'] === $tier));

        if (count($atTopList) === 1) {
            $selected = $cands[0];      // one clear winner
        } else {
            $tie = true;                // a tie, so we do NOT guess ...
            if ($hasContext) {
                // ... unless the context clearly favours one of the tied genes.
                usort($atTopList, fn($a, $b) => count($b['context_hits'] ?? []) <=> count($a['context_hits'] ?? []));
                if (count($atTopList[0]['context_hits'] ?? []) > count($atTopList[1]['context_hits'] ?? [])) {
                    $selected = $atTopList[0];
                    $tie      = false;
                    $flags[]  = 'resolved_by_context';
                }
            }
        }
        if (count($cands) > 1) {
            $flags[] = 'one_name_many_genes';
        }
        if ($selected && $selected['matched_as'] === 'retired_symbol') {
            $flags[] = 'retired_symbol_match';
        }

        $lead     = $selected ?: $cands[0];
        $prob     = $lead['confidence_probability'];
        $ctxWords = $selected ? array_slice($selected['context_hits'] ?? [], 0, 5) : [];

        $note = '';
        if ($hasContext) {
            $list = implode(', ', $ctxWords);
            if (in_array('resolved_by_context', $flags, true)) {
                $note = "Your context ($list) matches this gene's description, which separated it from the other gene(s) with the same name.";
            } elseif ($ctxWords) {
                $note = "Context words ($list) also appear in this gene's description.";
            } elseif (count($cands) > 1) {
                $note = 'The context did not help choose between the candidates.';
            }
        }
        $why = explain($lead, count($cands), $tie, $note, in_array('resolved_by_context', $flags, true));
    }

    $alternatives = array_values(array_filter(
        $cands,
        fn($c) => !$selected || $c['ncbi_gene_id'] !== $selected['ncbi_gene_id']
    ));

    return [
        'input_name'             => $input,
        'normalized_name'        => normalize_name($input),
        'species'                => $speciesName,
        'taxon_id'               => $taxon,
        'selected'               => $selected,
        'match_tier'             => $tier,
        'confidence_probability' => $prob,
        'confidence_label'       => confidence_label($prob),
        'explanation'            => $why,
        'ambiguity_flag'         => $flags,
        'candidate_count'        => count($cands),
        'context_used'           => $hasContext,
        'context_matches'        => $ctxWords,
        'alternative_candidates' => $alternatives,
    ];
}

/** Resolve one name in ONE species. */
function resolve_one(PDO $pdo, int $taxon, string $speciesName, string $input, string $context = ''): array
{
    $input = trim($input);
    $ctx   = context_tokens($context);
    return build_result(find_candidates($pdo, $taxon, $input, $ctx), $speciesName, $taxon, $input, (bool) $ctx);
}

/**
 * Resolve one name in EVERY species with a single database query.
 * Returns one answer object per species that has the name (sorted by species).
 * An empty list means no species has it.
 */
function resolve_all_species(PDO $pdo, string $input, string $context = ''): array
{
    $input = trim($input);
    $ctx   = context_tokens($context);
    $rows  = fetch_name_rows($pdo, null, $input);

    $byTaxon = [];
    foreach ($rows as $r) {
        $byTaxon[(int) $r['taxon_id']]['name'] = $r['scientific_name'];
        $byTaxon[(int) $r['taxon_id']]['rows'][] = $r;
    }

    $out = [];
    foreach ($byTaxon as $taxon => $group) {
        $out[] = build_result(rank_rows($group['rows'], $input, $ctx), $group['name'], $taxon, $input, (bool) $ctx);
    }
    // Best matches first: lowest tier, then highest confidence, then species name.
    usort($out, fn($a, $b) =>
        [$a['match_tier'] ?? 99, -($a['confidence_probability'] ?? 0), $a['species']]
        <=> [$b['match_tier'] ?? 99, -($b['confidence_probability'] ?? 0), $b['species']]);
    return $out;
}
