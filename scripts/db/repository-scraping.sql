\set ON_ERROR_STOP on
\ir repository-scraping-table.sql
\ir repository-scraping-checkpoints.sql

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

SELECT format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.repository_scraping TO %I',
    :'application_user'
) \gexec
SELECT format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.repository_scraping_cache, public.repository_scraping_runs, public.repository_scraping_run_repositories TO %I',
    :'application_user'
) \gexec
