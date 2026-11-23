# Repository scraping finder

The finder discovers public GitHub repositories associated with configured universities, enriches each repository with GitHub metadata, and publishes completed university runs into `public.repository_scraping`. A separately runnable classification stage reads those candidates and saves model-neutral predictions in `public.repository_classification_predictions`. Both stages are separate from the dashboard API, which continues to read its existing sample data.

Search results are candidates, not verified university affiliations. The classification stage scores university affiliation and classifies qualifying repositories as `DEV`, `EDU`, `DOCS`, `WEB`, `DATA`, or `OTHER`. It does not calculate bus factor. Configure search phrases carefully and review candidate quality downstream.

## Install and build

From this directory:

```sh
npm ci
npm test
npm run lint
npm run typecheck
npm run build
```

The build produces the import-safe scraper library at `dist/scraping.js`, the scrape CLI at `dist/cli.js`, and the classifier CLI at `dist/classify-cli.js`. Build before starting either CLI:

```sh
npm start -- --config config/universities.example.json
```

## Classify scraped candidates

Apply the same staging-table migration described below, scrape candidates, and configure the optional `classification` and university context fields in the universities JSON. The default provider uses an OpenAI-compatible chat-completions endpoint; set the configured `apiKeyEnv` variable (the example uses `OPENAI_API_KEY`). The default affiliation threshold is `0.4`, preserved from the upstream finder as a compatibility default rather than a validated quality cutoff.

```sh
npm run build
npm run classify -- --config config/universities.json
```

The command runs affiliation first. It requests a project type only when the structured affiliation decision is `supported` and its score meets the threshold. A `not_supported` decision and an `uncertain` decision are persisted distinctly and skip project typing for different reasons. `uncertain` uses a null score and does not count as a provider failure. Each result is saved independently, so interruption or an isolated provider failure does not lose earlier predictions.

While it runs, the command writes progress to stderr: university, task, completed/total, and failures so far. A terminal shows one line updated in place. Redirected output gets whole lines when a task starts, at each tenth of the task, at least every 30 seconds while it advances, and when it ends, so a log file stays readable. Stdout still holds only the final summary line.

Citations are repaired rather than failing the whole result when the quote itself is real. A quote that does not match its named field but appears verbatim in exactly one other allowed field is relabeled to that field. A citation that names a field with no text, quotes text absent from every visible field, or matches more than one other field is dropped, but only while at least one verified citation remains; a `supported` decision therefore still has at least one verified citation. When nothing verifiable remains, the result fails as before with `invalid_citation`. Quotes are never edited. The summary reports `repaired citations: N in M results`, and the JSON run report lists each repair under `citationRepairs` with its repository, task, action, reason, declared field, and new field. The database stores the repaired evidence; it does not mark a row as repaired, so use the run report to find them. The evaluation CLI keeps the strict policy, so its citation and contract validity remain first-pass numbers.

An affiliation evidence gate runs after validation and citation repair, before anything is saved. With `affiliationEvidenceGate: "names_institution"` (the default; rule `names-institution-v3`), a `supported` result is kept only when at least one accepted citation names the institution:

- its `fullName` or one of its optional `alternateNames` (other names people write for it, such as `"UC Santa Cruz"`), ignoring case and punctuation;
- an email address at one of its `emailDomains` (subdomains allowed; `slu.edu.ph` is not `slu.edu`), or that domain as the host of the repository's `homepage` citation. A domain inside other URLs does not count, because READMEs usually link to an institution's site when citing its software;
- its `acronym` as a whole word (case-sensitive for acronyms of up to four characters), but only when the repository's own text (description, README, homepage) also contains the full name or an alternate name, or the owner login contains the acronym as a token (logins split on punctuation and camelCase: `oss-slu`, `SLU-TMI`, `ucscGenomeBrowser`). A bare acronym collides with other institutions and terms, such as Saint Leo University, the Swedish University of Agricultural Sciences, or spoken language understanding.

