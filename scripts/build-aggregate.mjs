// Builds aggregate-index.json from registry.json plus (optionally) a centralized
// squigsites.json from squig.link. Both sources feed the same output schema.
//
// Usage:
//   node scripts/build-aggregate.mjs [--out dist/aggregate-index.json]
//                                    [--squigsites https://squig.link/squigsites.json]
//
// Env flags (compression tiers):
//   ELIDE_DERIVABLE_SHARE=1   Tier 2: drop `s` when it equals (brand + '_' + name).
//   COLLAPSE_PHONES=1         Tier 3: collapse identical (brand, name) into one row
//                             with a `m` array of measurements. Changes output shape;
//                             consumers branch on top-level `phonesFormat`.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  validatePhoneBookShape,
  validateSquigSite,
  sanitizeOutputString,
} from '../lib/validate.mjs';

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
}
const OUT = arg('--out', 'dist/aggregate-index.json');
const SQUIGSITES_URL = arg('--squigsites', null);
const ELIDE_SHARE = process.env.ELIDE_DERIVABLE_SHARE === '1';
const COLLAPSE_PHONES = process.env.COLLAPSE_PHONES === '1';

const registry = JSON.parse(readFileSync('registry.json', 'utf8'));

const sites = [];
const dbs = [];
const phoneRows = []; // flat rows; collapsed into `phones` later if Tier 3 on
const brandPool = [];
const brandIndex = new Map();

function brandIdx(name) {
  if (brandIndex.has(name)) return brandIndex.get(name);
  const i = brandPool.length;
  brandPool.push(name);
  brandIndex.set(name, i);
  return i;
}

// Pull a usable display name out of a phone entry. Some authors use
// name: "X" (the original convention), others wrap it as name: ["X"], and
// the rare entry has no name at all (typo).
function extractPhoneName(p) {
  if (typeof p?.name === 'string' && p.name.length) return sanitizeOutputString(p.name);
  if (Array.isArray(p?.name) && typeof p.name[0] === 'string' && p.name[0].length) return sanitizeOutputString(p.name[0]);
  return null;
}

// Pull a share filename out of a phone entry. Accepts:
//   - file: "X"           (original convention)
//   - file: ["X", "Y"]    (variants, share param is the first)
//   - hptfs: [{ files: ["X", ...] }]  (god damn it @potatosalad775 i gotta do this just for you)
function extractShare(p) {
  let raw = null;
  if (typeof p?.file === 'string' && p.file.length) {
    raw = p.file;
  } else if (Array.isArray(p?.file) && typeof p.file[0] === 'string' && p.file[0].length) {
    raw = p.file[0];
  } else if (Array.isArray(p?.hptfs) && p.hptfs.length) {
    const h = p.hptfs[0];
    if (h && Array.isArray(h.files) && typeof h.files[0] === 'string' && h.files[0].length) {
      raw = h.files[0];
    }
  }
  if (raw === null) return null;
  return sanitizeOutputString(raw.replace(/ /g, '_'));
}

function derivedShare(brand, name) {
  return (brand + ' ' + name).replace(/ /g, '_');
}

function pushPhone(dbId, brand, phoneName, share) {
  const row = { db: dbId, b: brandIdx(brand), n: phoneName };
  if (!ELIDE_SHARE || share !== derivedShare(brand, phoneName)) {
    row.s = share;
  }
  phoneRows.push(row);
}

// Trims a JSON-stringified value so a log line stays readable. Replaces
// control chars (incl. ANSI escapes / CR / LF) with '?' so a hostile name can't
// rewrite log output.
const PREVIEW_CTRL_RE = new RegExp('[\\x00-\\x1F\\x7F-\\x9F]', 'g');
function preview(v) {
  if (v === undefined) return '(missing)';
  let s;
  try { s = JSON.stringify(v); } catch { s = String(v); }
  s = s.replace(PREVIEW_CTRL_RE, '?');
  if (s.length > 80) s = s.slice(0, 77) + '...';
  return s;
}

