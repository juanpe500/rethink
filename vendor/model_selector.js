/**
 * ModelSelectorModal — Reusable AI model picker modal (workspace-themed).
 *
 * Dependency-free, framework-free, self-styling (injects its own <style>).
 * Drop the file in via a <script> tag / CDN and call the static API — nothing
 * in it talks to a backend or imports anything.
 *
 * Usage:
 *   ModelSelectorModal.open({
 *       inputModalities: ['text'],
 *       outputModalities: ['text'],
 *       currentModel: 'google/gemini-2.5-flash',   // native id, or a 'ir:'/'nv:' uid
 *       apis: ['openrouter', 'nvidia'],            // optional hard restriction
 *       onSelect: (modelId, modelObj, api) => { ... }
 *   });
 *   ModelSelectorModal.close();
 *   ModelSelectorModal.getDefault();   // reads ms_default_model
 *
 * ── N CATALOGS, ONE LIST ─────────────────────────────────────────────────────
 * Models come from any number of sources, each a window global the HOST page
 * fills (this file never fetches). Sources are declared once in MS_APIS; today:
 *
 *   window.OPENROUTER_MODELS   {data:[...]}  OpenRouter /models, verbatim.
 *                              Text + image models, priced per TOKEN.
 *   window.NVIDIA_MODELS       {data:[...]}  NVIDIA's OpenAI-style /models,
 *                              enriched by the host into OpenRouter shape (same
 *                              ids). Token-priced, free. Same parser as OR.
 *   window.IMAGEROUTER_MODELS  {data:[...]}  ImageRouter /v2/models, verbatim.
 *                              Image output only, priced per IMAGE, free tier.
 *
 * Each source's `shape` (in MS_APIS) picks the raw parser in _facts(): a new
 * OpenRouter-shaped source needs no new code. They are merged into one pool and
 * separated by the API tabs in the header (All / OpenRouter / NVIDIA / …), which
 * are just a hidden facet filter with a nicer hat — the tab strip only shows
 * when 2+ sources have models for the requested modalities. _facts() is the ONLY
 * place that reads any raw shape; everything downstream (filters, sorts, badges,
 * info panel) consumes the flat facts object, so a stripped catalog (NVIDIA
 * models OpenRouter doesn't know) or a shape with no concept of tokens at all
 * (ImageRouter) degrades to nulls/false there and nowhere else.
 *
 * Facet groups whose every option counts zero in the current scope are hidden,
 * which is what keeps the sidebar honest: pick ImageRouter and the reasoning,
 * context and caching groups disappear instead of showing eight zeroes.
 *
 * Optional: window.MS_API_STATUS = { <api>: { configured: bool } } marks a tab
 * with a ⚠ when the host has no key for that source (browse-only). Absent = no
 * warning. (window.IMAGE_APIS is honored as the old name for this.)
 *
 * The host is responsible for BYOK / provider auth: it fetches each catalog with
 * whatever key it holds and drops it in the matching global. This file only
 * shows what it's handed and hands the pick back — no key entry lives here.
 *
 * ── IDENTITY ────────────────────────────────────────────────────────────────
 * Rows, favorites and the default model are keyed by `uid`: the plain id for
 * OpenRouter, namespaced for the rest ('ir:' ImageRouter, 'nv:' NVIDIA). Sources
 * can and do list the same id (NVIDIA mirrors OpenRouter's ids exactly), and the
 * host has to know which API to call either way. onSelect still receives the
 * NATIVE id first — existing callers are unaffected — with the api as a third
 * argument and on modelObj._api. Helpers for host wiring: ModelSelectorModal
 * .apiOf(idOrUid) → source key, and .nativeId(uid) → id with the prefix stripped.
 *
 * localStorage keys (existing, kept): ms_favorites, ms_default_model,
 * ms_collapsed (provider groups), ms_group_by_provider, ms_density,
 * ms_facet_collapsed.
 *
 * See the WIRING NOTES block at the bottom for how to connect the rich model
 * metadata (reasoning efforts, caching, tools, max output, expiration) to the
 * actual agent request later. Nothing in this file talks to the backend.
 */

// The catalogs, and everything that differs between them in the UI. This is
// the single place a new source is registered: give it a label, an abbr for
// the row chip, the pricing unit, the window global its loader fills, and the
// uid namespace. `shape` says which raw JSON parser to use in _facts() —
// 'openrouter' for anything in the OpenRouter /models shape (OpenRouter itself,
// and NVIDIA, whose catalog the backend enriches into that exact shape),
// 'imagerouter' for the ImageRouter /v2/models shape.
//
// uidPrefix MUST be unique and non-empty for every source that can collide with
// another's ids. NVIDIA reuses OpenRouter's exact `vendor/model` ids, so it is
// namespaced 'nv:'; OpenRouter keeps the bare id so favorites/defaults saved
// before any of this still match.
const MS_APIS = {
    openrouter:  { label: 'OpenRouter',  abbr: 'OR', unit: 'token', shape: 'openrouter',  global: 'OPENROUTER_MODELS',  uidPrefix: '' },
    nvidia:      { label: 'NVIDIA',      abbr: 'NV', unit: 'token', shape: 'openrouter',  global: 'NVIDIA_MODELS',      uidPrefix: 'nv:' },
    imagerouter: { label: 'ImageRouter', abbr: 'IR', unit: 'image', shape: 'imagerouter', global: 'IMAGEROUTER_MODELS', uidPrefix: 'ir:' },
};
const MS_API_KEYS = Object.keys(MS_APIS);
// uidPrefix → api key, for resolving a saved uid back to its source. Longest
// prefix first so an empty-prefix source never shadows a real one.
const MS_UID_PREFIXES = MS_API_KEYS
    .filter(a => MS_APIS[a].uidPrefix)
    .map(a => [MS_APIS[a].uidPrefix, a])
    .sort((x, y) => y[0].length - x[0].length);
// Read a source's catalog global by name, tolerating its absence — a catalog
// that never loaded is simply skipped, so the others still render.
function _msCatalog(api) {
    const g = MS_APIS[api] && MS_APIS[api].global;
    const c = g && typeof window !== 'undefined' ? window[g] : undefined;
    return (c && Array.isArray(c.data)) ? c : null;
}

// ── Facet definitions ────────────────────────────────────────────────────────
// Declarative: adding a filter = adding an entry here; render + filtering are
// generic. Every test() receives the normalized facts object from _facts() —
// never the raw model — so missing fields degrade safely.
//
// Groups always AND with each other. WITHIN a group the mode is per-group and
// user-toggleable (badge in the header), because the two kinds of facet want
// opposite defaults:
//   mode:'all' → requirements. "Tools + Structured" means BOTH. (capabilities,
//                modalities, caching)
//   mode:'any' → alternatives. "Effort high + low" means EITHER. (efforts,
//                price/context buckets, tokenizer…)  ← default when unset
// lockMode pins a group that only makes sense one way (a model has exactly one
// tokenizer, so 'all' would always yield zero).
const MS_FACETS = [
    // Backs the API tab strip in the header rather than a sidebar block —
    // hence `hidden`. It is a normal facet group in every other respect, which
    // is what makes the tab persist, clear and restore with the rest.
    { key: 'api', title: 'API', hidden: true, lockMode: 'any',
      options: MS_API_KEYS.map(a => (
          { id: a, label: MS_APIS[a].label, test: f => f.api === a }
      ))},
    { key: 'cap', title: 'Capabilities', open: true, mode: 'all', options: [
        { id: 'tools',      label: 'Tools',               test: f => f.hasTools },
        { id: 'structured', label: 'Structured outputs',  test: f => f.hasStructured },
        { id: 'respfmt',    label: 'Response format',     test: f => f.hasResponseFormat },
        { id: 'ptc',        label: 'Parallel tool calls', test: f => f.params.has('parallel_tool_calls') },
        { id: 'seed',       label: 'Seed',                test: f => f.hasSeed },
        { id: 'logprobs',   label: 'Logprobs',            test: f => f.hasLogprobs },
        { id: 'websearch',  label: 'Web search',          test: f => f.hasWebSearch },
    ]},
    // WIRING NOTES (1): reasoning facts (efforts, mandatory) are already parsed
    // in _facts(); selecting an effort for the request is not implemented yet.
    { key: 'reason', title: 'Reasoning', open: true, options: [
        { id: 'any',       label: 'Supports reasoning',     test: f => f.hasReasoning },
        { id: 'mandatory', label: 'Always-on (mandatory)',  test: f => f.hasReasoning && f.reasoningMandatory },
        { id: 'optional',  label: 'Optional (can disable)', test: f => f.hasReasoning && !f.reasoningMandatory },
        { id: 'effctl',    label: 'Effort control',         test: f => f.hasEffortCtl },
        ...['xhigh', 'high', 'medium', 'low', 'minimal', 'none'].map(e => (
            { id: 'eff_' + e, label: 'Effort: ' + e, test: f => f.efforts.includes(e) }
        )),
    ]},
    // Tiers are MUTUALLY EXCLUSIVE (not cumulative "≤ X") on purpose: it's the
    // only way "check everything except Free" actually excludes free models —
    // under cumulative buckets a $0 model still satisfies "≤ $1". As a bonus
    // the counts now sum to the catalog total, which is what makes a facet
    // list feel trustworthy. Every model lands in exactly one tier: routers
    // ("-1") and catalogs without pricing fall into Variable/unknown.
    //
    // Every option is gated on f.tokenPriced. Per-token and per-image prices
    // are not comparable — $3/M tokens next to $0.04/image in the same tier
    // list would be gibberish — so ImageRouter models are not "unknown" here,
    // they are simply absent, and the group hides itself on the IR tab.
    { key: 'price', title: 'Price · per token', open: true, options: [
        { id: 'free', label: 'Free',              test: f => f.tokenPriced && f.isFree },
        { id: 'p1',   label: '≤ $1/M',            test: f => f.tokenPriced && f.priceIn !== null && !f.isFree && f.priceIn <= 1 },
        { id: 'p5',   label: '$1 – $5/M',         test: f => f.tokenPriced && f.priceIn !== null && f.priceIn > 1 && f.priceIn <= 5 },
        { id: 'p15',  label: '$5 – $15/M',        test: f => f.tokenPriced && f.priceIn !== null && f.priceIn > 5 && f.priceIn <= 15 },
        { id: 'pmax', label: '> $15/M',           test: f => f.tokenPriced && f.priceIn !== null && f.priceIn > 15 },
        { id: 'pvar', label: 'Variable / unknown', test: f => f.tokenPriced && f.priceIn === null },
    ]},
    // ImageRouter's half of the same idea. Exclusive tiers again, cut where the
    // catalog actually clusters (roughly 14 / 43 / 46 / 29 / 6 models). "Free"
    // means free at the TOP of the min/max spread, so a model that merely has a
    // cheap setting is never sold as free — see _facts().
    { key: 'imgprice', title: 'Price · per image', open: true, options: [
        { id: 'free', label: 'Free',            test: f => f.imagePriced && f.isFree },
        { id: 'i1',   label: '≤ $0.01',         test: f => f.imagePriced && !f.isFree && f.priceImage !== null && f.priceImage <= 0.01 },
        { id: 'i4',   label: '$0.01 – $0.04',   test: f => f.imagePriced && f.priceImage !== null && f.priceImage > 0.01 && f.priceImage <= 0.04 },
        { id: 'i10',  label: '$0.04 – $0.10',   test: f => f.imagePriced && f.priceImage !== null && f.priceImage > 0.04 && f.priceImage <= 0.10 },
        { id: 'imax', label: '> $0.10',         test: f => f.imagePriced && f.priceImage !== null && f.priceImage > 0.10 },
        { id: 'ivar', label: 'Unknown',         test: f => f.imagePriced && f.priceImage === null },
    ]},
    // Exclusive tiers, same rationale as price. Boundaries are upper-inclusive
    // EXCEPT the top one, which is "≥ 1M" inclusive on purpose: a pile of
    // frontier models sit at exactly 1000000 and belong in the 1M tier, not
    // below it. ctx 0 means the catalog didn't say (NVIDIA) → its own tier,
    // never silently counted as small. A context window is a token-catalog
    // concept, so "Unknown" is scoped to models that could have had one.
    { key: 'ctx', title: 'Context', open: true, options: [
        { id: 'c32',   label: '≤ 32K',      test: f => f.ctx > 0 && f.ctx <= 32000 },
        { id: 'c128',  label: '32K – 128K', test: f => f.ctx > 32000 && f.ctx <= 128000 },
        { id: 'c200',  label: '128K – 200K', test: f => f.ctx > 128000 && f.ctx <= 200000 },
        { id: 'c500',  label: '200K – 1M',  test: f => f.ctx > 200000 && f.ctx < 1000000 },
        { id: 'c1m',   label: '≥ 1M',       test: f => f.ctx >= 1000000 },
        { id: 'cunk',  label: 'Unknown',    test: f => f.tokenPriced && !f.ctx },
    ]},
    // ImageRouter-only: what the /images/edits endpoint will accept alongside
    // the prompt. Requirements, so mode 'all'.
    { key: 'imgedit', title: 'Image editing', open: false, mode: 'all', options: [
        { id: 'mask',    label: 'Mask / inpainting', test: f => f.acceptsMask },
        { id: 'quality', label: 'Quality control',   test: f => f.acceptsQuality },
    ]},
    { key: 'modin', title: 'Input modality', open: false, mode: 'all', options: [
        { id: 'text',  label: 'Text',  test: f => f.inMods.includes('text') },
        { id: 'image', label: 'Image', test: f => f.inMods.includes('image') },
        { id: 'file',  label: 'File',  test: f => f.inMods.includes('file') },
        { id: 'audio', label: 'Audio', test: f => f.inMods.includes('audio') },
        { id: 'video', label: 'Video', test: f => f.inMods.includes('video') },
    ]},
    { key: 'modout', title: 'Output modality', open: false, mode: 'all', options: [
        { id: 'text',  label: 'Text',  test: f => f.outMods.includes('text') },
        { id: 'image', label: 'Image', test: f => f.outMods.includes('image') },
        { id: 'audio', label: 'Audio', test: f => f.outMods.includes('audio') },
    ]},
    // WIRING NOTES (2): cache read/write prices parsed in _facts(); actually
    // using prompt caching happens in the agent engine, not here.
    { key: 'cache', title: 'Prompt caching', open: false, mode: 'all', options: [
        { id: 'read',  label: 'Cache read',  test: f => f.hasCacheRead },
        { id: 'write', label: 'Cache write', test: f => f.hasCacheWrite },
    ]},
    { key: 'bench', title: 'Benchmarks', open: false, sliders: true, options: [
        { id: 'aa',    label: 'Has AA score',     test: f => !!f.aa },
        { id: 'arena', label: 'Has Design Arena', test: f => !!f.arenaBest },
    ]},
    // Release date is the one freshness signal both catalogs carry (OpenRouter
    // `created`, ImageRouter `release_date`), so it leads. The rest are
    // token-catalog fields — scoped, or "Not deprecated" would silently match
    // every ImageRouter model and keep this group on screen for no reason.
    { key: 'fresh', title: 'Freshness', open: false, options: [
        { id: 'rel25', label: 'Released ≥ 2025',   test: f => f.releaseYear >= 2025 },
        { id: 'cut25', label: 'Cutoff ≥ 2025',     test: f => !!f.cutoff && f.cutoff >= '2025' },
        { id: 'alias', label: 'Latest alias (~)',  test: f => f.isAlias },
        { id: 'nodep', label: 'Not deprecated',    test: f => f.tokenPriced && !f.expires },
    ]},
    { key: 'other', title: 'Other', open: false, options: [
        { id: 'fav',   label: '⭐ Favorites',   test: (f, self) => self._isFavorite(f.uid) },
        { id: 'mod',   label: 'Moderated',      test: f => f.moderated },
        { id: 'unmod', label: 'Not moderated',  test: f => f.tokenPriced && !f.moderated },
    ]},
];

