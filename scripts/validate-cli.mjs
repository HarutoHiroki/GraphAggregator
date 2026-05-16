// Validates an entry JSON: shape, identity, phone_books, verify file.
// For action='remove', skips phone_books and additionally checks the entry
// exists in registry.json.
// Usage: node scripts/validate-cli.mjs [--creator <login>] path/to/entry.json
// Writes a markdown report to stdout. Exits 0 on success, 1 on failure.

import { readFileSync } from 'node:fs';
import { fullValidate } from '../lib/validate.mjs';

const args = process.argv.slice(2);
let entryPath = null;
let creator = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--creator') creator = args[++i];
  else if (!entryPath) entryPath = args[i];
}
if (!entryPath) {
  console.error('Usage: validate-cli.mjs [--creator <login>] path/to/entry.json');
  process.exit(2);
}

const entry = JSON.parse(readFileSync(entryPath, 'utf8'));
const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const registry = JSON.parse(readFileSync(new URL('../registry.json', import.meta.url), 'utf8'));

const isRemoval = entry?.action === 'remove';

const report = await fullValidate(entry, config, fetch, {
  creator: creator || undefined,
  registry
});

const lines = [];
const heading = isRemoval ? 'Removal' : 'Signup';
lines.push(`### ${heading} validation for \`${entry.id || entry.github || '(no id)'}\``);
lines.push('');
lines.push(`**Overall:** ${report.ok ? 'pass' : 'fail'}`);
lines.push('');

lines.push('**Shape & caps**');
if (report.shape.ok) {
  lines.push('- ok: schema and caps');
} else {
  for (const err of report.shape.errors) lines.push(`- fail: ${err}`);
}
lines.push('');

if (report.identity !== null) {
  lines.push('**Identity**');
  if (report.identity.ok) {
    lines.push(`- ok: issue opened by @${report.identity.creator}, matches claimed \`${report.identity.claimed}\``);
  } else {
    lines.push(`- fail: issue opened by @${report.identity.creator}, but entry claims \`${report.identity.claimed}\`. Only the claimed GitHub account can submit this entry.`);
  }
  lines.push('');
}

if (isRemoval && report.registryPresence !== null) {
  lines.push('**Existing registry entry**');
  if (report.registryPresence.ok) {
    lines.push(`- ok: \`${report.registryPresence.github}\` is currently registered`);
  } else {
    lines.push(`- fail: no current entry for \`${report.registryPresence.github}\` to remove`);
  }
  lines.push('');
}

lines.push('**Verification file**');
if (report.verifyFile?.ok) {
  lines.push(`- ok: \`${report.verifyFile.url}\` matches GitHub username`);
} else {
  lines.push(`- fail: ${report.verifyFile?.error || 'check skipped (shape failed)'}`);
}
lines.push('');

if (!isRemoval) {
  lines.push('**phone_books**');
  if (report.phoneBooks.length === 0) {
    lines.push('- (none checked)');
  } else {
    for (const pb of report.phoneBooks) {
      if (pb.ok) {
        lines.push(`- ok: \`${pb.phoneBookUrl}\` - ${pb.phoneCount} phones, ${pb.brandCount} brands (CORS: \`${pb.cors}\`)`);
      } else {
        lines.push(`- fail: \`${pb.phoneBookUrl}\` - ${pb.error}`);
      }
    }
  }
  lines.push('');
}

lines.push('---');
if (report.ok) {
  const verb = isRemoval ? 'remove your entry from' : 'commit it to';
  lines.push(
    `All checks passed. **Review the entry above carefully.** When you're ready, ` +
    `comment \`${config.confirmCommentKeyword}\` to ${verb} the registry, ` +
    `or \`${config.cancelCommentKeyword}\` to abort.`
  );
} else {
  lines.push(
    `Fix the issues above by **editing this issue body** (the validator re-runs on edit) ` +
    `and re-check, or comment \`${config.cancelCommentKeyword}\` to abort.`
  );
}

process.stdout.write(lines.join('\n') + '\n');
process.exit(report.ok ? 0 : 1);
