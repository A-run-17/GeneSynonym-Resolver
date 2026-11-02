
'use strict';

/* ============================================================
   GENESYNONYM.RESOLVER — COMPLETE FRONTEND JAVASCRIPT
   Live AJAX search, tier ranking, inline expandable gene cards
   ============================================================ */

const $ = id => document.getElementById(id);

const FLAG_TEXT = {
  no_match: 'No match',
  one_name_many_genes: 'One name, many genes',
  retired_symbol_match: 'Retired symbol',
  resolved_by_context: 'Resolved by context'
};

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function')
      node.addEventListener(key.slice(2), value);
    else if (value !== false && value != null)
      node.setAttribute(key, value === true ? '' : value);
  }

  for (const child of children.flat(Infinity)) {
    if (child != null) node.append(child);
  }

  return node;
};

function message(container, text, cls = 'empty') {
  container.replaceChildren(el('p', { class: cls, text }));
}

function notice(title, text) {
  return el('div', { class: 'notice' },
    el('strong', { text: title }),
    el('span', { text })
  );
}

const TIER_TEXT = {
  1: 'Tier 1: the input is exactly the official gene symbol.',
  2: 'Tier 2: the input is exactly a stored synonym, alias or locus tag.',
  3: 'Tier 3: matched after ignoring capitals, hyphens, underscores and spacing.'
};

function tierPill(tier) {
  if (!tier || tier > 3) return el('span', { class: 'pill', text: 'Related', title: 'A partial-name suggestion, not an exact match.' });
  return el('span', { class: 'pill', text: `Tier ${tier}`, title: TIER_TEXT[tier] });
}

function confPill(label, prob, why) {
  if (!label) return null;
  const pct = prob != null ? ` · ${Math.round(prob * 100)}%` : '';
  return el('span', {
    class: `pill conf-${label}`,
    text: label.charAt(0).toUpperCase() + label.slice(1) + pct,
    title: why || 'Confidence that this is the right gene.'
  });
}

const EXTERNAL_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" ' +
  'fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/>' +
  '<path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>' +
  '</svg>';

function linkButton(label, url, cls = 'btn-outline') {
  const icon = el('span', { class: 'icon' });
  icon.innerHTML = EXTERNAL_ICON;

  return el('a', {
    class: cls,
    href: url,
    target: '_blank',
    rel: 'noopener noreferrer'
  }, label, icon);
}

/* ------------------- API ------------------- */

async function api(path, params = {}, options = {}) {
  const url = new URL('/api' + path, location.origin);

  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value != null) {
      url.searchParams.set(key, value);
    }
  }

  // If the server says "too many requests" (429), wait a moment and try again
  // (up to 3 times) instead of failing straight away.
  let response;
  for (let attempt = 0; ; attempt++) {
    response = await fetch(url, options);
    if (response.status !== 429 || attempt >= 3) break;
    await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
  }

  let data;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const err = new Error(
      response.status === 429
        ? 'Too many requests. Please try again.'
        : data?.error || `Server error (${response.status})`
    );
    err.status = response.status;
    throw err;
  }

  return data;
}

/* ------------------- SPECIES ------------------- */

let speciesList = [];
const speciesByTaxon = new Map();

function speciesLabel(s) {
  return s.common_name
    ? `${s.scientific_name} (${s.common_name})`
    : s.scientific_name;
}

async function loadSpecies() {
  try {
    speciesList = await api('/species');

    $('s-species').replaceChildren(
      el('option', { value: 'all', text: 'All Species' })
    );
    $('b-species').replaceChildren();
    $('bulk-species').replaceChildren(
      el('option', { value: 'all', text: 'All species' })
    );

    for (const sp of speciesList) {
      speciesByTaxon.set(Number(sp.taxon_id), sp);

      for (const id of ['s-species', 'b-species', 'bulk-species']) {
        $(id).append(el('option', {
          value: sp.taxon_id,
          text: speciesLabel(sp)
        }));
      }
    }

    $('s-species').value = 'all';
    $('bulk-species').value = 'all';

    $('about-species').replaceChildren(
      ...speciesList.map(sp =>
        el('span', { class: 'chip', text: speciesLabel(sp) })
      )
    );

  } catch (err) {
    message($('s-results'), err.message, 'error');
  }
}

/* ------------------- GENE DETAILS ------------------- */

function statBox(label, value, accent = false) {
  return el('div', { class: 'stat' },
    el('span', { class: 'label', text: label }),
    el('strong', {
      class: accent ? 'accent' : '',
      text: String(value)
    })
  );
}

