import { runScraping } from '../runner';
import { formatCliFailure, writeImmediateCliFailure } from '../cli';
import { GitHubRequestClient } from '../utils/githubRequest';
import type {
    RepositoryScrapingRecord,
    ScrapingConfiguration,
} from '../types/scraping';
import {
    createTestClient,
    jsonResponse,
    nextPageHeader,
    searchEnvelope,
    textResponse,
} from './githubFixtures';

const configuration: ScrapingConfiguration = {
    universities: [
        { key: 'University One', fullName: 'University One', acronym: 'U1' },
        { key: 'University Two', fullName: 'University Two', acronym: 'U2' },
    ],
    repositoryConcurrency: 2,
    databaseBatchSize: 2,
};

function sharedRepositoryClient(
    incompleteSecondUniversity = false,
    includeMissingOwner = false,
) {
    return createTestClient((url) => {
        if (url.pathname === '/search/repositories') {
            const query = url.searchParams.get('q') ?? '';
            return jsonResponse(
                searchEnvelope(
                    [{ id: 88, full_name: 'shared/repository' }],
                    1,
                    incompleteSecondUniversity &&
                        query.includes('University Two'),
                ),
            );
        }
        if (url.pathname === '/search/users') {
            if (
                includeMissingOwner &&
                url.searchParams.get('q')?.includes('type:user')
            ) {
                return jsonResponse(
                    searchEnvelope([
                        { login: 'missing-owner', type: 'User' },
                    ]),
                );
            }
            return jsonResponse(searchEnvelope([]));
        }
        if (url.pathname === '/users/missing-owner/repos') {
            return jsonResponse({ message: 'Not Found' }, {}, 404);
        }
        if (url.pathname === '/repos/shared/repository') {
            return jsonResponse({
                id: 88,
                full_name: 'shared/repository',
                owner: { login: 'shared', type: 'User' },
                private: false,
                license: null,
                language: null,
                html_url: 'https://github.com/shared/repository',
                description: null,
                fork: false,
                created_at: '2020-01-01T00:00:00Z',
                updated_at: '2020-01-02T00:00:00Z',
                pushed_at: null,
                homepage: null,
                size: 0,
                stargazers_count: 0,
                watchers_count: 0,
                forks_count: 0,
                open_issues_count: 0,
                subscribers_count: 0,
            });
        }
        if (url.pathname === '/repos/shared/repository/readme') {
            return jsonResponse({ message: 'Not Found' }, {}, 404);
        }
        if (
            url.pathname === '/repos/shared/repository/releases' ||
            url.pathname === '/repos/shared/repository/contributors'
        ) {
            return jsonResponse([]);
        }
        if (url.pathname === '/repos/shared/repository/community/profile') {
            return jsonResponse({ message: 'Not Found' }, {}, 404);
        }
        if (url.pathname.startsWith('/repos/shared/repository/contents/')) {
            return jsonResponse({ message: 'Not Found' }, {}, 404);
        }
        throw new Error(`Unexpected request: ${url}`);
    });
}

function recoveryClient(
    candidates: Array<{ id: number; full_name: string }>,
    options: { description?: string | null; failStatus?: number } = {},
) {
    return createTestClient((url) => {
        if (url.pathname === '/search/repositories') {
            return jsonResponse(searchEnvelope(candidates));
        }
        if (url.pathname === '/search/users') {
            return jsonResponse(searchEnvelope([]));
        }
        const detail = candidates.find(
            (candidate) => `/repos/${candidate.full_name}` === url.pathname,
        );
        if (detail) {
            if (detail.full_name.endsWith('/tos')) {
                return jsonResponse(
                    {
                        message: 'Repository access blocked',
                        block: { reason: 'tos' },
                    },
                    {},
                    403,
                );
            }
            if (detail.full_name.endsWith('/missing')) {
                return jsonResponse({ message: 'Not Found' }, {}, 404);
            }
            if (options.failStatus !== undefined) {
                return jsonResponse({ message: 'Resource not accessible' }, {}, options.failStatus);
            }
            return jsonResponse({
                id: detail.id,
                full_name: detail.full_name,
                owner: { login: 'slu', type: 'Organization' },
                private: false,
                license: null,
                language: 'TypeScript',
                html_url: `https://github.com/${detail.full_name}`,
                description: options.description ?? null,
                fork: false,
                created_at: '2020-01-01T00:00:00Z',
                updated_at: '2020-01-02T00:00:00Z',
                pushed_at: null,
                homepage: null,
                size: 0,
                stargazers_count: 0,
                watchers_count: 0,
                forks_count: 0,
                open_issues_count: 0,
                subscribers_count: 0,
            });
        }
        const goodPrefix = '/repos/slu/good';
        if (url.pathname === `${goodPrefix}/readme`) {
            return jsonResponse({ message: 'Not Found' }, {}, 404);
        }
        if (
            url.pathname === `${goodPrefix}/releases` ||
            url.pathname === `${goodPrefix}/contributors`
        ) {
            return jsonResponse([]);
        }
        if (url.pathname === `${goodPrefix}/community/profile`) {
            return jsonResponse({ files: {} });
        }
        if (url.pathname.startsWith(`${goodPrefix}/contents/`)) {
            return jsonResponse({ message: 'Not Found' }, {}, 404);
        }
        if (url.pathname.startsWith('/repos/slu/')) {
            return textResponse('readme with NUL \u0000');
        }
        throw new Error(`Unexpected request: ${url}`);
    });
}