// Sort table. natAsc = the "natural" direction on first selection (cheapest
// first, newest first, smartest first…). Models with a null sort value always
// go LAST, regardless of direction — that's what keeps stripped-down catalogs
// (NVIDIA) and benchmark-less models from polluting the top of the list.
const MS_SORTS = [
    { key: 'name',     label: 'Name',             str: true,  natAsc: true,  val: f => f.nameLower },
    { key: 'priceIn',  label: 'Price (per token, in)',        natAsc: true,  val: f => f.priceIn },
    { key: 'priceOut', label: 'Price (per token, out)',       natAsc: true,  val: f => f.priceOut },
    // Its own entry rather than one merged "price": $/token and $/image can't
    // be ordered against each other. On the All tab the other catalog's models
    // sort last as nulls, which is the honest answer — "not priced this way".
    { key: 'priceImg', label: 'Price (per image)',            natAsc: true,  val: f => f.priceImage },
    { key: 'ctx',      label: 'Context',                      natAsc: false, val: f => f.ctx || null },
    { key: 'created',  label: 'Newest',                       natAsc: false, val: f => f.created || null },
    { key: 'cutoff',   label: 'Knowledge cutoff', str: true,  natAsc: false, val: f => f.cutoff },
    { key: 'maxout',   label: 'Max output',                   natAsc: false, val: f => f.maxOut },
    { key: 'aaint',    label: 'AA intelligence',              natAsc: false, val: f => f.aa ? f.aa.intelligence_index : null },
    { key: 'aacode',   label: 'AA coding',                    natAsc: false, val: f => f.aa ? f.aa.coding_index : null },
    { key: 'aaagent',  label: 'AA agentic',                   natAsc: false, val: f => f.aa ? f.aa.agentic_index : null },
    { key: 'elo',      label: 'Arena elo',                    natAsc: false, val: f => f.arenaBest ? f.arenaBest.elo : null },
];

const MS_EFFORT_ORDER = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'];
const MS_EFFORT_ABBR = { max: 'max', xhigh: 'xhi', high: 'hi', medium: 'med', low: 'lo', minimal: 'min', none: 'off' };

// AA slider config: state key → [label, benchmark field]
const MS_AA_SLIDERS = [
    ['i', 'Intelligence', 'intelligence_index'],
    ['c', 'Coding',       'coding_index'],
    ['g', 'Agentic',      'agentic_index'],
];

// Storage key for filters+sort. Bump the suffix whenever an option id changes
// meaning (not just when ids are added) — see the constructor for why.
// v3: price/context/freshness options became API-scoped, and the 'api' group
// was added, so a v2 blob could restore a filter that now means less than it
// did and quietly hide half the catalog.
const MS_PREFS_KEY = 'ms_prefs_v3';

// First-run preset — applied ONLY when MS_PREFS_KEY is absent (never seen this
// browser). Once anything is saved, the user's own config always wins, and an
// empty config stays empty: clearing every filter persists as "no filters",
// it does NOT resurrect this preset on the next open.
// Dream note: intentionally NO facet filters here — not even an API tab. The
// same picker serves text generation AND image generation (the caller
// pre-filters by modality), so an opinionated preset like "must support tools"
// would blank the list for image models, and defaulting to one catalog would
// hide the other. Newest first, no constraints; `created` is populated for
// both catalogs so that ordering is meaningful across the merged list.
const MS_DEFAULT_PREFS = {
    filters: {},
    aaMin: { i: 0, c: 0, g: 0 },
    modes: {},
    sortKey: 'created',
    sortDir: 1,                                       // created is natDesc → newest first
    // View prefs live under their own localStorage keys (they're not filters),
    // but the preset declares them so ↺ Defaults restores the whole picture.
    groupByProvider: true,
};

