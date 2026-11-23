import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { ClassificationStore } from '../classification/store';
import { FakeClassificationClient } from '../classification/client';
import { runClassification } from '../classification/runner';
import type { ClassificationPrediction } from '../types/scraping';
import { RepositoryStore } from '../db/repositoryStore';
import type { RepositoryScrapingRecord } from '../types/scraping';
import { validateClassificationConfiguration } from '../config';

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

    test('persists independent results for the same repository under two universities', async () => {
        const id = 8_765_432_901;
        const firstUniversity = `${prefix}-one`;
        const secondUniversity = `${prefix}-two`;
        const scraperStore = new RepositoryStore(pool);
        await scraperStore.upsertUniversity(firstUniversity, [
            record(firstUniversity, id),
        ]);
        await scraperStore.upsertUniversity(secondUniversity, [
            record(secondUniversity, id),
        ]);

        const firstCandidate = (await store.listCandidates(firstUniversity))[0];
        expect(firstCandidate).toMatchObject({
            id,
            university: firstUniversity,
            archived: false,
            isTemplate: false,
        });
        const firstPrediction = prediction(id, firstUniversity, 'a'.repeat(64));
        const secondPrediction = prediction(
            id,
            secondUniversity,
            'b'.repeat(64),
        );
        await store.savePrediction(firstPrediction);
        await store.savePrediction(secondPrediction);

        expect(await store.findPrediction(firstPrediction)).toMatchObject(
            firstPrediction,
        );
        expect(await store.findPrediction(secondPrediction)).toMatchObject(
            secondPrediction,
        );
        const rows = await adminPool.query(
            'SELECT count(*)::int AS count FROM public.repository_classification_predictions WHERE id = $1 AND university LIKE $2',
            [id, `${prefix}%`],
        );
        expect(rows.rows[0].count).toBe(2);
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

    test('runs the classifier offline against staged PostgreSQL candidates', async () => {
        const id = 8_765_432_902;
        const university = `${prefix}-offline`;
        await new RepositoryStore(pool).upsertUniversity(university, [
            record(university, id),
        ]);

        const report = await runClassification({
            store,
            client: new FakeClassificationClient([
                '{"decision":"supported","relationship":"institutional_project","score":0.8,"evidence":[{"field":"readme","quote":"# Project"}],"explanation":"The README documents an institutional project."}',
                '{"category":"DEV","evidence":[{"field":"readme","quote":"# Project"}],"explanation":"The repository is a software project."}',
            ]),
            // The quote does not name the institution; the gate has its own test.
            configuration: validateClassificationConfiguration({
                concurrency: 1,
                threshold: 0.4,
                affiliationEvidenceGate: 'off',
            }),
            universities: [
                { key: university, fullName: 'Test University', acronym: 'TU' },
            ],
        });

        expect(report.simulated).toBe(true);
        expect(report.failures).toEqual([]);
        expect(report.universities[0]).toMatchObject({
            candidates: 1,
            eligible: 1,
            affiliationPredicted: 1,
            projectTypesPredicted: 1,
        });
        const rows = await adminPool.query(
            `SELECT task, score, category, simulated, status
             FROM public.repository_classification_predictions
             WHERE id = $1 AND university = $2 ORDER BY task`,
            [id, university],
        );
        expect(rows.rows).toEqual([
            {
                task: 'affiliation',
                score: 0.8,
                category: null,
                simulated: true,
                status: 'predicted',
            },
            {
                task: 'project_type',
                score: null,
                category: 'DEV',
                simulated: true,
                status: 'predicted',
            },
        ]);
    });
});

function prediction(
    id: number,
    university: string,
    inputHash: string,
): ClassificationPrediction {
    return {
        id,
        university,
        task: 'affiliation',
        provider: 'test',
        model: 'fixed',
        promptVersion: 'v1',
        threshold: 0.4,
        inputHash,
        score: 0.75,
        category: null,
        affiliationDecision: 'supported',
        affiliationRelationship: 'institutional_project',
        affiliationEvidence: [
            { field: 'readme', quote: 'Test prediction.' },
        ],
        explanation: 'Test prediction.',
        status: 'predicted',
        simulated: true,
        errorMessage: null,
        classifiedAt: '2026-10-26T12:00:00.000Z',
    };
}

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
