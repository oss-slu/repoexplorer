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
    archived BOOLEAN,
    is_template BOOLEAN,
    PRIMARY KEY (id, university)
);

-- Existing staging rows predate eligibility metadata and stay NULL until the
-- repository is fetched again. The finder ignores a saved ETag for rows with
-- either flag NULL, so the next full or refresh run refetches and fills them.
-- Classification treats unknown values as ineligible rather than assuming an
-- archived/template flag is false.
ALTER TABLE public.repository_scraping
    ADD COLUMN IF NOT EXISTS archived BOOLEAN;
ALTER TABLE public.repository_scraping
    ADD COLUMN IF NOT EXISTS is_template BOOLEAN;

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

CREATE TABLE IF NOT EXISTS public.repository_classification_predictions (
    id BIGINT NOT NULL,
    university TEXT NOT NULL,
    task TEXT NOT NULL CHECK (task IN ('affiliation', 'project_type')),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    threshold DOUBLE PRECISION NOT NULL CHECK (threshold >= 0 AND threshold <= 1),
    input_hash TEXT NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
    score DOUBLE PRECISION CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
    category TEXT CHECK (category IS NULL OR category IN ('DEV', 'EDU', 'DOCS', 'WEB', 'DATA', 'OTHER')),
    affiliation_decision TEXT CHECK (affiliation_decision IS NULL OR affiliation_decision IN ('supported', 'not_supported', 'uncertain')),
    affiliation_relationship TEXT CHECK (affiliation_relationship IS NULL OR affiliation_relationship IN ('institutional_project', 'research_group', 'coursework', 'student_organization', 'maintainer_affiliation', 'incidental_mention', 'insufficient_evidence')),
    affiliation_evidence JSONB CHECK (affiliation_evidence IS NULL OR jsonb_typeof(affiliation_evidence) = 'array'),
    explanation TEXT,
    status TEXT NOT NULL,
    simulated BOOLEAN NOT NULL,
    error_message TEXT,
    classified_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (id, university, task, provider, model, prompt_version, threshold, input_hash),
    FOREIGN KEY (id, university)
        REFERENCES public.repository_scraping (id, university)
        ON DELETE CASCADE,
    CONSTRAINT repository_classification_predictions_task_status_check CHECK (
        (task = 'affiliation' AND status IN ('predicted', 'below_threshold', 'not_supported', 'uncertain', 'ineligible', 'failed'))
        OR (task = 'project_type' AND status IN ('predicted', 'skipped_threshold', 'skipped_eligibility', 'skipped_affiliation_failed', 'skipped_affiliation_uncertain', 'skipped_affiliation_rejected', 'failed'))
    ),
    CONSTRAINT repository_classification_predictions_result_check CHECK (
        (task = 'affiliation' AND category IS NULL AND
            ((status IN ('predicted', 'below_threshold', 'not_supported') AND score IS NOT NULL) OR
             (status = 'uncertain' AND score IS NULL) OR
             (status IN ('ineligible', 'failed') AND score IS NULL)))
        OR
        (task = 'project_type' AND score IS NULL AND
            ((status = 'predicted' AND category IS NOT NULL) OR
             (status IN ('skipped_threshold', 'skipped_eligibility', 'skipped_affiliation_failed', 'skipped_affiliation_uncertain', 'skipped_affiliation_rejected', 'failed') AND category IS NULL)))
    )
);

-- CREATE TABLE IF NOT EXISTS does not upgrade a classification table on an existing volume.
ALTER TABLE public.repository_classification_predictions
    ADD COLUMN IF NOT EXISTS affiliation_decision TEXT
        CHECK (affiliation_decision IS NULL OR affiliation_decision IN ('supported', 'not_supported', 'uncertain')),
    ADD COLUMN IF NOT EXISTS affiliation_relationship TEXT
        CHECK (affiliation_relationship IS NULL OR affiliation_relationship IN ('institutional_project', 'research_group', 'coursework', 'student_organization', 'maintainer_affiliation', 'incidental_mention', 'insufficient_evidence')),
    ADD COLUMN IF NOT EXISTS affiliation_evidence JSONB
        CHECK (affiliation_evidence IS NULL OR jsonb_typeof(affiliation_evidence) = 'array');

-- Replace the original unnamed status/result checks without touching existing rows.
ALTER TABLE public.repository_classification_predictions
    DROP CONSTRAINT IF EXISTS repository_classification_predictions_check,
    DROP CONSTRAINT IF EXISTS repository_classification_predictions_check1,
    DROP CONSTRAINT IF EXISTS repository_classification_predictions_check5,
    DROP CONSTRAINT IF EXISTS repository_classification_predictions_check6,
    DROP CONSTRAINT IF EXISTS repository_classification_predictions_task_status_check,
    DROP CONSTRAINT IF EXISTS repository_classification_predictions_result_check,
    DROP CONSTRAINT IF EXISTS repository_classification_predictions_threshold_check,
    DROP CONSTRAINT IF EXISTS repository_classification_predictions_affiliation_fields_check;