Add an alternate name only when it cannot name another institution: `"St. Louis University"` also matches inside "Washington University in St. Louis University Libraries". Nothing counts when the quote or the repository text contains one of the university's `excludedNames`, for other institutions whose names contain this one's (for example `"excludedNames": ["Saint Louis University Baguio"]`). Citations from the `owner` and `fullName` fields never count, and occurrences of the owner login are removed from quotes before matching. An organization login such as `oss-slu` appears in every repository's URLs and badges, so it can vouch for an acronym but is never evidence on its own.

A result that fails the gate is stored as `uncertain` with relationship `insufficient_evidence`, a null score, and the model's citations. Its explanation says it was downgraded and keeps the model's decision, relationship, score, and explanation. Project typing is then skipped as for any uncertain result. The summary's `uncertain` count includes these results and `downgraded: N` counts them separately. The JSON run report lists each one under `affiliationDowngrades` with the model's full original response. Set `"off"` to keep the model's decision. The gate rule version is part of the prediction fingerprint, so gated and ungated rows, and rows from different gate rules, are never reused for each other; `off` keeps the pre-gate fingerprint. The evaluation CLI keeps its affiliation metrics on the model's raw decisions and reports the gate separately under `affiliationEvidenceGate` (raw and gated supported counts, downgrades, and metrics computed from gated decisions). The semantic review uses the same name matcher.

A `supported` or `not_supported` affiliation reply with a null score gets one corrective follow-up: the original messages, the model's reply, and a request to either give a score or change the decision to `uncertain` with a null score. No score is filled in locally. A second null score fails with `invalid_schema`, and its message says the follow-up was tried. The summary reports `score retries: N (R recovered)`, the run report lists each one under `scoreRetries` with whether its reply was accepted, and accepted results' token usage and transport attempts include both requests. The evaluation CLI does not retry.

The post-inference review report flags coursework/type or coursework/subtype mismatches and supported affiliation claims whose cited passage does not name the target institution together with an explicit relationship cue. These are review signals, not ground truth: they do not rewrite model output or block persistence. The run summary exposes the findings for human review.

Affiliation responses use a versioned canonical contract with a decision, relationship, optional score for uncertainty, exact evidence citations, and explanation. The `citationMode` setting accepts `exact_quote` or `evidence_id`. Exact quotes must match the named field text actually sent after truncation. Evidence IDs refer to deterministic, request-local spans from that same visible text; the inference layer resolves each ID into a canonical field and exact quote, then applies the same strict citation validator. Unknown, duplicate, or task-ineligible IDs fail validation. Truncation limits and span lengths count UTF-16 code units, but a boundary that would split a surrogate pair (such as an emoji) moves inward, because PostgreSQL rejects half a character in the JSONB evidence column. Text without such a split keeps the same catalog and hash, so the catalog version is unchanged. The evidence catalog improves traceability but does not prove that a quote supports the model's decision. The canonical stored response remains independent of the selected model wire contract. The score is a model judgment, not a calibrated probability. Cache fingerprints include the endpoint, prompt and wire/canonical contract versions, citation mode, catalog algorithm and hash when used, output mode, generation settings, threshold, and supplied evidence. Old rows remain available, but rows without the new structured fields are not reused. The default prompt is `v3` with `exact_quote`; evidence IDs are opt-in because the local six-case run did not pass the semantic review gate. `v3` is the `v2` layout plus a short affiliation score rubric that ties score bands to evidence strength (an explicit institution name and relationship in one passage scores 0.90 to 1.00; weaker or partly stated relationships score lower; `not_supported` uses 0.00 to 0.30), because the earlier prompt led a local model to give every supported result 1.00, which made the threshold meaningless. With `evidence_id`, `v3` adds the same rubric to the evidence-reference prompt. `promptVersion: "v2"` still reproduces the earlier prompts. The prompt version is part of every prediction key, so moving to `v3` reclassifies rows.