// ── Theme ────────────────────────────────────────────────────────────────────
// The modal hangs off document.body, OUTSIDE #vclx-workspace, so workspace.css
// variables do NOT inherit here. The palette below re-declares the workspace
// tokens (workspace.css :5-38) with the same values so the modal matches the
// IDE chrome: near-black surfaces, #222 borders, neon-cyan accent, Space
// Grotesk UI + JetBrains Mono for ids/numbers.
const MS_CSS = `
#model-selector-overlay{
    --ms-bg:#020202; --ms-panel:#0a0a0a; --ms-surface:#0c0c0c; --ms-raised:#121212;
    --ms-active:#1a1a1a; --ms-border:#222; --ms-text:#f0f0f0; --ms-text-2:#888; --ms-text-3:#666;
    --ms-accent:#00ffcc; --ms-accent-dim:rgba(0,255,204,0.1); --ms-cyan:#00f0ff;
    --ms-warn:#ffcc00; --ms-danger:#ff0055;
    --ms-font:'Space Grotesk','Segoe UI',system-ui,sans-serif;
    --ms-mono:'JetBrains Mono',Consolas,monospace;
    position:fixed; inset:0; z-index:100000; display:none;
    justify-content:center; align-items:center;
    background:rgba(0,0,0,0.78); backdrop-filter:blur(4px);
    font-family:var(--ms-font); color:var(--ms-text);
}
#model-selector-overlay *{ box-sizing:border-box; }
#model-selector-overlay ::-webkit-scrollbar{ width:8px; height:8px; }
#model-selector-overlay ::-webkit-scrollbar-track{ background:transparent; }
#model-selector-overlay ::-webkit-scrollbar-thumb{ background:rgba(255,255,255,0.15); border-radius:4px; }
#model-selector-overlay ::-webkit-scrollbar-thumb:hover{ background:rgba(255,255,255,0.25); }

.ms-card{
    width:min(1200px,94vw); height:min(88vh,960px);
    background:var(--ms-panel); border:1px solid var(--ms-border); border-radius:10px;
    display:flex; flex-direction:column; overflow:hidden;
    box-shadow:0 24px 80px rgba(0,0,0,0.6);
}
.ms-header{ padding:14px 18px 10px; border-bottom:1px solid var(--ms-border); flex-shrink:0;
    display:flex; flex-direction:column; gap:10px; }
.ms-title-row{ display:flex; justify-content:space-between; align-items:center; }
.ms-title{ font-size:13px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; }
.ms-title .acc{ color:var(--ms-accent); }
.ms-close{ background:none; border:none; font-size:18px; color:var(--ms-text-2); cursor:pointer; padding:2px 8px; }
.ms-close:hover{ color:var(--ms-text); }
.ms-search{ width:100%; padding:9px 12px; border-radius:6px; font-size:13px;
    background:var(--ms-raised); border:1px solid var(--ms-border); color:var(--ms-text);
    outline:none; font-family:inherit; }
.ms-search:focus{ border-color:var(--ms-accent); }

/* ── API tabs ── */
/* The visible face of the 'api' facet group. Hidden entirely when only one
   catalog has models for the requested modalities, so a text-only picker looks
   exactly like it did before ImageRouter existed. */
.ms-tabs{ display:flex; gap:2px; align-items:center; }
.ms-tabs:empty{ display:none; }
.ms-tab{ background:none; border:none; border-bottom:2px solid transparent; cursor:pointer;
    padding:5px 11px 6px; font-size:11.5px; font-weight:600; color:var(--ms-text-3);
    font-family:inherit; display:flex; align-items:center; gap:6px; transition:color .12s; }
.ms-tab:hover{ color:var(--ms-text); }
.ms-tab.on{ color:var(--ms-accent); border-bottom-color:var(--ms-accent); }
.ms-tab .n{ font-size:9.5px; font-family:var(--ms-mono); opacity:.7; font-weight:400; }
.ms-tab .warn{ color:var(--ms-warn); font-size:10px; }

.ms-toolbar{ display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.ms-tool-lbl{ font-size:10px; color:var(--ms-text-3); text-transform:uppercase; letter-spacing:1px; }
.ms-select{ background:var(--ms-raised); border:1px solid var(--ms-border); color:var(--ms-text);
    border-radius:6px; padding:5px 8px; font-size:11px; font-family:inherit; cursor:pointer; outline:none; }
.ms-btn{ padding:5px 10px; border-radius:6px; font-size:11px; font-weight:600; cursor:pointer;
    border:1px solid var(--ms-border); background:var(--ms-raised); color:var(--ms-text-2);
    font-family:inherit; transition:all .15s; }
.ms-btn:hover{ color:var(--ms-text); border-color:#333; }
.ms-btn.on{ background:var(--ms-accent-dim); color:var(--ms-accent); border-color:rgba(0,255,204,0.35); }
.ms-seg{ display:flex; border:1px solid var(--ms-border); border-radius:6px; overflow:hidden; }
.ms-seg .ms-btn{ border:none; border-radius:0; }
.ms-sep{ border-left:1px solid var(--ms-border); height:18px; align-self:center; }
.ms-count{ margin-left:auto; font-size:11px; color:var(--ms-text-3); font-family:var(--ms-mono); }

.ms-main{ flex:1; display:flex; min-height:0; position:relative; }

/* ── Facet sidebar ── */
.ms-side{ width:262px; flex-shrink:0; overflow-y:auto; border-right:1px solid var(--ms-border);
    background:var(--ms-surface); padding:8px 10px 20px; }
.ms-fgroup{ margin-bottom:2px; }
.ms-fhead{ display:flex; align-items:center; gap:6px; padding:7px 4px 5px; font-size:10px;
    font-weight:700; letter-spacing:1px; text-transform:uppercase; color:var(--ms-text-2);
    cursor:pointer; user-select:none; }
.ms-fhead:hover{ color:var(--ms-text); }
.ms-fhead .arr{ color:var(--ms-text-3); font-size:11px; width:10px; }
/* Both badges are optional, so each claims the free space on its own and the
   sibling rule demotes the count when the mode badge already pushed right. */
.ms-fhead .n{ margin-left:auto; font-weight:400; color:var(--ms-accent); font-family:var(--ms-mono); }
.ms-fhead .ms-mode{ margin-left:auto; font-size:8px; font-weight:700; letter-spacing:.5px;
    padding:1px 4px; border-radius:3px; border:1px solid var(--ms-border);
    color:var(--ms-text-3); font-family:var(--ms-mono); flex-shrink:0; }
.ms-fhead .ms-mode:hover{ color:var(--ms-text); border-color:#3a3a3a; }
.ms-fhead .ms-mode.all{ color:var(--ms-accent); border-color:rgba(0,255,204,0.35); }
.ms-fhead .ms-mode ~ .n{ margin-left:6px; }
.ms-opt{ display:flex; align-items:center; gap:7px; padding:4px 6px; border-radius:5px;
    cursor:pointer; font-size:11.5px; color:#bfbfbf; }
.ms-opt:hover{ background:rgba(255,255,255,0.04); }
.ms-opt input{ accent-color:var(--ms-accent); width:13px; height:13px; margin:0; cursor:pointer; flex-shrink:0; }
.ms-opt-n{ margin-left:auto; font-size:10px; color:var(--ms-text-3); font-family:var(--ms-mono); }
.ms-opt.zero .ms-opt-lbl{ opacity:.45; }
.ms-slider{ padding:4px 6px 6px; font-size:10.5px; color:#bfbfbf; }
.ms-slider b{ color:var(--ms-accent); font-weight:600; font-family:var(--ms-mono); }
.ms-slider input{ width:100%; accent-color:var(--ms-accent); height:14px; cursor:pointer; margin:3px 0 0; }

/* ── Model list ── */
.ms-list{ flex:1; overflow-y:auto; padding:6px 14px 16px; }
.ms-provhead{ font-size:10px; font-weight:700; color:var(--ms-text-2); text-transform:uppercase;
    letter-spacing:1px; padding:9px 4px 5px; position:sticky; top:0; background:var(--ms-panel);
    z-index:2; cursor:pointer; user-select:none; display:flex; align-items:center; gap:6px; }
.ms-provhead:hover{ color:var(--ms-text); }
.ms-provhead .arr{ font-size:12px; color:var(--ms-text-3); }
.ms-provhead .n{ font-weight:400; color:var(--ms-text-3); }
.ms-row{ padding:8px 10px; border-radius:8px; cursor:pointer; margin-bottom:3px;
    border:1px solid transparent; background:rgba(255,255,255,0.02); transition:background .12s; }
.ms-row:hover{ background:rgba(255,255,255,0.05); }
.ms-row.sel{ background:rgba(0,255,204,0.06); border-color:rgba(0,255,204,0.35); }
.ms-row.compact{ padding:4px 8px; }
.ms-row-line{ display:flex; align-items:center; gap:9px; }
.ms-iconbtn{ background:none; border:none; cursor:pointer; font-size:13px; padding:0;
    flex-shrink:0; color:#3a3a3a; transition:color .12s; font-family:inherit; }
.ms-iconbtn:hover{ color:var(--ms-text-2); }
.ms-fav.on{ color:var(--ms-warn); }
.ms-def{ font-size:11px; }
.ms-def.on{ color:var(--ms-accent); }
.ms-name{ font-size:12.5px; font-weight:600; color:var(--ms-text);
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ms-row.compact .ms-name{ font-weight:500; font-size:12px; }
.ms-chip{ display:inline-block; font-size:8px; font-weight:700; letter-spacing:.6px;
    padding:1px 5px; border-radius:4px; margin-left:6px; vertical-align:1px; }
.ms-chip.sel-chip{ color:var(--ms-accent); background:var(--ms-accent-dim); }
.ms-chip.def-chip{ color:var(--ms-accent); border:1px solid rgba(0,255,204,0.35); }
.ms-chip.alias{ color:var(--ms-cyan); border:1px solid rgba(0,240,255,0.3); }
.ms-chip.warn-chip{ color:var(--ms-warn); border:1px solid rgba(255,204,0,0.3); }
/* Which catalog a row came from. Only rendered when the list actually mixes
   both — a single-API list would just repeat the same chip on every row. */
.ms-chip.api-chip{ font-family:var(--ms-mono); font-size:8px; margin-left:0; margin-right:6px;
    color:var(--ms-text-3); border:1px solid var(--ms-border); }
.ms-chip.api-imagerouter{ color:var(--ms-accent); border-color:rgba(0,255,204,0.3); }
.ms-chip.api-openrouter{ color:var(--ms-cyan); border-color:rgba(0,240,255,0.22); }
.ms-sub{ display:flex; align-items:center; gap:8px; margin-top:2px; min-width:0; }
.ms-id{ font-size:9.5px; color:var(--ms-text-3); font-family:var(--ms-mono);
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:0 1 auto; min-width:0; }
.ms-badges{ display:flex; gap:3px; flex-shrink:0; font-size:10.5px; align-items:center; }
.ms-badge{ opacity:.85; cursor:default; }
.ms-badge.mono{ font-family:var(--ms-mono); font-size:9px; color:var(--ms-accent);
    border:1px solid rgba(0,255,204,0.3); border-radius:3px; padding:0 3px; opacity:1; }
.ms-efforts{ font-family:var(--ms-mono); font-size:8.5px; color:var(--ms-text-2);
    border:1px solid var(--ms-border); border-radius:3px; padding:0 4px; flex-shrink:0; }
.ms-aa{ display:flex; align-items:center; gap:4px; flex-shrink:0; }
.ms-aabar{ width:40px; height:4px; border-radius:2px; background:rgba(255,255,255,0.08); overflow:hidden; }
.ms-aabar i{ display:block; height:100%; background:var(--ms-accent); }
.ms-aan{ font-size:9px; color:var(--ms-text-2); font-family:var(--ms-mono); flex-shrink:0; }
.ms-price{ text-align:right; flex-shrink:0; font-size:10px; color:#aaa; line-height:1.45;
    font-family:var(--ms-mono); min-width:86px; }
.ms-price .fr{ color:var(--ms-accent); font-weight:700; background:var(--ms-accent-dim);
    padding:2px 7px; border-radius:5px; font-family:var(--ms-font); font-size:10px; }
.ms-price .var{ color:var(--ms-text-3); font-style:italic; font-family:var(--ms-font); }
.ms-price .cache{ color:var(--ms-text-3); }
.ms-price1{ font-size:10px; color:#aaa; font-family:var(--ms-mono); flex-shrink:0; }
.ms-ctx{ font-size:10.5px; color:var(--ms-text-2); min-width:42px; text-align:right;
    flex-shrink:0; font-family:var(--ms-mono); }
.ms-info-btn{ background:none; border:1px solid var(--ms-border); border-radius:5px;
    color:var(--ms-text-2); cursor:pointer; padding:2px 6px; font-size:11px; flex-shrink:0;
    font-family:inherit; }
.ms-info-btn:hover{ color:var(--ms-accent); border-color:rgba(0,255,204,0.4); }

/* ── Grid density ── */
.ms-grid{ display:flex; flex-wrap:wrap; gap:6px; }
.ms-gcard{ width:calc(33.33% - 4px); min-width:190px; padding:8px 10px; border-radius:8px;
    cursor:pointer; border:1px solid rgba(255,255,255,0.06); background:rgba(255,255,255,0.02);
    display:flex; flex-direction:column; gap:4px; }
.ms-gcard:hover{ background:rgba(255,255,255,0.05); }
.ms-gcard.sel{ border-color:rgba(0,255,204,0.35); background:rgba(0,255,204,0.06); }
.ms-gmeta{ display:flex; justify-content:space-between; align-items:center; gap:4px;
    font-size:9px; color:var(--ms-text-3); }
.ms-gmeta .ms-ctx{ min-width:0; }

/* ── Info panel ── */
.ms-infopanel{ margin-top:9px; padding:11px; background:rgba(0,0,0,0.35); border-radius:6px;
    border:1px solid var(--ms-border); cursor:default; }
.ms-infopanel .desc{ font-size:11.5px; color:#aaa; line-height:1.5; margin-bottom:9px; }
.ms-igrid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr));
    gap:5px 14px; font-size:10.5px; }
.ms-igrid .k{ color:var(--ms-text-3); }
.ms-igrid .v{ color:#bfbfbf; font-family:var(--ms-mono); font-size:10px; }
.ms-isec{ margin-top:9px; font-size:10px; color:var(--ms-text-3); line-height:1.6; }
.ms-isec b{ color:var(--ms-text-2); font-weight:600; }
.ms-warnbox{ margin-top:9px; padding:7px 10px; border-radius:5px;
    background:rgba(255,204,0,0.07); border-left:2px solid var(--ms-warn);
    color:var(--ms-warn); font-size:10.5px; }
.ms-empty{ text-align:center; padding:48px 20px; color:var(--ms-text-3); font-size:13px; }

/* ── Responsive filters: collapsible sidebar ─────────────────────────────────
   The facet sidebar is a fixed 262px column that, on a phone, swallows most of
   the card and squeezes the model rows to a sliver. The "⚙ Filters" toolbar
   button toggles the .ms-filters-open class on the card:
     • Desktop (≥721px) — the sidebar is an inline column that collapses away so
       the list reclaims the width; open by default.
     • Mobile  (≤720px) — the card goes full-screen and the sidebar becomes an
       off-canvas drawer sliding over the list with a tap-to-dismiss backdrop;
       closed by default so the model list always owns the full width. */
.ms-backdrop{ display:none; }
.ms-filters-toggle .n{ margin-left:5px; color:var(--ms-accent); font-family:var(--ms-mono); }

@media (min-width:721px){
    .ms-card:not(.ms-filters-open) .ms-side{ display:none; }
}

@media (max-width:720px){
    .ms-card{ width:100vw; height:100dvh; max-width:100vw;
        border-radius:0; border:none;
        /* Clear the notch / status bar in the installed PWA. */
        padding-top:env(safe-area-inset-top, 0px); }
    .ms-side{
        position:absolute; top:0; bottom:0; left:0;
        width:84%; max-width:300px; z-index:12;
        transform:translateX(-100%);
        transition:transform .24s cubic-bezier(.4,0,.2,1);
        box-shadow:12px 0 44px rgba(0,0,0,.7);
    }
    .ms-card.ms-filters-open .ms-side{ transform:translateX(0); }
    .ms-backdrop{
        display:block; position:absolute; inset:0; z-index:11;
        background:rgba(0,0,0,.55); opacity:0; pointer-events:none;
        transition:opacity .24s;
    }
    .ms-card.ms-filters-open .ms-backdrop{ opacity:1; pointer-events:auto; }
    /* Now that the list owns the full width, tighten the chrome padding. */
    .ms-header{ padding:12px 12px 8px; }
    .ms-list{ padding:6px 10px 16px; }
    .ms-gcard{ width:calc(50% - 3px); min-width:0; }
}
`;

class ModelSelectorModal {
    static _instance = null;
    static _overlay = null;

    static open({ inputModalities = ['text'], outputModalities = ['text'], currentModel = '',
                  apis = null, onSelect }) {
        if (!ModelSelectorModal._instance) {
            ModelSelectorModal._instance = new ModelSelectorModal();
        }
        ModelSelectorModal._instance._open(inputModalities, outputModalities, currentModel, onSelect, apis);
    }

    static getDefault() {
        return localStorage.getItem('ms_default_model') || '';
    }

    static close() {
        if (ModelSelectorModal._overlay) {
            ModelSelectorModal._overlay.style.display = 'none';
        }
    }

    // Normalized facts for a raw catalog model — handy for wiring the agent
    // request later (see WIRING NOTES). Returns null before first open().
    static factsFor(model) {
        return ModelSelectorModal._instance ? ModelSelectorModal._instance._facts(model) : null;
    }

    // Display label for a picked model, for the "Model: ___" chips callers
    // keep. Callers used to inline `.replace(/^[^:]+:\s*/, '')`, which eats the
    // ':free' suffix off an ImageRouter id — go through here instead.
    static labelFor(modelOrId, fallbackId) {
        if (typeof modelOrId === 'string') return modelOrId.replace(/^[^:]+:\s+/, '');
        if (!modelOrId) return fallbackId || '';
        const inst = ModelSelectorModal._instance;
        if (inst) return inst._shortName(inst._facts(modelOrId));
        return (modelOrId.name || modelOrId.id || fallbackId || '').replace(/^[^:]+:\s+/, '');
    }

    // Which API a model id/uid belongs to, for callers that only kept the id —
    // typically on page load, restoring a saved pick. Deliberately does NOT go
    // through the instance: the modal may never have been opened yet, and
    // answering 'openrouter' by default would route an ImageRouter/NVIDIA model
    // to the wrong provider. Reads the catalogs directly instead.
    static apiOf(modelId) {
        if (!modelId) return 'openrouter';
        // A namespaced uid answers on its own — no catalog lookup needed.
        for (const [prefix, api] of MS_UID_PREFIXES) {
            if (modelId.startsWith(prefix)) return api;
        }
        // A bare id: find which source lists it. MS_API_KEYS order puts
        // OpenRouter first, so an id that somehow exists in more than one
        // resolves the same way _byUid() resolves it — and because every id
        // saved before the extra sources existed is an OpenRouter one.
        for (const api of MS_API_KEYS) {
            const cat = _msCatalog(api);
            if (cat && cat.data.some(m => m.id === modelId)) return api;
        }
        return 'openrouter';
    }