function aliasSection(g, matched) {
  const aliases = (g.synonyms || []).filter(s =>
    s.name_type !== 'official' &&
    s.name_raw !== g.official_symbol
  );

  if (!aliases.length) return [];

  return [
    el('h3', {
      class: 'section-label',
      text: `Reported aliases & synonyms (${aliases.length})`
    }),
    el('div', { class: 'chip-row' },
      aliases.map(s => el('span', {
        class: [
          'chip',
          s.name_type === 'retired_symbol' ? 'retired' : '',
          s.name_raw === matched ? 'hit' : ''
        ].filter(Boolean).join(' '),
        text: s.name_raw,
        title: s.name_type || 'Synonym'
      }))
    )
  ];
}

function previousIdSection(g) {
  if (!g.previous_ids?.length) return [];

  return [
    el('h3', {
      class: 'section-label',
      text: 'Previous gene IDs'
    }),
    el('div', { class: 'chip-row' },
      g.previous_ids.map(p => el('span', {
        class: 'chip retired',
        text: `${p.old_gene_id} ${p.change_type || ''} ${p.change_date || ''}`.trim()
      }))
    )
  ];
}

function xrefCard(title, subtitle, actions) {
  return el('div', { class: 'xref' },
    el('h4', { text: title }),
    el('p', { text: subtitle }),
    el('div', { class: 'xref-actions' }, actions)
  );
}

function crossRefSection(g) {
  const cards = [
    xrefCard('NCBI Gene', 'Official genomic Entrez record', [
      linkButton(
        `Open NCBI (${g.ncbi_gene_id})`,
        `https://www.ncbi.nlm.nih.gov/gene/${encodeURIComponent(g.ncbi_gene_id)}`
      )
    ])
  ];

  const groups = new Map();

  for (const x of g.cross_references || []) {
    if (!groups.has(x.external_database))
      groups.set(x.external_database, []);

    groups.get(x.external_database).push(x.external_id);
  }

  const used = new Set();

  function take(pattern) {
    const ids = [];

    for (const [db, values] of groups) {
      if (pattern.test(db)) {
        ids.push(...values);
        used.add(db);
      }
    }

    return ids;
  }

  const uniprot = take(/^uniprot/i);
  if (uniprot.length) {
    cards.push(xrefCard('UniProtKB', 'Curated protein sequence',
      uniprot.slice(0, 3).map(id =>
        linkButton(
          `Open UniProt (${id})`,
          `https://www.uniprot.org/uniprotkb/${encodeURIComponent(id)}`
        )
      )
    ));
  }

  const pdb = take(/^pdb/i);
  if (pdb.length) {
    cards.push(xrefCard('RCSB PDB 3D', 'Macromolecular structures', [
      el('div', { class: 'pdb-list' },
        pdb.slice(0, 12).map(id =>
          linkButton(
            id,
            `https://www.rcsb.org/structure/${encodeURIComponent(id)}`,
            'btn-mini'
          )
        )
      )
    ]));
  }

  const ensembl = take(/^ensembl/i);
  if (ensembl.length) {
    cards.push(xrefCard('Ensembl', 'Gene models and orthology',
      ensembl.slice(0, 3).map(id =>
        linkButton(
          `Open Ensembl (${id})`,
          `https://www.ensembl.org/id/${encodeURIComponent(id)}`
        )
      )
    ));
  }

  const others = [...groups].filter(([db]) => !used.has(db));
  if (others.length) {
    cards.push(xrefCard('Other identifiers', 'Reported by NCBI', [
      el('div', { class: 'pdb-list' },
        others.flatMap(([db, ids]) =>
          ids.slice(0, 6).map(id =>
            el('span', { class: 'chip', text: `${db}: ${id}` })
          )
        )
      )
    ]));
  }

  return [
    el('h3', {
      class: 'section-label',
      text: 'Cross-database identifiers'
    }),
    el('div', { class: 'xref-grid' }, cards)
  ];
}

