\set ON_ERROR_STOP on

DO $$
DECLARE
    relation_name TEXT;
    expected_columns TEXT[];
    actual_columns TEXT[];
    expected_key TEXT[];
    actual_key TEXT[];
BEGIN
    FOR relation_name, expected_columns, expected_key IN
        SELECT *
        FROM (VALUES
            (
                'repositories',
                ARRAY[
                    'university', 'id', 'full_name', 'owner', 'license', 'language', 'html_url',
                    'description', 'fork', 'created_at', 'updated_at', 'pushed_at', 'homepage',
                    'size', 'stargazers_count', 'readme', 'watchers_count', 'forks_count',
                    'open_issues_count', 'watchers', 'organization', 'release_downloads',
                    'contributors', 'contributor_count', 'bus_factor', 'code_of_conduct_file',
                    'contributing', 'security_policy', 'issue_templates', 'pull_request_template',
                    'subscribers_count', 'affiliation_prediction_gpt5_mini', 'type_prediction_gpt5_mini'
                ]::TEXT[],
                ARRAY['id', 'university']::TEXT[]
            ),
            (
                'organizations',
                ARRAY[
                    'login', 'name', 'description', 'location', 'company', 'email', 'url',
                    'created_at', 'updated_at', 'university', 'affiliation_prediction_orgs'
                ]::TEXT[],
                ARRAY['login', 'university']::TEXT[]
            ),
            (
                'security',
                ARRAY[
                    'html_url', 'binary_artifacts', 'branch_protection', 'ci_tests',
                    'cii_best_practices', 'code_review', 'contributors', 'dangerous_workflow',
                    'dependency_update_tool', 'fuzzing', 'license', 'maintained', 'packaging',
                    'pinned_dependencies', 'sast', 'security_policy', 'signed_releases',
                    'token_permissions', 'vulnerabilities', 'total_score'
                ]::TEXT[],
                ARRAY['html_url']::TEXT[]
            ),
            (
                'repository_scraping',
                ARRAY[
                    'university', 'id', 'full_name', 'owner', 'license', 'language', 'html_url',
                    'description', 'fork', 'created_at', 'updated_at', 'pushed_at', 'homepage',
                    'size', 'stargazers_count', 'readme', 'watchers_count', 'forks_count',
                    'open_issues_count', 'watchers', 'organization', 'release_downloads',
                    'contributors', 'contributor_count', 'bus_factor', 'code_of_conduct_file',
                    'contributing', 'security_policy', 'issue_templates', 'pull_request_template',
                    'subscribers_count', 'affiliation_prediction_gpt5_mini',
                    'type_prediction_gpt5_mini', 'scraped_at'
                ]::TEXT[],
                ARRAY['id', 'university']::TEXT[]
            ),
            (
                'repository_scraping_cache',
                ARRAY['university', 'repository_id', 'etag', 'updated_at']::TEXT[],
                ARRAY['university', 'repository_id']::TEXT[]
            ),
            (
                'repository_scraping_runs',
                ARRAY[
                    'run_id', 'university', 'mode', 'status', 'candidate_count',
                    'committed_count', 'skipped_owners', 'skipped_repositories',
                    'warnings', 'created_at', 'updated_at', 'completed_at'
                ]::TEXT[],
                ARRAY['run_id', 'university']::TEXT[]
            ),
            (
                'repository_scraping_run_repositories',
                ARRAY[
                    'run_id', 'university', 'repository_id', 'candidate', 'status',
                    'record', 'etag', 'skipped_repository', 'warnings', 'updated_at'
                ]::TEXT[],
                ARRAY['run_id', 'university', 'repository_id']::TEXT[]
            )
        ) AS expected(name, columns, primary_key)
    LOOP
        SELECT array_agg(column_info.column_name::TEXT ORDER BY column_info.ordinal_position)
        INTO actual_columns
        FROM information_schema.columns AS column_info
        WHERE column_info.table_schema = 'public'
            AND column_info.table_name = relation_name;

        IF actual_columns IS DISTINCT FROM expected_columns THEN
            RAISE EXCEPTION 'Column contract mismatch for public.%: expected %, received %',
                relation_name,
                expected_columns,
                actual_columns;
        END IF;

        SELECT array_agg(attribute.attname::TEXT ORDER BY key_column.ordinality)
        INTO actual_key
        FROM pg_catalog.pg_constraint AS constraint_info
        CROSS JOIN LATERAL unnest(constraint_info.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = constraint_info.conrelid
            AND attribute.attnum = key_column.attnum
        WHERE constraint_info.contype = 'p'
            AND constraint_info.conrelid = pg_catalog.to_regclass('public.' || relation_name);

        IF actual_key IS DISTINCT FROM expected_key THEN
            RAISE EXCEPTION 'Primary key mismatch for public.%: expected %, received %',
                relation_name,
                expected_key,
                actual_key;
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_roles AS role_info
        WHERE role_info.rolname = current_user
            AND (role_info.rolsuper OR role_info.rolcreatedb OR role_info.rolcreaterole)
    ) THEN
        RAISE EXCEPTION 'Application role % has elevated role attributes', current_user;
    END IF;

    IF NOT has_database_privilege(current_user, current_database(), 'CONNECT')
        OR NOT has_schema_privilege(current_user, 'public', 'USAGE') THEN
        RAISE EXCEPTION 'Application role % lacks database or schema access', current_user;
    END IF;

    IF NOT has_table_privilege(current_user, 'public.repositories', 'SELECT')
        OR NOT has_table_privilege(current_user, 'public.repositories', 'INSERT')
        OR NOT has_table_privilege(current_user, 'public.repositories', 'UPDATE')
        OR NOT has_table_privilege(current_user, 'public.repositories', 'DELETE')
        OR NOT has_table_privilege(current_user, 'public.organizations', 'SELECT')
        OR NOT has_table_privilege(current_user, 'public.organizations', 'INSERT')
        OR NOT has_table_privilege(current_user, 'public.organizations', 'UPDATE')
        OR NOT has_table_privilege(current_user, 'public.organizations', 'DELETE')
        OR NOT has_table_privilege(current_user, 'public.security', 'SELECT')
        OR NOT has_table_privilege(current_user, 'public.security', 'INSERT')
        OR NOT has_table_privilege(current_user, 'public.security', 'UPDATE')
        OR NOT has_table_privilege(current_user, 'public.security', 'DELETE')
        OR NOT has_table_privilege(current_user, 'public.repository_scraping', 'SELECT')
        OR NOT has_table_privilege(current_user, 'public.repository_scraping', 'INSERT')
        OR NOT has_table_privilege(current_user, 'public.repository_scraping', 'UPDATE')
        OR NOT has_table_privilege(current_user, 'public.repository_scraping', 'DELETE')
        OR NOT has_table_privilege(current_user, 'public.repository_scraping_cache', 'SELECT')
        OR NOT has_table_privilege(current_user, 'public.repository_scraping_cache', 'INSERT')
        OR NOT has_table_privilege(current_user, 'public.repository_scraping_cache', 'UPDATE')
        OR NOT has_table_privilege(current_user, 'public.repository_scraping_cache', 'DELETE')
        OR NOT has_table_privilege(current_user, 'public.repository_scraping_runs', 'SELECT')
        OR NOT has_table_privilege(current_user, 'public.repository_scraping_runs', 'INSERT')
        OR NOT has_table_privilege(current_user, 'public.repository_scraping_runs', 'UPDATE')
        OR NOT has_table_privilege(current_user, 'public.repository_scraping_runs', 'DELETE')
        OR NOT has_table_privilege(current_user, 'public.repository_scraping_run_repositories', 'SELECT')
        OR NOT has_table_privilege(current_user, 'public.repository_scraping_run_repositories', 'INSERT')
        OR NOT has_table_privilege(current_user, 'public.repository_scraping_run_repositories', 'UPDATE')
        OR NOT has_table_privilege(current_user, 'public.repository_scraping_run_repositories', 'DELETE') THEN
        RAISE EXCEPTION 'Application role % lacks one or more table CRUD privileges', current_user;
    END IF;