    // Strip any source's uid namespace back off, for sending to a provider.
    static nativeId(modelId) {
        let id = modelId || '';
        for (const [prefix] of MS_UID_PREFIXES) {
            if (id.startsWith(prefix)) { id = id.slice(prefix.length); break; }
        }
        return id;
    }

    constructor() {
        const safeJSON = (key, fallback) => {
            try { return JSON.parse(localStorage.getItem(key) || fallback); }
            catch (e) { return JSON.parse(fallback); }
        };
        // View state
        this._expandedInfo = null;
        this._density = localStorage.getItem('ms_density') || 'comfortable';
        if (!['comfortable', 'compact', 'grid'].includes(this._density)) this._density = 'comfortable';
        this._groupByProvider = localStorage.getItem('ms_group_by_provider') !== '0';
        this._search = '';
        this._dynGroups = [];              // tokenizer / output-size facets, built per catalog
        this._apis = null;                 // open({apis}) restriction; null = both

        // Filters + sort: persisted as one blob so a saved config restores
        // atomically. Absent key = first run → seed from MS_DEFAULT_PREFS.
        // Key is versioned: price/context option ids kept their names but
        // changed meaning when those groups became exclusive tiers (p5 was
        // "≤ $5", now "$1–$5"), so a v1 blob would be silently misread.
        // Bumping re-seeds the preset instead — and ↺ Defaults can bring it
        // back at any time.
        const raw = localStorage.getItem(MS_PREFS_KEY);
        this._applyPrefs(raw ? safeJSON(MS_PREFS_KEY, '{}') : MS_DEFAULT_PREFS);
        // Persisted user data (existing keys — do not rename)
        this._collapsedProviders = safeJSON('ms_collapsed', '{}');
        this._favorites = safeJSON('ms_favorites', '[]');
        this._facetCollapsed = safeJSON('ms_facet_collapsed', '{}');
        // Facts cache — WeakMap so a provider switch (new model objects) never
        // serves stale facts and old entries get GC'd.
        this._factsCache = new WeakMap();
        this._createDOM();
        this._updateToolbar();
    }

    // ── localStorage helpers ─────────────────────────────────────────────
    _saveCollapsed() {
        localStorage.setItem('ms_collapsed', JSON.stringify(this._collapsedProviders));
    }
    _saveFavorites() {
        localStorage.setItem('ms_favorites', JSON.stringify(this._favorites));
    }
    _saveFacetCollapsed() {
        localStorage.setItem('ms_facet_collapsed', JSON.stringify(this._facetCollapsed));
    }
    _saveGroupByProvider() {
        localStorage.setItem('ms_group_by_provider', this._groupByProvider ? '1' : '0');
    }
    // Load a prefs blob into live state. Shared by the constructor and the
    // Defaults button, and defensive about anything it reads: unknown groups,
    // empty arrays and bogus sort keys are dropped rather than trusted, so a
    // hand-edited or outdated localStorage entry can't wedge the picker.
    // Always copies (never aliases MS_DEFAULT_PREFS, which must stay pristine).
    _applyPrefs(p) {
        p = p || {};
        this._filters = {};                // groupKey -> Set(optionId)
        for (const k in (p.filters || {})) {
            if (Array.isArray(p.filters[k]) && p.filters[k].length) {
                this._filters[k] = new Set(p.filters[k]);
            }
        }
        this._aaMin = Object.assign({ i: 0, c: 0, g: 0 }, p.aaMin || {});
        this._modes = Object.assign({}, p.modes || {});   // groupKey -> 'all' | 'any' override
        this._sortKey = MS_SORTS.some(s => s.key === p.sortKey) ? p.sortKey : 'name';
        this._sortDir = p.sortDir === -1 ? -1 : 1;        // 1 = sort's natural direction
    }

    // Called after every filter/sort/mode change — writing the key at all is
    // what marks "this user has a config", so the first-run preset never
    // comes back once they've touched anything.
    _savePrefs() {
        const filters = {};
        for (const k in this._filters) {
            if (this._filters[k].size) filters[k] = [...this._filters[k]];
        }
        localStorage.setItem(MS_PREFS_KEY, JSON.stringify({
            filters,
            aaMin: this._aaMin,
            modes: this._modes,
            sortKey: this._sortKey,
            sortDir: this._sortDir,
        }));
    }
    _saveDensity() {
        localStorage.setItem('ms_density', this._density);
    }
    // uid, not id — see the IDENTITY note at the top. OpenRouter uids ARE the
    // bare id, so favorites saved before ImageRouter existed still match.
    _isFavorite(uid) {
        return this._favorites.includes(uid);
    }
    _toggleFavorite(uid) {
        const idx = this._favorites.indexOf(uid);
        if (idx >= 0) {
            this._favorites.splice(idx, 1);
        } else {
            this._favorites.push(uid);
        }
        this._saveFavorites();
    }
    _isDefault(uid) {
        return localStorage.getItem('ms_default_model') === uid;
    }
    _setDefault(uid) {
        const current = localStorage.getItem('ms_default_model');
        if (current === uid) {
            localStorage.removeItem('ms_default_model');
        } else {
            localStorage.setItem('ms_default_model', uid);
        }
    }
    _toggleProvider(prov) {
        this._collapsedProviders[prov] = !this._collapsedProviders[prov];
        this._saveCollapsed();
    }
    _isProviderCollapsed(prov) {
        return !!this._collapsedProviders[prov];
    }
    _isFacetCollapsed(group) {
        return Object.prototype.hasOwnProperty.call(this._facetCollapsed, group.key)
            ? this._facetCollapsed[group.key]
            : !group.open;
    }
    // On every open(): any group holding an active selection shows expanded,
    // everything else collapses. Keeps a restored config self-evident instead
    // of hiding it behind a count badge. Manual toggles still work afterwards
    // — they just don't survive the next open.
    _syncFacetCollapse() {
        for (const g of this._facetGroups()) {
            if (g.hidden) continue;
            let active = (this._filters[g.key] || new Set()).size > 0;
            if (g.sliders) for (const [k] of MS_AA_SLIDERS) if (this._aaMin[k] > 0) active = true;
            this._facetCollapsed[g.key] = !active;
        }
        this._saveFacetCollapsed();
    }
    // Resolution order: hard lock → user override → group default → 'any'.
    _modeOf(group) {
        return group.lockMode || this._modes[group.key] || group.mode || 'any';
    }

    // ── Filters sidebar visibility ────────────────────────────────────────
    // Below this width the sidebar is a drawer and starts closed; above it,
    // an inline column that starts open. Kept in one place so the JS default
    // and the CSS breakpoint (@media 720px) never drift apart.
    _isMobile() {
        return window.matchMedia('(max-width: 720px)').matches;
    }
    _setFiltersOpen(open) {
        this._filtersOpen = open;
        if (this._el.card) this._el.card.classList.toggle('ms-filters-open', open);
        if (this._el.filtersToggle) this._el.filtersToggle.classList.toggle('on', open);
    }

    // ── Providers ────────────────────────────────────────────────────────
    _getProvider(modelId) {
        const slash = modelId.indexOf('/');
        return slash > 0 ? modelId.substring(0, slash) : 'other';
    }

    _getProviderLabel(provider) {
        const labels = {
            'openai': 'OpenAI', 'anthropic': 'Anthropic', 'google': 'Google',
            'meta-llama': 'Meta (Llama)', 'meta': 'Meta', 'mistralai': 'Mistral AI', 'qwen': 'Qwen',
            'deepseek': 'DeepSeek', 'cohere': 'Cohere', 'microsoft': 'Microsoft',
            'x-ai': 'xAI', 'nvidia': 'NVIDIA', 'perplexity': 'Perplexity',
            'amazon': 'Amazon', 'moonshotai': 'MoonshotAI', 'minimax': 'MiniMax',
            'openrouter': 'OpenRouter', 'stepfun': 'StepFun', 'z-ai': 'Z.ai',
            'aion-labs': 'AionLabs', 'arcee-ai': 'Arcee AI',
            // Image houses — mostly ImageRouter-only
            'black-forest-labs': 'Black Forest Labs', 'stabilityai': 'Stability AI',
            'ideogram-ai': 'Ideogram', 'bytedance': 'ByteDance', 'recraft': 'Recraft',
            'bria': 'Bria', 'luma': 'Luma', 'krea': 'Krea', 'sourceful': 'Sourceful',
            'run-diffusion': 'RunDiffusion', 'prunaai': 'Pruna AI', 'imagineart': 'ImagineArt',
            'wavespeed': 'WaveSpeed', 'leonardoai': 'Leonardo AI', 'midjourney': 'Midjourney',
            'reve': 'Reve', 'birefnet': 'BiRefNet', 'tencent': 'Tencent', 'zai': 'Z.ai',
            'imagerouter': 'ImageRouter', 'fal': 'fal.ai',
        };
        // '~' prefix = auto-updating "latest" aliases; group them next to their
        // base provider but clearly labeled.
        const isAlias = provider.startsWith('~');
        const raw = isAlias ? provider.slice(1) : provider;
        // ImageRouter ships mixed-case vendor names ('xAI', 'HiDream-ai',
        // 'Tongyi-MAI'). Capitalising those would corrupt them, so anything
        // that already carries an uppercase letter is left exactly as written;
        // the all-lowercase OpenRouter ids keep the old treatment.
        const label = labels[raw] || labels[raw.toLowerCase()]
            || (/[A-Z]/.test(raw) ? raw : raw.charAt(0).toUpperCase() + raw.slice(1));
        return isAlias ? label + ' · Latest' : label;
    }

    // ── Facts: normalize one raw catalog model ───────────────────────────
    // The ONLY place that reads either raw catalog shape. Everything downstream
    // (filters, sorts, badges, info panel) consumes this flat object, so a
    // stripped catalog (NVIDIA) or one with no concept of tokens at all
    // (ImageRouter) degrades to nulls/false HERE — nowhere else.
    _facts(m) {
        let f = this._factsCache.get(m);
        if (f) return f;
        // The source is tagged on the raw object by _allModels() (m._api). The
        // parser is chosen by that source's `shape`, so a new OpenRouter-shaped
        // source (NVIDIA) reuses the OpenRouter parser without touching it.
        const api = (m._api && MS_APIS[m._api]) ? m._api : 'openrouter';
        f = MS_APIS[api].shape === 'imagerouter'
            ? this._factsImageRouter(m, api)
            : this._factsOpenRouter(m, api);
        this._factsCache.set(m, f);
        return f;
    }

    // Every key any consumer may read, with a neutral value. Both branches
    // start from this, so no downstream code ever has to ask which API a model
    // came from before touching a field.
    _blankFacts() {
        return {
            api: 'openrouter', uid: '', id: '', name: '', nameLower: '', searchBlob: '',
            provider: 'other', isAlias: false,
            tokenPriced: false, imagePriced: false,
            priceIn: null, priceOut: null, priceVariable: false, isFree: false,
            priceImage: null, priceImageMin: null, priceImageMax: null,
            ctx: 0, maxOut: null, created: 0, releaseYear: 0, releaseDate: null,
            cutoff: null, expires: null,
            inMods: [], outMods: [], sizes: [], aliases: [],
            tokenizer: null, moderated: false,
            params: new Set(),
            hasTools: false, hasStructured: false, hasResponseFormat: false,
            hasSeed: false, hasLogprobs: false, hasWebSearch: false,
            hasReasoning: false, reasoningMandatory: false, efforts: [], hasEffortCtl: false,
            cacheRead: null, cacheWrite: null, hasCacheRead: false, hasCacheWrite: false,
            acceptsImage: false, acceptsMask: false, acceptsQuality: false,
            aa: null, arenaBest: null,
        };
    }

