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

    test('requires search metadata before claiming a complete result', async () => {
        const client = createTestClient((url) =>
            url.pathname === '/search/repositories'
                ? jsonResponse({ items: [] })
                : jsonResponse(searchEnvelope([])),
        );

        await expect(
            discoverRepositories(client, university),
        ).rejects.toBeInstanceOf(GitHubPaginationError);
    });
});
