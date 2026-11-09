import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { RepositoryStore } from '../db/repositoryStore';
import type { RepositoryScrapingRecord } from '../types/scraping';
import { normalizeRepositoryText } from '../utils/normalizeRepositoryText';
import { ScrapingCancellationError } from '../utils/scrapingError';

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
const checkpointSqlPath = fileURLToPath(
    new URL(
        '../../../scripts/db/repository-scraping-checkpoints.sql',
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
        await adminPool.query(await readFile(checkpointSqlPath, 'utf8'));
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
                    'DELETE FROM public.repository_scraping_runs WHERE university LIKE $1',
                    [`${testPrefix}%`],
                );
                await adminPool.query(
                    'DELETE FROM public.repository_scraping_cache WHERE university LIKE $1',
                    [`${testPrefix}%`],
                );
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

    test('collection locks allow disjoint selections and clean up failed overlapping selections', async () => {
        const otherPool = new Pool({ connectionString: databaseUrl, max: 1 });
        const other = new RepositoryStore(otherPool, 1);
        const releases: Array<() => Promise<void>> = [];
        const a = `${testPrefix}-lock-a`;
        const b = `${testPrefix}-lock-b`;
        try {
            const releaseB = await store.acquireCollectionLock([b, b]);
            releases.push(releaseB);
            const releaseA = await other.acquireCollectionLock([a]);
            releases.push(releaseA);
            await releaseA();
            // A is acquired before B conflicts; the failed attempt must release A.
            await expect(other.acquireCollectionLock([a, b])).rejects.toThrow(
                'selected university',
            );
            await releaseB();
            await releaseB(); // Cleanup is idempotent, including duplicate keys.
            const releaseBoth = await store.acquireCollectionLock([b, a]);
            releases.push(releaseBoth);
            await expect(other.acquireCollectionLock([a])).rejects.toThrow(
                'selected university',
            );
            await releaseBoth();
            releases.push(await other.acquireCollectionLock([a, b]));
        } finally {
            for (const release of releases.reverse()) await release();
            await otherPool.end();
        }
    });

    test('collection locks exclude legacy collectors in both directions', async () => {
        const legacyPool = new Pool({ connectionString: databaseUrl, max: 1 });
        const legacy = await legacyPool.connect();
        let release: (() => Promise<void>) | undefined;
        try {
            await legacy.query('SELECT pg_advisory_lock(731947, 83)');
            await expect(
                store.acquireCollectionLock([`${testPrefix}-legacy`]),
            ).rejects.toThrow('legacy database-wide lock');
            await legacy.query('SELECT pg_advisory_unlock_all()');
            release = await store.acquireCollectionLock([
                `${testPrefix}-legacy`,
            ]);
            const blocked = await legacy.query<{ acquired: boolean }>(
                'SELECT pg_try_advisory_lock(731947, 83) AS acquired',
            );
            expect(blocked.rows[0].acquired).toBe(false);
            await release();
            const acquired = await legacy.query<{ acquired: boolean }>(
                'SELECT pg_try_advisory_lock(731947, 83) AS acquired',
            );
            expect(acquired.rows[0].acquired).toBe(true);
        } finally {
            await release?.();
            await legacy.query('SELECT pg_advisory_unlock_all()');
            legacy.release();
            await legacyPool.end();
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

    test('passes read-only database preflight with the application role', async () => {
        await expect(store.preflight()).resolves.toBeUndefined();
    });

    test('keeps repository work staged until completion, then publishes record and ETag', async () => {
        const university = `${testPrefix}-checkpoint`;
        const runId = `${testPrefix}-run`;
        const repositoryId = 8_765_432_150;
        const staleRepositoryId = 8_765_432_151;
        const candidate = {
            id: repositoryId,
            fullName: 'checkpoint-owner/repository',
            metadata: {
                id: repositoryId,
                full_name: 'checkpoint-owner/repository',
            },
        };
        await store.upsertUniversity(university, [
            record(university, staleRepositoryId, {
                fullName: 'stale-owner/repository',
            }),
        ]);

        expect(
            await store.startOrLoadUniversityCollection(
                runId,
                university,
                'full',
            ),
        ).toMatchObject({ status: 'discovering', discovered: 0 });
        await store.saveDiscoveryCheckpoint(runId, university, [candidate], []);
        await store.saveRepositoryCheckpoint(runId, university, {
            candidate,
            status: 'complete',
            record: record(university, repositoryId, {
                fullName: candidate.fullName,
                htmlUrl: 'https://github.com/checkpoint-owner/repository',
            }),
            etag: '"checkpoint-etag"',
        });

        const stagedRows = await adminPool.query(
            'SELECT id::text FROM public.repository_scraping WHERE university = $1 ORDER BY id',
            [university],
        );
        expect(stagedRows.rows.map((row) => row.id)).toEqual([
            String(staleRepositoryId),
        ]);
        expect(
            await store.startOrLoadUniversityCollection(
                runId,
                university,
                'full',
            ),
        ).toMatchObject({
            status: 'ready',
            discovered: 1,
            candidates: [{ status: 'complete', etag: '"checkpoint-etag"' }],
        });

        expect(await store.publishUniversityCollection(runId, university)).toBe(
            1,
        );
        const staleRow = await adminPool.query(
            'SELECT count(*)::int AS count FROM public.repository_scraping WHERE university = $1 AND id = $2',
            [university, staleRepositoryId],
        );
        expect(staleRow.rows[0].count).toBe(0);
        const published = await store.startOrLoadUniversityCollection(
            runId,
            university,
            'full',
        );
        expect(published).toMatchObject({
            status: 'complete',
            committed: 1,
            candidates: [],
        });
        expect(await store.listKnownRepositories(university)).toEqual([
            {
                id: repositoryId,
                fullName: 'checkpoint-owner/repository',
                etag: '"checkpoint-etag"',
            },
        ]);
    });

    test('cancellation before COMMIT rolls publication back and retains checkpoints', async () => {
        const university = `${testPrefix}-cancel-before-commit`;
        const runId = `${testPrefix}-cancel-before-commit-run`;
        const candidate = {
            id: 8_765_432_170,
            fullName: 'cancel-owner/repository',
        };
        await store.startOrLoadUniversityCollection(runId, university, 'full');
        await store.saveDiscoveryCheckpoint(runId, university, [candidate], []);
        await store.saveRepositoryCheckpoint(runId, university, {
            candidate,
            status: 'complete',
            record: record(university, candidate.id, {
                fullName: candidate.fullName,
            }),
        });

        const controller = new AbortController();
        const interruptAfterRunUpdate = interceptPoolQueries(pool, (sql) => {
            if (sql.includes("SET status = 'complete'")) {
                controller.abort(new ScrapingCancellationError('SIGINT'));
            }
        });
        const cancellableStore = new RepositoryStore(interruptAfterRunUpdate, 1);

        await expect(
            cancellableStore.publishUniversityCollection(
                runId,
                university,
                controller.signal,
            ),
        ).rejects.toMatchObject({
            name: 'ScrapingCancellationError',
            source: 'SIGINT',
        });

        expect(
            await store.startOrLoadUniversityCollection(
                runId,
                university,
                'full',
            ),
        ).toMatchObject({ status: 'ready', candidates: [{ status: 'complete' }] });
        const published = await adminPool.query(
            'SELECT count(*)::int AS count FROM public.repository_scraping WHERE university = $1',
            [university],
        );
        expect(published.rows[0].count).toBe(0);
        await expect(pool.query('SELECT 1')).resolves.toMatchObject({
            rows: [{ '?column?': 1 }],
        });
    });

    test('a successful COMMIT wins a concurrent cancellation race and reports committed rows', async () => {
        const university = `${testPrefix}-commit-race`;
        const runId = `${testPrefix}-commit-race-run`;
        const candidate = {
            id: 8_765_432_171,
            fullName: 'race-owner/repository',
        };
        await store.startOrLoadUniversityCollection(runId, university, 'full');
        await store.saveDiscoveryCheckpoint(runId, university, [candidate], []);
        await store.saveRepositoryCheckpoint(runId, university, {
            candidate,
            status: 'complete',
            record: record(university, candidate.id, {
                fullName: candidate.fullName,
            }),
        });

        const controller = new AbortController();
        const interruptAfterCommit = interceptPoolQueries(pool, (sql) => {
            if (sql === 'COMMIT') {
                controller.abort(new ScrapingCancellationError('SIGTERM'));
            }
        });
        const cancellableStore = new RepositoryStore(interruptAfterCommit, 1);

        await expect(
            cancellableStore.publishUniversityCollection(
                runId,
                university,
                controller.signal,
            ),
        ).resolves.toBe(1);
        expect(
            await store.startOrLoadUniversityCollection(
                runId,
                university,
                'full',
            ),
        ).toMatchObject({ status: 'complete', committed: 1, candidates: [] });
        const published = await adminPool.query(
            'SELECT count(*)::int AS count FROM public.repository_scraping WHERE university = $1',
            [university],
        );
        expect(published.rows[0].count).toBe(1);
        await expect(pool.query('SELECT 1')).resolves.toMatchObject({
            rows: [{ '?column?': 1 }],
        });
    });

    test('publishes healthy records for a partial run, persists documented skips, and preserves older rows', async () => {
        const university = `${testPrefix}-legal-partial`;
        const runId = `${testPrefix}-legal-run`;
        const healthyId = 8_765_432_160;
        const skippedId = 8_765_432_161;
        const oldId = 8_765_432_162;
        const contributorSkippedId = 8_765_432_163;
        const healthyCandidate = {
            id: healthyId,
            fullName: 'partial-owner/healthy',
            metadata: { id: healthyId, full_name: 'partial-owner/healthy' },
        };
        const skippedCandidate = {
            id: skippedId,
            fullName: 'partial-owner/unavailable',
            metadata: { id: skippedId, full_name: 'partial-owner/unavailable' },
        };
        const contributorSkippedCandidate = {
            id: contributorSkippedId,
            fullName: 'partial-owner/large-history',
            metadata: {
                id: contributorSkippedId,
                full_name: 'partial-owner/large-history',
            },
        };
        await store.upsertUniversity(university, [
            record(university, oldId, { fullName: 'old-owner/stale' }),
        ]);
        await store.startOrLoadUniversityCollection(runId, university, 'full');
        await store.saveDiscoveryCheckpoint(
            runId,
            university,
            [healthyCandidate, skippedCandidate, contributorSkippedCandidate],
            [],
        );
        await store.saveRepositoryCheckpoint(runId, university, {
            candidate: healthyCandidate,
            status: 'complete',
            record: record(university, healthyId, {
                fullName: healthyCandidate.fullName,
            }),
        });
        await store.saveRepositoryCheckpoint(runId, university, {
            candidate: skippedCandidate,
            status: 'skipped',
            skippedRepository: {
                university,
                repositoryId: skippedId,
                repositoryName: skippedCandidate.fullName,
                endpoint:
                    'https://api.github.com/repos/partial-owner/unavailable',
                status: 451,
                reasonCode: 'github_legal_restriction',
                requestId: 'REQ-LEGAL-451',
                reason: 'GitHub returned HTTP 451: repository access is unavailable for legal reasons.',
            },
        });
        await store.saveRepositoryCheckpoint(runId, university, {
            candidate: contributorSkippedCandidate,
            status: 'skipped',
            skippedRepository: {
                university,
                repositoryId: contributorSkippedId,
                repositoryName: contributorSkippedCandidate.fullName,
                endpoint:
                    'https://api.github.com/repos/partial-owner/large-history/contributors',
                status: 403,
                reasonCode: 'github_contributors_unavailable',
                requestId: 'REQ-CONTRIBUTORS-SIZE',
                reason: 'GitHub contributor history exceeds the REST API listing limit.',
            },
        });

        expect(await store.publishUniversityCollection(runId, university)).toBe(
            1,
        );
        const rows = await adminPool.query(
            'SELECT id::text FROM public.repository_scraping WHERE university = $1 ORDER BY id',
            [university],
        );
        expect(rows.rows.map((row) => row.id)).toEqual([
            String(healthyId),
            String(oldId),
        ]);
        const published = await store.startOrLoadUniversityCollection(
            runId,
            university,
            'full',
        );
        expect(published).toMatchObject({
            status: 'complete',
            committed: 1,
            skippedRepositories: [
                {
                    status: 451,
                    reasonCode: 'github_legal_restriction',
                    requestId: 'REQ-LEGAL-451',
                },
                {
                    status: 403,
                    reasonCode: 'github_contributors_unavailable',
                    requestId: 'REQ-CONTRIBUTORS-SIZE',
                },
            ],
        });
    });

    test('reproduces PostgreSQL NUL rejection and persists the normalized value', async () => {
        const university = `${testPrefix}-nul`;
        const rawRecord = record(university, 8_765_432_120, {
            description: 'synthetic\u0000description',
        });

        await expect(
            adminPool.query('SELECT $1::text AS description', [
                rawRecord.description,
            ]),
        ).rejects.toThrow(/invalid byte sequence|NUL/i);

        const normalized = normalizeRepositoryText([rawRecord]);
        expect(normalized.warnings).toMatchObject([
            { field: 'description', replacementCount: 1 },
        ]);
        await store.upsertUniversity(university, normalized.records);
        const persisted = await adminPool.query(
            'SELECT description FROM public.repository_scraping WHERE id = $1 AND university = $2',
            [rawRecord.id, university],
        );
        expect(persisted.rows[0].description).toBe('synthetic�description');
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
        ).rejects.toMatchObject({
            name: 'ScrapingDatabaseWriteError',
            message: 'Repository database batch failed',
            sqlState: 'P0001',
            batchNumber: 2,
            batchSize: 1,
            cause: expect.objectContaining({
                message: 'intentional integration failure',
            }),
        });

        const result = await adminPool.query(
            'SELECT count(*)::int AS count FROM public.repository_scraping WHERE university = $1',
            [university],
        );
        expect(result.rows[0].count).toBe(0);
        // The pool has one connection, so this query also proves the failed path released it.
    });
});

function interceptPoolQueries(
    pool: Pool,
    afterQuery: (query: string) => void,
): Pool {
    return {
        connect: async () => {
            const client = await pool.connect();
            return new Proxy(client, {
                get(target, property, receiver) {
                    if (property === 'query') {
                        return async (...args: unknown[]) => {
                            const result = await Reflect.apply(
                                target.query,
                                target,
                                args,
                            );
                            if (typeof args[0] === 'string') {
                                afterQuery(args[0]);
                            }
                            return result;
                        };
                    }
                    return Reflect.get(target, property, receiver) as unknown;
                },
            });
        },
    } as unknown as Pool;
}

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
    await executeFormattedSql(
        adminPool,
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.repository_scraping_cache TO %I',
        [user],
    );
    await executeFormattedSql(
        adminPool,
        'GRANT SELECT, INSERT, UPDATE ON TABLE public.repository_scraping_runs TO %I',
        [user],
    );
    await executeFormattedSql(
        adminPool,
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.repository_scraping_run_repositories TO %I',
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
