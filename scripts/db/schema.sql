\set ON_ERROR_STOP on

\getenv application_user APPLICATION_USER
\if :{?application_user}
\else
    \getenv application_user PGUSER
\endif

\if :{?application_user}
\else
    \echo 'Set APPLICATION_USER or PGUSER to the application role name.'
    \quit 1
\endif

CREATE TABLE IF NOT EXISTS public.repositories (
    university TEXT NOT NULL,
    id BIGINT NOT NULL,
    full_name TEXT,
    owner TEXT NOT NULL,
    license TEXT,
    language TEXT,
    html_url TEXT,
    description TEXT,
    fork INTEGER NOT NULL,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    pushed_at TIMESTAMPTZ,
    homepage TEXT,
    size BIGINT NOT NULL,
    stargazers_count BIGINT NOT NULL,
    readme TEXT,
    watchers_count BIGINT NOT NULL,
    forks_count BIGINT NOT NULL,
    open_issues_count BIGINT NOT NULL,
    watchers BIGINT NOT NULL,
    organization TEXT,
    release_downloads BIGINT NOT NULL,
    contributors TEXT,
    contributor_count BIGINT NOT NULL,
    bus_factor DOUBLE PRECISION,
    code_of_conduct_file TEXT,
    contributing TEXT,
    security_policy TEXT,
    issue_templates TEXT,
    pull_request_template TEXT,
    subscribers_count BIGINT NOT NULL,
    affiliation_prediction_gpt5_mini DOUBLE PRECISION NOT NULL,
    type_prediction_gpt5_mini TEXT,
    PRIMARY KEY (id, university)
);

CREATE TABLE IF NOT EXISTS public.organizations (
    login TEXT NOT NULL,
    name TEXT,
    description TEXT,
    location TEXT,
    company TEXT,
    email TEXT,
    url TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    university TEXT NOT NULL,
    affiliation_prediction_orgs TEXT,
    PRIMARY KEY (login, university)
);

CREATE TABLE IF NOT EXISTS public.security (
    html_url TEXT NOT NULL PRIMARY KEY,
    binary_artifacts INTEGER NOT NULL,
    branch_protection INTEGER NOT NULL,
    ci_tests INTEGER NOT NULL,
    cii_best_practices INTEGER NOT NULL,
    code_review INTEGER NOT NULL,
    contributors BIGINT NOT NULL,
    dangerous_workflow INTEGER NOT NULL,
    dependency_update_tool INTEGER NOT NULL,
    fuzzing INTEGER NOT NULL,
    license INTEGER NOT NULL,
    maintained INTEGER NOT NULL,
    packaging INTEGER NOT NULL,
    pinned_dependencies INTEGER NOT NULL,
    sast INTEGER NOT NULL,
    security_policy INTEGER NOT NULL,
    signed_releases INTEGER NOT NULL,
    token_permissions INTEGER NOT NULL,
    vulnerabilities BIGINT NOT NULL,
    total_score DOUBLE PRECISION NOT NULL
);

SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'application_user') \gexec
SELECT format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
    :'application_user'
) \gexec

\ir repository-scraping.sql
