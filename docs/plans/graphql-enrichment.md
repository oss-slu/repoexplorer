# GraphQL batching for repository enrichment

Status: implemented on `feature/reduce-api-costs`, including the SnT parity fixes (transcoded blobs, README truncation, 1,000-entry listings) and conditional contributor reads. Awaiting review.

## Goal

A first-time scrape used about 6–11 REST core requests per repository: the repository resource, `/readme`, paginated `/releases`, paginated `/contributors`, `/community/profile`, a root `/contents` listing, and one read per community file found. The ETag gate and directory index already made recurring runs cheap. This change moves first-time file and release reads into the separate `graphql` quota. Core cost becomes the ETag check plus contributor pages, the floor for data GraphQL does not expose.

## Flow

1. **ETag gate (unchanged, REST).** `refreshRepositoryMetadata` sends the saved ETag. A `304` is free and skips enrichment. A `200` supplies the full repository resource, including `subscribers_count`.
2. **Snapshot (GraphQL, batched).** `RepositoryGraphQLBatcher` collects concurrent repositories for up to 100 ms, or until 25 accumulate, and sends one query. For each repository it fetches `databaseId`, the default-branch commit OID, the root, `.github` and `docs` trees, the root `README.md` blob (the one read nearly every repository needs), and `releases(first: 100) { releaseAssets(first: 100) { downloadCount } }`.
3. **Object reads (GraphQL, batched).** README, community, security and template reads become `object(expression: "<commit-oid>:<path>")` lookups. They are batched across repositories (up to 50 per query) and pinned to the snapshot commit. Trees loaded in this phase inline their blobs, so a template directory takes one round trip.
4. **Contributors (REST, conditional).** Run in parallel with steps 2–3. A saved single-page list is revalidated with its ETag; see Conditional contributor reads.
5. **REST delegation.** `GraphQLRepositoryReader` implements the same reader interface as `RestRepositoryReader`. Any read GraphQL cannot answer exactly is delegated to the REST method for that read, so REST semantics and errors apply unchanged.

Selection: `createEnrichmentOptions(client, configuration.enrichmentApi)` returns a batcher only for an authenticated client when `enrichmentApi` is not `rest`, because GraphQL rejects anonymous requests. Both `runScraping` and `runCollection` create one batcher per university enrichment phase. Batch size is bounded by `repositoryConcurrency` (default 4).

## Field sources