function geneCard(g, opts = {}) {
  const sp = speciesByTaxon.get(Number(g.taxon_id));
  const common = sp?.common_name || 'Species';
  const badges = [];

  if (opts.tier && opts.tier <= 3) {
    badges.push(el('span', {
      class: 'badge',
      text: `Tier ${opts.tier}`,
      title: TIER_TEXT[opts.tier]
    }));
  }

  if (opts.confidence) {
    const level = String(opts.confidence).toLowerCase();
    const pct = opts.confidenceProb != null
      ? ` · ${Math.round(opts.confidenceProb * 100)}%` : '';

    badges.push(el('span', {
      class: `badge conf-${level}`,
      text: `${level.charAt(0).toUpperCase() + level.slice(1)} confidence${pct}`
    }));
  }

  for (const flag of opts.flags || []) {
    if (flag !== 'no_match') {
      badges.push(el('span', {
        class: 'badge flag',
        text: FLAG_TEXT[flag] || flag
      }));
    }
  }

  const stats = [
    statBox('NCBI Gene ID', g.ncbi_gene_id, true)
  ];

  if (g.chromosome)
    stats.push(statBox(
      'Chromosome',
      `Chr ${g.chromosome}${g.map_location ? ` (${g.map_location})` : ''}`
    ));

  if (g.type_of_gene)
    stats.push(statBox('Locus type', g.type_of_gene.toUpperCase()));

  if (g.protein_length)
    stats.push(statBox('Protein length', `${g.protein_length} AA`));

  if (g.locus_tag)
    stats.push(statBox('Locus tag', g.locus_tag));

  if (g.status != null)
    stats.push(statBox('Status', g.status));

  const annotation = g.summary ? [
    el('h3', {
      class: 'section-label',
      text: 'Functional annotation'
    }),
    el('div', {
      class: 'annotation',
      text: g.summary
    })
  ] : [];

  return el('article', { class: 'card' },
    el('header', { class: 'card-head' },
      el('div', {},
        el('div', { class: 'title-row' },
          el('h2', {
            class: 'symbol',
            text: g.official_symbol || '(no symbol)'
          }),
          badges
        ),
        el('p', { class: 'desc', text: g.description || '' })
      ),
      el('div', { class: 'organism' },
        el('span', { class: 'label', text: 'Organism' }),
        el('em', { class: 'sci', text: g.scientific_name || '' }),
        el('span', {
          class: 'common',
          text: `${common} (TaxID ${g.taxon_id})`
        })
      )
    ),
    el('div', { class: 'stats' }, stats),
    aliasSection(g, opts.matched),
    annotation,
    previousIdSection(g),
    crossRefSection(g)
  );
}

async function fetchGene(id) {
  const trail = [];
  let current = id;

  for (let hop = 0; hop < 4; hop++) {
    const g = await api('/gene/' + encodeURIComponent(current));

    if (!g.retired) return { gene: g, trail };

    trail.push(g);

    if (!g.current_gene_id) return { gene: null, trail };

    current = g.current_gene_id;
  }

  return { gene: null, trail };
}

function retiredNotice(g) {
  const when = g.change_date ? ` on ${g.change_date}` : '';

  return notice('Retired ID',
    g.current_gene_id
      ? `Gene ID ${g.old_gene_id} was replaced${when}. Current ID: ${g.current_gene_id}.`
      : `Gene ID ${g.old_gene_id} was discontinued${when}.`
  );
}

async function renderGeneResult(container, id, opts = {}) {
  message(container, 'Loading gene details…', 'loading');

  try {
    const { gene, trail } = await fetchGene(id);
    const parts = trail.map(retiredNotice);

    if (gene) parts.push(geneCard(gene, opts));

    container.replaceChildren(...parts);

  } catch (err) {
    message(container, err.message, 'error');
  }
}

/* ------------------- DIALOG ------------------- */

function openGene(id) {
  const dialog = $('gene-dialog');

  if (!dialog.open) dialog.showModal();

  renderGeneResult($('gd-body'), id);
}

$('gd-close').addEventListener('click', () => {
  $('gene-dialog').close();
});

$('gene-dialog').addEventListener('click', e => {
  if (e.target === $('gene-dialog')) $('gene-dialog').close();
});

/* ------------------- COMMON GENE LIST ------------------- */

function geneRow(g) {
  const meta = g.synonym_count != null
    ? ` · ${g.synonym_count} names`
    : '';

  return el('li', {},
    el('button', {
      type: 'button',
      class: 'gene',
      onclick: () => openGene(g.ncbi_gene_id)
    },
      el('span', {
        class: 'sym',
        text: g.official_symbol || '(no symbol)'
      }),
      el('span', { class: 'desc', text: g.description || '' }),
      el('span', { class: 'meta' },
        `${g.species || g.scientific_name || ''} · NCBI Gene ${g.ncbi_gene_id}${meta}`
      ),
      g.matched?.length
        ? el('span', {
            class: 'meta',
            text: `Matched: ${g.matched.join(', ')}`
          })
        : null
    )
  );
}

