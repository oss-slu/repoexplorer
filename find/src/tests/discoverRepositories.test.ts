import { discoverRepositories } from '../discoverRepositories';
import { GitHubPaginationError } from '../scraping';
import type { UniversityConfiguration } from '../types/scraping';
import {
    createTestClient,
    jsonResponse,
    nextPageHeader,
    searchEnvelope,
} from './githubFixtures';

const university: UniversityConfiguration = {
    key: 'Saint Louis University',
    fullName: 'Saint Louis University',
    acronym: 'SLU',
};

function repository(id: number, fullName = `owner/repo-${id}`) {
    return { id, full_name: fullName };
}

describe('discoverRepositories', () => {
    test('rejects an identity containing an actual NUL before enrichment', async () => {
        const client = createTestClient((url) => {
            if (url.pathname === '/search/repositories') {
                return jsonResponse(
                    searchEnvelope([repository(42, 'owner/bad\u0000name')]),
                );
            }
            if (url.pathname === '/search/users') {
                return jsonResponse(searchEnvelope([]));
            }
            throw new Error(`Unexpected request: ${url}`);
        });

        await expect(
            discoverRepositories(client, university, 2, {
                university: university.key,
            }),
        ).rejects.toMatchObject({
            name: 'RepositoryRecordValidationError',
            repository: 'repository 42',
            field: 'full_name',
        });
    });

    test('paginates, deduplicates overlapping repositories and owners, and uses the documented defaults', async () => {
        const client = createTestClient((url) => {
            if (url.pathname === '/search/repositories') {
                expect(url.searchParams.get('q')).toBe(
                    '"Saint Louis University" in:name,description archived:false size:>0 is:public',
                );
                if (url.searchParams.get('page') === '2') {
                    return jsonResponse(searchEnvelope([repository(2)], 2));
                }
                return jsonResponse(searchEnvelope([repository(1)], 2), {
                    link: nextPageHeader(url, 2),
                });
            }
            if (url.pathname === '/search/users') {
                const query = url.searchParams.get('q') ?? '';
                if (query.includes('type:org')) {
                    expect(query).toBe('"SLU" in:name,login type:org');
                    if (url.searchParams.get('page') === '2') {
                        return jsonResponse(
                            searchEnvelope(
                                [{ login: 'slu-dev', type: 'Organization' }],
                                2,
                            ),
                        );
                    }
                    return jsonResponse(
                        searchEnvelope(
                            [{ login: 'SLU-Dev', type: 'Organization' }],
                            2,
                        ),
                        { link: nextPageHeader(url, 2) },
                    );
                }
                expect(query).toBe('"SLU" in:name,login type:user');
                return jsonResponse(
                    searchEnvelope([{ login: 'slu-user', type: 'User' }]),
                );
            }
            if (url.pathname === '/orgs/SLU-Dev/repos') {
                if (url.searchParams.get('page') === '2') {
                    return jsonResponse([repository(3)]);
                }
                return jsonResponse([repository(1)], {
                    link: nextPageHeader(url, 2),
                });
            }
            if (url.pathname === '/users/slu-user/repos') {
                return jsonResponse([repository(1)]);
            }
            throw new Error(`Unexpected request: ${url}`);
        });

        const result = await discoverRepositories(client, university, 2);
        expect(result.candidates).toEqual([
            { id: 1, fullName: 'owner/repo-1' },
            { id: 2, fullName: 'owner/repo-2' },
            { id: 3, fullName: 'owner/repo-3' },
        ]);
        expect(result.ownersDiscovered).toBe(2);
    });

    test.each(['repositories', 'organizations', 'users'] as const)(
        'collects more than 1,000 %s results without narrowing the acronym',
        async (kind) => {
            const entries = Array.from({ length: 1_201 }, (_, index) => ({
                id: index + 1,
                full_name: `slu/repo-${index + 1}`,
                login: `slu-${index + 1}`,
                type: kind === 'organizations' ? 'Organization' : 'User',
                created: Date.parse(index < 600 ? '2009-01-01' : '2020-01-01'),
            }));
            const client = createTestClient((url) => {
                if (!url.pathname.startsWith('/search/'))
                    return jsonResponse([]);
                const query = url.searchParams.get('q') ?? '';
                const matchesKind =
                    kind === 'repositories'
                        ? url.pathname === '/search/repositories'
                        : url.pathname === '/search/users' &&
                          query.includes(
                              kind === 'organizations'
                                  ? 'type:org'
                                  : 'type:user',
                          );
                if (!matchesKind) return jsonResponse(searchEnvelope([]));
                const range = query.match(/created:(\S+)\.\.(\S+)/);
                const matching = range
                    ? entries.filter(
                          (entry) =>
                              entry.created >= Date.parse(range[1]) &&
                              entry.created <= Date.parse(range[2]),
                      )
                    : entries;
                const size = Number(url.searchParams.get('per_page'));
                const page = Number(url.searchParams.get('page') ?? '1');
                const end = size * page;
                return jsonResponse(
                    searchEnvelope(
                        matching.slice(end - size, end),
                        matching.length,
                    ),
                    end < matching.length
                        ? { link: nextPageHeader(url, page + 1) }
                        : {},
                );
            });
            const result = await discoverRepositories(client, university);
            if (kind === 'repositories') {
                expect(result.candidates).toHaveLength(1_201);
                expect(result.repositorySearchTotal).toBe(1_201);
                expect(result.candidates[1_200].id).toBe(1_201);
            } else {
                expect(result.ownersDiscovered).toBe(1_201);
                expect(
                    kind === 'organizations'
                        ? result.organizationSearchTotal
                        : result.userSearchTotal,
                ).toBe(1_201);
            }
        },
    );

    test.each([
        {
            kind: 'Organization' as const,
            login: 'missing-org',
            endpoint: '/orgs/missing-org/repos',
            query: 'type:org',
        },
        {
            kind: 'User' as const,
            login: 'missing-user',
            endpoint: '/users/missing-user/repos',
            query: 'type:user',
        },
    ])('skips a $kind owner listing 404 by default and keeps independent candidates', async ({
        kind,
        login,
        endpoint,
        query,
    }) => {
        const client = createTestClient((url) => {
            if (url.pathname === '/search/repositories') {
                return jsonResponse(searchEnvelope([repository(50)]));
            }
            if (url.pathname === '/search/users') {
                const owners = url.searchParams.get('q')?.includes(query)
                    ? [{ login, type: kind }]
                    : [];
                return jsonResponse(searchEnvelope(owners));
            }
            if (url.pathname === endpoint) {
                return jsonResponse(
                    { message: 'private diagnostic body' },
                    {},
                    404,
                );
            }
            throw new Error(`Unexpected request: ${url}`);
        });

        const result = await discoverRepositories(client, university);

        expect(result.candidates).toEqual([
            { id: 50, fullName: 'owner/repo-50' },
        ]);
        expect(result.skippedOwners).toEqual([
            expect.objectContaining({
                university: university.key,
                login,
                ownerType: kind,
                endpoint: `https://api.github.com${endpoint}`,
                status: 404,
                reason: expect.stringContaining('HTTP 404'),
            }),
        ]);
        if (kind === 'Organization') {
            expect(result.skippedOwners[0].endpoint).not.toContain('/users/');
        }
    });

    test('discards earlier pages for an owner when a later page returns 404 and continues with other owners', async () => {
        const client = createTestClient((url) => {
            if (url.pathname === '/search/repositories') {
                return jsonResponse(searchEnvelope([]));
            }
            if (url.pathname === '/search/users') {
                const owners = url.searchParams.get('q')?.includes('type:org')
                    ? [
                          { login: 'late-missing', type: 'Organization' },
                          { login: 'accessible', type: 'Organization' },
                      ]
                    : [];
                return jsonResponse(searchEnvelope(owners));
            }
            if (url.pathname === '/orgs/late-missing/repos') {
                if (url.searchParams.get('page') === '2') {
                    return jsonResponse({ message: 'private body' }, {}, 404);
                }
                return jsonResponse([repository(10)], {
                    link: nextPageHeader(url, 2),
                });
            }
            if (url.pathname === '/orgs/accessible/repos') {
                return jsonResponse([repository(20)]);
            }
            throw new Error(`Unexpected request: ${url}`);
        });

        const result = await discoverRepositories(client, university, 1);

        expect(result.candidates).toEqual([
            { id: 20, fullName: 'owner/repo-20' },
        ]);
        expect(result.skippedOwners).toHaveLength(1);
        expect(result.skippedOwners[0].login).toBe('late-missing');
        expect(result.skippedOwners[0].endpoint).toBe(
            'https://api.github.com/orgs/late-missing/repos',
        );
    });

    test('returns partial discovery when every owner is unavailable and has no candidates', async () => {
        const client = createTestClient((url) => {
            if (url.pathname === '/search/repositories') {
                return jsonResponse(searchEnvelope([]));
            }
            if (url.pathname === '/search/users') {
                const isOrganization = url.searchParams
                    .get('q')
                    ?.includes('type:org');
                return jsonResponse(
                    searchEnvelope([
                        {
                            login: isOrganization ? 'missing-org' : 'missing-user',
                            type: isOrganization ? 'Organization' : 'User',
                        },
                    ]),
                );
            }
            if (
                url.pathname === '/orgs/missing-org/repos' ||
                url.pathname === '/users/missing-user/repos'
            ) {
                return jsonResponse({ message: 'Not Found' }, {}, 404);
            }
            throw new Error(`Unexpected request: ${url}`);
        });

        const result = await discoverRepositories(client, university);

        expect(result.candidates).toEqual([]);
        expect(result.skippedOwners).toHaveLength(2);
    });

    test('strict policy rejects owner-listing 404s without trying another endpoint', async () => {
        let fallbackRequests = 0;
        const client = createTestClient((url) => {
            if (url.pathname.startsWith('/search/')) {
                return jsonResponse(
                    searchEnvelope(
                        url.pathname === '/search/users' &&
                            url.searchParams.get('q')?.includes('type:org')
                            ? [{ login: 'strict-org', type: 'Organization' }]
                            : [],
                    ),
                );
            }
            if (url.pathname === '/orgs/strict-org/repos') {
                return jsonResponse({ message: 'Not Found' }, {}, 404);
            }
            if (url.pathname === '/users/strict-org/repos') {
                fallbackRequests += 1;
                return jsonResponse([]);
            }
            throw new Error(`Unexpected request: ${url}`);
        });

        await expect(
            discoverRepositories(client, university, 4, {
                university: university.key,
                policy: 'strict',
            }),
        ).rejects.toMatchObject({
            cause: expect.objectContaining({ status: 404 }),
        });
        expect(fallbackRequests).toBe(0);
    });

    test.each([401, 403, 500])(
        'keeps unrelated owner-listing HTTP %s errors fatal in best-effort mode',
        async (status) => {
            const client = createTestClient((url) => {
                if (url.pathname === '/search/repositories') {
                    return jsonResponse(searchEnvelope([]));
                }
                if (url.pathname === '/search/users') {
                    const isOrganization = url.searchParams
                        .get('q')
                        ?.includes('type:org');
                    return jsonResponse(
                        searchEnvelope(
                            isOrganization
                                ? [
                                      {
                                          login: 'blocked',
                                          type: 'Organization',
                                      },
                                  ]
                                : [],
                        ),
                    );
                }
                if (url.pathname === '/orgs/blocked/repos') {
                    return jsonResponse({ message: 'Not Found' }, {}, status);
                }
                throw new Error(`Unexpected request: ${url}`);
            });

            await expect(
                discoverRepositories(client, university),
            ).rejects.toMatchObject({
                cause: expect.objectContaining({ status }),
            });
        },
    );

    test('requires search metadata before claiming a complete result', async () => {
        const client = createTestClient((url) =>
            url.pathname === '/search/repositories'
                ? jsonResponse({ items: [] })
                : jsonResponse(searchEnvelope([])),
        );

        await expect(
            discoverRepositories(client, university),
        ).rejects.toMatchObject({
            cause: expect.any(GitHubPaginationError),
        });
    });
});
