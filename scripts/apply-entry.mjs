// Applies an entry to registry.json. Three modes:
//   - default signup: add new, or replace existing entry keyed by GitHub
//     username (case-insensitive).
//   - action='remove': delete the existing entry. Exits non-zero if no entry
//     for that user is present.
// Writes the action taken (added | updated | removed) to stdout so the workflow
// can use it in the PR title.
//
// Usage: node scripts/apply-entry.mjs path/to/entry.json

import { readFileSync, writeFileSync } from 'node:fs';
import { entryId, ciEquals } from '../lib/validate.mjs';

const entryPath = process.argv[2];
if (!entryPath) {
  console.error('Usage: apply-entry.mjs path/to/entry.json');
  process.exit(2);
}

const entry = JSON.parse(readFileSync(entryPath, 'utf8'));
const registryPath = new URL('../registry.json', import.meta.url);
const registry = JSON.parse(readFileSync(registryPath, 'utf8'));

const existingIdx = registry.findIndex(e => ciEquals(e.github, entry.github));
let action;

if (entry.action === 'remove') {
  if (existingIdx < 0) {
    console.error(`No existing entry for "${entry.github}" - nothing to remove.`);
    process.exit(1);
  }
  registry.splice(existingIdx, 1);
  action = 'removed';
} else {
  entry.id = entryId(entry);
  if (existingIdx >= 0) {
    registry[existingIdx] = entry;
    action = 'updated';
  } else {
    registry.push(entry);
    action = 'added';
  }
}

registry.sort((a, b) => String(a.id).localeCompare(String(b.id)));
writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
process.stdout.write(action + '\n');
