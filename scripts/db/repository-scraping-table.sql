CREATE TABLE IF NOT EXISTS public.repository_scraping (
    university TEXT NOT NULL,
    id BIGINT NOT NULL CHECK (id > 0),
    full_name TEXT,
    owner TEXT NOT NULL,
    license TEXT,
    language TEXT,
    html_url TEXT,
    description TEXT,
    fork INTEGER NOT NULL CHECK (fork IN (0, 1)),
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    pushed_at TIMESTAMPTZ,
    homepage TEXT,
    size BIGINT NOT NULL CHECK (size >= 0),
    stargazers_count BIGINT NOT NULL CHECK (stargazers_count >= 0),
    readme TEXT,
    watchers_count BIGINT NOT NULL CHECK (watchers_count >= 0),
    forks_count BIGINT NOT NULL CHECK (forks_count >= 0),
    open_issues_count BIGINT NOT NULL CHECK (open_issues_count >= 0),
    watchers BIGINT NOT NULL CHECK (watchers >= 0),
    organization TEXT,
    release_downloads BIGINT NOT NULL CHECK (release_downloads >= 0),
    contributors TEXT NOT NULL,
    contributor_count BIGINT NOT NULL CHECK (contributor_count >= 0),
    bus_factor DOUBLE PRECISION,
    code_of_conduct_file TEXT,
    contributing TEXT,
    security_policy TEXT,
    issue_templates TEXT,
    pull_request_template TEXT,
    subscribers_count BIGINT NOT NULL CHECK (subscribers_count >= 0),
    affiliation_prediction_gpt5_mini DOUBLE PRECISION,
    type_prediction_gpt5_mini TEXT,
    scraped_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (id, university)
);

COMMENT ON TABLE public.repository_scraping IS
    'Raw GitHub repository snapshot and optional enrichment before downstream analysis.';
COMMENT ON COLUMN public.repository_scraping.organization IS
    'Legacy dataset marker: text "1" means the GitHub repository owner is an organization; NULL means an individual owner.';
COMMENT ON COLUMN public.repository_scraping.contributors IS
    'JSON array of contributor logins stored as TEXT; anonymous contributors are excluded by the GitHub endpoint.';
COMMENT ON COLUMN public.repository_scraping.bus_factor IS
    'Downstream-derived value; scraping inserts NULL and preserves existing values on rerun.';
COMMENT ON COLUMN public.repository_scraping.affiliation_prediction_gpt5_mini IS
    'Downstream-derived value; scraping inserts NULL and preserves existing values on rerun.';
COMMENT ON COLUMN public.repository_scraping.type_prediction_gpt5_mini IS
    'Downstream-derived value; scraping inserts NULL and preserves existing values on rerun.';