    _factsOpenRouter(m, api = 'openrouter') {
        const arch = m.architecture || {};
        const pricing = m.pricing || {};
        const num = (v) => {
            if (v === undefined || v === null || v === '') return null;
            const n = parseFloat(v);
            return Number.isFinite(n) ? n : null;
        };
        const pIn = num(pricing.prompt);
        const pOut = num(pricing.completion);
        // OpenRouter routers (openrouter/auto & co.) report "-1": price depends
        // on the routed model. Treat as "Variable", never as a real number.
        const variable = (pIn !== null && pIn < 0) || (pOut !== null && pOut < 0);
        const params = new Set(m.supported_parameters || []);
        const r = m.reasoning || null;
        const aa = (m.benchmarks && m.benchmarks.artificial_analysis) || null;
        let arenaBest = null;
        for (const e of ((m.benchmarks && m.benchmarks.design_arena) || [])) {
            if (!arenaBest || (e.elo || 0) > arenaBest.elo) arenaBest = e;
        }
        const cacheRead = num(pricing.input_cache_read);
        const cacheWrite = num(pricing.input_cache_write);
        const name = m.name || m.id;
        const created = m.created || 0;
        return Object.assign(this._blankFacts(), {
            api,
            uid: MS_APIS[api].uidPrefix + m.id,          // bare id for OpenRouter, 'nv:'-prefixed for NVIDIA
            id: m.id,
            name,
            nameLower: name.toLowerCase(),
            searchBlob: (name + ' ' + m.id + ' ' + (m.description || '')).toLowerCase(),
            provider: this._getProvider(m.id),
            isAlias: m.id.startsWith('~'),
            tokenPriced: true,
            // Prices normalized to $/M tokens; null = unknown/variable.
            priceIn: (variable || pIn === null) ? null : pIn * 1e6,
            priceOut: (variable || pOut === null) ? null : pOut * 1e6,
            priceVariable: variable,
            isFree: !variable && pIn === 0 && pOut === 0,
            ctx: m.context_length || 0,
            maxOut: (m.top_provider && m.top_provider.max_completion_tokens) || null,
            created,
            releaseYear: created ? new Date(created * 1000).getUTCFullYear() : 0,
            releaseDate: created ? new Date(created * 1000).toISOString().slice(0, 10) : null,
            cutoff: m.knowledge_cutoff || null,          // 'YYYY-MM-DD' | null
            expires: m.expiration_date || null,          // deprecation date | null
            inMods: arch.input_modalities || [],
            outMods: arch.output_modalities || [],
            acceptsImage: (arch.input_modalities || []).includes('image'),
            tokenizer: arch.tokenizer || null,
            moderated: !!(m.top_provider && m.top_provider.is_moderated),
            params,
            hasTools: params.has('tools'),
            hasStructured: params.has('structured_outputs'),
            hasResponseFormat: params.has('response_format'),
            hasSeed: params.has('seed'),
            hasLogprobs: params.has('logprobs'),
            hasWebSearch: params.has('web_search_options'),
            hasReasoning: !!r,
            reasoningMandatory: r ? !!r.mandatory : false,
            efforts: (r && r.supported_efforts) || [],
            hasEffortCtl: params.has('reasoning_effort'),
            cacheRead: cacheRead === null ? null : cacheRead * 1e6,
            cacheWrite: cacheWrite === null ? null : cacheWrite * 1e6,
            hasCacheRead: cacheRead !== null,
            hasCacheWrite: cacheWrite !== null,
            aa,
            arenaBest,
        });
    }

    // ImageRouter: image output only, no tokens, no context window, no
    // benchmarks. What it does carry that OpenRouter doesn't is a price SPREAD
    // (min/average/max — quality tiers and sizes cost different amounts), the
    // output sizes, and whether the model can edit an existing image.
    _factsImageRouter(m, api = 'imagerouter') {
        const inputs = m.inputs || {};
        const price = m.price || {};
        const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
        const avg = numOrNull(price.average);
        const min = numOrNull(price.min);
        const max = numOrNull(price.max);
        // Free only when it costs nothing at the TOP of the spread — a model
        // whose cheapest setting happens to be $0 is not a free model.
        const isFree = avg === 0 && (max === 0 || max === null);
        // No `name` field in this catalog. The id tail reads better than the
        // full id in a list already grouped and chipped by provider.
        const name = String(m.id).split('/').pop();
        const inMods = [];
        if (inputs.text !== false) inMods.push('text');
        if (inputs.image) inMods.push('image');
        const aliases = m.aliases || [];
        const rel = m.release_date || null;
        return Object.assign(this._blankFacts(), {
            api,
            uid: MS_APIS[api].uidPrefix + m.id,
            id: m.id,
            name,
            nameLower: name.toLowerCase(),
            // Aliases are searchable: people look for "gemini-2.5-flash-image"
            // and the catalog calls that model "google/nano-banana".
            searchBlob: (name + ' ' + m.id + ' ' + aliases.join(' ')).toLowerCase(),
            provider: m.provider || this._getProvider(m.id),
            imagePriced: true,
            priceImage: avg,
            priceImageMin: min,
            priceImageMax: max,
            isFree,
            created: rel ? Math.floor(Date.parse(rel + 'T00:00:00Z') / 1000) || 0 : 0,
            releaseYear: rel ? parseInt(rel.slice(0, 4), 10) || 0 : 0,
            releaseDate: rel,
            inMods,
            outMods: m.output || ['image'],
            sizes: Array.isArray(inputs.size) ? inputs.size : [],
            aliases,
            acceptsImage: !!inputs.image,
            acceptsMask: !!inputs.mask,
            acceptsQuality: !!inputs.quality,
        });
    }

    // ── Formatting helpers ───────────────────────────────────────────────
    _esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    _fmtPerM(perM) {
        if (perM === null) return '—';
        if (perM === 0) return 'Free';
        if (perM < 0.01) return `$${perM.toFixed(4)}/M`;
        if (perM < 1) return `$${perM.toFixed(3)}/M`;
        return `$${perM.toFixed(2)}/M`;
    }

    _fmtShort(perM) {
        if (perM === null) return '—';
        if (perM === 0) return '$0';
        const s = perM.toFixed(perM < 1 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '');
        return '$' + s;
    }

    _fmtCtx(len) {
        if (!len) return '—';
        if (len >= 1_000_000) return `${(len / 1_000_000).toFixed(1)}M`;
        return `${(len / 1000).toFixed(0)}K`;
    }

    _effortsAbbr(efforts) {
        return [...efforts]
            .sort((a, b) => MS_EFFORT_ORDER.indexOf(a) - MS_EFFORT_ORDER.indexOf(b))
            .map(e => MS_EFFORT_ABBR[e] || e)
            .join('·');
    }

    // ── Catalog / filtering / sorting ────────────────────────────────────
    // Everything the picker could possibly show, every registered source
    // merged. A catalog that failed to load is simply absent — the others
    // still render, which is the whole point of loading them independently.
    // Each raw model is tagged with its source (`_api`) here, so the loader is
    // not required to; _facts() reads that tag to pick a parser and namespace.
    _allModels() {
        const out = [];
        const allowed = this._apis;      // null = no restriction from open()
        for (const api of MS_API_KEYS) {
            if (allowed && !allowed.includes(api)) continue;
            const cat = _msCatalog(api);
            if (!cat) continue;
            for (const m of cat.data) {
                if (m && !m._api) m._api = api;      // idempotent; respects a pre-tagged loader
                out.push(m);
            }
        }
        return out;
    }

    // Hard pre-filter from open() args: the caller's REQUIRED modalities.
    // Reads facts rather than the raw JSON, so it works across both shapes —
    // and it is what makes an api restriction usually unnecessary: asking for
    // text OUTPUT already excludes every ImageRouter model, because none of
    // them produce text.
    _filterModels(inputMods, outputMods) {
        return this._allModels().filter(m => {
            const f = this._facts(m);
            return inputMods.every(mod => f.inMods.includes(mod))
                && outputMods.every(mod => f.outMods.includes(mod));
        });
    }

    _facetGroups() {
        return [...MS_FACETS, ...this._dynGroups];
    }

    // Dynamic facets: options come from the live catalog rather than a fixed
    // list. Rebuilt on every render (cheap — facts are cached); selected values
    // that vanish when the catalog changes are pruned, so a stale selection can
    // never silently blank the list.
    _buildDynGroups(catalog) {
        const byFreq = (counts) => Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
        const tally = (pick) => {
            const counts = {};
            for (const m of catalog) {
                for (const v of pick(this._facts(m))) counts[v] = (counts[v] || 0) + 1;
            }
            return counts;
        };

        const groups = [];

        const tokens = byFreq(tally(f => f.tokenizer ? [f.tokenizer] : []));
        if (tokens.length) {
            groups.push({
                key: 'tok', title: 'Tokenizer', open: false,
                lockMode: 'any',   // a model has exactly one tokenizer; ALL = always 0
                options: tokens.map(t => ({ id: 't_' + t, label: t, test: f => f.tokenizer === t })),
            });
        }

        // Output sizes (ImageRouter only). 'custom' and 'auto' are real values
        // the API reports, not placeholders, so they list like any other.
        const sizes = byFreq(tally(f => f.sizes));
        if (sizes.length) {
            groups.push({
                key: 'size', title: 'Output size', open: false,
                options: sizes.map(s => ({ id: 's_' + s, label: s, test: f => f.sizes.includes(s) })),
            });
        }

        this._dynGroups = groups;

        // Prune selections that no longer exist in the rebuilt options
        for (const g of groups) {
            const sel = this._filters[g.key];
            if (!sel) continue;
            const valid = new Set(g.options.map(o => o.id));
            for (const id of [...sel]) if (!valid.has(id)) sel.delete(id);
        }
        for (const key of ['tok', 'size']) {
            if (!groups.some(g => g.key === key)) delete this._filters[key];
        }
    }

    // Which APIs actually have models in the current modality scope. Drives
    // both the tab strip and whether it is worth showing at all.
    _apiCounts(catalog) {
        const counts = {};
        for (const m of catalog) {
            const a = this._facts(m).api;
            counts[a] = (counts[a] || 0) + 1;
        }
        return counts;
    }

    // The API tabs are a normal facet filter under the hood ('' = All), so they
    // persist, clear and restore with everything else.
    _activeApi() {
        const sel = this._filters.api;
        return (sel && sel.size === 1) ? [...sel][0] : '';
    }

    _setApi(api) {
        if (api) this._filters.api = new Set([api]);
        else delete this._filters.api;
        this._savePrefs();
    }

    _passesGroup(f, group, extraOpt) {
        const sel = this._filters[group.key];
        const all = this._modeOf(group) === 'all';
        let any = false, checked = 0;
        for (const o of group.options) {
            if (!(sel && sel.has(o.id)) && o !== extraOpt) continue;
            checked++;
            const hit = o.test(f, this);
            if (all) { if (!hit) return false; }                 // AND: every one must hit
            else if (hit) any = true;                            // OR: one is enough
        }
        if (checked === 0) return true;                          // nothing selected = no constraint
        return all ? true : any;
    }

    _passesSliders(f) {
        for (const [k, , field] of MS_AA_SLIDERS) {
            const min = this._aaMin[k];
            if (min > 0 && !(f.aa && f.aa[field] >= min)) return false;
        }
        return true;
    }

    // skipKey: exclude that group's own constraints — used to compute the
    // per-option counts a click WOULD yield (standard faceted-count behavior).
    _applyFilters(models, skipKey) {
        return models.filter(m => {
            const f = this._facts(m);
            if (this._search && !f.searchBlob.includes(this._search)) return false;
            for (const g of this._facetGroups()) {
                if (g.key === skipKey) continue;
                if (!this._passesGroup(f, g)) return false;      // AND between groups
            }
            if (skipKey !== 'bench' && !this._passesSliders(f)) return false;
            return true;
        });
    }

    _activeFilterCount() {
        let n = 0;
        for (const k in this._filters) n += this._filters[k].size;
        for (const [k] of MS_AA_SLIDERS) if (this._aaMin[k] > 0) n++;
        return n;
    }

    _clearFilters() {
        this._filters = {};
        this._aaMin = { i: 0, c: 0, g: 0 };
    }

    _sort(models) {
        const s = MS_SORTS.find(x => x.key === this._sortKey) || MS_SORTS[0];
        const mul = (s.natAsc ? 1 : -1) * this._sortDir;
        return [...models].sort((a, b) => {
            const va = s.val(this._facts(a));
            const vb = s.val(this._facts(b));
            const na = va === null || va === undefined;
            const nb = vb === null || vb === undefined;
            if (na && nb) return 0;
            if (na) return 1;                                    // nulls always last
            if (nb) return -1;
            const c = s.str ? String(va).localeCompare(String(vb)) : (va - vb);
            return mul * c;
        });
    }

