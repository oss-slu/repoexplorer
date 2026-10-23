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

The run still fails that university if GitHub reports incomplete results, counts change during collection, pagination is short, more than 1,000 matches share a single second, or a search exceeds 4,095 probes. A capped custom query that already contains `created:` also fails with an actionable error; remove that qualifier to allow automatic partitioning or make the query more specific. These checks preserve the rule that partial discovery writes no university rows. Rerun transient incomplete/count-change failures; narrow persistent failures in the configuration.

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

Or pass another configuration file. The CLI reports unique repository counts per university, committed associations, and failures. It exits nonzero if a university fails. Each university is discovered and enriched completely before its transaction begins. A failed university writes no rows; a prior successful university remains committed. Repeated successful runs update `(id, university)` rows atomically, preserve downstream analysis fields, and never delete rows that were not rediscovered.

All repository candidates, owner listings, details, README data, release pages, contributor pages, community metadata, and content reads use the shared request client. Documented missing optional files, such as a README `404`, are stored as `NULL`. Authentication and permission errors, exhausted retries, malformed responses, and unexpected API errors fail the university.

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
