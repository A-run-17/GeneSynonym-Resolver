<?php
declare(strict_types=1);

function normalize_name(string $name): string
{
    // 1. standard character forms (same as Python's unicodedata NFKC)
    if (class_exists('Normalizer')) {
        $fixed = Normalizer::normalize($name, Normalizer::FORM_KC);
        if ($fixed !== false) {
            $name = $fixed;
        }
    }
    // 2. lowercase
    $s = mb_strtolower($name, 'UTF-8');
    // 3. Greek letters to words (keep identical to your Python list)
    $s = strtr($s, ['α' => 'alpha', 'β' => 'beta']);
    // 4. hyphens, underscores, slashes and dots become spaces
    $s = preg_replace('/[-_\/.]/u', ' ', $s);
    // 5. collapse repeated spaces and trim the ends
    $s = preg_replace('/\s+/u', ' ', $s);
    return trim($s);
}