function pager(data, goToPage) {
  if (data.pages <= 1) return null;

  return el('div', { class: 'pager' },
    el('button', {
      type: 'button',
      text: 'Previous',
      disabled: data.page <= 1,
      onclick: () => goToPage(data.page - 1)
    }),
    el('span', { text: `Page ${data.page} of ${data.pages}` }),
    el('button', {
      type: 'button',
      text: 'Next',
      disabled: data.page >= data.pages,
      onclick: () => goToPage(data.page + 1)
    })
  );
}

function renderGenes(container, data, goToPage, emptyText) {
  if (!data.results?.length) {
    message(container, emptyText);
    return;
  }

  const nav = pager(data, goToPage);

  container.replaceChildren(
    el('p', {
      class: 'count',
      text: `${data.total.toLocaleString()} genes`
    }),
    el('ul', { class: 'genes' }, data.results.map(geneRow)),
    ...(nav ? [nav] : [])
  );
}

/* ------------------- ROUTING ------------------- */

const state = { letter: '' };
const VIEWS = ['search', 'browse', 'bulk', 'overview', 'about'];

function parseHash() {
  const raw = location.hash.replace(/^#/, '');
  const [view, query = ''] = raw.split('?');

  return {
    view: VIEWS.includes(view) ? view : 'search',
    params: new URLSearchParams(query)
  };
}

function setHash(view, params) {
  const query = params.toString();

  history.replaceState(
    null, '',
    '#' + view + (query ? '?' + query : '')
  );
}

function route() {
  const { view, params } = parseHash();

  document.querySelectorAll('[data-view]').forEach(section => {
    section.hidden = section.dataset.view !== view;
  });

  document.querySelectorAll('[data-tab]').forEach(tab => {
    if (tab.dataset.tab === view)
      tab.setAttribute('aria-current', 'page');
    else
      tab.removeAttribute('aria-current');
  });

  moveTabIndicator();
  window.scrollTo(0, 0);

  if (view === 'search') {
    const q = params.get('q');
    const species = params.get('species');

    if (species && [...$('s-species').options].some(
      option => option.value === species
    )) $('s-species').value = species;

    if (q && q !== $('q').value) {
      $('q').value = q;
      runSearch();
    }
  }

  if (view === 'overview') loadOverview();

  if (view === 'browse') {
    if (params.get('species'))
      $('b-species').value = params.get('species');

    if (params.get('letter'))
      state.letter = params.get('letter');

    runBrowse(1);
  }
}

/* ============================================================
   SEARCH: TIERS + INLINE EXPANSION
   ============================================================ */

let searchToken = 0;

function normalizeName(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[\s_-]/g, '');
}

// This ranks suggestions only.
// Confirmed tiers come from /api/resolve.
function suggestionTier(g, query) {
  const symbol = String(g.official_symbol || '');
  const aliases = Array.isArray(g.matched) ? g.matched : [];

  if (symbol === query) return 1;

  if (aliases.includes(query)) return 2;

  if (
    normalizeName(symbol) === normalizeName(query) ||
    aliases.some(a => normalizeName(a) === normalizeName(query))
  ) return 3;

  return 4; // Related partial name, not an exact tier match.
}

function tierSort(a, b) {
  return (a.tier || 4) - (b.tier || 4) ||
    String(a.official_symbol || '').localeCompare(
      String(b.official_symbol || '')
    ) ||
    String(a.scientific_name || '').localeCompare(
      String(b.scientific_name || '')
    );
}

function makeInlineGene(g) {
  const item = el('li', { class: 'gene-result-item' });
  const details = el('div', { class: 'inline-gene-detail' });
  const inner = el('div', { class: 'detail-inner' });

  details.append(inner);

  const button = el('button', {
    type: 'button',
    class: 'cand',
    'aria-expanded': 'false'
  },
    el('span', {
      class: 'sym',
      text: g.official_symbol || '(no symbol)'
    }),
    el('span', { class: 'main' },
      el('span', { class: 'desc', text: g.description || '' }),
      el('span', { class: 'meta' },
        el('i', { text: g.scientific_name || g.species || '' }),
        ` · NCBI Gene ${g.ncbi_gene_id}`
      )
    ),
    el('span', { class: 'chips' },
      tierPill(g.tier),
      g.tier && g.tier <= 3
        ? confPill(g.confidence, g.confidenceProb, g.explanation)
        : null
    )
  );

  button.addEventListener('click', async () => {
    const isOpen = details.classList.contains('is-open');

    // Close expanded details of other genes.
    document.querySelectorAll(
      '#s-results .inline-gene-detail.is-open'
    ).forEach(node => {
      node.classList.remove('is-open');
    });

    document.querySelectorAll(
      '#s-results .cand[aria-expanded="true"]'
    ).forEach(node => {
      node.setAttribute('aria-expanded', 'false');
    });

    if (isOpen) return;

    details.classList.add('is-open');
    button.setAttribute('aria-expanded', 'true');

    if (!inner.hasChildNodes()) {
      await renderGeneResult(inner, g.ncbi_gene_id, {
        tier: g.tier <= 3 ? g.tier : undefined,
        confidence: g.confidence,
        confidenceProb: g.confidenceProb,
        flags: g.flags || [],
        matched: g.matched_name
      });
    }

    // The details open directly below the clicked row.
    // We intentionally do not scroll the page to the top.
  });

  item.append(button, details);
  return item;
}

