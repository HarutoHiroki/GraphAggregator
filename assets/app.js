import {
  validateShape,
  checkPhoneBookUrl,
  checkVerifyFile,
  entryId
} from '../lib/validate.mjs';

const form = document.getElementById('signup');
const dbsContainer = document.getElementById('dbs');
const addDbBtn = document.getElementById('add-db');
const submitBtn = document.getElementById('submit');
const submitHint = document.getElementById('submit-hint');
const submitFallback = document.getElementById('submit-fallback');
const verifyFileBtn = document.getElementById('check-verify-file');
const verifyFileStatus = document.getElementById('verify-file-status');
const verifyFileExample = document.getElementById('verify-file-example');
const previewEl = document.getElementById('entry-json');
const capDisplay = document.getElementById('cap-display');
const template = document.getElementById('db-row-template');

const removeForm = document.getElementById('remove-form');
const removeSubmitBtn = document.getElementById('remove-submit');
const removeSubmitHint = document.getElementById('remove-submit-hint');
const removeSubmitFallback = document.getElementById('remove-submit-fallback');
const removeCheckBtn = document.getElementById('remove-check-verify');
const removeVerifyStatus = document.getElementById('remove-verify-status');
let removeSiteVerified = false;

let config;
const dbVerified = new WeakMap();   // row -> bool
let siteVerified = false;

(async function init() {
  config = await fetch('config.json').then(r => r.json());
  capDisplay.textContent = String(config.maxDatabasesPerUser);
  addDbRow();
  refreshSubmit();
  refreshPreview();
})();

function addDbRow() {
  if (dbsContainer.children.length >= config.maxDatabasesPerUser) return;

  const row = template.content.firstElementChild.cloneNode(true);
  const rigSelect = row.querySelector('select[name="rig"]');
  const typeSelect = row.querySelector('select[name="type"]');

  for (const rig of config.supportedRigs) {
    const opt = document.createElement('option');
    opt.value = rig.id;
    opt.textContent = rig.label;
    rigSelect.append(opt);
  }
  syncTypeOptions(rigSelect, typeSelect);

  rigSelect.addEventListener('change', () => {
    syncTypeOptions(rigSelect, typeSelect);
    invalidateRow(row);
  });
  typeSelect.addEventListener('change', () => invalidateRow(row));
  row.querySelector('input[name="phoneBookUrl"]').addEventListener('input', () => invalidateRow(row));
  row.querySelector('input[name="deltaReady"]').addEventListener('change', () => {
    refreshPreview();
    refreshSubmit();
  });

  row.querySelector('.check-phonebook').addEventListener('click', () => verifyPhoneBook(row));
  row.querySelector('.remove-db').addEventListener('click', () => {
    row.remove();
    refreshSubmit();
    refreshPreview();
  });

  dbsContainer.append(row);
  refreshPreview();
}

function syncTypeOptions(rigSelect, typeSelect) {
  const rig = config.supportedRigs.find(r => r.id === rigSelect.value);
  const previous = typeSelect.value;
  typeSelect.innerHTML = '';
  for (const type of rig.types) {
    const opt = document.createElement('option');
    opt.value = type;
    opt.textContent = type;
    typeSelect.append(opt);
  }
  if (rig.types.includes(previous)) typeSelect.value = previous;
}

function invalidateRow(row) {
  dbVerified.set(row, false);
  const s = row.querySelector('.status');
  s.textContent = 'not checked';
  s.className = 'status';
  refreshSubmit();
  refreshPreview();
}

async function verifyPhoneBook(row) {
  const url = row.querySelector('input[name="phoneBookUrl"]').value.trim();
  const s = row.querySelector('.status');
  if (!url) {
    s.textContent = 'enter a URL first';
    s.className = 'status err';
    return;
  }
  s.textContent = 'checking...';
  s.className = 'status';
  const r = await checkPhoneBookUrl(url);
  if (r.ok) {
    s.textContent = `ok - ${r.phoneCount} phones across ${r.brandCount} brands (CORS: ${r.cors})`;
    s.className = 'status ok';
    dbVerified.set(row, true);
  } else {
    s.textContent = `failed: ${r.error}`;
    s.className = 'status err';
    dbVerified.set(row, false);
  }
  refreshSubmit();
}