describe('runScraping', () => {
    test('keeps one repository identity associated with both configured universities', async () => {
        const persisted: Array<{
            university: string;
            records: readonly RepositoryScrapingRecord[];
        }> = [];
        const result = await runScraping(configuration, {
            client: sharedRepositoryClient(),
            store: {
                async upsertUniversity(university, records) {
                    persisted.push({ university, records });
                    return records.length;
                },
            },
            now: () => new Date('2026-10-20T12:00:00Z'),
        });

        expect(result).toMatchObject({
            universitiesProcessed: 2,
            committed: 2,
            failed: 0,
        });
        expect(persisted).toHaveLength(2);
        expect(
            persisted.map(({ university, records }) => [
                university,
                records[0].id,
            ]),
        ).toEqual([
            ['University One', 88],
            ['University Two', 88],
        ]);
        expect(persisted[0].records[0].university).toBe('University One');
        expect(persisted[1].records[0].university).toBe('University Two');
    });

    test('does not write a university when search completeness fails, while retaining earlier commits', async () => {
        const persisted: string[] = [];
        const result = await runScraping(configuration, {
            client: sharedRepositoryClient(true),
            store: {
                async upsertUniversity(university, records) {
                    persisted.push(university);
                    return records.length;
                },
            },
        });

        expect(persisted).toEqual(['University One']);
        expect(result.committed).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.failures[0].university).toBe('University Two');
        expect(formatCliFailure(result.failures[0])).toMatch(
            /incomplete-discovery/,
        );
    });
});

test('best-effort persists accessible candidates and reports a skipped user owner', async () => {
    const persisted: Array<{
        university: string;
        records: readonly RepositoryScrapingRecord[];
    }> = [];
    const result = await runScraping(
        {
            ...configuration,
            universities: configuration.universities.slice(0, 1),
        },
        {
            client: sharedRepositoryClient(false, true),
            store: {
                async upsertUniversity(university, records) {
                    persisted.push({ university, records });
                    return records.length;
                },
            },
        },
    );
    expect(result.failed).toBe(0);
    expect(result.partial).toBe(1);
    expect(result.results[0]).toMatchObject({
        status: 'partial',
        discovered: 1,
        committed: 1,
    });
    expect(result.results[0].skippedOwners[0]).toMatchObject({
        university: 'University One',
        login: 'missing-owner',
        ownerType: 'User',
        status: 404,
        endpoint: 'https://api.github.com/users/missing-owner/repos',
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].records.map((record) => record.id)).toEqual([88]);
});

test('all-owner-failure result stays partial when it has no candidates', async () => {
    let writes = 0;
    const result = await runScraping(
        {
            ...configuration,
            universities: configuration.universities.slice(0, 1),
        },
        {
            client: createTestClient((url) => {
                if (url.pathname === '/search/repositories') {
                    return jsonResponse(searchEnvelope([]));
                }
                if (url.pathname === '/search/users') {
                    return jsonResponse(
                        searchEnvelope(
                            url.searchParams.get('q')?.includes('type:user')
                                ? [{ login: 'missing-owner', type: 'User' }]
                                : [],
                        ),
                    );
                }
                if (url.pathname === '/users/missing-owner/repos') {
                    return jsonResponse({ message: 'Not Found' }, {}, 404);
                }
                throw new Error(`Unexpected request: ${url}`);
            }),
            store: {
                async upsertUniversity(_university, records) {
                    writes += 1;
                    expect(records).toEqual([]);
                    return 0;
                },
            },
        },
    );

    expect(writes).toBe(1);
    expect(result.partial).toBe(1);
    expect(result.committed).toBe(0);
    expect(result.results[0].status).toBe('partial');
    expect(result.results[0].discovered).toBe(0);
});

