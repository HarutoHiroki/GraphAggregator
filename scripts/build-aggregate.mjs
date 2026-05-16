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
import { validatePhoneBookShape } from '../lib/validate.mjs';

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
  if (typeof p?.name === 'string' && p.name.length) return p.name;
  if (Array.isArray(p?.name) && typeof p.name[0] === 'string' && p.name[0].length) return p.name[0];
  return null;
}

// Pull a share filename out of a phone entry. Accepts:
//   - file: "X"           (original convention)
//   - file: ["X", "Y"]    (variants, share param is the first)
//   - hptfs: [{ files: ["X", ...] }]  (god damn it @potatosalad775 i gotta do this just for you)
function extractShare(p) {
  if (typeof p?.file === 'string' && p.file.length) {
    return p.file.replace(/ /g, '_');
  }
  if (Array.isArray(p?.file) && typeof p.file[0] === 'string' && p.file[0].length) {
    return p.file[0].replace(/ /g, '_');
  }
  if (Array.isArray(p?.hptfs) && p.hptfs.length) {
    const h = p.hptfs[0];
    if (h && Array.isArray(h.files) && typeof h.files[0] === 'string' && h.files[0].length) {
      return h.files[0].replace(/ /g, '_');
    }
  }
  return null;
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

// Walks a brand's phones array, extracts what's usable, and pushes one row
// per phone. Skips entries that don't have at least a name and a share
// source. Counts skips so the caller can log them.
function ingestBrand(dbId, brand) {
  let added = 0, skipped = 0;
  if (!brand || typeof brand.name !== 'string' || !Array.isArray(brand.phones)) {
    return { added, skipped };
  }
  for (const phone of brand.phones) {
    if (!phone || typeof phone !== 'object') { skipped++; continue; }
    const phoneName = extractPhoneName(phone);
    const share = extractShare(phone);
    if (!phoneName || !share) { skipped++; continue; }
    pushPhone(dbId, brand.name, phoneName, share);
    added++;
  }
  return { added, skipped };
}

async function fetchPhoneBook(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function ingestRegistryEntry(entry) {
  sites.push({
    id: entry.id,
    name: entry.name,
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

    let totalSkipped = 0;
    for (const brand of phoneBook) {
      const { skipped } = ingestBrand(dbId, brand);
      totalSkipped += skipped;
    }
    if (totalSkipped) console.error(`${dbId}: skipped ${totalSkipped} malformed phone entries`);
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
    const squigSites = await (await fetch(SQUIGSITES_URL)).json();
    for (const site of squigSites) {
      const rootDomain = site.urlType === 'root';
      const subDomain = site.urlType === 'subdomain';
      const altDomain = site.urlType === 'altDomain';
      const baseUrl = rootDomain ? 'https://squig.link'
        : altDomain ? site.altDomain
        : subDomain ? `https://${site.username}.squig.link`
        : `https://squig.link/lab/${site.username}`;

      sites.push({
        id: `squigsites:${site.username}`,
        name: site.name,
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
        let totalSkipped = 0;
        for (const brand of phoneBook) {
          const { skipped } = ingestBrand(dbId, brand);
          totalSkipped += skipped;
        }
        if (totalSkipped) console.error(`squigsites ${dbId}: skipped ${totalSkipped} malformed phone entries`);
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