Existing configurations default to `responseFormat: "text"` for provider compatibility. Use `json_schema` or `json_object` only when the configured endpoint supports that mode; a rejected structured request fails clearly and is never retried as unstructured text. Generation settings allow an optional temperature from 0 to 2, `maxOutputTokens` from 1 to 32,768 (default 8,192), an optional `reasoningEffort` (`none`, `minimal`, `low`, `medium`, `high`, or `xhigh`), and an optional seed from 0 to 2,147,483,647. Temperature and reasoning effort are sent only when configured. GPT-5 reasoning models such as the default `gpt-5-mini` reject any temperature other than their default, so the OpenAI example omits it; the local Ollama example sets `temperature: 0` explicitly. `maxOutputTokensField` selects `max_completion_tokens` (the default for OpenAI) or `max_tokens` (used by the local Ollama example). For reasoning models, `max_completion_tokens` also covers hidden reasoning tokens, so a small budget ends replies early and they are saved as `provider_truncated_completion` failures; lowering `reasoningEffort` reduces that usage. Every generation setting, including an omitted temperature, is part of the cache fingerprint, so changing one reclassifies rows. Temperature 0 supports controlled comparisons but does not guarantee deterministic output.

For offline runs, `--mock` (model `deterministic-evidence-v2`) supports affiliation only when a visible field names the institution by the evidence gate's rule, cites that passage, and then classifies the project as `DEV` with a real citation; other repositories are `uncertain`. `--simulate --seed 42` (model `seeded-random-v3`) returns a seeded mix of `supported` (with a score and a positive relationship, only when the prompt shows a passage naming the institution, so supported samples pass the gate), `not_supported`, and `uncertain` affiliations, then a random project type. Supported results and project types cite text copied from the prompt (or catalog IDs shown in it in `evidence_id` mode), so they pass the same validation as provider replies and the project-type task runs offline. Neither is an evaluated judgment. Both mark results as simulated and still write to the configured PostgreSQL database. Use an isolated test database for experiments.

The classifier uses repository name, owner, description, README, and homepage as citation sources. It does not collect organization profiles or contributor bios, companies, and email addresses; missing profile information is treated as missing evidence. Coursework, assignments, teaching exercises, and learning projects take precedence as `EDU`; a general-purpose tool remains `DEV`, including when made at a university. Existing staging rows with unknown archived/template flags remain ineligible for the production classifier until they are fetched again. Scrape runs ignore a saved ETag for such rows, so the next full or `--mode refresh` run refetches them and fills both flags. The scrape and classify commands are independent; the classifier does not publish dashboard JSON or change dashboard reads.

## Evaluate without database writes

The evaluation CLI reads a frozen JSON snapshot and a standalone classification configuration. It does not import production CLI startup code or create a database pool. Eligibility is bypassed for prompt evaluation; candidate flags are retained as supplied, with missing archived/template values left `null`. Project-type calls run independently of affiliation results. Output files contain raw model replies and full input snapshots, so the CLI creates the report with mode `0600`.

The local example uses Ollama's OpenAI-compatible endpoint directly and requests the task-specific JSON schema. Ollama documents `response_format` and `max_tokens` for this API ([structured outputs](https://github.com/ollama/ollama/blob/main/docs/capabilities/structured-outputs.mdx), [OpenAI compatibility](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx)). The separate workspace proxy at port 8000 currently accepts a fixed legacy task schema, so it cannot satisfy this response contract; use the Ollama `/v1` endpoint until that proxy supports caller supplied schemas.

```sh
npm run evaluate:classification -- \
  --fixtures /absolute/path/candidates.json \
  --config config/evaluation.example.json \
  --output /private/tmp/classification-results.json
```

Fixtures use a top-level array or `{ "cases": [...] }`. Each case includes `caseId`, `snapshotAt`, `inputHash` (a lowercase SHA-256 digest; it is computed from the source snapshot when omitted), institution context, candidate evidence, optional human labels, `labelRationale`, and `split` (`development` or `held_out`). Human `uncertain` affiliation labels are reported as unresolved and excluded from definitive metrics. Reserve held-out cases before prompt tuning.

