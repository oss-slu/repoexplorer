import { jest } from '@jest/globals';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { ClassificationStore } from '../classification/store';
import { FakeClassificationClient } from '../classification/client';
import { runClassification } from '../classification/runner';
import { RepositoryStore } from '../db/repositoryStore';
import type { RepositoryScrapingRecord } from '../types/scraping';
import { validateClassificationConfiguration } from '../config';
import { runClassificationCli } from '../classificationCli';

const databaseUrl = process.env.FINDER_TEST_DATABASE_URL;
const adminDatabaseUrl =
    process.env.FINDER_TEST_ADMIN_DATABASE_URL ?? databaseUrl;
const applicationUser = process.env.FINDER_TEST_APPLICATION_USER;
const applicationPassword = process.env.FINDER_TEST_APPLICATION_PASSWORD;
const integrationDescribe = databaseUrl ? describe : describe.skip;
const prefix = `classification-${process.pid}-${Date.now()}`;
const tableSqlPath = fileURLToPath(
    new URL(
        '../../../scripts/db/repository-scraping-table.sql',
        import.meta.url,
    ),
);

integrationDescribe('ClassificationStore PostgreSQL integration', () => {
    let pool: Pool;
    let adminPool: Pool;
    let store: ClassificationStore;

    beforeAll(async () => {
        if (!databaseUrl || !adminDatabaseUrl)
            throw new Error('Test database URLs are required');
        adminPool = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
        await adminPool.query(await readFile(tableSqlPath, 'utf8'));
        if (applicationUser || applicationPassword) {
            if (!applicationUser || !applicationPassword) {
                throw new Error(
                    'FINDER_TEST_APPLICATION_USER and FINDER_TEST_APPLICATION_PASSWORD must be supplied together',
                );
            }
            await prepareApplicationRole(
                adminPool,
                applicationUser,
                applicationPassword,
            );
        }
        pool = new Pool({ connectionString: databaseUrl, max: 1 });
        store = new ClassificationStore(pool);
    });

    afterAll(async () => {
        try {
            if (adminPool) {
                await adminPool.query(
                    'DELETE FROM public.repository_scraping WHERE university LIKE $1',
                    [`${prefix}%`],
                );
            }
        } finally {
            await Promise.all(
                [pool, adminPool]
                    .filter((candidate): candidate is Pool =>
                        Boolean(candidate),
                    )
                    .map((candidate) => candidate.end()),
            );
        }
    });

    test('persists a gate downgrade as an uncertain row the CHECK constraints accept', async () => {
        const id = 8_765_432_903;
        const university = `${prefix}-gated`;
        await new RepositoryStore(pool).upsertUniversity(university, [
            record(university, id),
        ]);

        const report = await runClassification({
            store,
            client: new FakeClassificationClient([
                '{"decision":"supported","relationship":"institutional_project","score":0.8,"evidence":[{"field":"readme","quote":"# Project"}],"explanation":"The README documents an institutional project."}',
            ]),
            configuration: validateClassificationConfiguration({
                concurrency: 1,
                threshold: 0.4,
            }),
            universities: [
                { key: university, fullName: 'Test University', acronym: 'TU' },
            ],
        });

        expect(report.failures).toEqual([]);
        expect(report.universities[0]).toMatchObject({
            affiliationUncertain: 1,
            downgraded: 1,
            projectTypesPredicted: 0,
        });
        const rows = await adminPool.query(
            `SELECT task, score, status, affiliation_decision, affiliation_relationship,
                    jsonb_array_length(affiliation_evidence) AS citations,
                    explanation LIKE 'Downgraded to uncertain%' AS downgraded
             FROM public.repository_classification_predictions
             WHERE id = $1 AND university = $2 ORDER BY task`,
            [id, university],
        );
        expect(rows.rows).toEqual([
            {
                task: 'affiliation',
                score: null,
                status: 'uncertain',
                affiliation_decision: 'uncertain',
                affiliation_relationship: 'insufficient_evidence',
                citations: 1,
                downgraded: true,
            },
            {
                task: 'project_type',
                score: null,
                status: 'skipped_affiliation_uncertain',
                affiliation_decision: null,
                affiliation_relationship: null,
                citations: null,
                downgraded: false,
            },
        ]);
    });

    test('classify CLI end to end: mock run, gate, two universities, resume', async () => {
        const id = 8_765_432_902;
        const named = `${prefix}-named`;
        const other = `${prefix}-other`;
        const scraperStore = new RepositoryStore(pool);
        // The same repository is staged under two universities; only the
        // first is named in its README.
        for (const university of [named, other]) {
            await scraperStore.upsertUniversity(university, [
                {
                    ...record(university, id),
                    readme: '# Project\n\nBuilt by students at Alpha Test University.',
                },
            ]);
        }
        const directory = await mkdtemp(
            path.join(os.tmpdir(), 'classify-e2e-'),
        );
        const configPath = path.join(directory, 'universities.json');
        await writeFile(
            configPath,
            JSON.stringify({
                classification: {
                    citationMode: 'evidence_id',
                    concurrency: 1,
                },
                universities: [
                    {
                        key: named,
                        fullName: 'Alpha Test University',
                        acronym: 'ATU',
                    },
                    {
                        key: other,
                        fullName: 'Beta Test College',
                        acronym: 'BTC',
                    },
                ],
            }),
        );

        const run = async () => {
            const stdout: string[] = [];
            const out = jest
                .spyOn(process.stdout, 'write')
                .mockImplementation((chunk) => {
                    stdout.push(String(chunk));
                    return true;
                });
            const err = jest
                .spyOn(process.stderr, 'write')
                .mockImplementation(() => true);
            try {
                const exitCode = await withDatabaseEnvironment(() =>
                    runClassificationCli(['--config', configPath, '--mock']),
                );
                const summary = stdout.join('');
                const reportPath = summary.match(/report: (\S+)/)?.[1];
                if (reportPath) await rm(reportPath, { force: true });
                return { exitCode, summary };
            } finally {
                out.mockRestore();
                err.mockRestore();
            }
        };

        try {
            const first = await run();
            expect(first.exitCode).toBe(0);
            expect(first.summary).toMatch(/^COMPLETED/);
            expect(first.summary).toContain('affiliation supported: 1;');
            expect(first.summary).toContain('uncertain: 1;');
            expect(first.summary).toContain('failed: 0;');

            const rows = await adminPool.query(
                `SELECT university, task, status, affiliation_decision, category, simulated,
                        affiliation_evidence->0->>'quote' AS quote
                 FROM public.repository_classification_predictions
                 WHERE id = $1 AND university = ANY($2) ORDER BY university DESC, task`,
                [id, [named, other]],
            );
            expect(rows.rows).toEqual([
                {
                    university: other,
                    task: 'affiliation',
                    status: 'uncertain',
                    affiliation_decision: 'uncertain',
                    category: null,
                    simulated: true,
                    quote: null,
                },
                {
                    university: other,
                    task: 'project_type',
                    status: 'skipped_affiliation_uncertain',
                    affiliation_decision: null,
                    category: null,
                    simulated: true,
                    quote: null,
                },
                {
                    university: named,
                    task: 'affiliation',
                    status: 'predicted',
                    affiliation_decision: 'supported',
                    category: null,
                    simulated: true,
                    quote: expect.stringContaining('Alpha Test University'),
                },
                {
                    university: named,
                    task: 'project_type',
                    status: 'predicted',
                    affiliation_decision: null,
                    category: 'DEV',
                    simulated: true,
                    quote: null,
                },
            ]);

            // A second run with unchanged inputs reuses every stored row.
            const second = await run();
            expect(second.exitCode).toBe(0);
            expect(second.summary).toContain('resumed: 4;');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});

function record(university: string, id: number): RepositoryScrapingRecord {
    return {
        university,
        id,
        fullName: 'owner/repository',
        owner: 'owner',
        license: null,
        language: null,
        htmlUrl: 'https://github.com/owner/repository',
        description: 'A repository',
        fork: 0,
        archived: false,
        isTemplate: false,
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-02T00:00:00.000Z',
        pushedAt: null,
        homepage: null,
        size: 1,
        stargazersCount: 0,
        readme: '# Project',
        watchersCount: 0,
        forksCount: 0,
        openIssuesCount: 0,
        watchers: 0,
        organization: null,
        releaseDownloads: 0,
        contributors: '[]',
        contributorCount: 0,
        busFactor: null,
        codeOfConductFile: null,
        contributing: null,
        securityPolicy: null,
        issueTemplates: null,
        pullRequestTemplate: null,
        subscribersCount: 0,
        affiliationPredictionGpt5Mini: null,
        typePredictionGpt5Mini: null,
        scrapedAt: '2026-10-26T12:00:00.000Z',
    };
}

async function prepareApplicationRole(
    pool: Pool,
    user: string,
    password: string,
): Promise<void> {
    await executeFormattedSql(
        pool,
        'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
        [user, password],
    ).catch(async () =>
        executeFormattedSql(
            pool,
            'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
            [user, password],
        ),
    );
    await executeFormattedSql(pool, 'GRANT USAGE ON SCHEMA public TO %I', [
        user,
    ]);
    await executeFormattedSql(
        pool,
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.repository_scraping TO %I',
        [user],
    );
    await executeFormattedSql(
        pool,
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.repository_classification_predictions TO %I',
        [user],
    );
}

async function executeFormattedSql(
    pool: Pool,
    formatString: string,
    values: string[],
): Promise<void> {
    const parameters = [formatString, ...values];
    const placeholders = parameters
        .map((_, index) => `$${index + 1}::text`)
        .join(', ');
    const formatted = await pool.query(
        `SELECT format(${placeholders}) AS statement`,
        parameters,
    );
    await pool.query(formatted.rows[0].statement);
}

/** Runs `action` with the PG* variables the CLI reads, taken from the test URL. */
async function withDatabaseEnvironment<T>(
    action: () => Promise<T>,
): Promise<T> {
    const url = new URL(databaseUrl!);
    const values: Record<string, string> = {
        PGHOST: url.hostname,
        PGPORT: url.port || '5432',
        PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
        PGUSER: decodeURIComponent(url.username),
        PGPASSWORD: decodeURIComponent(url.password),
    };
    const saved = Object.fromEntries(
        Object.keys(values).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, values);
    try {
        return await action();
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}