function renderRankedMatches(
  container,
  matches,
  heading,
  extra = []
) {
  const unique = [
    ...new Map(matches.map(g => [
      String(g.ncbi_gene_id), g
    ])).values()
  ];

  unique.sort(tierSort);

  container.replaceChildren(
    ...extra,
    el('p', { class: 'count', text: heading }),
    el('ul', {
      class: 'cand-list'
    }, unique.map(makeInlineGene)),
    el('p', { class: 'legend' },
      el('strong', { text: 'Match tier ' }),
      '1 = exact official symbol · 2 = exact alias or locus tag · 3 = matched after ignoring capitals and hyphens. ',
      el('strong', { text: 'Confidence ' }),
      'is a 0–100% score: high 85% or more, medium 60–84%, low below 60%. Hover a label for the reason.'
    )
  );
}

/* ============================================================
   AJAX LIVE SEARCH / AUTOCOMPLETE
   ============================================================ */

const LIVE_MIN_CHARS = 2;
const LIVE_DELAY_MS = 300;

let liveToken = 0;
let liveTimer = null;
let liveController = null;

function suggestionBox() {
  let box = $('live-suggestions');

  // Also works if the HTML has not yet been updated.
  if (!box) {
    box = el('div', {
      id: 'live-suggestions',
      class: 'live-suggestions',
      role: 'listbox'
    });

    box.hidden = true;
    $('search-form').append(box);
  }

  return box;
}

function closeLiveSuggestions() {
  const box = suggestionBox();
  box.hidden = true;
  box.replaceChildren();
  $('q').setAttribute('aria-expanded', 'false');
}

async function apiLiveSearch(species, query, signal) {
  return api('/search', {
    q: query,
    species,
    mode: 'contains',
    per_page: 30
  }, { signal });
}

async function updateLiveSuggestions() {
  const query = $('q').value.trim();
  const selectedSpecies = $('s-species').value;
  const token = ++liveToken;

  liveController?.abort();
  liveController = new AbortController();

  const signal = liveController.signal;
  const box = suggestionBox();

  if (query.length < LIVE_MIN_CHARS || !selectedSpecies) {
    closeLiveSuggestions();
    return;
  }

  box.hidden = false;
  message(box, 'Finding related genes…', 'loading');
  $('q').setAttribute('aria-expanded', 'true');

  // ONE request is enough: the server searches every species when no species is given.
  const hits = [];
  let failed = false;

  try {
    const data = await apiLiveSearch(
      selectedSpecies === 'all' ? '' : selectedSpecies,
      query,
      signal
    );

    for (const g of data.results || []) {
      hits.push({
        ...g,
        scientific_name: g.species,
        tier: suggestionTier(g, query)
      });
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    failed = true;
  }

  // Ignore results from older keystrokes.
  if (token !== liveToken) return;

  const unique = [
    ...new Map(hits.map(g => [
      String(g.ncbi_gene_id), g
    ])).values()
  ];

  unique.sort(tierSort);

  const suggestions = unique.slice(0, 30);

  if (!suggestions.length) {
    message(
      box,
      failed
        ? 'Could not load suggestions.'
        : 'No related genes found.'
    );
    return;
  }

  box.replaceChildren(
    ...suggestions.map(g =>
      el('button', {
        type: 'button',
        class: 'live-suggestion',
        role: 'option',
        onclick: () => {
          $('q').value = g.official_symbol;

          // Preserve the matched organism.
          if (selectedSpecies === 'all' && g.taxon_id) {
            $('s-species').value = String(g.taxon_id);
          }

          closeLiveSuggestions();
          runSearch();
        }
      },
        el('span', {},
          el('strong', {
            text: g.official_symbol
          }),
          el('small', {
            text: `${g.scientific_name} · NCBI ${g.ncbi_gene_id}`
          })
        ),
        el('span', {
          class: 'tier-tag',
          text: g.tier <= 3 ? `Tier ${g.tier}` : 'Related'
        })
      )
    )
  );
}

// Trigger AJAX when user types.
$('q').addEventListener('input', () => {
  clearTimeout(liveTimer);
  ++liveToken;
  liveController?.abort();

  const query = $('q').value.trim();

  if (query.length < LIVE_MIN_CHARS) {
    closeLiveSuggestions();
    return;
  }

  liveTimer = setTimeout(
    updateLiveSuggestions,
    LIVE_DELAY_MS
  );
});

// Update suggestions when organism changes.
$('s-species').addEventListener('change', () => {
  clearTimeout(liveTimer);
  ++liveToken;
  liveController?.abort();

  if ($('q').value.trim().length >= LIVE_MIN_CHARS) {
    liveTimer = setTimeout(updateLiveSuggestions, 50);
  } else {
    closeLiveSuggestions();
  }
});

$('q').addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    clearTimeout(liveTimer);
    ++liveToken;
    liveController?.abort();
    closeLiveSuggestions();
  }
});

