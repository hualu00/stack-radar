[English](README.md) | [中文](README.zh-CN.md)

# Stack Radar

A dependency-intelligence CLI for frontend repos. It answers the question Dependabot and `npm-check-updates` cannot: **"is this upgrade worth doing *now*, for *this* project?"**

A rule engine drives every recommendation. AI (opt-in via `--use-ai`) only extracts evidence from changelogs. A local grep checks whether the changed APIs are actually used in your code. Source code is never sent over the network.

## Why it exists

- **Dependabot / `ncu`** answer *"is there a newer version?"*
- **Stack Radar** answers *"should I upgrade now, given what this project actually uses, what's in the changelog, and how the team chose to take risk?"*

The output is a Markdown report bucketed into six recommendations — Upgrade Now / Safe to Upgrade / Review First / Watch / Blocked / Defer — each with a Confidence score and (with `--use-ai`) quoted changelog evidence.

## Pipeline

```
scan          → .stack-radar/stack.json     (deps + lockfile + workspaces)
check-updates → .stack-radar/updates.json   (versions + changelog text + advisories + signals)
recommend     → .stack-radar/reports/<date>.md
                  (3-dim scoring + profile adjustment → Recommendation + Confidence)
                  --use-ai adds AI evidence (→ confidence + report)
                          and code relevance (→ value)
```

Side commands: `init-profile` (draft `project-profile.yaml`), `scan-api-usage` (ad-hoc API-usage counts), `feedback` (snooze/decline/accept), `watch-trends` (independent community radar).

## Requirements

- **Node.js ≥ 20** (declared in [package.json](package.json))
- **Optional: ripgrep** — used by `--use-ai` for fast API-usage grep. If `rg` is not on `PATH`, Stack Radar falls back to a pure-Node implementation with identical semantics.
- **Optional: `GITHUB_TOKEN` or `GH_TOKEN`** — without it, `check-updates` is rate-limited and degrades to CHANGELOG-only for some packages.
- **Optional: `ANTHROPIC_API_KEY`** — required only when you pass `--use-ai` (to `recommend` or `watch-trends`).

## Install & build

Not yet published to npm. Build from source:

```bash
git clone <repo-url> stack-radar
cd stack-radar
npm install
npm run build
```

This compiles TypeScript to `dist/`. Run the CLI as `node dist/cli.js <command>`.

## Quick start

```bash
node dist/cli.js scan          --repo <path-to-your-repo>
node dist/cli.js check-updates --repo <path-to-your-repo>
node dist/cli.js recommend     --repo <path-to-your-repo>
cat <path-to-your-repo>/.stack-radar/reports/*.md
```

For evidence-grounded reports add `--use-ai` to `recommend` (requires `ANTHROPIC_API_KEY`). The first run costs a few cents; re-runs hit the local disk cache and report `API calls: 0`.

## Commands

All commands accept `--repo <path>` (defaults to `.`) and write into `<repo>/.stack-radar/`. Command definitions live in [src/cli.ts](src/cli.ts).

### `scan`

Walks the repo, parses `package.json` (root and workspaces), parses the lockfile (npm / Yarn v1 / Yarn Berry / pnpm), and categorizes dependencies.

```bash
node dist/cli.js scan --repo <path>
```

Writes `.stack-radar/stack.json`.

### `check-updates`

For every dependency in `stack.json`, queries the **public** npm registry, GitHub releases (if `GITHUB_TOKEN` is set), OSV advisories, and extracts changelog text and keyword signals.

```bash
node dist/cli.js check-updates --repo <path>
node dist/cli.js check-updates --repo <path> --refresh   # bypass cache
```

Writes `.stack-radar/updates.json`. Re-run this command after upgrading Stack Radar itself — older `updates.json` files lack fields the newer `recommend` needs.

### `init-profile`