async function verifySiteFile() {
  const formData = readForm();
  if (!formData.url || !formData.github) {
    verifyFileStatus.textContent = 'fill GitHub username and site URL first';
    verifyFileStatus.className = 'status err';
    return;
  }
  verifyFileStatus.textContent = 'checking...';
  verifyFileStatus.className = 'status';
  const r = await checkVerifyFile(formData.url, config.verifyFileName, formData.github);
  if (r.ok) {
    verifyFileStatus.textContent = `ok ${r.url}`;
    verifyFileStatus.className = 'status ok';
    siteVerified = true;
  } else {
    verifyFileStatus.textContent = `failed: ${r.error}`;
    verifyFileStatus.className = 'status err';
    siteVerified = false;
  }
  refreshSubmit();
}

function readForm() {
  const fd = new FormData(form);
  const dbs = Array.from(dbsContainer.children).map(row => ({
    rig: row.querySelector('select[name="rig"]').value,
    type: row.querySelector('select[name="type"]').value,
    phoneBookUrl: row.querySelector('input[name="phoneBookUrl"]').value.trim(),
    deltaReady: row.querySelector('input[name="deltaReady"]').checked
  }));
  return {
    github: (fd.get('github') || '').trim(),
    name: (fd.get('name') || '').trim(),
    url: (fd.get('url') || '').trim().replace(/\/+$/, ''),
    dbs
  };
}

function buildEntry() {
  const raw = readForm();
  return {
    id: entryId(raw),
    github: raw.github,
    name: raw.name,
    url: raw.url,
    dbs: raw.dbs.map(db => ({
      id: `${entryId(raw)}:${db.type.toLowerCase()}:${db.rig}`,
      siteId: entryId(raw),
      rig: db.rig,
      type: db.type,
      phoneBookUrl: db.phoneBookUrl,
      deltaReady: db.deltaReady
    }))
  };
}

function refreshPreview() {
  const entry = buildEntry();
  previewEl.textContent = JSON.stringify(entry, null, 2);
  const formData = readForm();
  if (formData.url) {
    verifyFileExample.textContent = `${formData.url}/${config.verifyFileName}`;
  }
}

function allDbsVerified() {
  const rows = Array.from(dbsContainer.children);
  if (rows.length === 0) return false;
  return rows.every(row => dbVerified.get(row) === true);
}

function refreshSubmit() {
  const entry = buildEntry();
  const shape = validateShape(entry, config);
  const canSubmit = shape.ok && siteVerified && allDbsVerified();
  submitBtn.disabled = !canSubmit;

  if (!shape.ok) {
    submitHint.textContent = shape.errors[0];
  } else if (!siteVerified) {
    submitHint.textContent = `Verify aggregator_verify.txt on your site root.`;
  } else if (!allDbsVerified()) {
    submitHint.textContent = `Verify every phone_book URL.`;
  } else {
    submitHint.textContent = `Ready. Submit opens a pre-filled GitHub Issue in ${config.registryRepo}.`;
  }
}

function buildIssueUrl(entry, mode) {
  const [owner, repo] = config.registryRepo.split('/');
  const isRemoval = mode === 'remove';
  const verb = isRemoval ? 'remove your entry from' : 'commit it to';

  const body = [
    '<!-- signup-payload',
    'Do not edit between these markers. Automation reads this block.',
    '-->',
    '```json',
    JSON.stringify(entry, null, 2),
    '```',
    '<!-- /signup-payload -->',
    '',
    `@${entry.github} after the bot posts the validation report below, **review carefully**.`,
    '',
    `When you're sure, comment \`${config.confirmCommentKeyword}\` to ${verb} the registry.`,
    `If you change your mind at any time, comment \`${config.cancelCommentKeyword}\` to abort.`
  ].join('\n');

  const titlePrefix = isRemoval ? '[removal]' : '[signup]';
  const labels = isRemoval ? 'signup,unconfirmed,removal' : 'signup,unconfirmed';

  const params = new URLSearchParams({
    title: `${titlePrefix} ${entry.id || entry.github}`,
    labels,
    body
  });
  return `https://github.com/${owner}/${repo}/issues/new?${params.toString()}`;
}