test('strict policy reports the owner 404 as fatal and writes no rows', async () => {
    let writes = 0;
    const result = await runScraping(
        {
            ...configuration,
            universities: configuration.universities.slice(0, 1),
        },
        {
            policy: 'strict',
            client: sharedRepositoryClient(false, true),
            store: {
                async upsertUniversity() {
                    writes += 1;
                    return 0;
                },
            },
        },
    );
    expect(writes).toBe(0);
    expect(result.failed).toBe(1);
    expect(formatCliFailure(result.failures[0])).toContain(
        'owner listing, university University One, owner User missing-owner, Owner repository listing returned 404; strict discovery policy stopped before persistence. No alternate owner endpoint was used.',
    );
});

test.each([false, true])(
    'keeps organization 404s fatal and commits nothing when the failure is on page two (late=%s)',
    async (late404) => {
        let writes = 0;
        let userFallbackRequests = 0;
        const result = await runScraping(
            {
                ...configuration,
                universities: configuration.universities.slice(0, 1),
            },
            {
            policy: 'strict',
                client: createTestClient((url) => {
                    if (url.pathname === '/search/repositories') {
                        return jsonResponse(searchEnvelope([]));
                    }
                    if (url.pathname === '/search/users') {
                        const query = url.searchParams.get('q') ?? '';
                        return jsonResponse(
                            searchEnvelope(
                                query.includes('type:org')
                                    ? [
                                          {
                                              login: 'organization',
                                              type: 'Organization',
                                          },
                                      ]
                                    : [],
                            ),
                        );
                    }
                    if (url.pathname === '/orgs/organization/repos') {
                        if (late404 && url.searchParams.get('page') !== '2') {
                            return jsonResponse(
                                [{ id: 17, full_name: 'organization/repo' }],
                                { link: nextPageHeader(url, 2) },
                            );
                        }
                        return jsonResponse({ message: 'Not Found' }, {}, 404);
                    }
                    if (url.pathname === '/users/organization/repos') {
                        userFallbackRequests += 1;
                        return jsonResponse([]);
                    }
                    throw new Error(`Unexpected request: ${url}`);
                }),
                store: {
                    async upsertUniversity() {
                        writes += 1;
                        return 1;
                    },
                },
            },
        );

        expect(result.failed).toBe(1);
        expect(writes).toBe(0);
        expect(userFallbackRequests).toBe(0);
        expect(formatCliFailure(result.failures[0])).toContain(
            'No alternate owner endpoint was used',
        );
    },
);

test('aborts sibling discovery requests on the first fatal error and preserves that error', async () => {
    let abortedRequests = 0;
    let writes = 0;
    const eventOrder: string[] = [];
    let stderrText = '';
    const stderr = {
        write(value: string) {
            stderrText += value;
            return true;
        },
    };
    const client = new GitHubRequestClient({
        concurrency: 3,
        maxRetries: 0,
        fetch: (async (input, init) => {
            const url = new URL(String(input));
            if (
                url.pathname === '/search/users' &&
                url.searchParams.get('q')?.includes('type:org')
            ) {
                return jsonResponse({ message: 'Not Found' }, {}, 404);
            }
            return await new Promise<Response>((_resolve, reject) => {
                const abort = () => {
                    abortedRequests += 1;
                    eventOrder.push('sibling-aborted');
                    reject(new DOMException('Aborted', 'AbortError'));
                };
                if (init?.signal?.aborted) {
                    abort();
                    return;
                }
                init?.signal?.addEventListener('abort', abort, { once: true });
            });
        }) as typeof fetch,
    });
    const result = await runScraping(
        {
            ...configuration,
            universities: configuration.universities.slice(0, 1),
        },
        {
            client,
            store: {
                async upsertUniversity() {
                    writes += 1;
                    return 0;
                },
            },
            onFatalError(university, error) {
                eventOrder.push('fatal-reported');
                writeImmediateCliFailure(stderr, university, error);
            },
        },
    );

    expect(result.failed).toBe(1);
    expect(abortedRequests).toBe(2);
    expect(writes).toBe(0);
    expect(eventOrder[0]).toBe('fatal-reported');
    expect(eventOrder).toContain('sibling-aborted');
    expect(stderrText).toContain('HTTP 404');
    expect(stderrText).not.toContain('Aborted');
    const message = formatCliFailure(result.failures[0]);
    expect(message).toContain('HTTP 404');
    expect(message).not.toContain('Aborted');
});

