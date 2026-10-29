import type { Pool } from 'pg';
import { jest } from '@jest/globals';
import {
    RepositoryStore,
    REQUIRED_REPOSITORY_SCRAPING_COLUMNS,
} from '../db/repositoryStore';
import type { RepositoryScrapingRecord } from '../types/scraping';
import { ScrapingCancellationError } from '../utils/scrapingError';

describe('RepositoryStore input validation', () => {
    test('rejects unsafe counts and contributor text before opening a connection', async () => {
        const connect = jest.fn();
        const store = new RepositoryStore({ connect } as unknown as Pool);

        await expect(
            store.upsertUniversity('University', [
                record({ stargazersCount: Number.MAX_SAFE_INTEGER + 1 }),
            ]),
        ).rejects.toThrow(/safe integer/);
        await expect(
            store.upsertUniversity('University', [
                record({ contributors: "['alice']", contributorCount: 1 }),
            ]),
        ).rejects.toThrow(/JSON array/);
        expect(connect).not.toHaveBeenCalled();
    });

    test('rejects unnormalized NUL text and invalid contributor identities before connecting', async () => {
        const connect = jest.fn();
        const store = new RepositoryStore({ connect } as unknown as Pool);

        await expect(
            store.upsertUniversity('University', [
                record({ description: 'contains\u0000nul' }),
            ]),
        ).rejects.toMatchObject({ field: 'description' });
        await expect(
            store.upsertUniversity('University', [
                record({ owner: 'bad\u0000owner' }),
            ]),
        ).rejects.toMatchObject({ field: 'owner' });
        await expect(
            store.upsertUniversity('University', [
                record({ contributors: '["bad\\u0000login"]', contributorCount: 1 }),
            ]),
        ).rejects.toMatchObject({ field: 'contributors' });
        expect(connect).not.toHaveBeenCalled();
    });
});

describe('RepositoryStore read-only preflight', () => {
    function createPreflightPool(
        options: {
            tableExists?: boolean;
            missingColumn?: string;
            canInsert?: boolean;
        } = {},
    ) {
        const statements: string[] = [];
        const release = jest.fn();
        const query = jest.fn(async (sql: string) => {
            statements.push(sql);
            if (sql.includes('SELECT 1 AS connected')) {
                return { rows: [{ connected: 1 }] };
            }
            if (sql.includes('to_regclass')) {
                return { rows: [{ exists: options.tableExists ?? true }] };
            }
            if (sql.includes('information_schema.columns')) {
                return {
                    rows: REQUIRED_REPOSITORY_SCRAPING_COLUMNS.filter(
                        (column) => column !== options.missingColumn,
                    ).map((column_name) => ({ column_name })),
                };
            }
            return {
                rows: [
                    {
                        schema_usage: true,
                        can_select: true,
                        can_insert: options.canInsert ?? true,
                        can_update: true,
                        can_delete: true,
                        cache_select: true,
                        cache_insert: true,
                        cache_update: true,
                        cache_delete: true,
                        runs_select: true,
                        runs_insert: true,
                        runs_update: true,
                        checkpoints_select: true,
                        checkpoints_insert: true,
                        checkpoints_update: true,
                        checkpoints_delete: true,
                    },
                ],
            };
        });
        const pool = {
            async connect() {
                return { query, release };
            },
        } as unknown as Pool;
        return { pool, statements, release };
    }

    test('checks the table, all insert columns, and CRUD privileges without writes', async () => {
        const mock = createPreflightPool();
        await new RepositoryStore(mock.pool).preflight();
        expect(mock.statements).toHaveLength(5);
        expect(mock.statements.every((statement) => /^\s*SELECT\b/i.test(statement))).toBe(true);
        expect(mock.release).toHaveBeenCalledTimes(1);
    });

    test.each([
        [{ tableExists: false }, 'missing-table'],
        [{ missingColumn: 'readme' }, 'missing-columns'],
        [{ canInsert: false }, 'privileges'],
    ] as const)('reports a sanitized preflight failure for %s', async (options, failure) => {
        const mock = createPreflightPool(options);
        await expect(new RepositoryStore(mock.pool).preflight()).rejects.toMatchObject({
            failure,
        });
        expect(mock.release).toHaveBeenCalledTimes(1);
    });

    test('reports an unavailable database with SQLSTATE and no connection leak', async () => {
        const connectionError = Object.assign(new Error('private connection details'), {
            code: '08006',
        });
        const pool = {
            async connect() {
                throw connectionError;
            },
        } as unknown as Pool;
        await expect(new RepositoryStore(pool).preflight()).rejects.toMatchObject({
            failure: 'connection',
            sqlState: '08006',
        });
    });
});

describe('RepositoryStore publication cancellation', () => {
    function createPublicationPool(
        afterQuery: (query: string) => void,
    ) {
        const statements: string[] = [];
        const release = jest.fn();
        const query = jest.fn(async (sql: string) => {
            statements.push(sql);
            afterQuery(sql);
            if (sql.includes('SELECT mode, status, candidate_count')) {
                return {
                    rows: [
                        {
                            mode: 'full',
                            status: 'ready',
                            candidate_count: 1,
                            skipped_owners: [],
                        },
                    ],
                };
            }
            if (sql.includes('SELECT repository_id::TEXT')) {
                return {
                    rows: [
                        {
                            repository_id: '123',
                            status: 'complete',
                            record: record(),
                            etag: null,
                            skipped_repository: null,
                            warnings: [],
                        },
                    ],
                };
            }
            return { rows: [], rowCount: 1 };
        });
        const pool = {
            async connect() {
                return { query, release };
            },
        } as unknown as Pool;
        return { pool, statements, release };
    }

    test('rolls back before commit and releases the client when cancellation arrives during publication', async () => {
        const controller = new AbortController();
        const mock = createPublicationPool((sql) => {
            if (sql.includes("SET status = 'complete'")) {
                controller.abort(new ScrapingCancellationError('SIGINT'));
            }
        });

        await expect(
            new RepositoryStore(mock.pool, 1).publishUniversityCollection(
                'run',
                'University',
                controller.signal,
            ),
        ).rejects.toMatchObject({ name: 'ScrapingCancellationError', source: 'SIGINT' });
        expect(mock.statements).toContain('ROLLBACK');
        expect(mock.statements).not.toContain('COMMIT');
        expect(mock.release).toHaveBeenCalledTimes(1);
    });

    test('reports a successful commit when cancellation arrives after PostgreSQL commits', async () => {
        const controller = new AbortController();
        const mock = createPublicationPool((sql) => {
            if (sql === 'COMMIT') {
                controller.abort(new ScrapingCancellationError('SIGTERM'));
            }
        });

        await expect(
            new RepositoryStore(mock.pool, 1).publishUniversityCollection(
                'run',
                'University',
                controller.signal,
            ),
        ).resolves.toBe(1);
        expect(mock.statements).toContain('COMMIT');
        expect(mock.statements).not.toContain('ROLLBACK');
        expect(mock.release).toHaveBeenCalledTimes(1);
    });
});

function record(
    overrides: Partial<RepositoryScrapingRecord> = {},
): RepositoryScrapingRecord {
    return {
        university: 'University',
        id: 123,
        fullName: 'owner/repository',
        owner: 'owner',
        license: null,
        language: null,
        htmlUrl: null,
        description: null,
        fork: 0,
        createdAt: null,
        updatedAt: null,
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