    // ── DOM ──────────────────────────────────────────────────────────────
    _createDOM() {
        if (!document.getElementById('ms-styles')) {
            const st = document.createElement('style');
            st.id = 'ms-styles';
            st.textContent = MS_CSS;
            document.head.appendChild(st);
        }

        const overlay = document.createElement('div');
        overlay.id = 'model-selector-overlay';
        overlay.addEventListener('click', (e) => { if (e.target === overlay) ModelSelectorModal.close(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.style.display === 'flex') ModelSelectorModal.close();
        });

        const card = document.createElement('div');
        card.className = 'ms-card';
        const sortOptions = MS_SORTS.map(s =>
            `<option value="${s.key}"${s.key === this._sortKey ? ' selected' : ''}>${s.label}</option>`
        ).join('');
        card.innerHTML = `
            <div class="ms-header">
                <div class="ms-title-row">
                    <div class="ms-title">🤖 Select <span class="acc">AI Model</span></div>
                    <button class="ms-close" id="ms-close">✕</button>
                </div>
                <input type="text" id="ms-search" class="ms-search" placeholder="Search models… (name, id, description)" />
                <div class="ms-tabs" id="ms-tabs"></div>
                <div class="ms-toolbar">
                    <button id="ms-filters-toggle" class="ms-btn ms-filters-toggle" title="Show / hide filters">⚙ Filters</button>
                    <span class="ms-sep"></span>
                    <span class="ms-tool-lbl">Sort</span>
                    <select id="ms-sort" class="ms-select">${sortOptions}</select>
                    <button id="ms-dir" class="ms-btn" title="Reverse sort order">↑</button>
                    <span class="ms-sep"></span>
                    <div class="ms-seg" id="ms-density">
                        <button class="ms-btn" data-d="comfortable" title="Comfortable rows">☰</button>
                        <button class="ms-btn" data-d="compact" title="Compact rows">≡</button>
                        <button class="ms-btn" data-d="grid" title="Grid cards">▦</button>
                    </div>
                    <button id="ms-group" class="ms-btn" title="Group results by provider">🗂 Group by provider</button>
                    <button id="ms-clear" class="ms-btn" title="Clear all facet filters" style="display:none;">✕ Clear</button>
                    <button id="ms-defaults" class="ms-btn" title="Clear every filter and restore the default view: newest first, grouped by provider">↺ Defaults</button>
                    <span id="ms-count" class="ms-count"></span>
                </div>
            </div>
            <div class="ms-main">
                <div class="ms-side" id="ms-side"></div>
                <div class="ms-backdrop" id="ms-backdrop"></div>
                <div class="ms-list" id="ms-list"></div>
            </div>
        `;
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        ModelSelectorModal._overlay = overlay;

        this._el = {
            card,
            search: card.querySelector('#ms-search'),
            sort: card.querySelector('#ms-sort'),
            dir: card.querySelector('#ms-dir'),
            densityBtns: [...card.querySelectorAll('#ms-density [data-d]')],
            group: card.querySelector('#ms-group'),
            clear: card.querySelector('#ms-clear'),
            defaults: card.querySelector('#ms-defaults'),
            filtersToggle: card.querySelector('#ms-filters-toggle'),
            backdrop: card.querySelector('#ms-backdrop'),
            count: card.querySelector('#ms-count'),
            tabs: card.querySelector('#ms-tabs'),
            side: card.querySelector('#ms-side'),
            list: card.querySelector('#ms-list'),
        };

        // ── API tabs ──
        this._el.tabs.addEventListener('click', (e) => {
            const tab = e.target.closest('[data-api]');
            if (!tab) return;
            this._setApi(tab.dataset.api);
            this._syncFacetCollapse();       // a switch changes which groups matter
            this._render();
            this._el.list.scrollTop = 0;
        });

        // ── Header events ──
        card.querySelector('#ms-close').onclick = () => ModelSelectorModal.close();
        this._el.filtersToggle.onclick = () => this._setFiltersOpen(!this._filtersOpen);
        this._el.backdrop.onclick = () => this._setFiltersOpen(false);
        this._el.search.oninput = () => this._render();
        this._el.sort.onchange = () => {
            this._sortKey = this._el.sort.value;
            this._sortDir = 1;                       // new sort starts in its natural direction
            this._savePrefs();
            this._updateToolbar();
            this._render();
        };
        this._el.dir.onclick = () => {
            this._sortDir *= -1;
            this._savePrefs();
            this._updateToolbar();
            this._render();
        };
        this._el.densityBtns.forEach(btn => {
            btn.onclick = () => {
                this._density = btn.dataset.d;
                this._saveDensity();
                this._updateToolbar();
                this._render();
            };
        });
        this._el.group.onclick = () => {
            this._groupByProvider = !this._groupByProvider;
            this._saveGroupByProvider();
            this._updateToolbar();
            this._render();
        };
        this._el.clear.onclick = () => {
            this._clearFilters();
            this._savePrefs();               // persists as "no filters" — the
            this._updateToolbar();           // first-run preset does not return
            this._render();
        };
        // Escape hatch for the above: the preset is otherwise unreachable once
        // anything has been saved. Restores filters, sliders, group modes, sort
        // AND grouping, then re-opens the groups it filled in.
        this._el.defaults.onclick = () => {
            this._applyPrefs(MS_DEFAULT_PREFS);
            this._groupByProvider = MS_DEFAULT_PREFS.groupByProvider !== false;
            this._saveGroupByProvider();
            this._savePrefs();
            this._syncFacetCollapse();
            this._updateToolbar();
            this._render();
            this._el.side.scrollTop = 0;
        };

        // ── Sidebar events (delegated — the sidebar re-renders wholesale) ──
        this._el.side.addEventListener('click', (e) => {
            // Mode badge sits inside the header — check it first so toggling
            // ALL/ANY doesn't also collapse the group.
            const modeEl = e.target.closest('[data-fgmode]');
            if (modeEl) {
                const key = modeEl.dataset.fgmode;
                const group = this._facetGroups().find(g => g.key === key);
                if (group) {
                    this._modes[key] = this._modeOf(group) === 'all' ? 'any' : 'all';
                    this._savePrefs();
                    this._render();
                }
                return;
            }
            const head = e.target.closest('.ms-fhead');
            if (head) {
                const key = head.dataset.fg;
                const group = this._facetGroups().find(g => g.key === key);
                if (group) {
                    this._facetCollapsed[key] = !this._isFacetCollapsed(group);
                    this._saveFacetCollapsed();
                    this._render();
                }
            }
        });
        this._el.side.addEventListener('change', (e) => {
            const t = e.target;
            if (t.dataset.aa) {                       // AA min slider committed
                this._aaMin[t.dataset.aa] = parseInt(t.value, 10) || 0;
                this._savePrefs();
                this._render();
            } else if (t.dataset.fg && t.dataset.op) { // facet checkbox
                const set = this._filters[t.dataset.fg] || (this._filters[t.dataset.fg] = new Set());
                if (t.checked) set.add(t.dataset.op); else set.delete(t.dataset.op);
                this._savePrefs();
                this._render();
            }
        });
        this._el.side.addEventListener('input', (e) => {
            const t = e.target;
            if (t.dataset.aa) {                       // live label while dragging
                const b = t.closest('.ms-slider').querySelector('b');
                const v = parseInt(t.value, 10) || 0;
                b.textContent = v > 0 ? v : 'off';
            }
        });

        // ── List events (delegated) ──
        this._el.list.addEventListener('click', (e) => {
            const fav = e.target.closest('.ms-fav');
            if (fav) { this._toggleFavorite(fav.dataset.mid); this._render(); return; }
            const def = e.target.closest('.ms-def');
            if (def) { this._setDefault(def.dataset.mid); this._render(); return; }
            const info = e.target.closest('.ms-info-btn');
            if (info) {
                this._expandedInfo = this._expandedInfo === info.dataset.mid ? null : info.dataset.mid;
                this._render();
                return;
            }
            const prov = e.target.closest('.ms-provhead');
            if (prov) { this._toggleProvider(prov.dataset.prov); this._render(); return; }
            if (e.target.closest('.ms-infopanel')) return;   // text selection inside info ≠ pick
            const row = e.target.closest('[data-mid]');
            if (row) {
                const model = this._byUid(row.dataset.mid);
                if (!model) return;
                const f = this._facts(model);
                // The NATIVE id goes out first, never the uid — that is what a
                // caller sends to the provider. The api rides along twice (3rd
                // argument, and model._api) so callers that support both can
                // route the request without re-deriving it.
                // WIRING NOTES: modelObj carries everything — reasoning,
                // pricing, benchmarks. ModelSelectorModal.factsFor(model)
                // returns the normalized version for the agent request.
                if (this._onSelect) this._onSelect(f.id, model, f.api);
                ModelSelectorModal.close();
            }
        });
    }

    // Find a model by uid across every source. Also accepts a bare id, so a
    // `currentModel` saved before the extra sources existed still resolves.
    _byUid(uid) {
        if (!uid) return null;
        for (const m of this._allModels()) {
            const f = this._facts(m);
            if (f.uid === uid || f.id === uid) return m;
        }
        return null;
    }

    _updateToolbar() {
        const s = MS_SORTS.find(x => x.key === this._sortKey) || MS_SORTS[0];
        const effectiveAsc = s.natAsc ? this._sortDir === 1 : this._sortDir === -1;
        // Sort can change without the <select> being the trigger (restored
        // prefs, ↺ Defaults) — keep the control in sync with the state.
        this._el.sort.value = this._sortKey;
        this._el.dir.textContent = effectiveAsc ? '↑' : '↓';
        this._el.densityBtns.forEach(b => b.classList.toggle('on', b.dataset.d === this._density));
        this._el.group.classList.toggle('on', this._groupByProvider);
        const n = this._activeFilterCount();
        this._el.clear.style.display = n > 0 ? '' : 'none';
        this._el.clear.textContent = `✕ Clear (${n})`;
        // Surface the active-filter count on the toggle so it's visible even
        // while the sidebar is hidden (the whole point on mobile).
        this._el.filtersToggle.innerHTML = `⚙ Filters${n > 0 ? ` <span class="n">${n}</span>` : ''}`;
    }

    _open(inputMods, outputMods, currentModel, onSelect, apis) {
        this._inputMods = inputMods;
        this._outputMods = outputMods;
        this._apis = (Array.isArray(apis) && apis.length)
            ? apis.filter(a => MS_APIS[a]) : null;
        this._onSelect = onSelect;
        this._expandedInfo = null;

        const catalog = this._filterModels(inputMods, outputMods);
        // currentModel arrives as a native id from most callers, so resolve it
        // to a uid — that is what rows are keyed by.
        const cur = this._byUid(currentModel);
        this._currentModel = cur ? this._facts(cur).uid : currentModel;

        // An api tab saved from a previous open can point at a catalog this
        // context has nothing in (a text picker restoring "ImageRouter"), which
        // would open to an empty list with no obvious cause. Drop it.
        const counts = this._apiCounts(catalog);
        const api = this._activeApi();
        if (api && !counts[api]) this._setApi('');

        const overlay = ModelSelectorModal._overlay;
        overlay.style.display = 'flex';
        // Sidebar starts open on desktop, closed (as a drawer) on mobile so the
        // model list isn't squeezed the moment the picker opens on a phone.
        this._setFiltersOpen(!this._isMobile());
        this._el.search.value = '';
        // Dynamic facets are catalog-dependent, so build them before deciding
        // which groups open — otherwise a saved tokenizer filter stays hidden.
        this._buildDynGroups(catalog);
        this._syncFacetCollapse();
        this._el.search.focus();
        this._render();
        this._el.list.scrollTop = 0;
        this._el.side.scrollTop = 0;
    }

    // ── Render ───────────────────────────────────────────────────────────
    _render() {
        // Full innerHTML rebuild (same strategy as before) — preserve scroll
        // positions so a checkbox click doesn't yank either pane to the top.
        const sideScroll = this._el.side.scrollTop;
        const listScroll = this._el.list.scrollTop;

        const catalog = this._filterModels(this._inputMods || ['text'], this._outputMods || ['text']);
        this._buildDynGroups(catalog);
        this._search = this._el.search.value.toLowerCase().trim();

        let models = this._applyFilters(catalog, null);
        models = this._sort(models);

        // Whether rows carry an API chip: only worth it when the list actually
        // mixes catalogs. Computed once per render, read by every row.
        this._mixed = new Set(models.map(m => this._facts(m).api)).size > 1;

        this._el.count.textContent = `${models.length} / ${catalog.length} models`;
        this._updateToolbar();
        this._renderTabs(catalog);
        this._renderSidebar(catalog);
        this._renderList(models);

        this._el.side.scrollTop = sideScroll;
        this._el.list.scrollTop = listScroll;
    }

    // API tabs. Rendered only when more than one catalog can answer the
    // caller's modality request — asking for text output leaves ImageRouter
    // with nothing to contribute, and a one-tab strip is just noise.
    _renderTabs(catalog) {
        // Which tabs exist comes from the whole catalog; the numbers on them
        // come from the catalog with every OTHER filter applied — the same rule
        // the sidebar counts follow. Splitting the two matters: a filter that
        // empties a tab must not delete the tab, or there'd be no way back.
        const present = MS_API_KEYS.filter(a => this._apiCounts(catalog)[a]);
        if (present.length < 2) { this._el.tabs.innerHTML = ''; return; }
        const base = this._applyFilters(catalog, 'api');
        const counts = this._apiCounts(base);

        const active = this._activeApi();
        // Optional per-source status: { <api>: { configured: bool } }. The
        // neutral name is MS_API_STATUS; IMAGE_APIS is the old name from when
        // ImageRouter was the only extra source, still honored for old hosts.
        const status = (typeof MS_API_STATUS !== 'undefined' && MS_API_STATUS)
            || (typeof IMAGE_APIS !== 'undefined' && IMAGE_APIS) || null;
        const tab = (api, label, n) => {
            // Only warn on a key we KNOW is missing: status stays null when the
            // status call failed, and guessing there would cry wolf.
            const unset = api && status && status[api] && status[api].configured === false;
            const warn = unset
                ? ` <span class="warn" title="No ${this._esc(MS_APIS[api].label)} API key is configured on this server — you can browse these models, but generating with one will fail.">⚠</span>`
                : '';
            return `<button class="ms-tab${active === api ? ' on' : ''}" data-api="${api}">
                ${this._esc(label)}<span class="n">${n}</span>${warn}</button>`;
        };
        this._el.tabs.innerHTML = tab('', 'All', base.length)
            + present.map(a => tab(a, MS_APIS[a].label, counts[a] || 0)).join('');
    }