/* ============================================================
   CONFIRMED MATCHES FROM /api/resolve
   ============================================================ */

async function resolveOneSpecies(name, taxon) {
  const result = await api('/resolve', {
    species: taxon,
    name
  });

  const candidates = [
    result.selected,
    ...(result.alternative_candidates || [])
  ].filter(Boolean);

  return [
    ...new Map(candidates.map(c => [
      String(c.ncbi_gene_id),
      {
        ...c,
        tier: c.match_tier || result.match_tier || 4,
        confidence: c.confidence_label || result.confidence_label,
        confidenceProb: c.confidence_probability ?? result.confidence_probability,
        explanation: result.explanation,
        flags: result.ambiguity_flag || []
      }
    ])).values()
  ];
}

async function runSearch() {
  const name = $('q').value.trim();
  const taxon = $('s-species').value;
  const out = $('s-results');

  clearTimeout(liveTimer);
  ++liveToken;
  liveController?.abort();
  closeLiveSuggestions();

  const token = ++searchToken;

  if (!name) {
    message(out, 'Type a gene name, symbol or ID to search.');
    return;
  }

  if (!taxon) {
    message(out, 'Choose a species first.');
    return;
  }

  setHash('search', new URLSearchParams({
    q: name,
    species: taxon
  }));

  message(out, 'Resolving genes…', 'loading');

  try {
    // Numeric NCBI Gene ID lookup.
    if (/^\d{1,18}$/.test(name)) {
      try {
        const { gene, trail } = await fetchGene(name);

        if (token !== searchToken) return;

        if (gene) {
          if (
            taxon !== 'all' &&
            String(gene.taxon_id) !== String(taxon)
          ) {
            out.replaceChildren(notice(
              'Species mismatch',
              `This Gene ID belongs to ${gene.scientific_name}.`
            ));
            return;
          }

          out.replaceChildren(
            ...trail.map(retiredNotice),
            geneCard(gene)
          );
          return;
        }

        if (trail.length) {
          out.replaceChildren(...trail.map(retiredNotice));
          return;
        }
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }

    let failures = 0;
    let matches = [];

    try {
      if (taxon === 'all') {
        // One request: the server checks every species for us.
        const all = await api('/resolve/all', { name });

        matches = (all.matches || []).map(g => ({
          ...g,
          tier: g.match_tier || 4,
          confidence: g.confidence_label,
          confidenceProb: g.confidence_probability,
          flags: g.flags || []
        }));
      } else {
        const sp = speciesByTaxon.get(Number(taxon));
        const genes = await resolveOneSpecies(name, taxon);

        matches = genes.map(g => ({
          ...g,
          scientific_name: sp ? sp.scientific_name : ''
        }));
      }
    } catch {
      failures = 1;
    }

    if (token !== searchToken) return;

    const notes = failures ? [
      notice(
        'Search problem',
        'The search could not be completed. Please try again in a moment.'
      )
    ] : [];

    if (matches.length) {
      renderRankedMatches(
        out,
        matches,
        `${matches.length} matching gene(s) · ordered by match tier`,
        notes
      );
      return;
    }

    // No exact match: get related genes instead (one request, all species or the chosen one).
    const related = [];
    let errors = 0;

    try {
      const data = await api('/search', {
        q: name,
        species: taxon === 'all' ? '' : taxon,
        mode: 'contains',
        per_page: 100
      });

      related.push(...(data.results || []).map(g => ({
        ...g,
        scientific_name: g.species,
        tier: suggestionTier(g, name)
      })));
    } catch {
      errors++;
    }

    if (token !== searchToken) return;

    if (related.length) {
      renderRankedMatches(
        out,
        related,
        'Related genes (partial-name suggestions)',
        notes
      );
    } else {
      out.replaceChildren(
        ...notes,
        notice(
          'No match',
          errors
            ? 'No results found; some search requests failed.'
            : `No genes matching "${name}" were found.`
        )
      );
    }

  } catch (err) {
    if (token === searchToken)
      message(out, err.message, 'error');
  }
}

$('search-form').addEventListener('submit', e => {
  e.preventDefault();
  runSearch();
});

/* ============================================================
   BROWSER
   ============================================================ */

function renderLetters(letters, current) {
  const counts = new Map(
    letters.map(l => [l.letter, l.count])
  );

  const alphabet = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'];

  $('letters').replaceChildren(
    ...alphabet.map(letter =>
      el('button', {
        type: 'button',
        text: letter,
        'aria-pressed': String(letter === current),
        title: counts.has(letter)
          ? `${counts.get(letter).toLocaleString()} genes`
          : 'No genes',
        disabled: !counts.has(letter),
        onclick: () => {
          state.letter = letter;
          runBrowse(1);
        }
      })
    )
  );
}

async function runBrowse(page = 1) {
  const species = $('b-species').value;
  const out = $('b-results');

  if (!species) {
    message(out, 'Choose a species to browse.');
    return;
  }

  out.setAttribute('aria-busy', 'true');

  try {
    const data = await api('/browse', {
      species,
      letter: state.letter,
      page,
      per_page: 50
    });

    state.letter = data.letter;

    setHash('browse', new URLSearchParams({
      species,
      letter: data.letter
    }));

    renderLetters(data.letters, data.letter);

    renderGenes(
      out,
      data,
      runBrowse,
      'This species has no genes loaded yet.'
    );

  } catch (err) {
    message(out, err.message, 'error');
  } finally {
    out.removeAttribute('aria-busy');
  }
}

$('b-species').addEventListener('change', () => {
  state.letter = '';
  runBrowse(1);
});

/* ============================================================
   BULK CONVERTER
   ============================================================ */

let bulkBody = null;
let bulkResults = [];

function parseNames(text) {
  return text
    .split(/\r?\n/)
    .map(line => line.split(/[,\t]/)[0].trim())
    .filter(Boolean);
}

function setBulkStatus(text) {
  $('bulk-status').textContent = text;
}

$('bulk-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;

  if (file.size > 2 * 1024 * 1024) {
    setBulkStatus('That file is larger than 2 MB.');
    return;
  }

  try {
    $('bulk-names').value = await file.text();
    setBulkStatus(`Loaded ${file.name}.`);
  } catch {
    setBulkStatus('Could not read the file.');
  }
});

