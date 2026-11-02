# Repository scraping finder

The finder discovers public GitHub repositories associated with configured universities, enriches each repository with GitHub metadata, and publishes completed university runs into `public.repository_scraping`. It is separate from the dashboard API, which continues to read its existing sample data.

Search results are candidates, not verified university affiliations. The scraper does not classify repositories or infer affiliations, project types, or bus factor. Configure search phrases carefully and review candidate quality downstream.

## Install and build

From this directory:

```sh
npm ci
npm test
npm run lint
npm run typecheck
npm run build
```

The build produces the import-safe library at `dist/scraping.js` and the CLI at `dist/cli.js`. Build before starting the CLI:

```sh
npm start -- --config config/universities.example.json
```

## Configure universities

Copy `config/universities.example.json` to `config/universities.json` and set the universities to collect. Each `key` is stored in the staging table's `university` column; use the same full name as the final dataset if the rows should align with it. `fullName` and `acronym` supply the default search phrases. No production university list is embedded in the code.

```json
{
    "repositoryConcurrency": 4,
    "databaseBatchSize": 100,
    "universities": [
        {
            "key": "Saint Louis University",
            "fullName": "Saint Louis University",
            "acronym": "SLU",
            "queries": {
                "repositories": "\"Saint Louis University\" in:name,description archived:false size:>0",
                "organizations": "\"SLU\" in:name,login type:org",
                "users": "\"SLU\" in:name,login type:user"
            }
        }
    ]
}
```

`queries` is optional. The defaults are:

- Repositories: `"<fullName>" in:name,description archived:false size:>0 is:public`
- Organizations: `"<acronym>" in:name,login type:org`
- Users: `"<acronym>" in:name,login type:user`

GitHub Search returns at most 1,000 results per query. The finder probes each repository, organization, and user search before pagination. Searches with more than 1,000 matches are automatically split into non-overlapping `created:` time ranges, recursively down to one-second precision as needed. Each range is paginated separately, then results are combined and deduplicated through the existing repository/owner discovery. Exactly 1,000 matches can be retrieved without splitting. Broad acronyms such as `SLU` do not need to be narrowed solely to avoid the cap. Partitioning adds search requests; the shared request client continues to coordinate GitHub rate limits.

For an incomplete result flag, a changed count, or a short page, the finder retries that logical search up to three times, waiting one second and then two seconds between attempts. Each attempt starts from the root probe and discards the prior attempt's results. The retry applies only to the affected repository, organization, or user search; the shared request client continues to control HTTP retries and rate-limit waits. Search attempts are separate from request attempts. A cumulative limit of 4,095 partition probes applies across all attempts. The run fails that university if transient failures persist, metadata is invalid, more than 1,000 matches share a single second, or the probe limit is reached. A capped custom query that already contains `created:` also fails with an actionable error; remove that qualifier to allow automatic partitioning or make the query more specific. Incomplete discovery remains fatal before publication, including under best-effort policy.

Search failures use stable reason codes such as `incomplete-results`, `count-changed`, `short-results`, `invalid-search-metadata`, `created-filter-conflict`, `single-second-overflow`, and `partition-limit`. Reports include safe search kind, stage, counts, attempt totals, and a static hint. They omit custom queries, response bodies, and arbitrary API messages.

Creation-time splitting handles completeness, not affiliation quality. GitHub repository and user search do not offer the regular-expression matching available in code search; terms such as `*SLU*` are not a regex solution to the result cap. Keep acronym searches broad for candidate discovery and review affiliation downstream. See GitHub's [user creation filters](https://docs.github.com/en/search-github/searching-on-github/searching-users#search-by-when-a-personal-account-was-created) and [date-range syntax](https://docs.github.com/en/search-github/getting-started-with-searching-on-github/understanding-the-search-syntax#query-for-dates).

The request contracts follow GitHub's [REST search endpoints](https://docs.github.com/en/rest/search/search), [community profile endpoint](https://docs.github.com/en/rest/metrics/community), and [README/content endpoints](https://docs.github.com/en/rest/repos/contents).

The repository worker count defaults to 4 and can be set from 1 to 16. Database batches default to 100 records and can be set from 1 to 500. One shared `GitHubRequestClient` coordinates every request and pagination call in the run, including its retry and rate-limit handling.

## Prepare PostgreSQL

The scraper requires the staging table. For a new database, create the repository's `.env` and start the database service:

```sh
cd ..
./scripts/setup-env
docker compose up --build -d db
```

For an existing database volume, apply the non-destructive migration as the administrator. The complete instructions are in [the database guide](../docs/dev/database.md#add-finder-tables-to-an-existing-volume). The scraper never creates schema and must connect with the restricted application role.

The finder reads `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD`. The repository `.env` supplies the database name, role, password, and host port. When `PGHOST` is unset, the finder uses `127.0.0.1`; when `PGPORT` is unset, it uses the host port `5433`. From inside Compose, set `PGHOST=db` and `PGPORT=5432`. `GITHUB_TOKEN` is optional but recommended to increase GitHub's rate limits. The CLI loads the repository-root `.env` without replacing values already present in the process environment.

## Diagnose GitHub access

After building from `find/`, check whether the selected credential can list one page of an organization's repositories:

```sh
npm start -- --diagnose-github --owner oss-slu
```

This read-only probe requests only `GET /orgs/{owner}/repos?per_page=1`. It runs before scraper configuration or database setup, does not paginate or write a scrape report, and prints one JSON result with the endpoint, status, request ID, classified reason, safe SSO/quota evidence, and a static next step. It makes no automatic HTTP or quota retries. Exit status is `0` for access confirmed, `1` for a failed probe or configuration, and `130`/`143` if interrupted. A successful response confirms GitHub access to one page at that moment; it does not validate PostgreSQL access, search visibility, or full-scrape success.

The diagnostic uses the same credential selection as collection: a `GITHUB_TOKEN` already in the process environment takes precedence over the repository-root `.env`. When GitHub App credentials are configured, a nonempty effective `GITHUB_TOKEN` is used initially and the App provider refreshes it later. The diagnostic reports the initial token source separately from `refreshProvider`; without an initial token it reports `github-app`. An empty exported `GITHUB_TOKEN` remains empty rather than being replaced from `.env`. The report identifies the source and whether credential material is present, but never prints it or claims it has been authenticated. Credential-provider failures are reported separately from organization endpoint or network failures. `gh auth status` may describe a different credential from the one the finder selected.

## Run a scrape

Before making GitHub requests, the CLI performs a read-only database preflight: it checks connectivity, the staging and checkpoint tables, required columns, and the application's schema and table privileges. It does not create schema or write probe rows, and it cannot guarantee that the database remains available for a later transaction.

From `find/`, after building, run a full discovery or refresh known repositories:

```sh
npm start -- --config config/universities.json --mode full
npm start -- --config config/universities.json --mode refresh
```

Full mode is the default. Pass `--university "Saint Louis University"` to collect one exact configured key. Pass `--run-id <id>` to resume saved work; GitHub Actions supplies its run ID automatically, so rerunning a failed or interrupted workflow resumes completed repository enrichments and documented repository skips. Discovery candidates and completed repository results are checkpointed in PostgreSQL, then published to `repository_scraping` in one transaction after the university's candidates finish. If a run stops before discovery is checkpointed, discovery is retried; once its candidate set is checkpointed, completed repositories and skips are reused on resume and are not requested again. A fresh run can try a previously skipped repository again.

Refresh mode lists the current `repository_scraping` snapshot and sends `If-None-Match` with each saved repository ETag. A `304` is checkpointed as unchanged and skips enrichment; changed repositories are enriched and published when the university completes. Authenticated conditional requests returning `304` do not count against GitHub's primary REST limit ([GitHub guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)). Full discovery reuses complete repository metadata returned in search and owner-listing responses; it fetches the individual repository resource only when the discovery representation omits fields required by the existing record contract.

Best-effort policy skips documented owner-listing 404s, repository-detail 404s after discovery, repository endpoints whose structured GitHub response has `block.reason === 'tos'`, repository-scoped HTTP 451 responses, and the exact GitHub response that says a repository's contributor history is too large to list. That contributor exception applies only to the candidate's trusted `/repos/{owner}/{repo}/contributors` endpoint. It discards the whole in-progress record and checkpoints `github_contributors_unavailable`; it never stores an empty or partial contributor list. Unknown 403s remain fatal. Pass `--strict` to make all owner and repository skips fatal before publishing that university. Both policies normalize actual NUL characters in descriptive text to U+FFFD and report each affected repository, field, and replacement count. The library's `discoverRepositories` and `runScraping` entry points default to `best-effort`; callers can pass `policy: 'strict'` explicitly.

### HTTP error policy

| GitHub response | Shared request behavior | Best-effort collection | Strict collection |
| --- | --- | --- | --- |
| `401` | Terminal authentication failure; the same token is not retried. | Fail the university. | Fail the university. |
| `403` with recognized quota evidence, or `429` | Use bounded rate-limit recovery and shared cooldowns. | Resume after recovery, or fail when its budget is exhausted. | Same. |
| Structured repository ToS `403` | Do not transiently retry. | Skip the whole repository. | Fail before publishing the university. |
| Exact contributor-list-size `403` on the candidate's trusted contributors endpoint | Terminal permission response; retain the stable `github_contributors_size_limit` diagnostic. | Skip the whole repository as `github_contributors_unavailable`; discard any earlier contributor pages. | Fail before publishing the university. |
| Other `403`, including unknown, SSO, or permission denials | Terminal access failure with safe evidence. | Fail; do not skip owners or repositories. | Same. |
| Owner-listing `404` or root repository-detail `404` after discovery | Do not retry. | Skip the documented owner or repository. | Fail before publishing the university. |
| Optional-resource `404` | Do not retry. | Keep the documented absent-field behavior, such as a missing README. | Same. |
| Other `404` | Terminal not-found error with endpoint context. | Fail; do not infer an empty result. | Same. |
| Repository-scoped `451` | Do not retry; match the trusted API origin and requested repository path or its slash-delimited descendants. | Skip the entire repository and report the legal unavailability category and safe request ID. | Fail before publishing the university. |
| Search, owner-listing, or unrelated `451` | Do not retry. | Fail because discovery coverage is unknown. | Same. |
| `408`, `500`, `502`, `503`, `504` | Retry within the existing transient request budget. A valid `Retry-After` is a minimum wait; waits above 60 seconds fail safely instead of retrying early. | Fail after the bounded request budget is exhausted. | Same. |
| `400`, `409`, `410`, `412`, `422` | Terminal invalid-request, conflict, gone, precondition, or validation diagnostic. | Fail; do not rewrite the query or request automatically. | Same. |
| `202` | Unsupported asynchronous response; fail before publication. | Fail the university. | Same. |
| `204` | Accept only for the documented empty contributor-list response. | Other endpoints fail rather than becoming empty data. | Same. |
| `304` | Accept only for an ETag-conditional refresh of a saved repository. | Preserve that saved repository snapshot as unchanged. | Same. |

API redirects are followed manually for at most five hops. Every target must use HTTPS and the configured API origin; loops, invalid locations, insecure targets, and cross-origin redirects fail without forwarding the token. Redirects stay inside one request attempt and use the original timeout and retry budgets.

The separate [collection workflow](../.github/workflows/collect-find.yml) runs full discovery on the first Monday of each month and refreshes on other Mondays. Manual dispatch supports full or refresh mode and an optional university key or previous run ID. Workflow concurrency queues collection runs, and PostgreSQL advisory locks allow CLI invocations for different university keys to run concurrently against the same database. Each invocation reserves all selected university keys before collection starts and holds them until cleanup; an overlapping selection fails immediately and releases any locks it acquired. Use `--university` to select a single configured key. Full, refresh, and resumed runs use the same locks. Older binaries holding the former database-wide lock still exclude new collectors (and vice versa); restart them with the updated build to enable concurrent collections. Separate processes still share GitHub account or IP quota and do not coordinate their request queues. Configure the `FINDER_GITHUB_APP_ID` and `FINDER_GITHUB_APP_PRIVATE_KEY` secrets for the read-only GitHub App, the `FINDER_PGHOST`, `FINDER_PGDATABASE`, `FINDER_PGUSER`, and `FINDER_PGPASSWORD` database secrets, and the optional `FINDER_PGPORT` secret. The workflow exchanges the App credentials for a contents-read installation token and renews it before expiry during long scans. GitHub App installation tokens can access only repositories included in that installation; broad scans need the target repositories covered by its repository access. Set the `FINDER_UNIVERSITIES_CONFIG_JSON` repository variable to the production JSON configuration; otherwise the workflow uses the checked-in example configuration.

The CLI distinguishes complete, partial, failed, interrupted, and not-run university outcomes. A university is partial when an owner or repository was skipped, or descriptive text needed NUL replacement. An all-skipped university is partial with zero committed rows. A stop during an active university records it as interrupted; universities that have not started remain not-run, and earlier completed universities remain complete or partial. Summaries and progress report observed skip and warning counts; they do not estimate missing repositories. If a run includes both partial and failed universities, the fatal failure determines the exit code.

Every collection run writes a version 3 machine-readable JSON report to the ignored `find/reports/` directory and prints its path in the final summary. Version 3 adds the separate `interrupted` outcome and `interruptedUniversities` count; previously written version 2 reports remain unchanged. Reports include start and finish timestamps, policy, per-university status and committed counts, skipped owners and repositories, text-normalization warnings, and safe failure or interruption diagnostics. Diagnostics allowlist phase, repository/owner, cancellation source, category, sanitized endpoint path, HTTP status, request ID, retry and rate-limit data, block reason, validation field, SQLSTATE, and failed batch number/size. Repository skip entries retain the safe GitHub request ID when available. Search diagnostics add stable failure reason, search kind, stage, safe counts, logical search attempts, exhaustion state, and a static remediation hint. Access diagnostics preserve allowlisted 403 reason and SSO status plus parsed quota observations; an unknown 403 remains fatal and says its exact cause is unconfirmed. Legal-restriction diagnostics never include an inferred legal cause. Credentials, headers, query parameters, bind values, raw content, arbitrary response bodies, and PostgreSQL detail strings are not recorded. Report-writing errors are printed clearly and return exit code `1` unless a signal or recorded fatal failure determines the outcome; an interrupted run still returns its signal exit code, and the failed report path is shown as unavailable. Exit codes are `0` for complete success, `2` for partial completion, and `1` for fatal failure; `SIGINT` and `SIGTERM` retain exit codes `130` and `143`.

Each university's checkpointed results remain outside the dashboard staging table until publication. A failed or interrupted university publishes no incomplete in-flight records; cancellation before transaction commit rolls publication back and retains its checkpoints. If the transaction commits before a concurrent stop is observed, the report keeps the committed count. Prior successful universities remain committed. Repeated successful upserts update `(id, university)` rows atomically and preserve downstream analysis fields. A fully successful full discovery removes repository and ETag rows that were not rediscovered; partial full runs and refresh runs preserve existing rows. Partial runs can therefore leave stale records and bias downstream counts, coverage, and other metrics. Review the report and account for partial coverage before comparing downstream results.

Pass `--verbose` or `-v` to show progress:

```sh
npm start -- --config config/universities.json --verbose
```

On a terminal, verbose mode updates one line with the current university, phase-local counts, active and queued requests, known quota waits, and elapsed time. When output is redirected, it prints phase changes and waits of at least five seconds without ANSI codes or per-request output. The default mode stays quiet during work. Both modes include elapsed time in the final summary. `Ctrl+C` and `SIGTERM` cancel queued and in-flight GitHub requests, retain resumable checkpoints, release the collection lock, and allow cleanup and report writing to finish.

All repository candidates, owner listings, details, README data, release pages, contributor pages, community metadata, and content reads use the shared request client. Documented missing optional files, such as a README `404`, are stored as `NULL`. Authentication failures, ordinary permission and SSO restrictions, exhausted retries, malformed responses, incomplete discovery, unexpected API errors, and database errors fail the university.

Owner-listing recovery preserves its established behavior: it applies only to HTTP 404 responses from `GET /orgs/{login}/repos` or `GET /users/{login}/repos`. It does not treat 404 as an empty repository list and never substitutes a user endpoint for an organization endpoint. If a later page for an owner returns 404, that owner's earlier pages are discarded and the owner is reported as skipped; repository candidates discovered independently remain available. At enrichment, a root repository-detail 404, a structured ToS block, a repository-scoped 451, or GitHub's exact contributor-history-size-limit 403 on the candidate's contributors endpoint is skippable in best-effort mode. Contributor skip matching requires the exact message, a permission-classified 403 without rate-limit or SSO evidence, and both the original and effective HTTPS URLs to point to the exact candidate `/contributors` path on the configured API origin. A failure on a later contributor page discards all pages already read. Generic 403 responses, SSO restrictions, 401s, quota exhaustion, other unexpected API errors, incomplete searches, and database failures remain fatal. Strict mode writes no rows for a university when a documented skip condition occurs.

Actual U+0000 in descriptive text fields is replaced with U+FFFD before binding values to PostgreSQL. The warning identifies the repository, field, and count. Other Unicode, tabs, line endings, empty values, and the literal six-character `\\u0000` text are preserved. IDs, names, URLs, timestamps, contributor logins, and other structural values are validated and never rewritten. Supported JSON issue-template entries are parsed, their content strings normalized, and valid JSON re-serialized; contributor identities are not normalized.

Raw GitHub content is decoded using the platform's standard UTF-8 `Response.text()` behavior. The finder does not detect or reinterpret binary or UTF-16 data; malformed UTF-8 is decoded with U+FFFD by the platform before text normalization.

See GitHub's separate endpoint references for [listing organization repositories](https://docs.github.com/en/rest/repos/repos#list-organization-repositories) and [listing repositories for a user](https://docs.github.com/en/rest/repos/repos#list-repositories-for-a-user).

The request client tracks the `core` and `search` primary limit buckets separately, pauses both buckets for secondary limits, observes `Retry-After` and quota reset headers, and adds a one-second reset buffer. Ordinary permission `403` and authentication `401` failures stop promptly. Transient HTTP retries are limited to `408`, `500`, `502`, `503`, and `504`; 409 and 412 are terminal by default. Transient request retries and quota recovery have separate bounded budgets. A valid `Retry-After` on a transient server response is honored as a minimum wait up to 60 seconds; longer requests stop with a safe diagnostic rather than retrying early. Repeated quota failures include the request ID, bucket, remaining quota, reset/retry time, attempts, and stop reason where GitHub supplied those values. Successful responses reporting zero remaining quota pause later requests in that bucket until the later of the buffered reset deadline and `Retry-After`. When reset data is missing, malformed, or already past, the client uses a bounded 60-second conservative wait before retrying. See GitHub's [REST API rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) and [troubleshooting guidance](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api).

`GITHUB_TOKEN` and the repository-root `.env` are read at runtime, so changing the token does not require rebuilding. The collection workflow uses a GitHub App installation token with contents read permission. A token is recommended for broad collections: GitHub documents a 60-request-per-hour primary limit for unauthenticated REST requests, compared with 5,000 requests per hour for a personal authenticated limit ([rate-limit details](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)). A GitHub CLI login is separate from `GITHUB_TOKEN`; the finder uses the environment value only. Never paste tokens into command output or logs. Broad acronym searches such as `SLU` return candidates, not verified university affiliations; review them downstream.

## Staging field conventions

The scraper writes every field in the final repository shape plus `scraped_at`. See the [database field map](../docs/dev/database.md#publicrepository_scraping-field-mapping) for the complete source and nullability rules. A few conventions are worth calling out:

- `organization` preserves the existing sample's text marker: `"1"` for repositories owned by an organization, `NULL` for repositories owned by a user.
- `license` stores the lowercase SPDX identifier, `other` for an existing license without a usable SPDX identifier, and `NULL` when no license is reported.
- `contributors` is text containing a JSON array of unique contributor logins, such as `["alice","bob"]`. Existing sample data may contain Python-style list text.
- When the community profile omits issue templates, the finder checks `.github/ISSUE_TEMPLATE`, `ISSUE_TEMPLATE`, and `docs/ISSUE_TEMPLATE` for directory-based templates and issue forms.
- Community-file columns store file contents. Directory-based issue templates are stored as JSON text with each entry's path and content.
- GitHub's community profile endpoint does not support forked repositories, so the finder checks the repository root and `.github` directory for their standard community files.
- `bus_factor`, `affiliation_prediction_gpt5_mini`, and `type_prediction_gpt5_mini` are inserted as `NULL`; reruns preserve values filled by downstream analysis.
- GitHub IDs and counts must be non-negative safe integers before PostgreSQL binding. Unsafe values fail instead of being rounded by JavaScript.

## Verification

Unit tests use synthetic GitHub responses and do not make live GitHub requests. For actual persistence tests, prepare an isolated PostgreSQL database named with `test`, `integration`, or `verify` in its name and set `FINDER_TEST_DATABASE_URL`. An optional `FINDER_TEST_ADMIN_DATABASE_URL` can point to an administrator connection while the test URL uses the application's restricted role.

The repository includes a temporary Compose harness that creates its own project, credentials, port, and volume, then removes only that project:

```sh
cd ..
./scripts/db/verify-find.sh
```

This exercises the real finder store against PostgreSQL, including insert, rerun/update, same ID under two universities, quoted input, rollback, and connection release. `scripts/db/verify.sh` checks the fresh schema, application-role CRUD, repeatable bootstrap, and preservation of existing tables.