END;
$$;

BEGIN;

INSERT INTO public.repositories (
    university,
    id,
    owner,
    fork,
    created_at,
    updated_at,
    size,
    stargazers_count,
    watchers_count,
    forks_count,
    open_issues_count,
    watchers,
    release_downloads,
    contributors,
    contributor_count,
    bus_factor,
    subscribers_count,
    affiliation_prediction_gpt5_mini
)
VALUES
    (
        'Issue 56 Verify A', 9876543210123, 'verify-owner', 0,
        '2024-05-06 07:08:09+00', '2024-05-07 07:08:09+00', 4, 3, 3, 1, 0, 3, 0,
        $$['alpha', 'beta']$$, 2, NULL, 1, 0.375
    ),
    (
        'Issue 56 Verify B', 9876543210123, 'verify-owner', 1,
        '2024-05-06 07:08:09+00', '2024-05-07 07:08:09+00', 4, 3, 3, 1, 0, 3, 0,
        $$['alpha', 'beta']$$, 2, 1.5, 1, 0.625
    );

INSERT INTO public.organizations (
    login,
    name,
    created_at,
    updated_at,
    university
)
VALUES (
    'issue-56-verify-org', NULL,
    '2024-05-06 07:08:09+00', '2024-05-07 07:08:09+00', 'Issue 56 Verify'
);