Drafts `.stack-radar/project-profile.yaml` by inferring `product_type`, `tech_taste`, `upgrade_policy`, and `hard_constraints` from the repo. **Every field needs your review** — the generated file starts with a `# NEEDS REVIEW` header.

```bash
node dist/cli.js init-profile --repo <path>
node dist/cli.js init-profile --repo <path> --force   # overwrite an existing profile
```

Edit the file, then **delete the `# NEEDS REVIEW` line** so `recommend` will trust it. While that header is present, `recommend` still runs but prints a warning to stderr (this is deliberate, not a bug).

### `recommend`

Scores `updates.json` along three dimensions (urgency / risk / value), applies profile adjustments, optionally folds in AI evidence and code relevance, and writes a Markdown report.

```bash
node dist/cli.js recommend --repo <path>
node dist/cli.js recommend --repo <path> --use-ai            # AI evidence + code relevance
node dist/cli.js recommend --repo <path> --use-ai --dry-run  # print prompts, no API call
node dist/cli.js recommend --repo <path> --use-ai --refresh  # re-analyze, bypass AI cache
node dist/cli.js recommend --repo <path> --no-profile        # ignore any profile
node dist/cli.js recommend --repo <path> --profile <path>    # explicit profile path
node dist/cli.js recommend --repo <path> --out report.md     # write to a specific path
node dist/cli.js recommend --repo <path> --ai-model <id>     # override model
```

Default report path: `.stack-radar/reports/<YYYY-MM-DD>.md`. Default AI model: `claude-sonnet-4-6`.

### `scan-api-usage`

Counts local usage of specific API identifiers — useful for ad-hoc checks outside the main pipeline.

```bash
node dist/cli.js scan-api-usage --repo <path> --apis useState,useEffect
node dist/cli.js scan-api-usage --repo <path> --apis useState --package react
```

Output is `match_count` and `file_count` only — no file paths, no code snippets.

### `feedback`

Records a decision against a package (and optional semver range). Decisions are remembered by `recommend` on the next run; they affect *presentation*, not the underlying score.

```bash
# snooze (hide until a date)
node dist/cli.js feedback --repo <path> --package react --action snooze --until 2026-12-31

# decline (de-emphasize to Watch unless a new security advisory appears)
node dist/cli.js feedback --repo <path> --package eslint --action decline --reason "team prefers biome"

# accept (mark a recommendation as acknowledged)
node dist/cli.js feedback --repo <path> --package vite --action accept --version-range "5.x"
```

Required: `--package`, `--action`. Snooze additionally requires `--until <YYYY-MM-DD>`. Writes `.stack-radar/decisions.json`.

### `watch-trends`

Independent community radar — polls a hardcoded RSS registry (newsletters and release feeds), uses AI to extract tool names from public titles/summaries, matches against your stack, and writes a watchlist. **Does not affect upgrade scoring.**

```bash
node dist/cli.js watch-trends --repo <path>
node dist/cli.js watch-trends --repo <path> --dry-run    # no API key needed; prints prompts
node dist/cli.js watch-trends --repo <path> --refresh    # re-extract even when cached
```

Writes `.stack-radar/community-watchlist.md` and `.stack-radar/trends.json`. Run **weekly** — that matches newsletter cadence and the ≥2-week Signal gate. Run `scan` first or Signals are disabled (with a loud warning).

## Using AI (opt-in)

AI is **off by default**. Pass `--use-ai` to `recommend` or `watch-trends` and set `ANTHROPIC_API_KEY` to enable it.

- **Default model**: `claude-sonnet-4-6`. Override with `--ai-model <id>`.
- **Cost**: first run on a repo of ~50 packages costs a few cents on Sonnet 4.6. Re-runs hit the local disk cache (`.stack-radar/cache/ai-analyses/`, `.stack-radar/cache/trends-extractions/`) and typically report `API calls: 0`.
- **`--dry-run`** prints prompts without calling the API. No key needed. Nothing written to cache.
- **`--refresh`** bypasses the AI cache and re-analyzes.
- **What AI receives**: package metadata (name, current and latest version) + truncated changelog text + a coarse profile (`product_type`, `tech_taste`). Nothing else.
- **What AI never receives**: your source code. Ever.
- **Anti-fabrication**: every quote returned by the model is validated as a verbatim substring of the changelog it cites; the cited URL must be one we supplied. Quotes that fail validation are dropped and that record is marked low-quality. AI only informs Confidence and the report's Why/Evidence sections — it never changes the Recommendation.