First-pass metrics stay strict. The report's `productionPipeline` section processes the same first replies the way `npm run classify` would store them: citation repair, one missing-score follow-up (the only extra requests, counted under `followUpRequests`), and the affiliation evidence gate. It reports how many results that pipeline accepts, its repairs and retries, and affiliation and project-type metrics computed from its outcomes. Each case carries its own `pipeline` outcome. Project types are still evaluated for every case, not only supported affiliations. Reports separate logical requests from transport attempts, first-attempt outcomes, provider success, JSON/schema/citation/full-contract validity, uncertainty, latency, and available token usage. Evidence-reference validity is reported separately from canonical quote validity. Label provenance is explicit; accuracy metrics use only `independent_human` labels, while historical model output, agent suggestions, synthetic expectations, and unreviewed cases remain outside human-accuracy denominators. Affiliation confusion counts, precision, recall, and coverage include explicit denominators and are split by development and held-out sets. Project-type reports include a confusion matrix and per-class counts. Unsupported-claim review is counted only when a human review is recorded; valid quotations demonstrate traceability and are not automatic hallucination detection. The paired-report helper matches cases by input hash, institution and candidate context, split, labels, and repository group; it reports mismatches and bootstraps quality differences by repository group. Missing independent labels produce unavailable accuracy intervals, not zero-error claims. The six-record smoke sample is not sufficient to establish accuracy or justify changing the default `0.40` threshold.

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

