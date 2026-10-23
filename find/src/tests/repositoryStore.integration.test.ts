import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { RepositoryStore } from '../db/repositoryStore';
import type { RepositoryScrapingRecord } from '../types/scraping';

const databaseUrl = process.env.FINDER_TEST_DATABASE_URL;
const adminDatabaseUrl =
    process.env.FINDER_TEST_ADMIN_DATABASE_URL ?? databaseUrl;
const applicationUser = process.env.FINDER_TEST_APPLICATION_USER;
const applicationPassword = process.env.FINDER_TEST_APPLICATION_PASSWORD;
const integrationDescribe = databaseUrl ? describe : describe.skip;
const testPrefix = `issue58-${process.pid}-${Date.now()}`;
const tableSqlPath = fileURLToPath(
    new URL(
        '../../../scripts/db/repository-scraping-table.sql',
        import.meta.url,
    ),
);

integrationDescribe('RepositoryStore PostgreSQL integration', () => {
    let pool: Pool;
    let adminPool: Pool;
    let store: RepositoryStore;

    beforeAll(async () => {
        if (!databaseUrl) {
            throw new Error(
                'FINDER_TEST_DATABASE_URL is required for integration tests',
            );
        }
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
        store = new RepositoryStore(pool, 1);
    });

    afterAll(async () => {
        try {
            if (adminPool) {
                const table = await adminPool.query(
                    "SELECT to_regclass('public.repository_scraping') IS NOT NULL AS exists",
                );
                if (table.rows[0].exists) {
                    await adminPool.query(
                        'DROP TRIGGER IF EXISTS issue58_test_reject_trigger ON public.repository_scraping',
                    );
                    await adminPool.query(
                        'DELETE FROM public.repository_scraping WHERE university LIKE $1',
                        [`${testPrefix}%`],
                    );
                }
                await adminPool.query(
                    'DROP FUNCTION IF EXISTS public.issue58_test_reject_record()',
                );
            }
        } finally {
            const pools = [pool, adminPool].filter(
                (candidate): candidate is Pool => Boolean(candidate),
            );
            await Promise.all(pools.map((candidate) => candidate.end()));
        }
    });

    test('inserts and reruns by identity, updates scrape fields, and preserves analysis fields', async () => {
        const university = `${testPrefix}-rerun`;
        const first = record(university, 8_765_432_101, {
            description: "O'Reilly's first record",
        });
        expect(await store.upsertUniversity(university, [first])).toBe(1);

        await adminPool.query(
            `UPDATE public.repository_scraping
             SET bus_factor = 2.5,
                 affiliation_prediction_gpt5_mini = 0.75,
                 type_prediction_gpt5_mini = 'DATA'
             WHERE id = $1 AND university = $2`,
            [first.id, university],
        );
        const second = record(university, first.id, {
            fullName: 'owner/renamed',
            description: "O'Reilly's updated record; --",
            stargazersCount: 9,
            scrapedAt: '2026-10-20T13:00:00.000Z',
        });
        expect(await store.upsertUniversity(university, [second])).toBe(1);

        const result = await adminPool.query(
            `SELECT full_name, description, stargazers_count, bus_factor,
                    affiliation_prediction_gpt5_mini, type_prediction_gpt5_mini,
                    scraped_at
             FROM public.repository_scraping
             WHERE id = $1 AND university = $2`,
            [first.id, university],
        );
        expect(result.rowCount).toBe(1);
        expect(result.rows[0]).toMatchObject({
            full_name: 'owner/renamed',
            description: "O'Reilly's updated record; --",
            stargazers_count: '9',
            bus_factor: 2.5,
            affiliation_prediction_gpt5_mini: 0.75,
            type_prediction_gpt5_mini: 'DATA',
        });
        expect(new Date(result.rows[0].scraped_at).toISOString()).toBe(
            '2026-10-20T13:00:00.000Z',
        );
    });

    test('allows one GitHub ID under different universities', async () => {
        const id = 8_765_432_102;
        const firstUniversity = `${testPrefix}-one`;
        const secondUniversity = `${testPrefix}-two`;
        await store.upsertUniversity(firstUniversity, [
            record(firstUniversity, id),
        ]);
        await store.upsertUniversity(secondUniversity, [
            record(secondUniversity, id),
        ]);

        const result = await adminPool.query(
            'SELECT count(*)::int AS count FROM public.repository_scraping WHERE id = $1 AND university LIKE $2',
            [id, `${testPrefix}%`],
        );
        expect(result.rows[0].count).toBe(2);
    });

    test('rolls back all batches for a university when a later batch fails', async () => {
        const university = `${testPrefix}-rollback`;
        await adminPool.query(`
            CREATE OR REPLACE FUNCTION public.issue58_test_reject_record()
            RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.description = 'trigger-failure' THEN
                    RAISE EXCEPTION 'intentional integration failure';
                END IF;
                RETURN NEW;
            END;
            $$;
            DROP TRIGGER IF EXISTS issue58_test_reject_trigger ON public.repository_scraping;
            CREATE TRIGGER issue58_test_reject_trigger
                BEFORE INSERT OR UPDATE ON public.repository_scraping
                FOR EACH ROW EXECUTE FUNCTION public.issue58_test_reject_record();
        `);

        await expect(
            store.upsertUniversity(university, [
                record(university, 8_765_432_103, {
                    description: 'first batch',
                }),
                record(university, 8_765_432_104, {
                    description: 'trigger-failure',
                }),
            ]),
        ).rejects.toThrow(/intentional integration failure/);

        const result = await adminPool.query(
            'SELECT count(*)::int AS count FROM public.repository_scraping WHERE university = $1',
            [university],
        );
        expect(result.rows[0].count).toBe(0);
        // The pool has one connection, so this query also proves the failed path released it.
    });
});

async function prepareApplicationRole(
    adminPool: Pool,
    user: string,
    password: string,
): Promise<void> {
    const roleExists = await adminPool.query(
        'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1) AS exists',
        [user],
    );
    await executeFormattedSql(
        adminPool,
        roleExists.rows[0].exists
            ? 'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L'
            : 'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
        [user, password],
    );
    const database = await adminPool.query('SELECT current_database() AS name');
    await executeFormattedSql(
        adminPool,
        'GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I',
        [database.rows[0].name, user],
    );
    await executeFormattedSql(adminPool, 'GRANT USAGE ON SCHEMA public TO %I', [
        user,
    ]);
    await executeFormattedSql(
        adminPool,
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.repository_scraping TO %I',
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

function record(
    university: string,
    id: number,
    overrides: Partial<RepositoryScrapingRecord> = {},
): RepositoryScrapingRecord {
    return {
        university,
        id,
        fullName: 'owner/repository',
        owner: 'owner',
        license: null,
        language: null,
        htmlUrl: 'https://github.com/owner/repository',
        description: null,
        fork: 0,
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-02T00:00:00.000Z',
        pushedAt: null,
        homepage: null,
        size: 0,
        stargazersCount: 0,
        readme: null,
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
        scrapedAt: '2026-10-20T12:00:00.000Z',
        ...overrides,
    };
}