function td(content) {
  return el('td', {}, content);
}

function renderBulk(results) {
  const tbody = document.querySelector('#bulk-table tbody');
  let previous = null;

  tbody.replaceChildren(
    ...results.map(r => {
      const selected = r.selected;
      const first = r.input_name !== previous;
      previous = r.input_name;

      const dash = () => el('span', { class: 'dash', text: '—' });

      const idCell = selected
        ? el('button', {
            type: 'button',
            class: 'link',
            text: String(selected.ncbi_gene_id),
            onclick: () => openGene(selected.ncbi_gene_id)
          })
        : dash();

      // With no clear winner (a tie) the top candidate is still shown, in the alternatives column.
      const conf = confPill(r.confidence_label, r.confidence_probability, r.explanation);

      const tr = el('tr', { class: first ? 'group-start' : '' },
        el('td', { class: first ? '' : 'repeat', text: first ? r.input_name : '' }),
        el('td', { class: 'sp', text: r.species === 'All species' ? '—' : r.species }),
        td(idCell),
        td(selected ? selected.official_symbol : dash()),
        td(r.match_tier ? tierPill(r.match_tier) : dash()),
        td(conf || dash()),
        td((r.ambiguity_flag || [])
          .map(f => FLAG_TEXT[f] || f)
          .join(', ')
        ),
        td((r.alternative_candidates || [])
          .map(a => `${a.official_symbol} (${a.ncbi_gene_id})`)
          .join('; ')
        )
      );
      return tr;
    })
  );

  $('bulk-output').hidden = false;
}

