// Extracts the JSON payload from an issue body.
// Usage: cat body.md | node scripts/parse-issue.mjs > entry.json

import { readFileSync } from 'node:fs';

const body = process.argv[2]
  ? readFileSync(process.argv[2], 'utf8')
  : readFileSync(0, 'utf8');

const startMarker = '<!-- signup-payload';
const endMarker = '<!-- /signup-payload -->';

const start = body.indexOf(startMarker);
const end = body.indexOf(endMarker);
if (start === -1 || end === -1 || end < start) {
  console.error('No signup-payload markers found.');
  process.exit(2);
}

const block = body.slice(start, end);
const fenceMatch = block.match(/```json\s*\n([\s\S]*?)```/);
if (!fenceMatch) {
  console.error('No json code fence found between markers.');
  process.exit(2);
}

try {
  const json = JSON.parse(fenceMatch[1]);
  process.stdout.write(JSON.stringify(json, null, 2) + '\n');
} catch (e) {
  console.error('Payload is not valid JSON:', e.message);
  process.exit(2);
}