`enrichmentApi` is optional and accepts `graphql` (the default) or `rest`. With credentials, `graphql` reads README, community files, and release downloads through batched GraphQL queries; an anonymous client always uses REST because GraphQL requires authentication. Set `rest` to return to per-repository REST reads. See [GraphQL enrichment](#graphql-enrichment).

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

The diagnostic uses the same credential selection as collection: a `GITHUB_TOKEN` already in the process environment takes precedence over the repository-root `.env`. An empty exported `GITHUB_TOKEN` remains empty rather than being replaced from `.env`. The report identifies the source and whether credential material is present, but never prints it or claims it has been authenticated. `gh auth status` may describe a different credential from the one the finder selected.

## Run a demo

Use demo mode to exercise repository enrichment for a small sample without touching PostgreSQL:

```sh
npm start -- --config config/universities.json --university "Saint Louis University" --demo --demo-limit 10 --verbose
```

The `--university` value must match exactly one configured key. The default limit is 10; `--demo-limit` accepts 1–100. Demo mode makes one bounded repository-search operation for the selected university's configured repository query (or the normal default query), reads only its first search page, and enriches up to the requested number of unique candidates in returned order. The shared request client may repeat a transient or quota-limited HTTP request within its retry policy. It reports GitHub's search total separately from the sample size. An empty first page is a successful empty demo when GitHub reports a total of zero. An incomplete or malformed search response fails the demo.

Demo mode omits organization and user searches, owner enumeration and owner repository listings, logical search retries, search pagination and partitioning, database preflight, checkpoints, and publication. The shared request client retains its bounded handling for transient HTTP failures. Demo uses the same enrichment and repository skip rules as collection. Documented repository skips are reported and do not fail a completed demo; other enrichment errors do. `--mode refresh`, `--run-id`, and `--strict` cannot be combined with `--demo`.

The terminal summary and versioned JSON report are labeled `demo`, `sampled`, and `not published`. Reports are written to the ignored `find/reports/` directory and contain counts, repository names and IDs, statuses, sanitized diagnostics, and timings. They do not contain scraped repository content, credentials, raw API responses, or database values. A demo never creates a database pool, performs a database preflight, writes checkpoints, or publishes rows. It is not a completeness check and must not be used for production health or completeness metrics.

Demo requests honor GitHub's primary and secondary rate limits. A scheduled quota wait of up to five seconds is honored. If the next required request needs a longer wait, the demo stops promptly with `quota-wait-budget-exceeded`, without sending early. Production collection retains its existing quota waits and retry behavior.

## Run a scrape

Before making GitHub requests, the CLI performs a read-only database preflight: it checks connectivity, the staging and checkpoint tables, required columns, and the application's schema and table privileges. It does not create schema or write probe rows, and it cannot guarantee that the database remains available for a later transaction.

From `find/`, after building, run a full discovery or refresh known repositories:

```sh
npm start -- --config config/universities.json --mode full
npm start -- --config config/universities.json --mode refresh
```

Full mode is the default. Pass `--university "Saint Louis University"` to collect one exact configured key. Pass `--run-id <id>` to resume saved work; GitHub Actions supplies its run ID automatically, so rerunning a failed or interrupted workflow resumes completed repository enrichments and documented repository skips. Discovery candidates and completed repository results are checkpointed in PostgreSQL, then published to `repository_scraping` in one transaction after the university's candidates finish. If a run stops before discovery is checkpointed, discovery is retried; once its candidate set is checkpointed, completed repositories and skips are reused on resume and are not requested again. A fresh run can try a previously skipped repository again.

Refresh mode lists the current `repository_scraping` snapshot and sends `If-None-Match` with each saved repository ETag. Rows whose `archived` or `is_template` flag is `NULL` (rows that predate those columns) are listed without their ETag and fetched unconditionally, so the flags are filled. A `304` is checkpointed as unchanged and skips enrichment; changed repositories are enriched and published when the university completes. Authenticated conditional requests returning `304` do not count against GitHub's primary REST limit ([GitHub guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)). Search and owner-listing responses omit `subscribers_count`, so both modes fetch each repository's detail resource and save its ETag. Full discovery also sends the saved ETag for repositories already in `repository_scraping`, so an unchanged repository costs one free `304` in either mode and its published row is kept. Unchanged repositories are not re-enriched, so their release download counts stay at the last enriched value until the repository resource changes. A changed repository also sends its saved contributor-list ETag with `GET /repos/{owner}/{repo}/contributors?per_page=100`; a `304` reuses the published `contributors` and `contributor_count`, so a repository whose contributors did not change costs no contributor quota. A first-page `304` cannot show that later pages are unchanged, and a full page cannot show that no contributor was added after it, so the finder saves a contributor ETag only for a list that fits in one page with fewer than 100 entries. Larger lists, and stored lists that are not a JSON array of logins, are read again in full. Optional files are located from one root directory listing (plus `.github/` and `docs/` listings only when those directories exist) instead of probing each `SECURITY.md` and issue-template path.

Best-effort policy skips documented owner-listing 404s, repository-detail 404s after discovery or for known repositories during a refresh, repository endpoints whose structured GitHub response has `block.reason === 'tos'`, repository-scoped HTTP 451 responses, and the exact GitHub response that says a repository's contributor history is too large to list. That contributor exception applies only to the candidate's trusted `/repos/{owner}/{repo}/contributors` endpoint. It discards the whole in-progress record and checkpoints `github_contributors_unavailable`; it never stores an empty or partial contributor list. Unknown 403s remain fatal. Pass `--strict` to make all owner and repository skips fatal before publishing that university. Both policies normalize actual NUL characters in descriptive text to U+FFFD and report each affected repository, field, and replacement count. The library's `discoverRepositories` and `runScraping` entry points default to `best-effort`; callers can pass `policy: 'strict'` explicitly.

### GraphQL enrichment

After the repository resource passes the ETag check, enrichment reads each repository's README, `CODE_OF_CONDUCT`, `CONTRIBUTING`, pull-request and issue templates, `SECURITY.md`, and release downloads from batched GraphQL queries in the separate `graphql` quota. Concurrent repositories share a snapshot query (root, `.github`, and `docs` trees plus up to 100 releases with up to 100 assets each), and later file reads are batched and pinned to the snapshot's default-branch commit. Repository fields, including `subscribers_count`, still come from the REST repository resource, and contributors stay on REST because GraphQL has no equivalent. A first-time repository therefore costs the ETag check plus its contributor pages in core quota; a changed repository with an unchanged contributor list of fewer than 100 entries costs only the repository resource, because its contributor read is a free `304`.

GraphQL answers a field only when it can return the REST value exactly. Otherwise that read uses REST: symlinks, submodules, binary files, files over 512,000 bytes or not stored as UTF-8, directories over REST's 1,000-entry listing limit, more than 100 releases or assets, a README outside the root or more than one README candidate, and community-file names other than the recognized forms. Batch sizes follow `repositoryConcurrency`. The [design note](../docs/plans/graphql-enrichment.md) maps every staging field to its source and lists the remaining semantic differences.

### HTTP error policy

| GitHub response | Shared request behavior | Best-effort collection | Strict collection |
| --- | --- | --- | --- |
| `401` | Terminal authentication failure; the same token is not retried. | Fail the university. | Fail the university. |
| `403` with recognized quota evidence, or `429` | Use bounded rate-limit recovery and shared cooldowns. | Resume after recovery, or fail when its budget is exhausted. | Same. |
| Structured repository ToS `403` | Do not transiently retry. | Skip the whole repository. | Fail before publishing the university. |
| Exact contributor-list-size `403` on the candidate's trusted contributors endpoint, including a conditional request | Terminal permission response; retain the stable `github_contributors_size_limit` diagnostic. | Skip the whole repository as `github_contributors_unavailable`; discard any earlier contributor pages and keep the saved contributor ETag unpublished. | Fail before publishing the university. |
| Other `403`, including unknown, SSO, or permission denials | Terminal access failure with safe evidence. | Fail; do not skip owners or repositories. | Same. |
| Owner-listing `404` or root repository-detail `404` after discovery | Do not retry. | Skip the documented owner or repository. | Fail before publishing the university. |
| Optional-resource `404` | Do not retry. | Keep the documented absent-field behavior, such as a missing README. | Same. |
| Other `404` | Terminal not-found error with endpoint context. | Fail; do not infer an empty result. | Same. |
| Repository-scoped `451` | Do not retry; match the trusted API origin and requested repository path or its slash-delimited descendants. | Skip the entire repository and report the legal unavailability category and safe request ID. | Fail before publishing the university. |
| Search, owner-listing, or unrelated `451` | Do not retry. | Fail because discovery coverage is unknown. | Same. |
| `408`, `500`, `502`, `503`, `504` | Retry within the existing transient request budget. A valid `Retry-After` is a minimum wait; waits above 60 seconds fail safely instead of retrying early. | Fail after the bounded request budget is exhausted. | Same. |
| `400`, `409`, `410`, `412`, `422` | Terminal invalid-request, conflict, gone, precondition, or validation diagnostic. | Fail; do not rewrite the query or request automatically. | Same. |
| `202` | Unsupported asynchronous response; fail before publication. | Fail the university. | Same. |
| `204` | Accept only for the documented empty contributor-list response, with or without a saved contributor ETag. | Store an empty list; other endpoints fail rather than becoming empty data. | Same. |
| `304` | Accept only for an ETag-conditional request: a saved repository's refresh, or the first contributor page of a saved single-page list. | Preserve that saved repository snapshot as unchanged, or reuse the published contributor list. | Same. |
| GraphQL error attributed to a repository (any `errors[].path` under its alias), or a different `databaseId` | Not retried as GraphQL. | Request the REST repository resource; its `404`, ToS `403`, or `451` row above decides the skip, and a `200` continues the repository through REST. | Same evidence; skips fail before publishing the university. |
| GraphQL `RATE_LIMITED` (HTTP `200`), or a GraphQL `403`/`429` with quota evidence | Pause the `graphql` bucket for a primary limit, or every bucket for a secondary limit, within the rate-limit recovery budget. | Resume after recovery, or fail when its budget is exhausted. | Same. |
| GraphQL `408`/`5xx`/timeout, or an unattributed GraphQL error | Retry within the transient request budget, then split the batch in half. | A single repository that still fails is read through REST. | Same. |
| GraphQL query rejected (`extensions.code` validation error), `401`, or other `403` | Terminal; no REST fallback. | Fail the university. | Same. |

API redirects are followed manually for at most five hops. Every target must use HTTPS and the configured API origin; loops, invalid locations, insecure targets, and cross-origin redirects fail without forwarding the token. Redirects stay inside one request attempt and use the original timeout and retry budgets.

The separate [collection workflow](../.github/workflows/collect-find.yml) runs full discovery on the first Monday of each month and refreshes on other Mondays. Manual dispatch supports full or refresh mode and an optional university key or previous run ID. Workflow concurrency queues collection runs, and PostgreSQL advisory locks allow CLI invocations for different university keys to run concurrently against the same database. Each invocation reserves all selected university keys before collection starts and holds them until cleanup; an overlapping selection fails immediately and releases any locks it acquired. Use `--university` to select a single configured key. Full, refresh, and resumed runs use the same locks. Older binaries holding the former database-wide lock still exclude new collectors (and vice versa); restart them with the updated build to enable concurrent collections. Separate processes still share GitHub account or IP quota and do not coordinate their request queues. Configure the `FINDER_GITHUB_TOKEN` secret with a personal access token that can read public repositories (a fine-grained token with public-repository read access is enough), the `FINDER_PGHOST`, `FINDER_PGDATABASE`, `FINDER_PGUSER`, and `FINDER_PGPASSWORD` database secrets, and the optional `FINDER_PGPORT` secret. The workflow passes the token to the finder as `GITHUB_TOKEN` and stops before building if it is missing. Set the `FINDER_UNIVERSITIES_CONFIG_JSON` repository variable to the production JSON configuration; otherwise the workflow uses the checked-in example configuration.

The CLI distinguishes complete, partial, failed, interrupted, and not-run university outcomes. A university is partial when an owner or repository was skipped, or descriptive text needed NUL replacement. An all-skipped university is partial with zero committed rows. A stop during an active university records it as interrupted; universities that have not started remain not-run, and earlier completed universities remain complete or partial. Summaries and progress report observed skip and warning counts; they do not estimate missing repositories. If a run includes both partial and failed universities, the fatal failure determines the exit code.

Every collection run writes a version 4 machine-readable JSON report to the ignored `find/reports/` directory and prints its path in the final summary. Version 4 adds `unchangedRepositories` per university and in the summary: repositories that returned `304 Not Modified` are kept as published and are not counted in `committedAssociations`, so an all-unchanged run reports zero committed rows. Version 3 added the separate `interrupted` outcome and `interruptedUniversities` count; previously written reports remain unchanged. Reports include start and finish timestamps, policy, per-university status, committed and unchanged counts, skipped owners and repositories, text-normalization warnings, and safe failure or interruption diagnostics. Diagnostics allowlist phase, repository/owner, cancellation source, category, sanitized endpoint path, HTTP status, request ID, retry and rate-limit data, block reason, validation field, SQLSTATE, and failed batch number/size. Repository skip entries retain the safe GitHub request ID when available. Search diagnostics add stable failure reason, search kind, stage, safe counts, logical search attempts, exhaustion state, and a static remediation hint. Access diagnostics preserve allowlisted 403 reason and SSO status plus parsed quota observations; an unknown 403 remains fatal and says its exact cause is unconfirmed. Legal-restriction diagnostics never include an inferred legal cause. Credentials, headers, query parameters, bind values, raw content, arbitrary response bodies, and PostgreSQL detail strings are not recorded. Report-writing errors are printed clearly and return exit code `1` unless a signal or recorded fatal failure determines the outcome; an interrupted run still returns its signal exit code, and the failed report path is shown as unavailable. Exit codes are `0` for complete success, `2` for partial completion, and `1` for fatal failure; `SIGINT` and `SIGTERM` retain exit codes `130` and `143`.

Each university's checkpointed results remain outside the dashboard staging table until publication. A failed or interrupted university publishes no incomplete in-flight records; cancellation before transaction commit rolls publication back and retains its checkpoints. If the transaction commits before a concurrent stop is observed, the report keeps the committed count. Prior successful universities remain committed. Repeated successful upserts update `(id, university)` rows atomically and preserve downstream analysis fields. A published full run removes repository and ETag rows that were not rediscovered as complete or unchanged, including repositories whose detail request now returns 404. It keeps rows for repositories skipped for another documented reason (451, Terms of Service block, or contributor-history limit), which still exist, and rows owned by a skipped owner, whose repositories could not be listed. Refresh runs never remove rows; a known repository that has become unavailable is skipped and reported. Kept rows for skipped repositories and owners can be stale and bias downstream counts, coverage, and other metrics. Review the report and account for partial coverage before comparing downstream results.

Pass `--verbose` or `-v` to show progress:

```sh
npm start -- --config config/universities.json --verbose
```

On a terminal, verbose mode updates one line with the current university, phase-local counts, active and queued requests, known quota waits, and elapsed time. When output is redirected, it prints phase changes and waits of at least five seconds without ANSI codes or per-request output. The default mode stays quiet during work. Both modes include elapsed time in the final summary. `Ctrl+C` and `SIGTERM` cancel queued and in-flight GitHub requests, retain resumable checkpoints, release the collection lock, and allow cleanup and report writing to finish.

All repository candidates, owner listings, details, README data, release pages, contributor pages, community metadata, content reads, and GraphQL queries use the shared request client. Documented missing optional files, such as a README `404`, are stored as `NULL`. Authentication failures, ordinary permission and SSO restrictions, exhausted retries, malformed responses, incomplete discovery, unexpected API errors, and database errors fail the university.

Owner-listing recovery preserves its established behavior: it applies only to HTTP 404 responses from `GET /orgs/{login}/repos` or `GET /users/{login}/repos`. It does not treat 404 as an empty repository list and never substitutes a user endpoint for an organization endpoint. If a later page for an owner returns 404, that owner's earlier pages are discarded and the owner is reported as skipped; repository candidates discovered independently remain available. At enrichment, a root repository-detail 404, a structured ToS block, a repository-scoped 451, or GitHub's exact contributor-history-size-limit 403 on the candidate's contributors endpoint is skippable in best-effort mode. Contributor skip matching requires the exact message, a permission-classified 403 without rate-limit or SSO evidence, and both the original and effective HTTPS URLs to point to the exact candidate `/contributors` path on the configured API origin. A failure on a later contributor page discards all pages already read. Generic 403 responses, SSO restrictions, 401s, quota exhaustion, other unexpected API errors, incomplete searches, and database failures remain fatal. Strict mode writes no rows for a university when a documented skip condition occurs.

Actual U+0000 in descriptive text fields is replaced with U+FFFD before binding values to PostgreSQL. The warning identifies the repository, field, and count. Other Unicode, tabs, line endings, empty values, and the literal six-character `\\u0000` text are preserved. IDs, names, URLs, timestamps, contributor logins, and other structural values are validated and never rewritten. Supported JSON issue-template entries are parsed, their content strings normalized, and valid JSON re-serialized; contributor identities are not normalized.

Raw GitHub content is decoded using the platform's standard UTF-8 `Response.text()` behavior. The finder does not detect or reinterpret binary or UTF-16 data; malformed UTF-8 is decoded with U+FFFD by the platform before text normalization.

See GitHub's separate endpoint references for [listing organization repositories](https://docs.github.com/en/rest/repos/repos#list-organization-repositories) and [listing repositories for a user](https://docs.github.com/en/rest/repos/repos#list-repositories-for-a-user).

The request client tracks the `core`, `search`, and `graphql` primary limit buckets separately (GraphQL responses report `x-ratelimit-resource: graphql`), pauses every bucket for secondary limits, observes `Retry-After` and quota reset headers, and adds a one-second reset buffer. Ordinary permission `403` and authentication `401` failures stop promptly. Transient HTTP retries are limited to `408`, `500`, `502`, `503`, and `504`; 409 and 412 are terminal by default. Transient request retries and quota recovery have separate bounded budgets. A valid `Retry-After` on a transient server response is honored as a minimum wait up to 60 seconds; longer requests stop with a safe diagnostic rather than retrying early. Repeated quota failures include the request ID, bucket, remaining quota, reset/retry time, attempts, and stop reason where GitHub supplied those values. Successful responses reporting zero remaining quota pause later requests in that bucket until the later of the buffered reset deadline and `Retry-After`. When reset data is missing, malformed, or already past, the client uses a bounded 60-second conservative wait before retrying. See GitHub's [REST API rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) and [troubleshooting guidance](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api).

`GITHUB_TOKEN` and the repository-root `.env` are read at runtime, so changing the token does not require rebuilding. The collection workflow uses the `FINDER_GITHUB_TOKEN` secret. A token is recommended for broad collections: GitHub documents a 60-request-per-hour primary limit for unauthenticated REST requests, compared with 5,000 requests per hour for a personal authenticated limit ([rate-limit details](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)). A GitHub CLI login is separate from `GITHUB_TOKEN`; the finder uses the environment value only. Never paste tokens into command output or logs. Broad acronym searches such as `SLU` return candidates, not verified university affiliations; review them downstream.

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

This exercises the real finder store against PostgreSQL, including insert, rerun/update, same ID under two universities, quoted input, rollback, and connection release. `scripts/db/verify.sh` checks the fresh schema, application-role CRUD, repeatable bootstrap, preservation of existing tables, and the classification migration against a legacy row and a newly structured prediction.
