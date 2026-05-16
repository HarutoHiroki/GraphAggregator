// graphAggregator.js
//
// Full replacement for graphtool/assets/js/squigsites.js (and the modified
// bandaid version that followed it). Drop one <script> tag into a squig-style
// site and you get:
//
//   - "More squigsites" dropdown in the header, built from the aggregator.
//   - Federated search across every registered site plus every squigsites.json
//     entry, rendered via a virtualized list so the DOM stays small no matter
//     how many phones match.
//   - Delta target mods (5128 logo, automatic baseline switching).
//   - Cachebust cookie.
//
// What this fixes
// ---------------
// The old dbExplorer built a DOM node for every brand/phone tuple in every
// squig site at search-focus time and toggled display: flex via CSS selectors
// on matches. With thousands of items it lagged the whole site til refresh,
// because the graph viewer had to fight that pile of DOM for layout
// every frame.
//
// The previous bandaid (squigsites_modified.js) detached the dbExplorer
// subtree while the search was empty. That fixed the empty-search case but
// did nothing for "search has text". This client fixes both:
//
//   - Empty search: results region is empty. Zero DOM cost.
//   - Filled search: only items in (or near) the viewport are in the DOM.
//     Total active DOM never exceeds ~80 items, regardless of match count.
//
// All matches are still reachable by scrolling.
//
// Drop-in
// -------
//   <script src="https://graphaggregator.harutohiroki.com/graphAggregator.js" defer></script>
//
// Optional override set BEFORE the script tag:
//   window.GRAPHAGGREGATOR_BASE - override the aggregator origin