// Opens the issue URL in a new tab. If a popup blocker prevents that, render a
// clickable fallback link so the user can complete the submission manually.
function openIssue(url, fallbackEl) {
  fallbackEl.style.display = 'none';
  fallbackEl.textContent = '';
  const win = window.open(url, '_blank', 'noopener');
  if (!win) {
    fallbackEl.innerHTML = 'Popup blocked. ';
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Click here to open the GitHub issue';
    fallbackEl.append(link);
    fallbackEl.append(' instead.');
    fallbackEl.style.display = 'block';
  }
}

form.addEventListener('input', () => {
  refreshPreview();
  refreshSubmit();
});
addDbBtn.addEventListener('click', addDbRow);
verifyFileBtn.addEventListener('click', verifySiteFile);
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const entry = buildEntry();
  openIssue(buildIssueUrl(entry, 'signup'), submitFallback);
});

// ---- Removal form ----

function readRemoveForm() {
  const fd = new FormData(removeForm);
  return {
    github: (fd.get('github') || '').trim(),
    url: (fd.get('url') || '').trim().replace(/\/+$/, '')
  };
}

function buildRemovalEntry() {
  const raw = readRemoveForm();
  return {
    id: entryId(raw),
    action: 'remove',
    github: raw.github,
    url: raw.url
  };
}

function refreshRemoveSubmit() {
  const { github, url } = readRemoveForm();
  const ghOk = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(github);
  const urlOk = /^https:\/\/[^\s/$.?#].[^\s]*$/i.test(url);
  const canSubmit = ghOk && urlOk && removeSiteVerified;
  removeSubmitBtn.disabled = !canSubmit;

  if (!ghOk) removeSubmitHint.textContent = 'Enter a valid GitHub username.';
  else if (!urlOk) removeSubmitHint.textContent = 'Enter a valid https site URL.';
  else if (!removeSiteVerified) removeSubmitHint.textContent = 'Verify your aggregator_verify.txt file to enable removal.';
  else removeSubmitHint.textContent = `Ready. Submit opens a pre-filled GitHub Issue in ${config.registryRepo}.`;
}

async function verifyRemoveSiteFile() {
  const { github, url } = readRemoveForm();
  if (!github || !url) {
    removeVerifyStatus.textContent = 'fill GitHub username and site URL first';
    removeVerifyStatus.className = 'status err';
    return;
  }
  removeVerifyStatus.textContent = 'checking...';
  removeVerifyStatus.className = 'status';
  const r = await checkVerifyFile(url, config.verifyFileName, github);
  if (r.ok) {
    removeVerifyStatus.textContent = `ok ${r.url}`;
    removeVerifyStatus.className = 'status ok';
    removeSiteVerified = true;
  } else {
    removeVerifyStatus.textContent = `failed: ${r.error}`;
    removeVerifyStatus.className = 'status err';
    removeSiteVerified = false;
  }
  refreshRemoveSubmit();
}

removeForm.addEventListener('input', () => {
  removeSiteVerified = false;
  removeVerifyStatus.textContent = 'not checked';
  removeVerifyStatus.className = 'status';
  refreshRemoveSubmit();
});
removeCheckBtn.addEventListener('click', verifyRemoveSiteFile);
removeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const entry = buildRemovalEntry();
  openIssue(buildIssueUrl(entry, 'remove'), removeSubmitFallback);
});
refreshRemoveSubmit();