ALTER TABLE public.repository_classification_predictions
    ADD CONSTRAINT repository_classification_predictions_task_status_check CHECK (
        (task = 'affiliation' AND status IN ('predicted', 'below_threshold', 'not_supported', 'uncertain', 'ineligible', 'failed'))
        OR (task = 'project_type' AND status IN ('predicted', 'skipped_threshold', 'skipped_eligibility', 'skipped_affiliation_failed', 'skipped_affiliation_uncertain', 'skipped_affiliation_rejected', 'failed'))
    ),
    ADD CONSTRAINT repository_classification_predictions_result_check CHECK (
        (task = 'affiliation' AND category IS NULL AND
            ((status IN ('predicted', 'below_threshold', 'not_supported') AND score IS NOT NULL) OR
             (status = 'uncertain' AND score IS NULL) OR
             (status IN ('ineligible', 'failed') AND score IS NULL)))
        OR
        (task = 'project_type' AND score IS NULL AND
            ((status = 'predicted' AND category IS NOT NULL) OR
             (status IN ('skipped_threshold', 'skipped_eligibility', 'skipped_affiliation_failed', 'skipped_affiliation_uncertain', 'skipped_affiliation_rejected', 'failed') AND category IS NULL)))
    ),
    ADD CONSTRAINT repository_classification_predictions_threshold_check CHECK (
        threshold >= 0 AND threshold <= 1
    ),
    ADD CONSTRAINT repository_classification_predictions_affiliation_fields_check CHECK (
        (affiliation_decision IS NULL AND affiliation_relationship IS NULL AND affiliation_evidence IS NULL)
        OR
        (task = 'affiliation' AND affiliation_decision IS NOT NULL AND affiliation_relationship IS NOT NULL AND affiliation_evidence IS NOT NULL AND
            ((affiliation_decision = 'uncertain' AND score IS NULL AND status = 'uncertain') OR
             (affiliation_decision = 'not_supported' AND score IS NOT NULL AND status = 'not_supported' AND affiliation_relationship <> 'insufficient_evidence') OR
             (affiliation_decision = 'supported' AND score IS NOT NULL AND status IN ('predicted', 'below_threshold') AND
                affiliation_relationship NOT IN ('incidental_mention', 'insufficient_evidence') AND jsonb_array_length(affiliation_evidence) > 0)))
    );

CREATE INDEX IF NOT EXISTS repository_classification_predictions_resume_idx
    ON public.repository_classification_predictions
        (university, task, status, classified_at DESC);

COMMENT ON TABLE public.repository_classification_predictions IS
    'Model-neutral, resumable classification outcomes linked to retained scraped candidates.';

-- One row per repository and university: the newest affiliation result that
-- did not fail and was produced by a real model (not --mock or --simulate),
-- paired with the project-type row from the same model, prompt version, and
-- threshold. Use it when a single current answer per repository is needed;
-- the table keeps every result.
CREATE OR REPLACE VIEW public.repository_classification_latest AS
SELECT
    affiliation.university,
    affiliation.id,
    affiliation.affiliation_decision,
    affiliation.affiliation_relationship,
    affiliation.score AS affiliation_score,
    affiliation.status AS affiliation_status,
    project_type.category AS project_type,
    project_type.status AS project_type_status,
    affiliation.provider,
    affiliation.model,
    affiliation.prompt_version,
    affiliation.threshold,
    affiliation.classified_at
FROM (
    SELECT DISTINCT ON (university, id) *
    FROM public.repository_classification_predictions
    WHERE task = 'affiliation' AND status <> 'failed' AND NOT simulated
    ORDER BY university, id, classified_at DESC
) AS affiliation
LEFT JOIN LATERAL (
    SELECT candidate.category, candidate.status
    FROM public.repository_classification_predictions AS candidate
    WHERE candidate.task = 'project_type'
        AND candidate.university = affiliation.university
        AND candidate.id = affiliation.id
        AND candidate.provider = affiliation.provider
        AND candidate.model = affiliation.model
        AND candidate.prompt_version = affiliation.prompt_version
        AND candidate.threshold = affiliation.threshold
        AND candidate.status <> 'failed'
    ORDER BY candidate.classified_at DESC
    LIMIT 1
) AS project_type ON TRUE;

COMMENT ON VIEW public.repository_classification_latest IS
    'Latest non-failed, non-simulated affiliation and matching project type per repository and university.';
