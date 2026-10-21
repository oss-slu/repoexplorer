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

    test('fails when a search reaches GitHub’s 1,000-result limit', async () => {
        const client = createTestClient((url) =>
            url.pathname === '/search/repositories'
                ? jsonResponse(searchEnvelope([], 1_000))
                : jsonResponse(searchEnvelope([])),
        );

        await expect(discoverRepositories(client, university)).rejects.toThrow(
            /1,000-result search limit/,
        );
    });

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