// Walks a brand's phones array, extracts what's usable, and pushes one row
// per phone. Skips entries that don't have at least a name and a share
// source. Returns the skips with enough context that the caller's log
// pinpoints which phone is malformed and why.
function ingestBrand(dbId, brand) {
  let added = 0;
  const skips = [];

  if (!brand || typeof brand !== 'object') {
    return { added, skips: [{ where: '(brand)', reason: 'brand entry is not an object', detail: preview(brand) }] };
  }
  if (typeof brand.name !== 'string') {
    return { added, skips: [{ where: '(brand)', reason: 'brand.name is missing or not a string', detail: preview(brand.name) }] };
  }
  const brandName = sanitizeOutputString(brand.name, 120);
  if (!brandName) {
    return { added, skips: [{ where: '(brand)', reason: 'brand.name is empty after sanitization', detail: preview(brand.name) }] };
  }
  if (!Array.isArray(brand.phones)) {
    return { added, skips: [{ where: brandName, reason: 'phones is not an array', detail: preview(brand.phones) }] };
  }

  for (let pi = 0; pi < brand.phones.length; pi++) {
    const phone = brand.phones[pi];
    const where = `${brandName}.phones[${pi}]`;
    if (!phone || typeof phone !== 'object') {
      skips.push({ where, reason: 'phone is not an object', detail: preview(phone) });
      continue;
    }
    const phoneName = extractPhoneName(phone);
    const share = extractShare(phone);
    if (!phoneName && !share) {
      skips.push({ where, reason: 'no usable name and no usable file/hptfs', detail: preview({ name: phone.name, file: phone.file, hptfs: phone.hptfs }) });
      continue;
    }
    if (!phoneName) {
      skips.push({ where, reason: 'missing or unusable name', detail: 'name=' + preview(phone.name) + ' file=' + preview(phone.file ?? phone.hptfs) });
      continue;
    }
    if (!share) {
      skips.push({ where, reason: 'missing or unusable file/hptfs', detail: 'name=' + preview(phoneName) });
      continue;
    }
    pushPhone(dbId, brandName, phoneName, share);
    added++;
  }
  return { added, skips };
}