    _renderSidebar(catalog) {
        let html = '';
        for (const g of this._facetGroups()) {
            if (g.hidden) continue;                  // rendered elsewhere (API tabs)
            const collapsed = this._isFacetCollapsed(g);
            let active = (this._filters[g.key] || new Set()).size;
            if (g.sliders) for (const [k] of MS_AA_SLIDERS) if (this._aaMin[k] > 0) active++;
            const mode = this._modeOf(g);

            // Counts always assume every OTHER group's filters still apply.
            // Within the group the reading depends on the mode:
            //   ANY → "results if only this option were checked" (stable,
            //          and with exclusive tiers the column sums to total)
            //   ALL → "results if this requirement is added on top of the
            //          ones already checked" (the only useful reading when
            //          each click narrows)
            const base = this._applyFilters(catalog, g.key);
            const sel = this._filters[g.key];
            const counts = g.options.map(o => {
                const others = mode === 'all'
                    ? g.options.filter(o2 => o2.id !== o.id && sel && sel.has(o2.id))
                    : [];
                return base.filter(m => {
                    const f = this._facts(m);
                    for (const o2 of others) if (!o2.test(f, this)) return false;
                    return o.test(f, this);
                }).length;
            });

            // A group where nothing can match is a group that doesn't apply
            // here: reasoning, context and caching mean nothing to ImageRouter,
            // per-image price means nothing to OpenRouter. Hiding beats showing
            // a column of zeroes. Never hide one holding a selection, or the
            // user couldn't undo it.
            if (!active && counts.every(n => n === 0)) continue;

            const modeBadge = g.lockMode ? '' : `<span class="ms-mode${mode === 'all' ? ' all' : ''}"
                data-fgmode="${g.key}"
                title="${mode === 'all'
                    ? 'Match ALL checked options (a model must satisfy every one). Click for ANY.'
                    : 'Match ANY checked option (a model needs just one). Click for ALL.'}"
                >${mode === 'all' ? 'ALL' : 'ANY'}</span>`;
            html += `<div class="ms-fgroup">
                <div class="ms-fhead" data-fg="${g.key}">
                    <span class="arr">${collapsed ? '▸' : '▾'}</span>${g.title}
                    ${modeBadge}
                    ${active ? `<span class="n">${active}</span>` : ''}
                </div>`;
            if (!collapsed) {
                g.options.forEach((o, i) => {
                    const n = counts[i];
                    const checked = sel && sel.has(o.id);
                    html += `<label class="ms-opt${n === 0 ? ' zero' : ''}">
                        <input type="checkbox" data-fg="${g.key}" data-op="${o.id}"${checked ? ' checked' : ''}>
                        <span class="ms-opt-lbl">${this._esc(o.label)}</span>
                        <span class="ms-opt-n">${n}</span>
                    </label>`;
                });
                if (g.sliders) {
                    for (const [k, label] of MS_AA_SLIDERS) {
                        const v = this._aaMin[k];
                        html += `<div class="ms-slider">
                            <div>${label} ≥ <b>${v > 0 ? v : 'off'}</b></div>
                            <input type="range" min="0" max="80" step="1" value="${v}" data-aa="${k}">
                        </div>`;
                    }
                }
            }
            html += `</div>`;
        }
        this._el.side.innerHTML = html;
    }

    _renderList(models) {
        const list = this._el.list;
        if (!models.length) {
            const api = this._activeApi();
            const hint = api
                ? `You're on the ${this._esc(MS_APIS[api].label)} tab — try “All”, or clear some filters (✕ Clear, top right).`
                : 'Try clearing some filters (✕ Clear, top right).';
            list.innerHTML = `<div class="ms-empty">No models found matching your criteria.<br>
                <span style="font-size:11px;">${hint}</span></div>`;
            return;
        }
        const renderItems = (items) => {
            if (this._density === 'grid') {
                return `<div class="ms-grid">${items.map(m => this._renderGridCard(m)).join('')}</div>`;
            }
            const fn = this._density === 'compact' ? this._renderCompactRow : this._renderRow;
            return items.map(m => fn.call(this, m)).join('');
        };

        let html = '';
        if (!this._groupByProvider) {
            // Ungrouped: pure sort order — this is what makes global sorts readable.
            html = renderItems(models);
        } else {
            const groups = {};
            for (const m of models) {
                // facts.provider, not the id prefix: ImageRouter states the
                // vendor explicitly, and its casing ('xAI', 'HiDream-ai') is
                // the one worth showing.
                const prov = this._facts(m).provider;
                if (!groups[prov]) groups[prov] = [];
                groups[prov].push(m);
            }
            const sortedProviders = Object.keys(groups).sort((a, b) =>
                this._getProviderLabel(a).localeCompare(this._getProviderLabel(b))
            );
            for (const prov of sortedProviders) {
                const provModels = groups[prov];
                const isCollapsed = this._isProviderCollapsed(prov);
                html += `<div style="margin-bottom:10px;">
                    <div class="ms-provhead" data-prov="${this._esc(prov)}">
                        <span class="arr">${isCollapsed ? '▸' : '▾'}</span>
                        ${this._esc(this._getProviderLabel(prov))}
                        <span class="n">(${provModels.length})</span>
                    </div>
                    ${isCollapsed ? '' : renderItems(provModels)}
                </div>`;
            }
        }
        list.innerHTML = html;
    }

    // Capability badges — icon + tooltip. Derived exclusively from facts, so
    // catalogs without supported_parameters simply render no badges.
    _renderBadges(f) {
        const b = [];
        if (f.acceptsMask) b.push(['🩹', 'Accepts a mask — inpainting / partial edits']);
        if (f.acceptsQuality) b.push(['🎚️', 'Quality setting supported']);
        if (f.hasReasoning) b.push(['🧠', 'Reasoning — ' + (f.reasoningMandatory ? 'always on' : 'optional')]);
        if (f.hasTools) b.push(['🔧', 'Tool calling' + (f.params.has('parallel_tool_calls') ? ' (parallel)' : '')]);
        if (f.hasStructured) b.push([null, 'Structured outputs']);
        if (f.hasCacheRead || f.hasCacheWrite) {
            let t = 'Prompt caching';
            if (f.cacheRead !== null) t += ` — read ${this._fmtPerM(f.cacheRead)}`;
            if (f.cacheWrite !== null) t += ` · write ${this._fmtPerM(f.cacheWrite)}`;
            b.push(['💾', t]);
        }
        if (f.inMods.includes('image')) b.push(['🖼️', 'Image input']);
        if (f.inMods.includes('file')) b.push(['📎', 'File input']);
        if (f.inMods.includes('video')) b.push(['🎬', 'Video input']);
        if (f.inMods.includes('audio')) b.push(['🎤', 'Audio input']);
        if (f.outMods.includes('image')) b.push(['🎨', 'Image output']);
        if (f.outMods.includes('audio')) b.push(['🔊', 'Audio output']);
        if (f.hasWebSearch) b.push(['🌐', 'Web search']);
        if (!b.length) return '';
        return `<span class="ms-badges">${b.map(([ic, t]) => ic
            ? `<span class="ms-badge" title="${this._esc(t)}">${ic}</span>`
            : `<span class="ms-badge mono" title="${this._esc(t)}">{}</span>`
        ).join('')}</span>`;
    }

    _renderChips(f, sel, def) {
        return [
            f.isAlias ? `<span class="ms-chip alias" title="Auto-updating alias — always points at the newest version">LATEST</span>` : '',
            sel ? `<span class="ms-chip sel-chip">● SELECTED</span>` : '',
            def ? `<span class="ms-chip def-chip">DEFAULT</span>` : '',
            f.expires ? `<span class="ms-chip warn-chip" title="Scheduled for deprecation on ${this._esc(f.expires)}">EXP ${this._esc(f.expires)}</span>` : '',
        ].join('');
    }

    _renderAA(f) {
        // Some catalog entries carry a partial AA object (intelligence_index:
        // null, only coding scored) — no bar for those, same as no AA at all.
        if (!f.aa || !Number.isFinite(f.aa.intelligence_index)) return '';
        const pct = Math.min(100, (f.aa.intelligence_index / 70) * 100);
        const aaVal = (v) => Number.isFinite(v) ? v : '—';
        const title = `Artificial Analysis — intelligence ${aaVal(f.aa.intelligence_index)} · coding ${aaVal(f.aa.coding_index)} · agentic ${aaVal(f.aa.agentic_index)}`;
        return `<span class="ms-aa" title="${this._esc(title)}">
            <span class="ms-aabar"><i style="width:${pct}%"></i></span>
            <span class="ms-aan">${f.aa.intelligence_index}</span>
        </span>`;
    }

    // Per-image price, formatted at the precision the number needs — the
    // catalog spans $0.0006 to $0.25 and rounding the cheap end to two decimals
    // would print "$0.00" for the models people are here for.
    _fmtPerImage(usd) {
        if (usd === null) return '—';
        if (usd === 0) return 'Free';
        if (usd < 0.01) return `$${usd.toFixed(4)}`;
        return `$${usd.toFixed(3).replace(/0$/, '')}`;
    }

    _renderPrice(f) {
        if (f.imagePriced) {
            if (f.isFree) return `<div class="ms-price"><span class="fr">FREE</span></div>`;
            if (f.priceImage === null) {
                return `<div class="ms-price" title="This catalog did not price this model">—</div>`;
            }
            // The spread is real information: quality tiers and output sizes
            // move the price, sometimes by 10x, and the average alone hides it.
            const spread = (f.priceImageMin !== null && f.priceImageMax !== null
                            && f.priceImageMin !== f.priceImageMax)
                ? `<div class="cache" title="Cheapest to most expensive setting">${this._fmtPerImage(f.priceImageMin)}–${this._fmtPerImage(f.priceImageMax)}</div>`
                : '';
            return `<div class="ms-price" title="Average price per generated image">
                <div>${this._fmtPerImage(f.priceImage)}/img</div>
                ${spread}
            </div>`;
        }
        if (f.priceVariable) {
            return `<div class="ms-price" title="Router model — price depends on the routed model"><span class="var">Variable</span></div>`;
        }
        if (f.isFree) {
            return `<div class="ms-price"><span class="fr">FREE</span></div>`;
        }
        if (f.priceIn === null && f.priceOut === null) {
            return `<div class="ms-price" title="Pricing not exposed by this catalog">—</div>`;
        }
        const cache = f.cacheRead !== null
            ? `<div class="cache" title="Cache read price">⚡ ${this._fmtPerM(f.cacheRead)}</div>` : '';
        return `<div class="ms-price">
            <div>in&nbsp;&nbsp;${this._fmtPerM(f.priceIn)}</div>
            <div>out ${this._fmtPerM(f.priceOut)}</div>
            ${cache}
        </div>`;
    }

    _priceOneLine(f) {
        if (f.imagePriced) {
            if (f.isFree) return 'FREE';
            return f.priceImage === null ? '—' : `${this._fmtPerImage(f.priceImage)}/img`;
        }
        if (f.priceVariable) return 'Variable';
        if (f.isFree) return 'FREE';
        if (f.priceIn === null && f.priceOut === null) return '—';
        return `${this._fmtShort(f.priceIn)} / ${this._fmtShort(f.priceOut)}`;
    }

    // The right-hand column: context window for token catalogs, output size for
    // image ones. Same slot, because they answer the same question — "how big
    // is what I get?" — and an image model has no context to report.
    _renderScale(f) {
        if (f.ctx) {
            return `<div class="ms-ctx" title="Context window">${this._fmtCtx(f.ctx)}</div>`;
        }
        if (f.sizes.length) {
            const first = f.sizes[0];
            // 1024x1024 → 1024², which fits the column; anything else as-is.
            const sq = /^(\d+)x\1$/.exec(first);
            const label = sq ? sq[1] + '²' : first;
            const title = f.sizes.length > 1
                ? `Output sizes: ${f.sizes.join(', ')}`
                : `Output size: ${first}`;
            return `<div class="ms-ctx" title="${this._esc(title)}">${this._esc(label)}</div>`;
        }
        return `<div class="ms-ctx">—</div>`;
    }

    // The catalog-agnostic display name. OpenRouter names are "Vendor: Model";
    // the vendor is already the group header, so it goes. The space after the
    // colon is REQUIRED in the match — ImageRouter names carry a ':free' suffix
    // and a laxer pattern would render 'nano-banana:free' as just 'free'.
    _shortName(f) {
        return f.name.replace(/^[^:]+:\s+/, '');
    }

    _apiChip(f) {
        if (!this._mixed) return '';
        const a = MS_APIS[f.api];
        return `<span class="ms-chip api-chip api-${f.api}" title="${this._esc(a.label)}">${a.abbr}</span>`;
    }

