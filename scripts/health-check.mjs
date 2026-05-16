// Daily liveness check for federated sites.
//
// For each entry in registry.json, fetches aggregator_verify.txt and every
// phoneBookUrl. Tracks consecutive failures in health.json. Files a tracking
// issue on first failure; queues an auto-removal PR after the configured
// threshold of unreachable days; closes the issue (and any open auto-removal
// PR) when the site recovers.
//
// Side effects:
//   - Updates health.json in the working tree (workflow commits it).
//   - Opens/comments/closes GitHub issues via `gh` CLI.
//   - Closes auto-remove PRs when the site recovers.
//   - For each queued removal, writes /tmp/auto-removals/<id>.json plus a
//     /tmp/auto-removals/<id>.body.md for the PR body. The workflow loops over
//     these to actually open the PRs (needs git ops in a clean working tree).
//
// Requires env: GH_TOKEN (the workflow injects ${{ secrets.GITHUB_TOKEN }}).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  checkPhoneBookUrl,
  checkVerifyFile,
  entryId
} from '../lib/validate.mjs';

const config = JSON.parse(readFileSync('config.json', 'utf8'));
const registry = JSON.parse(readFileSync('registry.json', 'utf8'));

const REMOVE_AFTER_DAYS = config.removeAfterUnreachableDays ?? 5;
const REPO = config.registryRepo;
const HEALTH_PATH = 'health.json';

const oldHealth = existsSync(HEALTH_PATH)
  ? JSON.parse(readFileSync(HEALTH_PATH, 'utf8'))
  : { entries: {} };

const now = Date.now();
const DAY_MS = 86_400_000;

mkdirSync('/tmp/auto-removals', { recursive: true });

function gh(cmd) {
  try {
    return execSync(`gh ${cmd}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const stderr = e.stderr?.toString?.() || e.message;
    console.error(`gh failed: ${cmd}\n${stderr}`);
    return null;
  }
}

// Look up existing open auto-remove PRs so we don't queue duplicates.
const openAutoRemovePRTitles = new Set();
const prListJson = gh(`pr list --repo ${REPO} --label auto-remove --state open --json title,number`);
let openAutoRemovePRs = [];
if (prListJson) {
  try {
    openAutoRemovePRs = JSON.parse(prListJson);
    for (const p of openAutoRemovePRs) openAutoRemovePRTitles.add(p.title);
  } catch {
    // ignore parse error; treat as no open PRs
  }
}

function closeRecoveredAutoRemovePR(id) {
  const expectedTitle = `auto-remove: ${id}`;
  for (const pr of openAutoRemovePRs) {
    if (pr.title === expectedTitle) {
      writeFileSync('/tmp/health-pr-recovery.md', `\`${id}\` is reachable again. Closing this auto-removal PR.`);
      gh(`pr comment ${pr.number} --repo ${REPO} --body-file /tmp/health-pr-recovery.md`);
      gh(`pr close ${pr.number} --repo ${REPO}`);
    }
  }
}

function closeRecoveredIssue(id, issueNumber) {
  writeFileSync('/tmp/health-issue-recovery.md', `\`${id}\` is reachable again. Closing this health alert.`);
  gh(`issue comment ${issueNumber} --repo ${REPO} --body-file /tmp/health-issue-recovery.md`);
  gh(`issue close ${issueNumber} --repo ${REPO}`);
}

function openNotificationIssue(id, entry, failures, firstFailureAt) {
  const lines = [
    `@${entry.github} your federated site is failing health checks.`,
    '',
    '**Failing endpoints:**',
    ...failures.map(f => `- \`${f.url}\` - ${f.error}`),
    '',
    `**First detected:** ${firstFailureAt}`,
    `**Auto-removal:** if not resolved within **${REMOVE_AFTER_DAYS} days**, this entry will be automatically removed from the registry.`,
    '',
    `The next health check runs in about 24 hours. The bot will close this issue automatically once your site is reachable again.`,
    '',
    `To remove the entry yourself before then, use the form's "Remove your entry" section at ${config.siteUrl}.`
  ].join('\n');
  writeFileSync('/tmp/health-issue-open.md', lines);
  const out = gh(`issue create --repo ${REPO} --title "[health] ${id} unreachable" --label "health" --body-file /tmp/health-issue-open.md`);
  if (!out) return null;
  const m = out.match(/\/issues\/(\d+)/);
  return m ? Number(m[1]) : null;
}

function queueAutoRemoval(id, entry, issueNumber, firstFailureAt) {
  const removalEntry = { id, action: 'remove', github: entry.github, url: entry.url };
  writeFileSync(`/tmp/auto-removals/${id}.json`, JSON.stringify(removalEntry));

  const body = [
    `Automated removal: \`${id}\` has been unreachable for over ${REMOVE_AFTER_DAYS} days.`,
    '',
    issueNumber ? `Tracking issue: #${issueNumber}` : `(No tracking issue was opened.)`,
    `First failure detected: ${firstFailureAt}`,
    '',
    `Merge this PR to remove the entry from \`registry.json\`. The aggregate index will rebuild without it on next deploy.`,
    '',
    `If the site has since been restored, close this PR. The next health check will close the tracking issue.`
  ].join('\n');
  writeFileSync(`/tmp/auto-removals/${id}.body.md`, body);
}

const newEntries = {};
const queuedRemovalIds = [];

for (const entry of registry) {
  const id = entry.id || entryId(entry);
  const failures = [];

  const vf = await checkVerifyFile(entry.url, config.verifyFileName, entry.github);
  if (!vf.ok) {
    failures.push({ kind: 'verify-file', url: `${entry.url}/${config.verifyFileName}`, error: vf.error });
  }

  for (const db of entry.dbs || []) {
    const r = await checkPhoneBookUrl(db.phoneBookUrl);
    if (!r.ok) {
      failures.push({ kind: 'phone_book', url: db.phoneBookUrl, error: r.error });
    }
  }

  const prev = oldHealth.entries?.[id];

  if (failures.length === 0) {
    if (prev?.issueNumber) closeRecoveredIssue(id, prev.issueNumber);
    closeRecoveredAutoRemovePR(id);
    continue;
  }

  const firstFailureAt = prev?.firstFailureAt || new Date(now).toISOString();
  let issueNumber = prev?.issueNumber || null;

  if (!issueNumber) {
    issueNumber = openNotificationIssue(id, entry, failures, firstFailureAt);
  }

  const daysFailing = (now - new Date(firstFailureAt).getTime()) / DAY_MS;
  if (daysFailing >= REMOVE_AFTER_DAYS) {
    if (openAutoRemovePRTitles.has(`auto-remove: ${id}`)) {
      console.log(`Auto-remove PR already open for ${id}; skipping queue.`);
    } else {
      queueAutoRemoval(id, entry, issueNumber, firstFailureAt);
      queuedRemovalIds.push(id);
    }
  }

  newEntries[id] = {
    firstFailureAt,
    lastFailureAt: new Date(now).toISOString(),
    daysFailing: Math.round(daysFailing * 10) / 10,
    failingUrls: failures.map(f => f.url),
    issueNumber
  };
}

writeFileSync(HEALTH_PATH, JSON.stringify({
  lastCheckAt: new Date(now).toISOString(),
  removeAfterDays: REMOVE_AFTER_DAYS,
  entries: newEntries
}, null, 2) + '\n');

writeFileSync('/tmp/auto-removals/list.txt', queuedRemovalIds.join('\n'));

console.log(
  `Checked ${registry.length} entries: ${Object.keys(newEntries).length} unhealthy, ` +
  `${queuedRemovalIds.length} queued for auto-removal.`
);