## Project profile

A profile differentiates "this is a customer-facing app" from "this is an internal SDK". Without one, `recommend` falls back to global scoring.

Workflow:

```bash
node dist/cli.js init-profile --repo <path>
# edit .stack-radar/project-profile.yaml
# delete the leading "# NEEDS REVIEW" line
node dist/cli.js recommend --repo <path>
```

The profile affects scoring via five rules (`R1–R5`) — for example, `hard_constraints.node` raises a Blocked recommendation for packages that need a newer Node; `tech_taste: conservative` shifts breaking changes toward Watch; `tech_taste: aggressive` relaxes clean majors. See [PLAN.md](PLAN.md) §8 for the full ruleset.

## Trend watcher

`watch-trends` is a **separate** stream from upgrade scoring. It exists to surface community signal — "is the world moving from X to Y?" — without coupling that noise to your dependency report.

- Polls 11 RSS feeds across 7 publisher groups (JS Weekly, Frontend Focus, This Week in React, VoidZero releases, TanStack, Biome, GitHub Trending JS/TS).
- A *Signal* requires ≥3 publisher groups, ≥2 weeks, ≥2 stories, a match against your stack, and no release-cluster spike.
- Output: `community-watchlist.md` (human-readable) + `trends.json` (incremental store).
- Run weekly. Within-a-day re-runs typically cost nothing because feeds haven't published new items.

## Feedback loop

`feedback` writes a decision keyed by `(package, version_range)`. The next `recommend` run reads these decisions and adjusts presentation:

- **snooze**: hidden from the report and stdout while `today < until`. Resurfaces automatically on the `until` date. Snoozed records also skip AI and relevance scanning.
- **decline**: de-emphasized to **Watch** unless a security advisory is present (in which case the original recommendation is preserved and the record is marked).
- **accept**: marker only — no scoring change. Useful for "we know about this, we'll do it next sprint".

Decisions never change the underlying score — only what shows up in the report.

## Privacy

Stack Radar is built around three rules:

1. **Public npm only.** Queries hit hardcoded `registry.npmjs.org`. If your `.npmrc` points at a private mirror, that mirror is **not** used as a privacy signal — Stack Radar treats it as a mirror, not a source of truth about which packages are private.
2. **Workspace package names are never sent.** Local workspace packages are excluded from registry queries (zero-leak). Internal scopes (e.g. `@yourcompany/...`) may 404 against the public registry, which is the expected behaviour.
3. **AI never sees source code.** With `--use-ai`, only package metadata + changelog text + coarse profile fields are sent. `scan-api-usage` and the relevance grep emit `match_count` and `file_count` only — never paths, never code.

## Output layout

Everything Stack Radar writes lives under `.stack-radar/` and should be gitignored:

```
<repo>/.stack-radar/
├── stack.json                  scan output
├── updates.json                check-updates output
├── project-profile.yaml        init-profile output (you edit this)
├── decisions.json              feedback log
├── trends.json                 watch-trends store (incremental)
├── reports/<YYYY-MM-DD>.md     recommend output
├── community-watchlist.md      watch-trends rendered output
└── cache/
    ├── npm/                    registry responses
    ├── github/                 release/changelog responses
    ├── osv/                    advisory responses
    ├── changelogs/             extracted changelog text
    ├── ai-analyses/            AI extractions (recommend --use-ai)
    └── trends-extractions/     AI extractions (watch-trends)
```

## License

[MIT](package.json)