    // Comfortable row: two lines + badges, effort chip, AA bar, price block.
    _renderRow(m) {
        const f = this._facts(m);
        const uid = this._esc(f.uid);
        const sel = f.uid === this._currentModel;
        const exp = this._expandedInfo === f.uid;
        const fav = this._isFavorite(f.uid);
        const def = this._isDefault(f.uid);
        const name = this._esc(this._shortName(f));
        // WIRING NOTES (1): the efforts chip is display-only; an effort PICKER
        // for the request would live here (or in ai.html after selection).
        const efforts = f.efforts.length
            ? `<span class="ms-efforts" title="Reasoning efforts: ${this._esc(f.efforts.join(', '))}">${this._effortsAbbr(f.efforts)}</span>`
            : '';
        return `
        <div class="ms-row${sel ? ' sel' : ''}" data-mid="${uid}">
            <div class="ms-row-line">
                <button class="ms-iconbtn ms-fav${fav ? ' on' : ''}" data-mid="${uid}"
                    title="${fav ? 'Remove from favorites' : 'Add to favorites'}">${fav ? '★' : '☆'}</button>
                <button class="ms-iconbtn ms-def${def ? ' on' : ''}" data-mid="${uid}"
                    title="${def ? 'Remove as default' : 'Set as default model'}">${def ? '◉' : '◎'}</button>
                <div style="flex:1;min-width:0;">
                    <div class="ms-name">${name}${this._renderChips(f, sel, def)}</div>
                    <div class="ms-sub">
                        ${this._apiChip(f)}
                        <span class="ms-id">${this._esc(f.id)}</span>
                        ${this._renderBadges(f)}
                        ${efforts}
                        ${this._renderAA(f)}
                    </div>
                </div>
                ${this._renderPrice(f)}
                ${this._renderScale(f)}
                <button class="ms-info-btn" data-mid="${uid}" title="Model info">ℹ</button>
            </div>
            ${exp ? this._renderInfoPanel(m, f) : ''}
        </div>`;
    }

    // Compact row: one line, badges but no effort chip / AA bar.
    _renderCompactRow(m) {
        const f = this._facts(m);
        const uid = this._esc(f.uid);
        const sel = f.uid === this._currentModel;
        const exp = this._expandedInfo === f.uid;
        const fav = this._isFavorite(f.uid);
        const def = this._isDefault(f.uid);
        const name = this._esc(this._shortName(f));
        const miniChips = [
            f.isAlias ? `<span class="ms-chip alias">L</span>` : '',
            sel ? `<span class="ms-chip sel-chip">●</span>` : '',
            def ? `<span class="ms-chip def-chip">D</span>` : '',
        ].join('');
        return `
        <div class="ms-row compact${sel ? ' sel' : ''}" data-mid="${uid}">
            <div class="ms-row-line">
                <button class="ms-iconbtn ms-fav${fav ? ' on' : ''}" data-mid="${uid}">${fav ? '★' : '☆'}</button>
                <button class="ms-iconbtn ms-def${def ? ' on' : ''}" data-mid="${uid}">${def ? '◉' : '◎'}</button>
                ${this._apiChip(f)}
                <div class="ms-name" style="flex:1;min-width:0;" title="${this._esc(f.id)}">${name}${miniChips}</div>
                ${this._renderBadges(f)}
                ${f.aa && Number.isFinite(f.aa.intelligence_index) ? `<span class="ms-aan" title="AA intelligence">${f.aa.intelligence_index}</span>` : ''}
                <span class="ms-price1" title="${f.imagePriced ? 'Average price per image' : 'in / out per M tokens'}">${this._priceOneLine(f)}</span>
                ${this._renderScale(f)}
                <button class="ms-info-btn" data-mid="${uid}" title="Model info">ℹ</button>
            </div>
            ${exp ? this._renderInfoPanel(m, f) : ''}
        </div>`;
    }

    // Grid card: favorites + select only (no default/info buttons — same
    // trade-off the old flat view made).
    _renderGridCard(m) {
        const f = this._facts(m);
        const uid = this._esc(f.uid);
        const sel = f.uid === this._currentModel;
        const fav = this._isFavorite(f.uid);
        const name = this._esc(this._shortName(f));
        return `
        <div class="ms-gcard${sel ? ' sel' : ''}" data-mid="${uid}">
            <div style="display:flex;align-items:center;gap:6px;">
                <button class="ms-iconbtn ms-fav${fav ? ' on' : ''}" data-mid="${uid}" style="font-size:12px;">${fav ? '★' : '☆'}</button>
                ${this._apiChip(f)}
                <div class="ms-name" style="flex:1;min-width:0;font-size:12px;" title="${this._esc(f.id)}">${name}</div>
                ${sel ? '<span style="color:var(--ms-accent);font-size:9px;">●</span>' : ''}
            </div>
            <div class="ms-gmeta">
                <span>${this._esc(this._getProviderLabel(f.provider))}</span>
                ${this._renderScale(f)}
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:4px;">
                ${this._renderBadges(f) || '<span></span>'}
                <span class="ms-price1">${this._priceOneLine(f)}</span>
            </div>
        </div>`;
    }

    _renderInfoPanel(m, f) {
        if (MS_APIS[f.api] && MS_APIS[f.api].shape === 'imagerouter') return this._renderInfoPanelIR(m, f);
        return this._renderInfoPanelOR(m, f);
    }

    // ImageRouter publishes no descriptions and no benchmarks — what it does
    // have is the price spread, the exact output sizes, and the alias list,
    // which is the only place you learn that 'google/nano-banana' is the model
    // everyone else calls gemini-2.5-flash-image.
    _renderInfoPanelIR(m, f) {
        const kv = (k, v) => v ? `<div><span class="k">${k}:</span> <span class="v">${v}</span></div>` : '';
        const spread = (f.priceImageMin !== null && f.priceImageMax !== null
                        && f.priceImageMin !== f.priceImageMax)
            ? `${this._fmtPerImage(f.priceImageMin)} – ${this._fmtPerImage(f.priceImageMax)} (avg ${this._fmtPerImage(f.priceImage)})`
            : this._fmtPerImage(f.priceImage);
        const accepts = [
            f.acceptsImage ? 'reference image' : '',
            f.acceptsMask ? 'mask' : '',
            f.acceptsQuality ? 'quality setting' : '',
        ].filter(Boolean).join(' · ') || 'prompt only';

        return `
        <div class="ms-infopanel">
            <div class="desc">Image generation via <b style="color:var(--ms-accent);">ImageRouter</b>, billed per image.
                ${f.isFree ? 'This model is <b style="color:var(--ms-accent);">free</b> — generations with it cost no credits.' : ''}</div>
            <div class="ms-igrid">
                ${kv('Provider', this._esc(this._getProviderLabel(f.provider)))}
                ${kv('Price / image', spread)}
                ${kv('Released', this._esc(f.releaseDate || ''))}
                ${kv('Accepts', this._esc(accepts))}
                ${kv('Output sizes', this._esc(f.sizes.join(', ')))}
            </div>
            ${f.aliases.length ? `<div class="ms-isec"><b>Also known as:</b> ${this._esc(f.aliases.join(', '))}</div>` : ''}
            ${!f.acceptsImage ? `<div class="ms-warnbox">⚠ Text-to-image only — this model ignores reference images, so it can't edit a sprite or match an existing style.</div>` : ''}
        </div>`;
    }

    _renderInfoPanelOR(m, f) {
        const desc = this._esc((m.description || 'No description available.').substring(0, 600))
            + ((m.description || '').length > 600 ? '…' : '');
        const kv = (k, v) => v ? `<div><span class="k">${k}:</span> <span class="v">${v}</span></div>` : '';
        const r = m.reasoning || null;
        const createdDate = f.releaseDate;

        let reasoningStr = null;
        if (r) {
            reasoningStr = r.mandatory ? 'always on' : 'optional';
            if (r.default_effort) reasoningStr += ` · default ${this._esc(r.default_effort)}`;
            if (r.supported_efforts && r.supported_efforts.length) {
                reasoningStr += ` · efforts: ${this._esc(r.supported_efforts.join(', '))}`;
            }
        }

        let benchSec = '';
        if (f.aa) {
            const aaVal = (v) => Number.isFinite(v) ? v : '—';
            benchSec += `<div class="ms-isec"><b>Artificial Analysis:</b>
                intelligence ${aaVal(f.aa.intelligence_index)} · coding ${aaVal(f.aa.coding_index)} · agentic ${aaVal(f.aa.agentic_index)}</div>`;
        }
        const arena = (m.benchmarks && m.benchmarks.design_arena) || [];
        if (arena.length) {
            const top = [...arena].sort((a, b) => (b.elo || 0) - (a.elo || 0)).slice(0, 5)
                .map(e => `${this._esc(e.category)} <span style="color:#bfbfbf;">${e.elo} elo · ${e.win_rate}% · #${e.rank}</span>`)
                .join(' &nbsp;|&nbsp; ');
            benchSec += `<div class="ms-isec"><b>Design Arena (top ${Math.min(5, arena.length)} of ${arena.length}):</b> ${top}</div>`;
        }

        const params = (m.supported_parameters || []).join(', ');
        const cacheStr = (f.cacheRead !== null || f.cacheWrite !== null)
            ? [f.cacheRead !== null ? `read ${this._fmtPerM(f.cacheRead)}` : '',
               f.cacheWrite !== null ? `write ${this._fmtPerM(f.cacheWrite)}` : ''].filter(Boolean).join(' · ')
            : null;

        return `
        <div class="ms-infopanel">
            <div class="desc">${desc}</div>
            <div class="ms-igrid">
                ${kv('Modalities', this._esc(f.inMods.join('+') || '—') + ' → ' + this._esc(f.outMods.join('+') || '—'))}
                ${kv('Context', f.ctx ? f.ctx.toLocaleString() : null)}
                ${kv('Max output', f.maxOut ? f.maxOut.toLocaleString() : null)}
                ${kv('Tokenizer', this._esc(f.tokenizer || ''))}
                ${kv('Knowledge cutoff', this._esc(f.cutoff || ''))}
                ${kv('Released', createdDate)}
                ${kv('Reasoning', reasoningStr)}
                ${kv('Prompt caching', cacheStr)}
                ${kv('Moderated', f.moderated ? 'yes' : null)}
            </div>
            ${params ? `<div class="ms-isec"><b>Supports:</b> ${this._esc(params)}</div>` : ''}
            ${benchSec}
            ${f.expires ? `<div class="ms-warnbox">⚠ Scheduled for deprecation: ${this._esc(f.expires)}</div>` : ''}
        </div>`;
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * WIRING NOTES — cómo conectar esto al agente (hoy NO implementado)
 *
 * El picker sólo FILTRA y DEVUELVE un id. Todos estos campos ya están
 * parseados en _facts() y disponibles vía:
 *   - el 2º argumento de onSelect(id, modelObj)  → el objeto crudo del catálogo
 *   - el 3º argumento onSelect(id, modelObj, api) → la fuente: cualquier clave de
 *     MS_APIS ('openrouter' | 'nvidia' | 'imagerouter' | …). Ese `api` es lo que
 *     el host usa para saber a qué proveedor mandar el request.
 *   - ModelSelectorModal.factsFor(modelObj)      → la versión normalizada
 *   - ModelSelectorModal.apiOf(idOrUid) / .nativeId(uid) → helpers para el host
 *     cuando sólo guardó el id (restaurar una selección al cargar la página).
 *
 * 0. RUTEAR POR FUENTE (ejemplo del host original — adaptá los endpoints)
 *    Los endpoints del host (p.ej. /api/assets/generate-*) reciben un campo de
 *    proveedor. Mandá el 3er argumento de onSelect tal cual: sin él, un modelo
 *    de otra fuente (ImageRouter, NVIDIA) se pide a OpenRouter y falla. NVIDIA
 *    reusa los mismos ids que OpenRouter, así que el `api` NO es opcional ahí.
 *    Los facts relevantes: facts.imagePriced, facts.acceptsImage (¿sirve para
 *    image-to-image?), facts.sizes.
 *
 * 1. REASONING EFFORT
 *    facts.efforts / facts.reasoningMandatory salen de m.reasoning.
 *    Para usarlo: agregar un selector de effort junto al chip del modelo en
 *    ai.html y mandar { reasoning: { effort: "high" | "medium" | ... } } en el
 *    body del request a OpenRouter. Los modelos con reasoning.mandatory=true
 *    SIEMPRE razonan: el selector debe ocultar la opción "none".
 *    → tocar: ai.html (sendPrompt) y agent_engine (payload al provider).
 *
 * 2. PROMPT CACHING
 *    facts.cacheRead / cacheWrite salen de pricing.input_cache_read/write.
 *    Anthropic requiere cache_control explícito en los bloques del prompt;
 *    OpenAI/DeepSeek cachean solos. → agent_engine, armado de mensajes.
 *
 * 3. TOOLS / STRUCTURED OUTPUTS
 *    facts.hasTools / hasStructured. Si el modelo elegido NO soporta tools,
 *    el agente no puede usar herramientas: conviene avisar en ai.html antes
 *    de correr, o degradar a modo chat.
 *
 * 4. MAX OUTPUT
 *    facts.maxOut (top_provider.max_completion_tokens) → clamp de max_tokens
 *    en el request.
 *
 * 5. EXPIRATION
 *    facts.expires: algunos modelos traen expiration_date. El picker ya
 *    muestra el chip EXP + warning en el panel ℹ; faltaría bloquear/migrar la
 *    selección guardada cuando la fecha ya pasó.
 * ═══════════════════════════════════════════════════════════════════════════ */