async function fetchPhoneBook(url, { timeoutMs = 20000 } = {}) {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function ingestRegistryEntry(entry) {
  sites.push({
    id: entry.id,
    name: sanitizeOutputString(entry.name, 100),
    url: entry.url,
    github: entry.github,
    lastVerified: new Date().toISOString()
  });

  for (const db of entry.dbs) {
    const dbId = db.id || `${entry.id}:${db.type.toLowerCase()}:${db.rig}`;
    let phoneBook;
    try {
      phoneBook = await fetchPhoneBook(db.phoneBookUrl);
    } catch (e) {
      console.error(`Skipping ${dbId}: ${e.message}`);
      continue;
    }

    const shape = validatePhoneBookShape(phoneBook);
    if (!shape.ok) {
      console.error(`Skipping ${dbId}: malformed phone_book - ${shape.errors[0]}`);
      continue;
    }

    dbs.push({
      id: dbId,
      siteId: entry.id,
      type: db.type,
      rig: db.rig,
      url: db.phoneBookUrl.replace(/\/[^/]*$/, '/'), // strip filename to base
      phoneBookUrl: db.phoneBookUrl,
      deltaReady: !!db.deltaReady
    });

    const allSkips = [];
    for (const brand of phoneBook) {
      const { skips } = ingestBrand(dbId, brand);
      for (const s of skips) allSkips.push(s);
    }
    if (allSkips.length) {
      console.error(`${dbId}: skipped ${allSkips.length} malformed phone entries:`);
      for (const s of allSkips) {
        console.error(`  - ${s.where}: ${s.reason} | ${s.detail}`);
      }
    }
  }
}

// 1. Federated registry entries.
for (const entry of registry) {
  await ingestRegistryEntry(entry);
}

// 2. squigsites.json
// a separate, centralized source we mirror in for users of that solution who haven't moved over yet.
if (SQUIGSITES_URL) {
  try {
    const squigSites = await fetchPhoneBook(SQUIGSITES_URL);
    if (!Array.isArray(squigSites)) throw new Error('squigsites.json root is not an array');
    for (const site of squigSites) {
      const reason = validateSquigSite(site);
      if (reason) {
        console.error(`Skipping squigsites entry: ${reason} | ${preview(site)}`);
        continue;
      }
      const rootDomain = site.urlType === 'root';
      const subDomain = site.urlType === 'subdomain';
      const altDomain = site.urlType === 'altDomain';
      const baseUrl = rootDomain ? 'https://squig.link'
        : altDomain ? site.altDomain
        : subDomain ? `https://${site.username}.squig.link`
        : `https://squig.link/lab/${site.username}`;

      const safeName = sanitizeOutputString(site.name, 100);
      sites.push({
        id: `squigsites:${site.username}`,
        name: safeName,
        url: baseUrl,
        lastVerified: new Date().toISOString(),
        source: 'squigsites'
      });

      for (const db of site.dbs) {
        const dbUrl = baseUrl + db.folder;
        const phoneBookUrl = dbUrl + 'data/phone_book.json';
        const dbId = `squigsites:${site.username}:${db.type.toLowerCase()}`;
        let phoneBook;
        try {
          phoneBook = await fetchPhoneBook(phoneBookUrl);
        } catch (e) {
          console.error(`Skipping squigsites ${dbId}: ${e.message}`);
          continue;
        }

        const shape = validatePhoneBookShape(phoneBook);
        if (!shape.ok) {
          console.error(`Skipping squigsites ${dbId}: malformed phone_book - ${shape.errors[0]}`);
          continue;
        }

        dbs.push({
          id: dbId,
          siteId: `squigsites:${site.username}`,
          type: db.type,
          url: dbUrl,
          phoneBookUrl,
          deltaReady: db.deltaReady === true || db.deltaReady === 'true',
          source: 'squigsites'
        });
        const allSkips = [];
        for (const brand of phoneBook) {
          const { skips } = ingestBrand(dbId, brand);
          for (const s of skips) allSkips.push(s);
        }
        if (allSkips.length) {
          console.error(`squigsites ${dbId}: skipped ${allSkips.length} malformed phone entries:`);
          for (const s of allSkips) {
            console.error(`  - ${s.where}: ${s.reason} | ${s.detail}`);
          }
        }
      }
    }
  } catch (e) {
    console.error(`squigsites ingest failed: ${e.message}`);
  }
}

// Tier 3: collapse identical (brand, name) rows into one with `m[]`.
// Trades a normalized lookup for a flatter, smaller list. Consumers branch on
// `phonesFormat`.
let phones, phonesFormat;
if (COLLAPSE_PHONES) {
  const groups = new Map();
  for (const row of phoneRows) {
    const key = row.b + ' ' + row.n.toLowerCase();
    let g = groups.get(key);
    if (!g) {
      g = { b: row.b, n: row.n, m: [] };
      groups.set(key, g);
    }
    const meas = { db: row.db };
    if (row.s !== undefined) meas.s = row.s;
    g.m.push(meas);
  }
  phones = Array.from(groups.values());
  phonesFormat = 'collapsed';
} else {
  phones = phoneRows;
  phonesFormat = 'flat';
}

const out = {
  v: 2,
  generatedAt: new Date().toISOString(),
  phonesFormat,
  brands: brandPool,
  sites,
  dbs,
  phones
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.error(`Wrote ${OUT}: ${sites.length} sites, ${dbs.length} dbs, ${phones.length} phone rows (${phonesFormat}), ${brandPool.length} brands.`);
