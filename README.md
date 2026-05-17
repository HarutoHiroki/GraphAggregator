# GraphAggregator

Federated phone_book aggregator for squig-style graph tool sites.

Site: <https://graphaggregator.harutohiroki.com>

Aggregate index: <https://graphaggregator.harutohiroki.com/aggregate-index.json>

## What this is

A single index that lets graphtool sites search across each other's phone_books without each site having to fetch every other site's data on every page load. Anyone can host their own graphtool site on any domain, register here once, and the aggregator does the rest.

## How it works

1. A user fills out the signup form at `/` and submits.
2. The form opens a pre-filled GitHub Issue in this repo. The issue is created under the submitter's GitHub account, which is the identity proof.
3. Automation validates: the issue creator matches the claimed `github` field in the payload, every declared phone_book URL is reachable and well-formed, and the user's site serves `aggregator_verify.txt` containing their GitHub username.
4. The bot posts the validation report and asks the user to review the entry carefully. The user comments `confirm` to commit it, or `cancel` to abort.
5. On `confirm` (re-validated to make sure nothing changed in the meantime), automation opens a PR adding or updating the entry in `registry.json`.
6. On merge, the aggregator rebuilds `aggregate-index.json` and redeploys.

## Files

- `config.json` - caps, rig taxonomy, repo metadata, keyword strings. Source of truth for form + workflows.
- `registry.json` - confirmed federated entries.
- `index.html` + `assets/` - the static signup form (GitHub Pages root).
- `lib/validate.mjs` - shared schema / URL / identity / verify-file validation. Runs in browser and Node.
- `scripts/` - Node scripts the workflows shell out to.
- `.github/workflows/` - issue intake, confirmation, PR opening, aggregate build & deploy.

## Identity model

Two independent identity proofs, both required before the entry lands in `registry.json`:

1. **Issue creator must equal the claimed `github` field.** GitHub itself attests to who opened the issue so it can't be spoofed. The validate workflow rejects any submission where these don't match.
2. **`aggregator_verify.txt` at site root contains the same GitHub username.** Ties the GitHub identity to control of the site being registered. An attacker would need to compromise both a GitHub account and the site itself.

After both pass, the user does a deliberate two-step confirmation by commenting `confirm` (or `cancel`) on the issue (not an identity check, just a checkpoint so the submitter can eyeball the parsed entry one more time before it gets committed).

Any subsequent submission from the same GitHub user replaces their existing entry in `registry.json`. There's no separate edit flow; re-submit the form, confirm again, and the existing entry is overwritten on merge.

## Cancelling a submission

While the issue is still in `unconfirmed` state, the submitter can comment `cancel` to abort. The bot closes the issue and labels it `cancelled`. Once an issue is in a terminal state (`confirmed` or `cancelled`), further `confirm`/`cancel` comments are ignored. Open a new signup to start over.

## Liveness checks and auto-removal

A daily scheduled workflow (`health-check.yml`, 12:00 UTC) tests every registered site:

1. `aggregator_verify.txt` at the site root must still serve the GitHub username.
2. Every declared `phoneBookUrl` must still return a 200 and a valid phone_book.

Behavior:

- **First failure:** the bot files a `[health]` tracking issue tagging the owner with the list of failing endpoints and the auto-removal deadline.
- **Subsequent failures (below the threshold):** the original issue stays open, no new comments.
- **Threshold reached** (default 5 days, configurable via `config.removeAfterUnreachableDays`): the bot opens an auto-removal PR labeled `auto-remove`. A maintainer can merge it, or close it if the site is being repaired imminently. Merging the PR removes the entry from `registry.json` and the next daily build rebuilds `aggregate-index.json` without it.
- **Recovery at any point:** the bot comments on and closes the tracking issue, and also closes any open `auto-remove` PR for that entry.

State is tracked in `health.json` at the repo root. The bot maintains it and pushes directly to `main`. Only currently-unhealthy entries appear in `health.json.entries`; recovered sites are evicted from the file.

Until the health-check workflow lands its first scan, sites that go offline after registration would have silently lingered as ghost entries in `aggregate-index.json` (present in `sites[]`, missing from `dbs[]`/`phones[]`). build-aggregate skips unreachable dbs, so the consumer-facing index stays clean during the threshold window.

## Removing your entry (un-federating)

The form has a "Remove your entry from the registry" section at the bottom. Submitting that opens a removal issue with the same identity proofs required as signup:

1. The issue must be opened from the GitHub account whose entry is being removed (the validate workflow rejects mismatches).
2. `aggregator_verify.txt` must still be served at your site root and contain your GitHub username.
3. The bot posts a validation report and waits for the same `confirm`/`cancel` decision as a normal signup. `confirm` opens a PR that deletes the entry from `registry.json`. Merge triggers a rebuild of `aggregate-index.json` without it.

If your site is no longer reachable, the verify-file check will fail. Restore the file briefly, or open a manual removal request labeled `signup,removal` with the issue body explaining the situation.

Removal issues are tagged with the `removal` label so they're easy to filter in the issues list.

## Issues opened without using the form

