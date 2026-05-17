export function slugify(githubUsername) {
  return String(githubUsername || '').trim().toLowerCase();
}

export function ciEquals(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

const URL_RE = /^https:\/\/[^\s/$.?#].[^\s]*$/i;
const GH_USER_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
const SQUIG_USER_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,62}[a-zA-Z0-9])?$/;
const SQUIG_FOLDER_RE = /^\/(?:[a-zA-Z0-9._-]+\/)*$/;
const SQUIG_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const SQUIG_URL_TYPES = new Set(['root', 'subdomain', 'altDomain', 'labFolder']);

// Strips the C0/C1 control band (null, CR, LF, ANSI escapes) and caps
// length so a runaway value can't blow up the index. Returns null
// if the result is empty or wasn't even a string to begin with
const CTRL_CHAR_RE = new RegExp('[\\x00-\\x1F\\x7F-\\x9F]', 'g');
export function sanitizeOutputString(s, maxLen = 200) {
  if (typeof s !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  let cleaned = s.replace(CTRL_CHAR_RE, '');
  if (cleaned.length > maxLen) cleaned = cleaned.slice(0, maxLen);
  return cleaned.length ? cleaned : null;
}

// Strict shape check for an entry in squig.link's squigsites.json. The mirror
// is third-party content with no PR review, so this validate every field we
// interpolate into a URL, an id, or the output index.
export function validateSquigSite(site) {
  if (!site || typeof site !== 'object') return 'not an object';
  if (typeof site.username !== 'string' || !SQUIG_USER_RE.test(site.username)) return 'invalid username';
  if (typeof site.name !== 'string' || site.name.length === 0 || site.name.length > 100) return 'invalid name';
  if (!SQUIG_URL_TYPES.has(site.urlType)) return 'invalid urlType';
  if (site.urlType === 'altDomain') {
    if (typeof site.altDomain !== 'string' || !URL_RE.test(site.altDomain)) return 'invalid altDomain';
  }
  if (!Array.isArray(site.dbs) || site.dbs.length === 0 || site.dbs.length > 20) return 'invalid dbs';
  for (let i = 0; i < site.dbs.length; i++) {
    const db = site.dbs[i];
    if (!db || typeof db !== 'object') return `db[${i}] not object`;
    if (typeof db.folder !== 'string' || !SQUIG_FOLDER_RE.test(db.folder) || db.folder.includes('..')) return `db[${i}].folder invalid`;
    if (typeof db.type !== 'string' || !SQUIG_TYPE_RE.test(db.type)) return `db[${i}].type invalid`;
  }
  return null;
}

export function validateShape(entry, config) {
  const errors = [];

  if (!entry || typeof entry !== 'object') {
    return { ok: false, errors: ['Entry is not an object'] };
  }

  if (!entry.github || !GH_USER_RE.test(entry.github)) {
    errors.push('`github` must be a valid GitHub username');
  }
  if (!entry.url || !URL_RE.test(entry.url)) {
    errors.push('`url` (site root URL) must be a valid https URL');
  }

  // Removal payload: just identity + url + action='remove'. No name, no dbs.
  if (entry.action === 'remove') {
    return { ok: errors.length === 0, errors };
  }

  if (!entry.name || typeof entry.name !== 'string') {
    errors.push('`name` (site display name) is required');
  }

  if (!Array.isArray(entry.dbs) || entry.dbs.length === 0) {
    errors.push('`dbs` must be a non-empty array');
    return { ok: false, errors };
  }

  if (entry.dbs.length > config.maxDatabasesPerUser) {
    errors.push(`Too many databases: ${entry.dbs.length} > ${config.maxDatabasesPerUser}`);
  }

  const supportedRigIds = config.supportedRigs.map(r => r.id);
  const rigById = Object.fromEntries(config.supportedRigs.map(r => [r.id, r]));

  entry.dbs.forEach((db, i) => {
    const where = `dbs[${i}]`;
    if (!db || typeof db !== 'object') {
      errors.push(`${where}: not an object`);
      return;
    }
    if (!supportedRigIds.includes(db.rig)) {
      errors.push(`${where}.rig must be one of: ${supportedRigIds.join(', ')}`);
    } else {
      const allowedTypes = rigById[db.rig].types;
      if (!allowedTypes.includes(db.type)) {
        errors.push(`${where}.type must be one of [${allowedTypes.join(', ')}] for rig ${db.rig}`);
      }
    }
    if (!config.supportedDbTypes.includes(db.type)) {
      errors.push(`${where}.type must be one of: ${config.supportedDbTypes.join(', ')}`);
    }
    if (!db.phoneBookUrl || !URL_RE.test(db.phoneBookUrl)) {
      errors.push(`${where}.phoneBookUrl must be a valid https URL`);
    }
    if (db.deltaReady !== undefined && typeof db.deltaReady !== 'boolean') {
      errors.push(`${where}.deltaReady must be a boolean if present`);
    }
  });

  return { ok: errors.length === 0, errors };
}

// Brand-level structural check only. Individual phones inside a brand are
// allowed to be weird. build-aggregate skips bad phones one by one
// while keeping the rest of the db.
export function validatePhoneBookShape(json) {
  const errors = [];
  if (!Array.isArray(json)) {
    return { ok: false, errors: ['phone_book root is not an array'] };
  }
  if (json.length === 0) {
    return { ok: false, errors: ['phone_book is empty'] };
  }
  for (let i = 0; i < json.length; i++) {
    const brand = json[i];
    if (!brand || typeof brand !== 'object') {
      errors.push(`brand[${i}]: not an object`);
      continue;
    }
    if (typeof brand.name !== 'string') errors.push(`brand[${i}].name missing`);
    if (!Array.isArray(brand.phones)) errors.push(`brand[${i}].phones not an array`);
  }
  return { ok: errors.length === 0, errors };
}

export async function checkPhoneBookUrl(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect: 'follow' });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const cors = res.headers.get('access-control-allow-origin');
    let json;
    try {
      json = await res.json();
    } catch (e) {
      return { ok: false, error: 'Response is not valid JSON' };
    }
    const shape = validatePhoneBookShape(json);
    if (!shape.ok) return { ok: false, error: shape.errors.join('; ') };
    return {
      ok: true,
      cors: cors || '(missing)',
      brandCount: json.length,
      phoneCount: json.reduce((n, b) => n + (Array.isArray(b.phones) ? b.phones.length : 0), 0)
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

export async function checkVerifyFile(siteUrl, verifyFileName, expectedGithubUsername, fetchImpl = fetch) {
  const url = siteUrl.replace(/\/+$/, '') + '/' + verifyFileName;
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect: 'follow' });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} at ${url}` };
    const text = (await res.text()).trim();
    if (!ciEquals(text, expectedGithubUsername)) {
      return { ok: false, error: `Expected "${expectedGithubUsername}", got "${text.slice(0, 80)}"` };
    }
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// Full validation: shape + identity + URLs + verify file. Returns a structured report.
// `options.creator` (optional) is the GitHub login of whoever opened the issue.
// When provided, it must match entry.github case-insensitively for identity proof.
// Browser-side use can omit it; workflows always pass it.
export async function fullValidate(entry, config, fetchImpl = fetch, options = {}) {
  const shape = validateShape(entry, config);
  const isRemoval = entry?.action === 'remove';
  const report = {
    ok: shape.ok,
    action: isRemoval ? 'remove' : 'signup',
    shape,
    identity: null,
    registryPresence: null,
    phoneBooks: [],
    verifyFile: null
  };
  if (!shape.ok) return report;

  if (options.creator) {
    const match = ciEquals(options.creator, entry.github);
    report.identity = { ok: match, creator: options.creator, claimed: entry.github };
    if (!match) report.ok = false;
  }

  // For removal: the entry must already exist in the registry. Optional check
  // CLI only runs it when the caller passes the registry.
  if (isRemoval && Array.isArray(options.registry)) {
    const exists = options.registry.some(e => ciEquals(e.github, entry.github));
    report.registryPresence = { ok: exists, github: entry.github };
    if (!exists) report.ok = false;
  }

  // phone_book check is signup-only.
  if (!isRemoval) {
    for (const db of entry.dbs) {
      const r = await checkPhoneBookUrl(db.phoneBookUrl, fetchImpl);
      report.phoneBooks.push({ phoneBookUrl: db.phoneBookUrl, ...r });
      if (!r.ok) report.ok = false;
    }
  }

  const vf = await checkVerifyFile(entry.url, config.verifyFileName, entry.github, fetchImpl);
  report.verifyFile = vf;
  if (!vf.ok) report.ok = false;

  return report;
}

// Build the canonical entry id (= lowercased github username).
export function entryId(entry) {
  return slugify(entry.github);
}
