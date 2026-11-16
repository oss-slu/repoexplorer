CREATE TABLE IF NOT EXISTS public.repository_scraping_cache (
    university TEXT NOT NULL,
    repository_id BIGINT NOT NULL CHECK (repository_id > 0),
    etag TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    contributors_etag TEXT,
    PRIMARY KEY (university, repository_id)
);

CREATE TABLE IF NOT EXISTS public.repository_scraping_runs (
    run_id TEXT NOT NULL,
    university TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('full', 'refresh')),
    status TEXT NOT NULL CHECK (status IN ('discovering', 'ready', 'complete')),
    candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
    committed_count INTEGER NOT NULL DEFAULT 0 CHECK (committed_count >= 0),
    skipped_owners JSONB NOT NULL DEFAULT '[]'::JSONB,
    skipped_repositories JSONB NOT NULL DEFAULT '[]'::JSONB,
    warnings JSONB NOT NULL DEFAULT '[]'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    PRIMARY KEY (run_id, university)
);

CREATE TABLE IF NOT EXISTS public.repository_scraping_run_repositories (
    run_id TEXT NOT NULL,
    university TEXT NOT NULL,
    repository_id BIGINT NOT NULL CHECK (repository_id > 0),
    candidate JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'unchanged', 'skipped')),
    record JSONB,
    etag TEXT,
    skipped_repository JSONB,
    warnings JSONB NOT NULL DEFAULT '[]'::JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    contributors_etag TEXT,
    PRIMARY KEY (run_id, university, repository_id),
    FOREIGN KEY (run_id, university)
        REFERENCES public.repository_scraping_runs (run_id, university)
        ON DELETE CASCADE,
    CHECK ((status = 'complete') = (record IS NOT NULL)),
    CHECK ((status = 'skipped') = (skipped_repository IS NOT NULL))
);

-- Tables created before conditional contributor reads gain the column with
-- NULL values; those repositories read contributors unconditionally once.
ALTER TABLE public.repository_scraping_cache
    ADD COLUMN IF NOT EXISTS contributors_etag TEXT;
ALTER TABLE public.repository_scraping_run_repositories
    ADD COLUMN IF NOT EXISTS contributors_etag TEXT;

COMMENT ON TABLE public.repository_scraping_runs IS
    'Durable per-university collection checkpoints; staged rows are published only after all candidates finish.';
COMMENT ON TABLE public.repository_scraping_cache IS
    'Conditional request metadata for known repository snapshots.';
COMMENT ON COLUMN public.repository_scraping_cache.contributors_etag IS
    'ETag of the published contributor list; set only for lists that fit in one non-full page.';