(function () {
  'use strict';

  // ============================================================ Config

  const CACHE_BUSTER = 'hurrr';

  const AGGREGATOR_BASE = (typeof window.GRAPHAGGREGATOR_BASE === 'string')
    ? window.GRAPHAGGREGATOR_BASE
    : 'https://graphaggregator.harutohiroki.com';
  const AGGREGATOR_URL = AGGREGATOR_BASE + '/aggregate-index.json';
  const INDEX_CACHE_KEY = 'graphaggregator:index:v2';
  const INDEX_CACHE_TTL_MS = 60 * 60 * 1000;     // 1 hour

  // Virtualized render tuning.
  const DEBOUNCE_MS       = 120;
  const HEADER_HEIGHT_PX  = 58;
  const ITEM_HEIGHT_PX    = 46;
  const SCROLL_BUFFER_PX  = 400;

  // ============================================================ State

  let aggregate = null;        // raw aggregate-index.json
  let searchRows = null;       // flat array of pre-built search rows
  let aggregateLoading = null; // in-flight promise

  let filterInput = null;
  let phonesPanel = null;
  let resultsRoot = null;      // <section.ga-results> (mounts into #phones)
  let scroller = null;         // inner positioned div with computed total height
  let emptyMsg = null;

  let layout = null;           // [{type:'header'|'item', top, height, data}, ...]
  let totalHeight = 0;
  let debounceTimer = null;
  let scrollRaf = null;

  // ============================================================ Entry

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  }
  ready(boot);

  function boot() {
    initCacheBust();

    loadJquery(function () {
      ensureAggregateLoaded().then(function () {
        createSquigSelect();
        initSearch();
      });
    });

    initDeltaTargetModsOnLoad();
  }

  // ============================================================ Helpers

  function loadJquery(onLoad) {
    if (typeof window.jQuery === 'function') { onLoad(); return; }
    const local = 'https://graphaggregator.harutohiroki.com/assets/jquery-4.0.0.min.js';
    const fallback = 'https://code.jquery.com/jquery-4.0.0.min.js';
    const tryLoad = (src, next) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.addEventListener('load', onLoad, { once: true });
      s.addEventListener('error', () => next ? tryLoad(next, null) : onLoad(), { once: true });
      document.body.appendChild(s);
    };
    tryLoad(local, fallback);
  }

  function ensureAggregateLoaded() {
    if (aggregate) return Promise.resolve();
    if (aggregateLoading) return aggregateLoading;
    aggregateLoading = loadAggregate().then((data) => {
      aggregate = data;
      searchRows = buildSearchRows(data);
    }).catch((e) => {
      console.warn('[graphAggregator] failed to load aggregate index:', e);
    });
    return aggregateLoading;
  }

  async function loadAggregate() {
    // Try cache.
    try {
      const raw = localStorage.getItem(INDEX_CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached && Date.now() - cached.at < INDEX_CACHE_TTL_MS) {
          return cached.data;
        }
      }
    } catch { /* ignore */ }

    const res = await fetch(AGGREGATOR_URL, { credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    try {
      localStorage.setItem(INDEX_CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
    } catch { /* quota etc., not fatal */ }
    return data;
  }

  // Build a flat array of search rows once. Each row carries everything render
  // needs and a pre-lowered search string for fast indexOf matching.
  function buildSearchRows(data) {
    const sitesById = Object.create(null);
    for (const site of data.sites) sitesById[site.id] = site;
    const dbsById = Object.create(null);
    for (const db of data.dbs) dbsById[db.id] = db;
    const brands = data.brands || [];
    const collapsed = data.phonesFormat === 'collapsed';

    const rows = [];
    for (const phone of data.phones) {
      const brand = brands[phone.b];
      const name = phone.n;
      const display = brand + ' ' + name;
      const derivedShare = (brand + '_' + name).replace(/ /g, '_');
      const measurements = collapsed ? phone.m : [{ db: phone.db, s: phone.s }];

      for (const m of measurements) {
        const db = dbsById[m.db];
        if (!db) continue;
        const site = sitesById[db.siteId];
        if (!site) continue;

        const share = m.s !== undefined ? m.s : derivedShare;
        const link = db.url + '?share=' + share;

        rows.push({
          brand,
          phoneName: name,
          display,
          siteId: site.id,
          siteName: site.name,
          siteUrl: site.url,
          source: site.source || 'federated',
          dbId: db.id,
          dbType: db.type,
          dbRig: db.rig || (db.source === 'squigsites' ? null : 'unknown'),
          deltaReady: !!db.deltaReady,
          source5128: db.rig === 'bk-5128' || db.type === '5128',
          link,
          searchString: (site.name + ' ' + db.type + ' ' + display).toLowerCase()
        });
      }
    }
    return rows;
  }

  // ============================================================ "More squigsites" dropdown

  function createSquigSelect() {
    const headerLinksUl = document.querySelector('ul.header-links');
    if (!headerLinksUl) return;
    if (document.querySelector('select.squig-select')) return; // idempotent
    if (!aggregate) return;

    const select = document.createElement('select');
    select.className = 'squig-select';
    select.addEventListener('change', squigsiteChange);

    const blank = document.createElement('option');
    blank.setAttribute('disabled', '');
    blank.setAttribute('selected', '');
    blank.setAttribute('value', '');
    blank.textContent = 'More squigsites';
    select.append(blank);

    const groups = {
      '5128':       optgroup('5128'),
      'IEMs':       optgroup('IEMs'),
      'Headphones': optgroup('Headphones'),
      'Earbuds':    optgroup('Earbuds')
    };
    for (const g of Object.values(groups)) select.append(g);

    const currentDbBase = currentDbBaseUrl();

    // Build a (site, db) option for every db in the index.
    const sitesById = Object.fromEntries(aggregate.sites.map(s => [s.id, s]));
    for (const db of aggregate.dbs) {
      const site = sitesById[db.siteId];
      if (!site) continue;
      const isCurrent = currentDbBase && db.url && currentDbBase === db.url;
      const groupKey = (db.rig === 'bk-5128' || db.type === '5128') ? '5128' : db.type;
      const group = groups[groupKey];
      if (!group) continue;

      const opt = document.createElement('option');
      opt.textContent = site.name;
      opt.value = db.url;
      opt.setAttribute('data-site-id', site.id);
      if (isCurrent) opt.setAttribute('selected', '');
      group.append(opt);
    }

    const li = document.createElement('li');
    li.className = 'squig-select-li';
    li.append(select);
    headerLinksUl.append(li);

    injectSquigSelectStyles();

    function squigsiteChange() {
      const selected = select.options[select.selectedIndex];
      if (selected && selected.value) {
        window.location = selected.value;
      }
    }

    function optgroup(label) {
      const g = document.createElement('optgroup');
      g.setAttribute('label', label);
      return g;
    }
  }

  function currentDbBaseUrl() {
    // Best-effort: strip any ?share=... query, return the base directory URL.
    const u = new URL(window.location.href);
    u.search = '';
    u.hash = '';
    // Trim filename component if any (e.g. /index.html)
    if (u.pathname.endsWith('/')) return u.toString();
    const slash = u.pathname.lastIndexOf('/');
    if (slash >= 0) u.pathname = u.pathname.slice(0, slash + 1);
    return u.toString();
  }

  function injectSquigSelectStyles() {
    if (document.getElementById('ga-squigselect-styles')) return;
    const css = `
      @media (min-width: 1001px) {
        ul.header-links { justify-content: flex-end; }
      }
      ul.header-links li.squig-select-li {
        order: -1;
        position: relative;
        padding: 6px 16px 0 0;
        margin: 0 auto 0 -16px;
        color: #fff;
      }
      li.squig-select-li:after {
        position: absolute;
        top: 21px;
        right: 32px;
        content: '';
        display: block;
        width: 4px;
        height: 4px;
        border-right: 1px solid var(--background-color-contrast-more, #888);
        border-bottom: 1px solid var(--background-color-contrast-more, #888);
        transform: rotate(45deg);
      }
      select.squig-select {
        appearance: none;
        position: relative;
        display: flex;
        box-sizing: border-box;
        height: 36px;
        padding: 2px 30px 0 16px;
        background-color: transparent;
        border: 1px solid var(--background-color-contrast-more, #888);
        border-radius: 18px;
        color: currentColor;
        outline: none;
      }
      select.squig-select option { color: initial; }
      @media (max-width: 1000px) {
        ul.header-links li.squig-select-li {
          order: 1;
          width: 100%;
          height: auto;
          padding-top: 16px;
          margin: 36px 0 0 0;
          border-top: 1px solid var(--font-color-primary, currentColor);
          color: var(--font-color-primary, currentColor);
        }
        select.squig-select { width: 100%; }
        li.squig-select-li:after { top: 32px; }
      }
    `;
    const style = document.createElement('style');
    style.id = 'ga-squigselect-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ============================================================ Search

  function initSearch() {
    filterInput = document.querySelector('input.search');
    phonesPanel = document.querySelector('div#phones');
    if (!filterInput || !phonesPanel) return;

    injectResultsStyles();
    mountResults();

    filterInput.addEventListener('input', onInput);
    phonesPanel.addEventListener('scroll', onScroll, { passive: true });

    // If the user already typed something before the script booted, render now.
    if (filterInput.value.trim()) applyFilter();
  }

  function mountResults() {
    if (resultsRoot) return;
    resultsRoot = document.createElement('section');
    resultsRoot.className = 'ga-results';

    emptyMsg = document.createElement('div');
    emptyMsg.className = 'ga-empty';
    emptyMsg.textContent = 'No federated matches.';
    emptyMsg.style.display = 'none';

    scroller = document.createElement('div');
    scroller.className = 'ga-scroller';

    resultsRoot.append(emptyMsg, scroller);
    phonesPanel.appendChild(resultsRoot);
  }

  function onInput() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(applyFilter, DEBOUNCE_MS);
  }

  function applyFilter() {
    if (!searchRows) return;
    const terms = (filterInput.value || '').toLowerCase()
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);

    if (!terms.length) {
      layout = null;
      totalHeight = 0;
      scroller.style.height = '0px';
      scroller.replaceChildren();
      emptyMsg.style.display = 'none';
      // Reset the host panel scroll so the user sees their own phones again.
      phonesPanel.scrollTop = 0;
      return;
    }

    // AND across comma-separated terms
    const matches = [];
    const rows = searchRows;
    for (let i = 0; i < rows.length; i++) {
      const s = rows[i].searchString;
      let all = true;
      for (let t = 0; t < terms.length; t++) {
        if (s.indexOf(terms[t]) === -1) { all = false; break; }
      }
      if (all) matches.push(rows[i]);
    }

    if (matches.length === 0) {
      layout = null;
      totalHeight = 0;
      scroller.style.height = '0px';
      scroller.replaceChildren();
      emptyMsg.style.display = 'block';
      phonesPanel.scrollTop = 0;
      return;
    }
    emptyMsg.style.display = 'none';

    layout = buildLayout(matches);
    totalHeight = layout.length ? layout[layout.length - 1].top + layout[layout.length - 1].height : 0;
    scroller.style.height = totalHeight + 'px';
    phonesPanel.scrollTop = 0;
    renderWindow();
  }

  // Groups matches by db (one section per site+db pair, matching the old
  // dbExplorer's section-per-db layout) and sorts the sections:
  //   1. 5128 sources first      (was order: -1)
  //   2. Delta-ready next         (was order: 0)
  //   3. Everything else, by site name
  function buildLayout(matches) {
    const groups = new Map();
    for (const row of matches) {
      let g = groups.get(row.dbId);
      if (!g) { g = []; groups.set(row.dbId, g); }
      g.push(row);
    }

    const ordered = Array.from(groups.values());
    ordered.sort((a, b) => {
      const ra = a[0], rb = b[0];
      if (ra.source5128 !== rb.source5128) return ra.source5128 ? -1 : 1;
      if (ra.deltaReady !== rb.deltaReady) return ra.deltaReady ? -1 : 1;
      const cmp = ra.siteName.localeCompare(rb.siteName);
      if (cmp !== 0) return cmp;
      return ra.dbType.localeCompare(rb.dbType);
    });

    const out = [];
    let top = 0;
    for (let gi = 0; gi < ordered.length; gi++) {
      const rows = ordered[gi];
      out.push({ type: 'header', top, height: HEADER_HEIGHT_PX, row: rows[0] });
      top += HEADER_HEIGHT_PX;
      for (let ri = 0; ri < rows.length; ri++) {
        out.push({ type: 'item', top, height: ITEM_HEIGHT_PX, row: rows[ri] });
        top += ITEM_HEIGHT_PX;
      }
    }
    return out;
  }

  function onScroll() {
    if (!layout) return;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = null;
      renderWindow();
    });
  }

  function renderWindow() {
    if (!layout) return;
    const scrollerOffsetTop = scroller.offsetTop;
    const viewportHeight = phonesPanel.clientHeight;
    const relativeTop = phonesPanel.scrollTop - scrollerOffsetTop;
    const viewTop = Math.max(0, relativeTop - SCROLL_BUFFER_PX);
    const viewBottom = relativeTop + viewportHeight + SCROLL_BUFFER_PX;

    const firstIdx = findFirstVisible(layout, viewTop);
    const lastIdx = findLastVisible(layout, viewBottom);
    if (firstIdx > lastIdx) {
      scroller.replaceChildren();
      return;
    }

    const frag = document.createDocumentFragment();
    for (let i = firstIdx; i <= lastIdx; i++) {
      const node = layout[i];
      const el = (node.type === 'header')
        ? createHeader(node.row)
        : createItem(node.row);
      el.style.position = 'absolute';
      el.style.left = '0';
      el.style.right = '0';
      el.style.top = node.top + 'px';
      el.style.height = node.height + 'px';
      frag.appendChild(el);
    }
    scroller.replaceChildren(frag);
  }

  function findFirstVisible(arr, viewTop) {
    // First index where item.top + item.height > viewTop. Binary search.
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid].top + arr[mid].height > viewTop) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  function findLastVisible(arr, viewBottom) {
    // Last index where item.top < viewBottom. Binary search.
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid].top < viewBottom) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  // Header element.
  function createHeader(row) {
    const el = document.createElement('div');
    el.className = 'db-site-header';
    if (row.source5128) el.setAttribute('data-source-5128', 'true');
    if (row.deltaReady && !row.source5128) el.setAttribute('data-delta-ready', 'true');

    const link = document.createElement('a');
    link.href = row.siteUrl;
    link.target = '_blank';
    link.rel = 'noopener';

    const label = document.createElement('span');

    const sourceIcon = document.createElement('span');
    sourceIcon.className = 'ga-source-icon';
    sourceIcon.setAttribute('data-source', row.source === 'squigsites' ? 'squigsites' : 'federated');
    sourceIcon.setAttribute('aria-hidden', 'true');
    sourceIcon.title = row.source === 'squigsites'
      ? 'Listed on squigsites.json'
      : 'Federated via GraphAggregator';
    label.appendChild(sourceIcon);

    label.appendChild(document.createTextNode(row.siteName));

    const tag = document.createElement('span');
    tag.className = 'db-site-tag';
    tag.textContent = row.dbType;
    label.appendChild(tag);

    link.appendChild(label);
    el.appendChild(link);
    return el;
  }

  // Item element.
  function createItem(row) {
    const el = document.createElement('div');
    el.className = 'fauxn-item';
    if (row.deltaReady) el.setAttribute('data-delta-ready', 'true');

    const a = document.createElement('a');
    a.className = 'fauxn-link';
    a.href = row.link;
    a.target = '_blank';
    a.rel = 'noopener';

    const label = document.createElement('span');
    label.textContent = row.display;
    a.appendChild(label);

    // Delta-ready: append the current baseline phone to the share URL
    // so the destination site loads the right delta target alongside the
    // phone.
    if (row.deltaReady) {
      const handleDeltaClick = (e) => {
        try {
          const b = (typeof window !== 'undefined') ? window.baseline : null;
          if (b && b.p && typeof b.p.fileName === 'string' && b.p.fileName.length) {
            e.preventDefault();
            const extra = encodeURI(b.p.fileName.replace(/ /g, '_'));
            window.open(row.link + ',' + extra, '_blank', 'noopener');
          }
        } catch { /* fall through to default link behavior */ }
      };
      a.addEventListener('click', handleDeltaClick);
      a.addEventListener('auxclick', handleDeltaClick);
    }

    el.appendChild(a);
    return el;
  }

  function injectResultsStyles() {
    if (document.getElementById('ga-results-styles')) return;
    const css = `
      :root {
        --ga-icon-federated: url("data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Ccircle cx='12' cy='4' r='2.2' fill='black'/%3E%3Ccircle cx='4' cy='18' r='2.2' fill='black'/%3E%3Ccircle cx='20' cy='18' r='2.2' fill='black'/%3E%3Cpath d='M11 5.5 L5 16 M13 5.5 L19 16 M6 18 L18 18' stroke='black' stroke-width='1.6' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
        --ga-icon-squigsites: url("data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M3 12 Q 6 6 9 12 T 15 12 T 21 12' stroke='black' stroke-width='2.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
        --ga-icon-new-tab: url("data:image/svg+xml,%3Csvg id='Layer_1' data-name='Layer 1' xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cdefs%3E%3Cstyle%3E.cls-1,.cls-2%7Bfill:none;stroke:%23231f20;%7D.cls-2%7Bstroke-linecap:round;%7D%3C/style%3E%3C/defs%3E%3Cpath class='cls-1' d='M21,11v2c0,3.77,0,5.66-1.17,6.83S16.77,21,13,21H11c-3.77,0-5.66,0-6.83-1.17S3,16.77,3,13V11C3,7.23,3,5.34,4.17,4.17S7.23,3,11,3h1'/%3E%3Cpath class='cls-2' d='M21,3.15H16.76m4.24,0V7.39m0-4.24-8.49,8.48'/%3E%3C/svg%3E");
        --ga-icon-5128: url("data:image/svg+xml,%3Csvg width='685' height='200' viewBox='0 0 685 200' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cg clip-path='url(%23clip0_1_44)'%3E%3Cpath fill-rule='evenodd' clip-rule='evenodd' d='M485 20H20V180H485V20ZM485 0H0V200H485H685V0H485ZM59.088 55.936V144H89.936C97.7867 144 104.187 143.616 109.136 142.848C114.085 141.995 117.968 140.629 120.784 138.752C123.6 136.789 125.605 134.144 126.8 130.816C128.08 127.403 128.891 123.179 129.232 118.144C129.573 113.109 129.744 107.051 129.744 99.968C129.744 92.8853 129.573 86.8267 129.232 81.792C128.891 76.7573 128.08 72.576 126.8 69.248C125.605 65.8347 123.6 63.1893 120.784 61.312C117.968 59.3493 114.085 57.984 109.136 57.216C104.187 56.3627 97.7867 55.936 89.936 55.936H59.088ZM89.424 126.848H81.36V73.088H89.424C92.9227 73.088 95.7813 73.1733 98 73.344C100.219 73.5147 101.968 74.0267 103.248 74.88C104.528 75.7333 105.467 77.1413 106.064 79.104C106.661 80.9813 107.003 83.6267 107.088 87.04C107.259 90.368 107.344 94.6773 107.344 99.968C107.344 105.259 107.259 109.611 107.088 113.024C107.003 116.352 106.661 118.997 106.064 120.96C105.552 122.837 104.613 124.203 103.248 125.056C101.968 125.824 100.219 126.336 98 126.592C95.7813 126.763 92.9227 126.848 89.424 126.848ZM210.654 144H148.958V55.936H210.654V73.088H171.23V91.136H204.638V108.032H171.23V126.848H210.654V144ZM252.975 55.936H230.703V144H287.279V126.08H252.975V55.936ZM308.978 144V73.856H284.914V55.936H355.442V73.856H331.25V144H308.978ZM379.145 144H357.129L385.033 55.936H415.369L443.401 144H420.873L415.625 126.72H384.265L379.145 144ZM389.001 109.952H410.761L400.265 75.136H399.369L389.001 109.952ZM538.755 142.367C537.987 143.901 537.603 144.668 537.695 145.292C537.775 145.836 538.076 146.323 538.527 146.639C539.043 147 539.901 147 541.616 147H627.384C629.099 147 629.957 147 630.473 146.639C630.924 146.323 631.225 145.836 631.305 145.292C631.397 144.668 631.013 143.901 630.245 142.367L587.361 56.7151C586.44 54.8753 585.98 53.9554 585.357 53.6601C584.815 53.4031 584.186 53.4031 583.643 53.6601C583.02 53.9554 582.56 54.8753 581.639 56.7151L538.755 142.367ZM584.5 93.4398L567.197 128H601.803L584.5 93.4398Z' fill='black'/%3E%3C/g%3E%3Cdefs%3E%3CclipPath id='clip0_1_44'%3E%3Crect width='685' height='200' fill='white'/%3E%3C/clipPath%3E%3C/defs%3E%3C/svg%3E");
        --ga-icon-5128-sm: url("data:image/svg+xml,%3Csvg width='200' height='200' viewBox='0 0 200 200' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M54.896 147.208L54 145.8L97.136 53H99.696L145.648 145.544L144.624 147.208H54.896ZM81.136 129.032H116.08L98.032 91.4L81.136 129.032Z' fill='black'/%3E%3C/svg%3E");
      }

      div.db-site-header {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        margin: 0 0 6px 0;

        background-color: var(--background-color-contrast);
        border-bottom: 1px solid var(--background-color);
        border-radius: 6px 6px 0 0;

        color: var(--accent-color);
        font-weight: bold;
      }

      div.db-site-header:before {
        content: '';
        display: block;
        flex: 100% 0 0;
        height: 11px;

        background-color: var(--background-color);
      }

      div.db-site-header a {
        display: flex;
        flex: auto 1 1;
        padding: 11px 0 11px 12px;

        color: var(--accent-color-contrast);
        font-weight: 400;
        font-size: 12px;
        line-height: 1.5em;
        text-decoration: none;
      }

      div.db-site-header a:hover {
        text-decoration: underline;
      }

      div.db-site-header a span.db-site-tag {
        margin: 0 0 0 6px;
        color: var(--background-color-contrast-more);
        font-size: 11px;
        font-family: var(--font-secondary);
        text-transform: uppercase;
      }

      /* Federated / squigsites source mark next to the site name */
      div.db-site-header span.ga-source-icon {
        display: inline-block;
        width: 14px;
        height: 14px;
        margin: 0 6px -2px 0;
        vertical-align: middle;

        background-color: var(--accent-color-contrast);
        mask-size: contain;
        mask-repeat: no-repeat;
        mask-position: center;
        -webkit-mask-size: contain;
        -webkit-mask-repeat: no-repeat;
        -webkit-mask-position: center;
      }
      div.db-site-header span.ga-source-icon[data-source="federated"] {
        mask-image: var(--ga-icon-federated);
        -webkit-mask-image: var(--ga-icon-federated);
      }
      div.db-site-header span.ga-source-icon[data-source="squigsites"] {
        mask-image: var(--ga-icon-squigsites);
        -webkit-mask-image: var(--ga-icon-squigsites);
      }

      div.db-site-header[data-delta-ready="true"]:after {
        content: '';
        flex: 54px 0 0;
        height: 18px;
        margin: 0 12px 0 0;

        background: linear-gradient(135deg, var(--background-color-contrast-more) 40%, var(--accent-color), var(--background-color-contrast-more) 50%);
        background-size: 800% 800%;
        animation: ga-gradient-flash 6s ease-in-out infinite;

        mask: var(--ga-icon-5128);
        -webkit-mask: var(--ga-icon-5128);
        mask-size: 100%;
        mask-repeat: no-repeat;
        mask-position: center;
        -webkit-mask-size: 100%;
        -webkit-mask-repeat: no-repeat;
        -webkit-mask-position: center;
      }

      div.fauxn-item {
        display: flex;
        padding: 0 0 6px 0;

        background-color: var(--background-color-contrast);
        color: var(--font-color-primary);
        font-weight: 400;
        font-size: 12px;
        line-height: 1.5em;
      }

      div.fauxn-item a {
        display: flex;
        align-items: flex-start;
        flex: auto 1 1;
        padding: 11px 0 11px 12px;

        color: var(--font-color-primary);
        text-decoration: none;
      }

      div.fauxn-item a:hover {
        text-decoration: underline;
      }

      div.db-site-header span,
      div.fauxn-item span {
        flex: auto 1 1;
      }

      div.fauxn-item a:before {
        content: '';
        display: block;
        flex: 18px 0 0;
        height: 18px;
        margin: 0 8px 0 0;

        background-color: var(--accent-color-contrast);
        mask: var(--ga-icon-new-tab);
        -webkit-mask: var(--ga-icon-new-tab);
        mask-size: 14px;
        mask-repeat: no-repeat;
        mask-position: center;
        -webkit-mask-size: 14px;
        -webkit-mask-repeat: no-repeat;
        -webkit-mask-position: center;
      }

      div.fauxn-item[data-delta-ready="true"] a:after {
        content: '';
        flex: 18px 0 0;
        height: 18px;
        margin: 0 12px 0 0;

        background: linear-gradient(135deg, var(--background-color-contrast-more) 40%, var(--accent-color), var(--background-color-contrast-more) 50%);
        background-size: 800% 800%;
        animation: ga-gradient-flash 6s ease-in-out infinite;

        mask: var(--ga-icon-5128-sm);
        -webkit-mask: var(--ga-icon-5128-sm);
        mask-size: 100%;
        mask-repeat: no-repeat;
        mask-position: center;
        -webkit-mask-size: 100%;
        -webkit-mask-repeat: no-repeat;
        -webkit-mask-position: center;
      }

      @keyframes ga-gradient-flash {
        0%    { background-position: 0% 0%; }
        40%   { background-position: 100% 100%; }
        40.1% { background-position: 0% 0%; }
        100%  { background-position: 0% 0%; }
      }

      section.ga-results { margin: 0; padding: 0; }
      div.ga-scroller { position: relative; width: 100%; }
      div.ga-empty {
        padding: 12px;
        text-align: center;
        font-size: 12px;
        color: var(--background-color-contrast-more, #888);
      }

      @media (max-width: 1000px) {
        div.db-site-header { margin-right: 2px; }
        div.fauxn-item { margin-right: 2px; }
      }
    `;
    const style = document.createElement('style');
    style.id = 'ga-results-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ============================================================ Delta target mods

  function initDeltaTargetModsOnLoad() {
    window.addEventListener('load', () => {
      const interval = setInterval(() => {
        if (document.querySelectorAll('div.targetLabel').length) {
          clearInterval(interval);
          deltaTargetMods();
        }
      }, 200);
    });
  }

  function deltaTargetMods() {
    injectDeltaTargetStyles();
    const targetLabels = document.querySelectorAll('div.targetLabel span');
    targetLabels.forEach((label) => {
      if (!label.textContent.includes('Δ')) return;
      const targetCollection = label.closest('div.targetClass');
      if (!targetCollection) return;
      targetCollection.classList.add('delta-targets');

      const deltaTargets = targetCollection.querySelectorAll('div.target');
      deltaTargets.forEach((target) => {
        const targetName = target.textContent;

        const observer = new MutationObserver((mutations) => {
          mutations.forEach((mutation) => {
            const style = mutation.target.getAttribute('style') || '';
            if (style.length) {
              const tr = document.querySelector('tr[data-filename="' + targetName + ' Target"]');
              if (!tr) return;
              const baselineBtn = tr.querySelector('td.button-baseline:not(.selected)');
              if (baselineBtn) baselineBtn.click();
            }
          });
        });
        observer.observe(target, { attributes: true, attributeFilter: ['style'] });

        if (Array.isArray(window.activePhones)) {
          window.activePhones.forEach((phone) => {
            if (phone.dispName === targetName) {
              const tr = document.querySelector('tr[data-filename="' + targetName + ' Target"]');
              if (!tr) return;
              const baselineBtn = tr.querySelector('td.button-baseline:not(.selected)');
              if (baselineBtn) baselineBtn.click();
            }
          });
        }
      });
    });
  }

  function injectDeltaTargetStyles() {
    if (document.getElementById('ga-delta-target-styles')) return;
    const css = `
      :root {
        --icon-5128: url("data:image/svg+xml,%3Csvg width='685' height='200' viewBox='0 0 685 200' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cg clip-path='url(%23clip0_1_44)'%3E%3Cpath fill-rule='evenodd' clip-rule='evenodd' d='M485 20H20V180H485V20ZM485 0H0V200H485H685V0H485ZM59.088 55.936V144H89.936C97.7867 144 104.187 143.616 109.136 142.848C114.085 141.995 117.968 140.629 120.784 138.752C123.6 136.789 125.605 134.144 126.8 130.816C128.08 127.403 128.891 123.179 129.232 118.144C129.573 113.109 129.744 107.051 129.744 99.968C129.744 92.8853 129.573 86.8267 129.232 81.792C128.891 76.7573 128.08 72.576 126.8 69.248C125.605 65.8347 123.6 63.1893 120.784 61.312C117.968 59.3493 114.085 57.984 109.136 57.216C104.187 56.3627 97.7867 55.936 89.936 55.936H59.088ZM89.424 126.848H81.36V73.088H89.424C92.9227 73.088 95.7813 73.1733 98 73.344C100.219 73.5147 101.968 74.0267 103.248 74.88C104.528 75.7333 105.467 77.1413 106.064 79.104C106.661 80.9813 107.003 83.6267 107.088 87.04C107.259 90.368 107.344 94.6773 107.344 99.968C107.344 105.259 107.259 109.611 107.088 113.024C107.003 116.352 106.661 118.997 106.064 120.96C105.552 122.837 104.613 124.203 103.248 125.056C101.968 125.824 100.219 126.336 98 126.592C95.7813 126.763 92.9227 126.848 89.424 126.848ZM210.654 144H148.958V55.936H210.654V73.088H171.23V91.136H204.638V108.032H171.23V126.848H210.654V144ZM252.975 55.936H230.703V144H287.279V126.08H252.975V55.936ZM308.978 144V73.856H284.914V55.936H355.442V73.856H331.25V144H308.978ZM379.145 144H357.129L385.033 55.936H415.369L443.401 144H420.873L415.625 126.72H384.265L379.145 144ZM389.001 109.952H410.761L400.265 75.136H399.369L389.001 109.952ZM538.755 142.367C537.987 143.901 537.603 144.668 537.695 145.292C537.775 145.836 538.076 146.323 538.527 146.639C539.043 147 539.901 147 541.616 147H627.384C629.099 147 629.957 147 630.473 146.639C630.924 146.323 631.225 145.836 631.305 145.292C631.397 144.668 631.013 143.901 630.245 142.367L587.361 56.7151C586.44 54.8753 585.98 53.9554 585.357 53.6601C584.815 53.4031 584.186 53.4031 583.643 53.6601C583.02 53.9554 582.56 54.8753 581.639 56.7151L538.755 142.367ZM584.5 93.4398L567.197 128H601.803L584.5 93.4398Z' fill='black'/%3E%3C/g%3E%3Cdefs%3E%3CclipPath id='clip0_1_44'%3E%3Crect width='685' height='200' fill='white'/%3E%3C/clipPath%3E%3C/defs%3E%3C/svg%3E%0A");
      }
      div.targetClass.delta-targets:before {
        content: '';
        display: block;
        width: 108px;
        height: 36px;
        margin: 0 10px 0 0;
        background: linear-gradient(135deg, var(--background-color-contrast-more) 40%, var(--accent-color), var(--background-color-contrast-more) 50%);
        background-size: 800% 800%;
        animation: ga-gradient-flash 6s ease-in-out infinite;
        mask: var(--icon-5128);
        -webkit-mask: var(--icon-5128);
        mask-size: 100%;
        mask-repeat: no-repeat;
        mask-position: center;
        -webkit-mask-size: 100%;
        -webkit-mask-repeat: no-repeat;
        -webkit-mask-position: center;
      }
      @keyframes ga-gradient-flash {
        0%    { background-position: 0% 0%; }
        40%   { background-position: 100% 100%; }
        40.1% { background-position: 0% 0%; }
        100%  { background-position: 0% 0%; }
      }
      div.targetClass.delta-targets div.targetLabel { display: none; }
    `;
    const style = document.createElement('style');
    style.id = 'ga-delta-target-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ============================================================ Cachebust

  function initCacheBust() {
    if (window.location.search.includes('cachebust')) {
      document.cookie = 'cachebust=1; path=/; max-age=300';
    }
  }
})();