test('continues past repository ToS blocks and root-detail 404s while committing accessible records', async () => {
    const persisted: Array<readonly RepositoryScrapingRecord[]> = [];
    let fatalCallbacks = 0;
    const progress: Array<{ completed: number; skipped?: number }> = [];
    const result = await runScraping(
        {
            ...configuration,
            universities: configuration.universities.slice(0, 1),
        },
        {
            client: recoveryClient([
                { id: 101, full_name: 'slu/good' },
                { id: 102, full_name: 'slu/tos' },
                { id: 103, full_name: 'slu/missing' },
            ]),
            store: {
                async upsertUniversity(_university, records) {
                    persisted.push(records);
                    return records.length;
                },
            },
            onFatalError() {
                fatalCallbacks += 1;
            },
            onProgress(event) {
                if (event.type === 'progress' && event.phase === 'enrichment') {
                    progress.push({
                        completed: event.completed,
                        skipped: event.skipped,
                    });
                }
            },
        },
    );

    expect(result.failed).toBe(0);
    expect(result.partial).toBe(1);
    expect(result.committed).toBe(1);
    expect(result.results[0]).toMatchObject({
        status: 'partial',
        skippedRepositories: [
            { repositoryId: 102, status: 403, reasonCode: 'github_tos_block' },
            { repositoryId: 103, status: 404, reasonCode: 'repository_unavailable_404' },
        ],
    });
    expect(persisted[0].map((record) => record.id)).toEqual([101]);
    expect(fatalCallbacks).toBe(0);
    expect(progress.at(-1)).toMatchObject({ completed: 3, skipped: 2 });
});

test('all skipped repositories produce a partial zero-commit result', async () => {
    let writes = 0;
    const result = await runScraping(
        {
            ...configuration,
            universities: configuration.universities.slice(0, 1),
        },
        {
            client: recoveryClient([
                { id: 102, full_name: 'slu/tos' },
                { id: 103, full_name: 'slu/missing' },
            ]),
            store: {
                async upsertUniversity(_university, records) {
                    writes += 1;
                    expect(records).toEqual([]);
                    return 0;
                },
            },
        },
    );

    expect(writes).toBe(1);
    expect(result).toMatchObject({ failed: 0, partial: 1, committed: 0 });
    expect(result.results[0]).toMatchObject({
        status: 'partial',
        discovered: 2,
        committed: 0,
        skippedRepositories: expect.arrayContaining([
            expect.objectContaining({ reasonCode: 'github_tos_block' }),
            expect.objectContaining({ reasonCode: 'repository_unavailable_404' }),
        ]),
    });
});

test('strict policy fails on a skippable repository block before database write', async () => {
    let writes = 0;
    const result = await runScraping(
        {
            ...configuration,
            universities: configuration.universities.slice(0, 1),
        },
        {
            policy: 'strict',
            client: recoveryClient([{ id: 102, full_name: 'slu/tos' }]),
            store: {
                async upsertUniversity() {
                    writes += 1;
                    return 1;
                },
            },
        },
    );

    expect(writes).toBe(0);
    expect(result.failed).toBe(1);
    expect(formatCliFailure(result.failures[0])).toContain(
        'GitHub block reason tos',
    );
});

test('generic repository permission failures stay fatal and do not write', async () => {
    let writes = 0;
    const result = await runScraping(
        {
            ...configuration,
            universities: configuration.universities.slice(0, 1),
        },
        {
            client: recoveryClient(
                [{ id: 101, full_name: 'slu/good' }],
                { failStatus: 403 },
            ),
            store: {
                async upsertUniversity() {
                    writes += 1;
                    return 1;
                },
            },
        },
    );

    expect(writes).toBe(0);
    expect(result.failed).toBe(1);
    expect(formatCliFailure(result.failures[0])).toContain('HTTP 403');
    expect(result.failures[0].skippedRepositories).toEqual([]);
});

test('NUL normalization is reported as a partial result and committed text is replaced', async () => {
    let persisted: readonly RepositoryScrapingRecord[] = [];
    const result = await runScraping(
        {
            ...configuration,
            universities: configuration.universities.slice(0, 1),
        },
        {
            client: recoveryClient([{ id: 101, full_name: 'slu/good' }], {
                description: 'unsafe\u0000text',
            }),
            store: {
                async upsertUniversity(_university, records) {
                    persisted = records;
                    return records.length;
                },
            },
        },
    );

    expect(result.partial).toBe(1);
    expect(result.results[0].warnings).toMatchObject([
        { field: 'description', replacementCount: 1, code: 'nul_replaced' },
    ]);
    expect(persisted[0].description).toBe('unsafe�text');
});

test('retains text-normalization warnings when the later database write fails', async () => {
    const databaseError = Object.assign(new Error('private write details'), {
        code: '22021',
    });
    const result = await runScraping(
        {
            ...configuration,
            universities: configuration.universities.slice(0, 1),
        },
        {
            client: recoveryClient([{ id: 101, full_name: 'slu/good' }], {
                description: 'unsafe\u0000text',
            }),
            store: {
                async upsertUniversity() {
                    throw databaseError;
                },
            },
        },
    );

    expect(result.failed).toBe(1);
    expect(result.failures[0].warnings).toMatchObject([
        { field: 'description', replacementCount: 1 },
    ]);
    expect(formatCliFailure(result.failures[0])).toContain('SQLSTATE 22021');
    expect(formatCliFailure(result.failures[0])).not.toContain('private write details');
});
