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
            /marked results incomplete/,
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
        endpoint:
            'https://api.github.com/users/missing-owner/repos?per_page=100&type=owner',
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
