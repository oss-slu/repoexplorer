# Scraping Analysis: `main_scraping.py`

## Purpose

Findings from reading `repofinder`'s `main_scraping.py` and its imports, plus a plan for rebuilding this functionality in RepoExplorer. `repofinder` (UC OSPO) is the source of the parquet files this project currently consumes from S3. Those files haven't updated since February — running `main_scraping.py` locally showed why: after nearly an hour, it was still on the first of 30+ universities.

## Findings

### What it does

`scrape()` loops over university acronyms (e.g. `UCSB`, `UCSC`, `UCSD`) and runs nine steps per university, in sequence:

1. `search_repositories` — search GitHub, write results to JSON
2. `create_and_populate_database` — load JSON into SQLite
3. `search_organizations` → `populate_organizations` — same, for orgs
4. `get_repositories_from_organizations` → `create_and_populate_database` — fetch each org's repos
5. `search_users` → `populate_users` — same, for users
6. `get_repositories_from_users` → `create_and_populate_database` — fetch each user's repos
7. `get_features_data` — per repo, fetch README, license, subscriber count, release downloads, community files
8. `get_organization_data` — per repo, check/fetch owner org details
9. `get_contributor_data` — per repo, fetch contributors, then per-contributor profile details

The next university doesn't start until all nine steps finish.

### The bottleneck

Every API call goes through `github_api_request()` (`repo_scraping_utils.py`), which uses synchronous `requests`. The four files handling per-item data (`get_repo_extras.py`, `get_organizations.py`, `get_contributors.py`, and the org/user repo-fetchers in `repo_scraping_utils.py`) all loop one item at a time, blocking on each call before starting the next.

This compounds fast:
- `get_features_data`: up to 8 sequential calls per repo
- `get_contributor_data`: 1 call to list contributors + 1 more per contributor (20 contributors = 21 calls)
- `get_organization_data`: 1+ call per repo
- Universities themselves run sequentially too

With 30+ universities and hundreds of repos each, the total sequential round-trips explain the long runtimes.

### Unused concurrency already exists

`repo_scraping_utils.py` has a working `process_items_concurrently()` using `ThreadPoolExecutor` + `Semaphore`, and some functions (`get_organization_details`, `get_contributor_details`) already accept a `rate_limiter` param — but it's never actually called anywhere. Every real loop is preceded by `# Process sequentially (no multithreading)`. Concurrency was clearly planned, just never finished being implemented.

## Plan for Rebuilding

**Goal:** scraping time should scale with the slowest call in a batch, not the sum of every call.

1. **Async/await for all GitHub API calls.** Replace `github_api_request()` with an async version using TypeScript's built-in `fetch()`, batched with `Promise.all()` (see PoC). This keeps the rebuild consistent with the rest of RepoExplorer's API, which is TypeScript.
2. **Rate-limit concurrency**, since GitHub enforces both hourly and secondary rate limits — e.g. batching requests in fixed-size groups or using a concurrency-limiting library.
3. **Parallelize across universities** once per-item concurrency is proven — carefully, to avoid tripping rate limits across 30+ at once.
4. **Keep the existing SQLite schema and JSON files unchanged** initially, so this drops in without touching downstream filtering/analysis.
5. **Preserve the existing retry/backoff logic** (exponential backoff, rate-limit sleep-and-retry) in the async version.

**Out of scope:** filtering (`main_filtering.py`) and analysis (`main_analysis.py`, `main_analysis_combined.py`) run entirely on already-scraped local data and make no GitHub calls — unaffected by this plan.

## Proof-of-Concept

`/api/src/scripts/asyncScrapingPoc.ts` runs a scaled-down version of the real scraping pipeline for one university (`SLU`): searching GitHub for matching repositories, organizations, and users, then fetching every found org's/user's repositories — first sequentially, then concurrently with `Promise.all()`, using an authenticated `GITHUB_TOKEN`.

**Result:** ~719.8s (12 minutes) sequential vs. ~9.0s concurrent to fetch 16,000+ owner repositories across 1,682 organizations and users — roughly an **80x speedup**. This is a much closer approximation of real pipeline behavior than a small synthetic sample, and gives a concrete sense of what a fully async rebuild could achieve: work that currently takes over 12 minutes for a single university's owner-repo fetch step alone could plausibly complete in under 10 seconds.