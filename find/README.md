# Repository scraping finder

The finder discovers public GitHub repositories associated with configured universities, enriches each repository with GitHub metadata, and upserts complete results into `public.repository_scraping`. It is separate from the dashboard API, which continues to read its existing sample data.

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

The run still fails that university if GitHub reports incomplete results, counts change during collection, pagination is short, more than 1,000 matches share a single second, or a search exceeds 4,095 probes. A capped custom query that already contains `created:` also fails with an actionable error; remove that qualifier to allow automatic partitioning or make the query more specific. Search and pagination completeness checks prevent writes when search discovery is incomplete. Rerun transient incomplete/count-change failures; narrow persistent failures in the configuration.

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

For an existing database volume, apply the non-destructive migration as the administrator. The complete instructions are in [the database guide](../docs/dev/database.md#add-the-staging-table-to-an-existing-volume). The scraper never creates schema and must connect with the restricted application role.

The finder reads `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD`. The repository `.env` supplies the database name, role, password, and host port. When `PGHOST` is unset, the finder uses `127.0.0.1`; when `PGPORT` is unset, it uses the host port `5433`. From inside Compose, set `PGHOST=db` and `PGPORT=5432`. `GITHUB_TOKEN` is optional but recommended to increase GitHub's rate limits. The CLI loads the repository-root `.env` without replacing values already present in the process environment.

## Run a scrape

From `find/`, after building:

```sh
npm start -- --config config/universities.json
```

Or pass another configuration file. Owner-listing 404s are skipped by default, allowing the finder to enrich and transactionally upsert candidates from repository search and accessible owners. Pass `--strict` to restore all-or-nothing discovery: an owner-listing 404 then fails that university before any rows are written. The library's `discoverRepositories` and `runScraping` entry points also default to `best-effort`; callers can pass `policy: 'strict'` explicitly.

The CLI distinguishes complete, partial, and failed university outcomes. A university is partial whenever one or more owners were skipped, including when no candidates remain. It reports the number of skipped owners, never an estimated number of missing repositories. A prominently labeled partial summary is printed when accessible rows were committed. If a run includes both partial and failed universities, the fatal failure determines the exit code.

Every run writes a machine-readable JSON report to the ignored `find/reports/` directory and prints its path in the final summary. Reports include start and finish timestamps, policy, per-university status and committed counts, and skipped owner details (login, owner type, university, sanitized endpoint, HTTP status, and reason). Credentials, headers, and response bodies are not recorded. Report-writing errors are printed clearly and make a non-interrupted run fail. Exit codes are `0` for complete success, `2` for partial completion, and `1` for fatal failure; `SIGINT` and `SIGTERM` retain exit codes `130` and `143`.

Each university is discovered and enriched before its transaction begins. A failed university writes no rows; prior successful universities remain committed. Repeated successful upserts update `(id, university)` rows atomically, preserve downstream analysis fields, and never delete rows that were not rediscovered. Consequently, a partial run can leave stale records for repositories that were not listed and can bias downstream counts, coverage, and other metrics. Review the report and account for partial coverage before comparing downstream results. A complete later run can refresh accessible records, but still does not delete rows that are no longer discovered.

Pass `--verbose` or `-v` to show progress:

```sh
npm start -- --config config/universities.json --verbose
```

On a terminal, verbose mode updates one line with the current university, phase-local counts, active and queued requests, known quota waits, and elapsed time. When output is redirected, it prints phase changes and waits of at least five seconds without ANSI codes or per-request output. The default mode stays quiet during work. Both modes include elapsed time in the final summary. `Ctrl+C` and `SIGTERM` cancel queued and in-flight GitHub requests and allow cleanup to finish.

All repository candidates, owner listings, details, README data, release pages, contributor pages, community metadata, and content reads use the shared request client. Documented missing optional files, such as a README `404`, are stored as `NULL`. Authentication and permission errors, exhausted retries, malformed responses, and unexpected API errors fail the university.

Best-effort recovery applies only to HTTP 404 responses from `GET /orgs/{login}/repos` or `GET /users/{login}/repos`. It does not treat 404 as an empty repository list and never substitutes a user endpoint for an organization endpoint. If a later page for an owner returns 404, that owner's earlier pages are discarded and the owner is reported as skipped; repository candidates discovered independently remain available. Authentication and permission failures, quota exhaustion, other unexpected API errors, incomplete searches, enrichment failures, and database failures remain fatal. Strict mode aborts on an owner-listing 404 and commits no rows for that university.

See GitHub's separate endpoint references for [listing organization repositories](https://docs.github.com/en/rest/repos/repos#list-organization-repositories) and [listing repositories for a user](https://docs.github.com/en/rest/repos/repos#list-repositories-for-a-user).

The request client tracks the `core` and `search` primary limit buckets separately, pauses both buckets for secondary limits, observes `Retry-After` and quota reset headers, and adds a one-second reset buffer. Ordinary permission `403` and authentication `401` failures stop promptly. Network/server retries and quota recovery have separate bounded budgets; repeated quota failures end with the request ID, bucket, remaining quota, reset/retry time, attempts, and stop reason where GitHub supplied those values. Successful responses reporting zero remaining quota pause later requests in that bucket until the later of the buffered reset deadline and `Retry-After`. When reset data is missing, malformed, or already past, the client uses a bounded 60-second conservative wait before retrying. See GitHub's [REST API rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) and [troubleshooting guidance](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api).

`GITHUB_TOKEN` and the repository-root `.env` are read at runtime, so changing the token does not require rebuilding. A token is recommended for broad collections: GitHub documents a 60-request-per-hour primary limit for unauthenticated REST requests, compared with 5,000 requests per hour for a personal authenticated limit ([rate-limit details](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)). A GitHub CLI login is separate from `GITHUB_TOKEN`; the finder uses the environment value only. Never paste tokens into command output or logs. Broad acronym searches such as `SLU` return candidates, not verified university affiliations; review them downstream.

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