INSERT INTO public.security (
    html_url,
    binary_artifacts,
    branch_protection,
    ci_tests,
    cii_best_practices,
    code_review,
    contributors,
    dangerous_workflow,
    dependency_update_tool,
    fuzzing,
    license,
    maintained,
    packaging,
    pinned_dependencies,
    sast,
    security_policy,
    signed_releases,
    token_permissions,
    vulnerabilities,
    total_score
)
VALUES (
    'https://example.invalid/issue-56-verify', 1, -1, -1, 0, 1, 2, -1, 0, -1,
    1, 1, -1, -1, 0, 1, -1, -1, 4, 7.25
);

INSERT INTO public.repository_scraping (
    university, id, owner, fork, size, stargazers_count, watchers_count, forks_count,
    open_issues_count, watchers, release_downloads, contributors, contributor_count,
    subscribers_count, scraped_at
)
VALUES (
    'Issue 58 Verify', 9876543210456, 'verify-owner', 0, 0, 0, 0, 0,
    0, 0, 0, '[]', 0, 0, '2026-10-20 12:00:00+00'
);

DO $$
BEGIN
    IF (
        SELECT count(*)
        FROM public.repositories
        WHERE id = 9876543210123
            AND university IN ('Issue 56 Verify A', 'Issue 56 Verify B')
    ) <> 2 THEN
        RAISE EXCEPTION 'Repository composite key did not allow one ID in two universities';
    END IF;

    IF (
        SELECT count(*)
        FROM public.repositories
        WHERE university = 'Issue 56 Verify A'
            AND bus_factor IS NULL
            AND contributors = $opaque$['alpha', 'beta']$opaque$
            AND created_at = '2024-05-06 07:08:09+00'::TIMESTAMPTZ
            AND affiliation_prediction_gpt5_mini = 0.375
    ) <> 1 THEN
        RAISE EXCEPTION 'Repository nullable, timestamp, text, or fractional values did not round-trip';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.organizations
        WHERE login = 'issue-56-verify-org'
            AND name IS NULL
    ) THEN
        RAISE EXCEPTION 'Nullable organization name was not preserved';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.security
        WHERE html_url = 'https://example.invalid/issue-56-verify'
            AND ci_tests = -1
            AND dangerous_workflow = -1
            AND total_score = 7.25
    ) THEN
        RAISE EXCEPTION 'Security sentinel or fractional values did not round-trip';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.repository_scraping
        WHERE id = 9876543210456
            AND university = 'Issue 58 Verify'
            AND scraped_at = '2026-10-20 12:00:00+00'::TIMESTAMPTZ
            AND bus_factor IS NULL
            AND affiliation_prediction_gpt5_mini IS NULL
            AND type_prediction_gpt5_mini IS NULL
    ) THEN
        RAISE EXCEPTION 'Repository scraping row did not preserve nullable downstream fields';
    END IF;

    BEGIN
        INSERT INTO public.repositories (
            university, id, owner, fork, size, stargazers_count, watchers_count, forks_count,
            open_issues_count, watchers, release_downloads, contributor_count,
            subscribers_count, affiliation_prediction_gpt5_mini
        )
        VALUES (
            'Issue 56 Verify A', 9876543210123, 'duplicate', 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0
        );
        RAISE EXCEPTION 'Repository table accepted a duplicate composite primary key';
    EXCEPTION
        WHEN unique_violation THEN NULL;
    END;
END;
$$;

UPDATE public.repositories
SET description = 'CRUD verification'
WHERE university = 'Issue 56 Verify A'
    AND id = 9876543210123;

DELETE FROM public.repositories
WHERE university = 'Issue 56 Verify B'
    AND id = 9876543210123;

UPDATE public.repository_scraping
SET description = 'CRUD verification'
WHERE university = 'Issue 58 Verify'
    AND id = 9876543210456;

DELETE FROM public.repository_scraping
WHERE university = 'Issue 58 Verify'
    AND id = 9876543210456;

ROLLBACK;