| `RepositoryScrapingRecord` field | Before | Now | Notes |
| --- | --- | --- | --- |
| `university`, `scrapedAt`, `busFactor`, `affiliationPredictionGpt5Mini`, `typePredictionGpt5Mini` | Local | Local | Unchanged. |
| `id`, `fullName`, `owner`, `license`, `language`, `htmlUrl`, `description`, `fork`, `createdAt`, `updatedAt`, `pushedAt`, `homepage`, `size`, `stargazersCount`, `watchersCount`, `watchers`, `forksCount`, `openIssuesCount`, `organization`, `subscribersCount` | REST repository resource | REST repository resource (the ETag gate's `200` body) | Kept on REST on purpose: the gate already pays for this body, and GraphQL equivalents differ. `issues(states: OPEN).totalCount` excludes pull requests while `open_issues_count` includes them, `licenseInfo` is not REST's `license.spdx_id`, and `diskUsage` is not documented as identical to `size`. `watchers { totalCount }` equals `subscribers_count` but adds nothing once the gate response is in hand. |
| `readme` | REST `/readme` | GraphQL blob when unambiguous, else REST `/readme` | See README resolution. |
| `releaseDownloads` | REST `/releases` (all pages) | GraphQL `releases`/`releaseAssets.downloadCount` sum, else REST | REST when releases or any release's assets exceed 100. |
| `contributors`, `contributorCount` | REST `/contributors` | REST `/contributors`, or the published list after a `304` | GraphQL has no contributor list. |
| `codeOfConductFile`, `contributing`, `pullRequestTemplate` | REST `/community/profile` reference, then REST contents/raw reads (forks: directory detection) | Profile emulated from the trees, content from GraphQL blobs; forks keep directory detection with GraphQL listings | See community profile. |
| `issueTemplates` | Profile reference, else directory search of `.github/ISSUE_TEMPLATE`, `ISSUE_TEMPLATE`, `docs/ISSUE_TEMPLATE` | Same rules over GraphQL trees and inlined blobs | Output format unchanged (JSON array of `{path, content}`). |
| `securityPolicy` | Listing-gated raw reads of `SECURITY.md`, `.github/SECURITY.md`, `docs/SECURITY.md` | Same order over GraphQL trees and blobs | Symlinked `SECURITY.md` uses REST, which resolves the target. |

## Semantic differences and how each is handled

**README resolution.** REST `/readme` returns GitHub's preferred README. GitHub documents the `.github`, root, `docs` search order but not the choice among variants in one directory (`README.md` vs `README.zh.md`). GraphQL answers in two cases only: no README-named file (`/^readme(\..*)?$/i`, file or symlink) in any of those directories, giving `null`; or exactly one, a regular file in the root whose blob passes the file-content checks below. Every other layout, including docs-only and `.github` READMEs, uses REST `/readme`. So does a root README whose blob fails those checks: REST `/readme` truncates raw content at 512,000 bytes, while a raw `/contents` read returns the whole file (observed on `sntaoirsntioea/kkndme`, 857,065 bytes, and `sntntn/ethereum-org-website`, 551,279 bytes). Live, 3 of 75 `oss-slu` repositories took this path.

**Community profile (non-forks).** REST's `/community/profile` rules are undocumented, so the emulation is based on observed behavior:
- Files only. Template directories (`.github/PULL_REQUEST_TEMPLATE/`, `.github/ISSUE_TEMPLATE/`) are not reported. Observed live on `oss-slu/handbook_tech_lead`, `oss_dev_analytics` and `oss-slu.github.io`. The first implementation accepted directories, and the live parity run caught it.
- `-` and `_` are interchangeable (`docs/CODE-OF-CONDUCT.md`, `.github/pull_request-template.md` were detected live).
- Precedence is `.github`, root, `docs`, following GitHub's documented order for community health files.
- Accepted names are the stem with no extension or `.md`. Any other extension, a symlink, or two matches in the winning directory uses REST `/community/profile`.

Not verified: whether the REST profile reports default community health files inherited from the owner's `.github` repository. The emulation never does. No `oss-slu` repository showed a difference, but the sample is one organization; recheck on a larger university before relying on it.

**Forks.** Unchanged rule: directory detection over the root and `.github` listings (root names first). It runs on GraphQL trees instead of REST listings.

**Release pagination beyond 100.** If `releases.pageInfo.hasNextPage` or any `releaseAssets.pageInfo.hasNextPage` is true, the whole release total comes from REST `/releases` pagination. One live repository did this. Drafts follow the token's visibility on both APIs.

**File content.** GraphQL `Blob.text` is used only for a regular file (mode not `120000`, not a submodule) with `isBinary === false`, `isTruncated === false` and non-null text. Its UTF-8 length must also equal `byteSize`: GitHub transcodes UTF-16 and other non-UTF-8 files into `text`, while REST returns the stored bytes, which `Response.text()` decodes as UTF-8 with replacement characters (observed on three UTF-16 READMEs in SnT, for example `sntrantan/DSA`: 16 bytes, 8 transcoded characters). A leading U+FEFF is removed to match REST raw reads, whose `Response.text()` drops a UTF-8 BOM. Binary, truncated (over 512,000 bytes), transcoded, symlinked or missing blobs use the REST raw read for that path.

**Directory listings.** GraphQL tree entries map to REST types: `tree` → `dir`, `blob` mode `120000` → `symlink`, `commit` → `submodule`. Symlinks and submodules stay out of `entries` but remain in `paths`, as before. REST contents listings may report a submodule as `file` (not rechecked here), while GraphQL reports `commit`. This only matters for a submodule named like a community file or inside a template directory. REST contents listings stop at 1,000 entries, and `/readme` searches only those: `saintgo7/01-prg-app-web` has 1,994 root entries and a `README.md` past the first 1,000, so REST returns `404`. A GraphQL tree with more than 1,000 entries is therefore listed through REST, and README and community-profile emulation use REST whenever any of the `.github`, root or `docs` listings came from REST. Entry order is GraphQL tree order; the fake test server and the live run assume it matches REST order, and the live parity check found no ordering differences.

**Snapshot consistency.** REST issues independent requests against the moving default branch. GraphQL object reads are pinned to the commit OID from the snapshot query; only the snapshot's own trees resolve `HEAD` in that same query.

**Empty repositories.** A null default branch means no files. Listings, README and community files are `null`, matching REST's `404` for contents on an empty repository.

## Error mapping

| GraphQL outcome | Handling | REST policy that applies |
| --- | --- | --- |
| Error whose `path` starts with the repository alias, a null repository, or a `databaseId` that differs from the candidate | The reader requests the REST repository resource once. | Its `404` → skip `repository_unavailable_404`; structured ToS `403` → skip `github_tos_block`; `451` → skip `github_legal_restriction`; other errors are fatal. A `200` continues the repository entirely through REST, so nested `404`/ToS/`451` rows apply as before. |
| Error under one object alias (`r<i>.f<j>`) | That read uses REST. | Same as the REST read. |
| HTTP `200` with `errors[].type === 'RATE_LIMITED'` | Client treats it as a rate limit: primary pauses the `graphql` bucket until `x-ratelimit-reset`; a secondary-limit message pauses every bucket. Retried within the rate-limit budget. | Quota exhaustion stays fatal after the budget, with diagnostics `bucket: 'graphql'`. |
| HTTP `403`/`429` with quota evidence on `/graphql` | Existing rate-limit logic; bucket from `x-ratelimit-resource: graphql`. | Same. |
| `408`/`5xx`, network timeout, invalid JSON, or an unattributed error with no validation code | Client retries transiently; the batcher then halves the batch. A single repository that still fails is read through REST. | REST rows for that repository. |
| Validation error (`extensions.code`), `401`, other `403` | Fatal `GitHubGraphQLError` (diagnostic category `graphql-query-rejected`) or `GitHubRequestError`. | Fails the university, as unexpected REST errors do. |

The contributor size-limit skip is unchanged because contributors stay on REST.

## Conditional contributor reads

After the repository ETag gate, a modified repository's only remaining core cost was `GET /repos/{o}/{r}/contributors`. The finder now saves a contributor ETag in `repository_scraping_cache.contributors_etag` (staged in `repository_scraping_run_repositories.contributors_etag`, added by the repeatable `repository-scraping-checkpoints.sql`). Discovery and refresh attach it to the candidate together with the published `contributors` list, and the first contributor page is sent with `If-None-Match`. A `304` reuses the published list.

Multi-page rule. A first-page `304` proves only that page 1 is unchanged. Page 2 can change on its own, and a full page 1 can stay byte-identical while a 101st contributor appears on page 2. An ETag is therefore saved only for a list that fits in one page with fewer than 100 entries (`per_page=100`). Then the whole list is in that body, so any added, removed or recounted contributor changes its ETag. Full or multi-page lists save no contributor ETag and are reread in full. A cached list of 100 or more is never sent conditionally. Storing every page's ETag was rejected: page boundaries shift when page 1 changes, and UW–Madison needed only 3 contributor pages beyond the first across 590 repositories.

Other rules:
- Each published record overwrites the contributor ETag, clearing it when the new list is not reusable, so a stale ETag cannot later revalidate an older list.
- Stored lists that are not a JSON array of logins (legacy Python-style text) are not reused.
- `204` (empty repository) is handled as before. Its ETag is kept if GitHub sends one.
- A conditional request that returns the size-limit `403` is still skipped as `github_contributors_unavailable`, and nothing is published for it.
- Migrated rows start with `NULL` and read contributors once unconditionally. Until an existing database has the column, preflight reports `missing-columns`.

Measured on 2026-11-02 against `oss-slu` (75 repositories), using a throwaway Compose database (`repoexplorer-contrib-etag-test`) and the same token. Requests were counted in-process by a fetch preload, because another session was using the same token's core quota at the same time. To make every repository look modified, each refresh first cleared the saved repository ETags.

| Run | Repository resources | Contributor requests | Core requests (billable) | GraphQL queries | Elapsed |
| --- | --- | --- | --- | --- | --- |
| Full, seeds ETags | 75 × `200` | 78 × `200` | 159 (159) | 192 | 47 s |
| Refresh, contributor ETags kept | 75 × `200` | 73 × `304`, 5 × `200` | 158 (85) | 189 | 40 s |
| Refresh, contributor ETags cleared (previous behavior) | 75 × `200` | 78 × `200` | 158 (158) | 184 | 42 s |

The full run saved contributor ETags for 73 of 75 repositories. The other 2 have 100 or more contributors (215 at most) and need three further pages between them. Billable core requests for modified repositories fell from 2.1 to 1.13 per repository (−46%). The rest are the repository resources, the large lists, 3 README and 1 release REST fallbacks. All 75 published contributor lists were identical after each refresh, and the unconditional baseline returned the same lists, so the reused lists were current. The migration was rehearsed on the same database: dropping both columns and running `repository-scraping.sql` twice added them back in fresh-volume column order, and the second run was a no-op.

`304` cost is GitHub's documented rule for authenticated conditional requests. The concurrent session made the quota counter unusable for a direct check: core usage rose by 180–229 over 14 s windows whether or not the probe was sending requests.

## Request client changes

- `RateLimitBucket` adds `graphql`; `pause('all')`, queue waits, progress events and the CLI renderer include it.
- `request()` accepts `method: 'POST'` and `body`, only for the GraphQL endpoint (`/graphql`, or `/api/graphql` beside a GHES `/api/v3` base). `GitHubRequestError.method` reflects the method.
- `client.graphql(query, variables)` returns `{ data, errors }` for attributable errors and throws `GitHubGraphQLError` for unattributable envelopes. Error messages are not retained.
- `client.isAuthenticated()` gates GraphQL selection.

## Verification

Unit and integration-free checks (`find/`): `npm test` (406 passed, 13 skipped), `npm run typecheck`, `npm run lint`, all passing.

- `src/tests/enrichRepositoryGraphQL.test.ts`: 28 REST-vs-GraphQL parity scenarios mirroring the existing enrichment fixtures (community files, directory templates, forks, symlinked and docs `SECURITY.md`, README variants, BOM, binary README, UTF-16 README and community file, README and community file over 512,000 bytes, README past the first 1,000 root entries, nested template directories, more than 100 releases or assets, empty repository, live-observed profile rules). Plus call counts (each repository makes exactly the ETag check and contributors in core, with every GraphQL query shared by the batch), 404/ToS/451 mapping, REST continuation, `databaseId` mismatch, batch splitting, query rejection, `401`/`403`, the contributor skip, and option selection.
- `src/tests/fakeGitHubRepository.ts`: one repository model served over both REST and GraphQL, including discovery searches, UTF-16 storage, the 512,000-byte text limits and the 1,000-entry listing limit. Reverting each SnT fix fails at least one of the new scenarios.
- `src/tests/enrichmentWiring.test.ts`: `runCollection` and `runScraping` read file content through GraphQL for an authenticated client, and through REST for an anonymous client or `enrichmentApi: 'rest'`. Removing the batcher argument from `runScraping` makes it fail.
- `src/tests/githubGraphQL.test.ts`: POST envelope, GHES path, safe unattributed errors, `RATE_LIMITED` wait isolated to `graphql`, budget exhaustion diagnostics, secondary limit pausing all buckets, zero-remaining pause.

Live checks on 2026-11-02 with a personal GitHub CLI token (artifacts in ignored `find/reports/graphql-batching/`):

| Run | Repositories | Core requests | GraphQL | Elapsed | Result |
| --- | --- | --- | --- | --- | --- |
| Parity, REST path (`…194342Z-oss-slu-parity-2`) | 75 (`oss-slu`, including forks) | 816 (10.9 per repository) | none | 64 s | Baseline |
| Parity, GraphQL path (same run) | 75 | 158 (2.1 per repository; 4 REST fallbacks: 3 `/readme`, 1 `/releases`) | 193 queries | 46 s | 74/75 records identical; the one difference (`oss-slu/code-futures`) is a PR merged at 19:44:14Z between the two passes |
| First parity run (`…194041Z-oss-slu-parity`) | 75 | 816 → 158 | 191 queries | 63 s → 41 s | 71/75 identical; 3 community-profile mismatches led to the template-directory and `-`/`_` fixes above, plus the same live drift |
| CLI full (`…194733Z-oss-slu-cli-full`) | 75 discovered, 75 committed | 160 including discovery | 42 points | 51 s | Exit 0; 0 skips or warnings; 75 ETags saved |
| CLI refresh (`…194833Z-oss-slu-cli-refresh`) | 75 | 1 | 0 points | 10 s | Exit 0; all 75 unchanged via `304` |
| CLI full, UW–Madison reproduction config (`…195832Z-uwmadison-full`) | 590 discovered, 590 committed | 1,222 including discovery (2.07 per repository) | 247 points, 1,004 queries | 7 min 50 s | Exit 2 (partial) only because `malcolmsng/cs639`'s README had 18 NUL characters, replaced per policy; 0 skips; no quota wait of 5 s or more logged |

UW–Madison review. The run used the issue #83 configuration unchanged (`repositoryConcurrency` 6) against a throwaway database (`repoexplorer-uwmadison-test`). Its rows were compared by repository ID with the 590 rows stored on 2026-10-28 by the earlier REST scraper, read-only from the dedicated database:
- The same 590 repositories, none missing or extra.
- 583 rows identical apart from `scraped_at`.
- README, code-of-conduct, contributing, security, issue-template and PR-template fill counts identical (482, 2, 11, 1, 4, 1).
- The 7 differing rows changed only timestamps, `size`, one open-issue count, one release-download count (526 vs 525 in total), and the README of 4 repositories, all pushed after Oct 28.

Re-enriching those 7 through both current paths gave identical REST and GraphQL records, so every baseline difference is a real change on GitHub. Core requests by endpoint: 590 repository resources, 593 contributor pages (10 empty `204`), 16 README fallbacks, 24 owner-listing pages; no release, community-profile or contents fallbacks. The REST path would have needed roughly 10 core requests per repository (about 6,000 here, more than one hourly window). This run stayed within one window.

The CLI runs used a throwaway PostgreSQL Compose project (`repoexplorer-graphql-smoke`) built from this branch's `schema.sql`, removed afterwards.

Batching window (`…204457Z-batching-window`): GraphQL-path enrichment of the 75 `oss-slu` repositories, concurrency 4, README prefetch enabled. Each pass used 158 core requests.

| Flush window | GraphQL queries | Snapshot queries | Repositories per snapshot | Elapsed |
| --- | --- | --- | --- | --- |
| Before the README prefetch, 10 ms (parity run 2) | 193 | — | — | 46 s |
| 10 ms | 120 | 71 | 1.06 | 38 s |
| 50 ms | 117 | 67 | 1.12 | 34 s |
| 100 ms (new default) | 94 | 52 | 1.44 | 37 s |

The README prefetch cut queries by 38% and the 100 ms window by a further 22%. Elapsed time varied by run without a trend, since contributor requests overlap the wait. Records were identical across the three passes except `oss-slu/material-derailleur`, pushed at 20:46:53Z during the runs.

### SnT full collection

Run `…205341Z-snt-full`, 2026-11-02 to 11-03: issue #83 SnT reproduction configuration (8,192 repositories, mostly user-owned), frozen `git archive` build of `608ee08`, throwaway database `repoexplorer-snt-test`, collection run `febbf744-896c-4a46-a0f6-a4da4300c7a9`.

| Attempt (UTC) | Active | Core | GraphQL queries | Core quota waits | Result |
| --- | --- | --- | --- | --- | --- |
| Initial, 11-02 20:53:41 → 22:04:59 | 71 min | 8,370 (3,986 discovery) | 1,774 | 1 (47 min) | Exit 1: laptop clamshell sleep on battery at 22:00:52Z; the network was down at dark wake and `GET /repos/sntanju/clean-functional-bank` used up its transient retries |
| resume-01, 22:11:27 → 23:01:50 | 50 min | 4,883 | 1,702 | 1 (35 min) | Exit 1: same cause at 23:00:41Z (`Geilson9/Projeto---Pretty-Neals`) |
| resume-02, 11-03 05:42:44 → 06:49:26 | 67 min | 7,987 | 2,686 | 1 (46 min) | Exit 2 (partial): 8,192 discovered, 8,177 committed; 6 owners (`404`) and 15 repositories skipped (8 `451`, 4 ToS `403`, 3 contributor `403`); 9 NUL-replacement warnings |

Checkpoints carried the first 4,404 repositories across both interruptions; nothing was published until the end. Totals: 3 h 08 min active, about 2 h 08 min of it in core quota waits; 21,240 core requests, 3,986 for discovery and 17,254 for enrichment (2.10 per repository: 8,202 repository resources, 8,859 contributor pages, 175 `/readme`, 15 contents, 2 community-profile and 1 release fallbacks); 6,162 GraphQL queries (5,301 snapshots, 861 object reads), with graphql quota never below 4,600 remaining. The earlier REST collection with the same configuration (2026-10-28 to 10-29) took about 17.5 h active over 5 attempts, with about 55 quota-wait log lines, because at roughly 10 core requests per repository it needed 15 to 18 hourly windows.

Comparison by repository ID with the 8,139 rows that REST collection stored (read-only export):
- 8,131 repositories in both. 8 only in the baseline: 7 now return `404`, and `sntkn/pancake-frontend` hit a contributor `403` during the run that no longer reproduces (contributors are REST on both paths). 46 only in the new run, all new since Oct 29.
- 7,919 common rows identical apart from `scraped_at`. The rest differ in volatile metadata (timestamps, `size`, counts, 78 renames) and in content for 88 repositories.
- Re-enriching those 88 through both paths at `608ee08` gave identical records for the 82 pushed since Oct 29, so their differences are real changes. The 6 not pushed were GraphQL parity bugs: 3 UTF-16 READMEs, 2 READMEs over 512,000 bytes, and the README beyond the 1,000-entry root listing. After the fixes above, all 88 are identical through both paths (`recheck-fixed/`), at 191 core requests for GraphQL and 687 for REST.
- Content fill counts, baseline vs new: README 5,423 vs 5,453, code of conduct 214 vs 214, contributing 484 vs 485, security 195 vs 196, issue templates 428 vs 430, PR template 301 vs 300.

The 46 new repositories have no REST baseline and were not rechecked. The throwaway database still holds the 6 pre-fix rows; it was discarded.

## Limitations and follow-ups

- GraphQL cost is dominated by the release snapshot. GitHub estimates `releases(first: 100) { releaseAssets(first: 100) }` at about one point per repository even when a repository has few releases. Lowering `releaseAssets(first:)` would cut points but send more repositories to REST; measure on a university with many releases before tuning.
- Batching stays small because repositories finish their ETag checks tens of milliseconds apart and each batch is bounded by `repositoryConcurrency`. On UW–Madison (10 ms window, before the README prefetch) 556 snapshot queries covered 590 repositories. Core savings and points do not depend on batch size. Prefetching `README.md` and a 100 ms window reduced GraphQL requests (batching table above); further gains need batching at the runner level, for example prefetching snapshots for a block of candidates.
- Org-level default community health files and REST's choice among README variants remain unverified beyond the `oss-slu` sample; both cases use REST where ambiguity is detectable.
- The UW–Madison sample has few community files (11 `CONTRIBUTING`, 4 issue-template sets), so it adds little evidence for the community-profile emulation beyond `oss-slu`. SnT adds 485 `CONTRIBUTING` files and 430 issue-template sets with no community-file parity difference.
- A network outage longer than the transient retry budget (as at laptop sleep) fails the run. Checkpoints make resuming cheap, but a longer backoff for network errors would ride out short outages.
- Conditional contributor reads cover only lists with fewer than 100 contributors. A repository with a larger list still pays every contributor page each time it changes. Per-page ETags with stored page contents would extend reuse to those lists, but they matter only if large projects dominate a university. The rule was measured on `oss-slu`, where every repository looked modified. A real weekly refresh has fewer modified repositories and saves correspondingly less. The free `304` was not confirmed against the quota counter, because the token was shared during the run.
- Existing databases need `repository-scraping.sql` applied by an administrator for the `contributors_etag` columns before this code can run against them.
