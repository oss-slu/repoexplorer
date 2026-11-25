\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.repository_scraping (
    university, id, owner, fork, size, stargazers_count, watchers_count,
    forks_count, open_issues_count, watchers, release_downloads, contributors,
    contributor_count, subscribers_count, scraped_at
)
VALUES
    ('Issue 86 Migration Verify', 9876543210770, 'verify-owner', 0, 0, 0, 0, 0, 0, 0, 0, '[]', 0, 0, now()),
    ('Issue 86 Migration Verify', 9876543210771, 'verify-owner', 0, 0, 0, 0, 0, 0, 0, 0, '[]', 0, 0, now());

-- The latest-result view depends on the table; the migration recreates it.
DROP VIEW public.repository_classification_latest;
DROP TABLE public.repository_classification_predictions;

-- Recreate the pre-contract shape with an existing result to exercise the
-- additive migration against rows that have no structured affiliation fields.
CREATE TABLE public.repository_classification_predictions (
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
        (task = 'affiliation' AND status IN ('predicted', 'below_threshold', 'ineligible', 'failed'))
        OR (task = 'project_type' AND status IN ('predicted', 'skipped_threshold', 'skipped_eligibility', 'skipped_affiliation_failed', 'failed'))
    ),
    CONSTRAINT repository_classification_predictions_result_check CHECK (
        (task = 'affiliation' AND category IS NULL AND
            ((status IN ('predicted', 'below_threshold') AND score IS NOT NULL) OR
             (status IN ('ineligible', 'failed') AND score IS NULL)))
        OR
        (task = 'project_type' AND score IS NULL AND
            ((status = 'predicted' AND category IS NOT NULL) OR
             (status IN ('skipped_threshold', 'skipped_eligibility', 'skipped_affiliation_failed', 'failed') AND category IS NULL)))
    )
);

INSERT INTO public.repository_classification_predictions (
    id, university, task, provider, model, prompt_version, threshold,
    input_hash, score, category, explanation, status, simulated,
    error_message, classified_at
)
VALUES (
    9876543210770, 'Issue 86 Migration Verify', 'affiliation', 'verify',
    'legacy-model', 'v1', 0.4, repeat('0', 64), 0.7, NULL,
    'legacy prediction retained by migration', 'predicted', true, NULL, now()
);

\i /docker-entrypoint-initdb.d/repository-scraping-table.sql

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.repository_classification_predictions
        WHERE id = 9876543210770
            AND university = 'Issue 86 Migration Verify'
            AND task = 'affiliation'
            AND input_hash = repeat('0', 64)
            AND score = 0.7
            AND status = 'predicted'
            AND affiliation_decision IS NULL
            AND affiliation_relationship IS NULL
            AND affiliation_evidence IS NULL
    ) THEN
        RAISE EXCEPTION 'The additive classification migration did not preserve the legacy row';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint
        WHERE conrelid = 'public.repository_classification_predictions'::regclass
            AND conname = 'repository_classification_predictions_threshold_check'
            AND contype = 'c'
            AND convalidated
    ) THEN
        RAISE EXCEPTION 'The classification threshold constraint is missing after migration';
    END IF;
END;
$$;

INSERT INTO public.repository_classification_predictions (
    id, university, task, provider, model, prompt_version, threshold,
    input_hash, score, category, affiliation_decision,
    affiliation_relationship, affiliation_evidence, explanation, status,
    simulated, error_message, classified_at
)
VALUES (
    9876543210771, 'Issue 86 Migration Verify', 'affiliation', 'verify',
    'current-model', 'v2', 0.4, repeat('1', 64), 0.9, NULL, 'supported',
    'coursework', '[{"field":"readme","quote":"Course assignment"}]'::JSONB,
    'structured row accepted after migration', 'predicted', true, NULL, now()
);

DO $$
BEGIN
    BEGIN
        INSERT INTO public.repository_classification_predictions (
            id, university, task, provider, model, prompt_version, threshold,
            input_hash, score, category, explanation, status, simulated,
            error_message, classified_at
        )
        VALUES (
            9876543210771, 'Issue 86 Migration Verify', 'project_type', 'verify',
            'threshold-check', 'v2', 1.1, repeat('2', 64), NULL, 'EDU',
            'threshold outside contract', 'predicted', true, NULL, now()
        );
        RAISE EXCEPTION 'The migration accepted a threshold outside [0, 1]';
    EXCEPTION
        WHEN check_violation THEN NULL;
    END;
END;
$$;

ROLLBACK;