The validate workflow handles bad-format issues on its own: if the issue body doesn't contain a valid signup/removal payload between the `<!-- signup-payload -->` markers, the bot leaves a comment pointing the submitter at the official form and closes the issue with an `invalid-format` label.

## Compression flags for `build-aggregate.mjs`

Set as environment variables on the build step (both are optional opt in and just proof of concepts).

- `ELIDE_DERIVABLE_SHARE=1` - Drops the `s` field when it equals `(brand + '_' + name)`.
- `COLLAPSE_PHONES=1` - Collapses identical `(brand, name)` rows into one entry with a `m[]` array of measurements. Changes `phonesFormat` in the output from `flat` to `collapsed`. Consumers must branch on it.

## Consuming the aggregate from your site

`graphAggregator.js` is the full replacement for `squigsites.js` (and my modified bandaid version of it). One script tag gives you the squig-select dropdown, federated search, delta target mods, and the cachebust cookie. All the original stuff, minus the ads, plus the federation.

```html
<script src="https://graphaggregator.harutohiroki.com/graphAggregator.js" defer></script>
```

The client fetches `aggregate-index.json` once per session (cached in `localStorage` for 1 hour). On every keystroke in the existing `input.search`, it filters the entire corpus and renders every match.

### squigsites aggregated by default

The aggregator's build workflow runs `build-aggregate.mjs --squigsites https://squig.link/squigsites.json` on every deploy, so every site in the centralized `squigsites.json` is mirrored into the aggregate alongside federated entries. The client labels squigsites-sourced rows with a small `squigsites` tag in the site header so you can tell them apart, but otherwise they're treated identically.

### Per-site overrides

You can override the aggregator origin (useful for self-hosted forks):

```html
<script>window.GRAPHAGGREGATOR_BASE = 'https://your-fork.example.com';</script>
<script src="https://graphaggregator.harutohiroki.com/graphAggregator.js" defer></script>
```

The script uses the host page's CSS variables (`--background-color-contrast`, `--accent-color`, `--font-color-primary`, etc.) when present and falls back to neutral defaults otherwise.

## GitHub repo setup (one-time, if you want to self host this)

### Workflow permissions

**Settings -> Actions -> General -> Workflow permissions**:

- Select "Read and write permissions"
- Tick "Allow GitHub Actions to create and approve pull requests"

Both are required. `signup-confirm.yml` and `health-check.yml` commit to `registry.json`, push branches, and open PRs on behalf of the bot. None of that works under the default read-only token.

### Pre-create labels

If you don't create these in advance, GitHub auto-creates them on first use with grey defaults. Pre-creating with sensible colors makes the issues list legible.

**Issues -> Labels -> New label**:

| Label              | Suggested color | Used by                                                |
|--------------------|-----------------|--------------------------------------------------------|
| `signup`           | `#0366d6` blue  | Every signup/removal issue (workflow gate label)       |
| `unconfirmed`      | `#fbca04` yellow| Initial state of a fresh signup issue                  |
| `confirmed`        | `#28a745` green | Terminal state after `confirm`                         |
| `cancelled`        | `#6a737d` grey  | Terminal state after `cancel`                          |
| `validation-passed`| `#28a745` green | Set by the validate workflow                           |
| `validation-failed`| `#d73a4a` red   | Set by the validate workflow                           |
| `invalid-format`   | `#d73a4a` red   | Hand-opened issue missing the signup-payload markers   |
| `removal`          | `#d93f0b` orange| User-initiated removal request                         |
| `removed`          | `#d93f0b` orange| PR label after merge for removed entries               |
| `added`            | `#28a745` green | PR label for new signups                               |
| `updated`          | `#1f6feb` blue  | PR label for re-submitted entries                      |
| `auto-remove`      | `#d73a4a` red   | PR opened by the health-check workflow                 |
| `health`           | `#e99695` pink  | Tracking issue for an unreachable federated site       |
| `bug`              | `#d73a4a` red   | Bug-report template                                    |

### Creating a PR token for your PR bots
1. **Mint the token.** Go to <https://github.com/settings/personal-access-tokens/new> and create a fine-grained PAT:
   - Token name: `GraphAggregator workflow PR creator`
   - Expiration: whatever your policy allows (max 1 year for best practice)
   - Repository access: Only select repositories
   - Repository permissions (leave everything else at "No access"):
     - Contents: Read and write
     - Issues: Read and write
     - Pull requests: Read and write
   - Click "Generate token" and copy it once (you can't see it again).
2. **Store it as a repo secret.** Repo Settings -> Secrets and variables -> Actions -> New repository secret:
   - Name: `PR_PAT`
   - Value: paste the token
   - Click **Add secret**.

## Closing statement
Hi there, Haruto here. I'm the sole maintainer of this project, and I built it to scratch my own itch for a federated graphtool ecosystem and to solve a certain lagging issues with the current squiglink implementation. I hope this can be a useful reference implementation for anyone else who wants to build similar federation layers for their own projects. That said, this is a side project that I maintain in my spare time, so please be patient if you open an issue or submit a PR. I'll do my best to respond in a timely manner, but I can't make any guarantees. Thanks for your understanding and interest!