function postBatch(body, format) {
  const suffix = format
    ? `?format=${encodeURIComponent(format)}`
    : '';

  return fetch('/api/resolve/batch' + suffix, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

$('bulk-run').addEventListener('click', async () => {
  const body = {
    species: $('bulk-species').value === 'all'
      ? 'all'
      : Number($('bulk-species').value),
    names: parseNames($('bulk-names').value),
    context: $('bulk-context').value
  };

  if (!body.species) {
    setBulkStatus('Choose a species.');
    return;
  }

  if (!body.names.length) {
    setBulkStatus('Enter at least one name.');
    return;
  }

  setBulkStatus('Working…');

  try {
    const response = await postBatch(body);

    let data;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      setBulkStatus(
        data?.error || `Request failed (${response.status}).`
      );
      return;
    }

    bulkBody = body;
    bulkResults = data.results || [];

    renderBulk(bulkResults);

    const speciesHit = new Set(
      bulkResults.filter(r => r.taxon_id).map(r => r.taxon_id)
    ).size;
    const ctxNote = data.context_used ? ' Context was used to rank ambiguous names.' : '';
    setBulkStatus(
      (body.species === 'all'
        ? `${data.count} names resolved · ${data.row_count} rows across ${speciesHit} species.`
        : `${data.count} names resolved.`) + ctxNote
    );

  } catch {
    setBulkStatus(
      'Request failed. Check that the server is running.'
    );
  }
});

/* ------------------- EXPORT ------------------- */

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });

  document.body.append(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('dl-json').addEventListener('click', () => {
  saveBlob(
    new Blob(
      [JSON.stringify(bulkResults, null, 2)],
      { type: 'application/json' }
    ),
    'resolved.json'
  );
});

$('dl-csv').addEventListener('click', async () => {
  if (!bulkBody) return;

  try {
    const response = await postBatch(bulkBody, 'csv');

    if (!response.ok) throw new Error('CSV export failed.');

    saveBlob(await response.blob(), 'resolved.csv');

  } catch (err) {
    setBulkStatus(err.message);
  }
});

/* ============================================================
   SLIDING LINE UNDER THE ACTIVE TAB
   One coral line glides from the old tab to the new one.
   ============================================================ */

let indicatorReady = false;

function moveTabIndicator() {
  const nav = document.querySelector('.tabs');
  const line = nav && nav.querySelector('.tab-indicator');
  const active = nav && nav.querySelector('[aria-current="page"]');

  if (!line || !active) return;

  // offsetLeft/offsetTop = where the tab sits inside the nav.
  const x = active.offsetLeft;
  const y = active.offsetTop + active.offsetHeight - line.offsetHeight;

  line.style.width = active.offsetWidth + 'px';
  line.style.transform = `translate(${x}px, ${y}px)`;

  // The very first placement must not animate (no sliding in from the corner).
  if (!indicatorReady) {
    indicatorReady = true;
    requestAnimationFrame(() => line.classList.add('is-ready'));
  }
}

window.addEventListener('resize', moveTabIndicator);
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(moveTabIndicator);  // fonts change the tab widths
}

/* ============================================================
   OVERVIEW PAGE: live numbers and source files
   ============================================================ */

let overviewLoaded = false;

async function loadOverview() {
  if (overviewLoaded) return;

  try {
    const [stats, releases] = await Promise.all([
      api('/stats'),
      api('/releases')
    ]);

    document.querySelectorAll('[data-stat]').forEach(node => {
      const v = stats[node.dataset.stat];
      if (v != null) node.textContent = Number(v).toLocaleString();
    });

    document.querySelector('#ov-releases tbody').replaceChildren(
      ...releases.map(r => el('tr', {},
        el('td', { text: r.source_name || '' }),
        el('td', { class: 'mono', text: r.release_version || '' }),
        el('td', { text: r.download_date || '' })
      ))
    );

    overviewLoaded = true;
  } catch {
    // The page still reads fine without the live numbers.
  }
}

/* ============================================================
   THEME SWITCH (dark <-> light, no page reload)
   ============================================================ */

function applyTheme(theme, save) {
  const root = document.documentElement;
  const btn = $('theme-toggle');

  root.setAttribute('data-theme', theme);
  btn.setAttribute('aria-pressed', String(theme === 'light'));
  btn.setAttribute(
    'aria-label',
    theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'
  );

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f6fbf8' : '#121415');

  if (save) {
    try { localStorage.setItem('theme', theme); } catch { /* private mode */ }
  }
}

$('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light'
    ? 'dark' : 'light';
  applyTheme(next, true);
});

applyTheme(document.documentElement.getAttribute('data-theme') || 'dark', false);

/* Example chips under the search bar */
document.querySelectorAll('.example').forEach(btn => {
  btn.addEventListener('click', () => {
    $('q').value = btn.dataset.example;
    runSearch();
  });
});

/* ============================================================
   START APPLICATION
   ============================================================ */

window.addEventListener('hashchange', route);

loadSpecies().then(route);
