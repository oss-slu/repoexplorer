import {
    enrichRepository,
    enrichRepositoryWithEtags,
} from '../enrichRepository';
import type {
    RepositoryCandidate,
    RepositoryContributorCache,
    UniversityConfiguration,
} from '../types/scraping';
import {
    createTestClient,
    jsonResponse,
    nextPageHeader,
} from './githubFixtures';

const university: UniversityConfiguration = {
    key: 'Saint Louis University',
    fullName: 'Saint Louis University',
    acronym: 'SLU',
};
const candidate: RepositoryCandidate = { id: 77, fullName: 'slu/project' };
const SIZE_LIMIT_MESSAGE =
    'The history or contributor list is too large to list contributors for this repository via the API.';

type ContributorRequest = { page: number; ifNoneMatch: string | null };

/**
 * Serves one repository over REST. The contributor endpoint answers `304`
 * whenever `If-None-Match` matches the first page's current ETag, as GitHub
 * does, so the tests can show which lists a first-page `304` can revalidate.
 */
function contributorServer(options: {
    pages: string[][];
    etag?: string;
    noContent?: boolean;
    sizeLimit?: boolean;
}) {
    const requests: ContributorRequest[] = [];
    const client = createTestClient((url, init) => {
        const path = url.pathname;
        if (path === '/repos/slu/project') return jsonResponse(repository());
        if (path === '/repos/slu/project/contributors') {
            const page = Number(url.searchParams.get('page') ?? '1');
            const ifNoneMatch = new Headers(init.headers).get('if-none-match');
            requests.push({ page, ifNoneMatch });
            if (options.sizeLimit) {
                return jsonResponse({ message: SIZE_LIMIT_MESSAGE }, {}, 403);
            }
            const etagHeaders: Record<string, string> =
                options.etag && page === 1 ? { etag: options.etag } : {};
            if (options.noContent) {
                return new Response(null, {
                    status: 204,
                    headers: etagHeaders,
                });
            }
            if (page === 1 && ifNoneMatch && ifNoneMatch === options.etag) {
                return new Response(null, {
                    status: 304,
                    headers: etagHeaders,
                });
            }
            const logins = options.pages[page - 1] ?? [];
            return jsonResponse(
                logins.map((login) => ({ login, contributions: 1 })),
                {
                    ...etagHeaders,
                    ...(page < options.pages.length
                        ? { link: nextPageHeader(url, page + 1) }
                        : {}),
                },
            );
        }
        if (path === '/repos/slu/project/releases') return jsonResponse([]);
        if (path === '/repos/slu/project/community/profile') {
            return jsonResponse({ files: {} });
        }
        if (path === '/repos/slu/project/contents') return jsonResponse([]);
        return jsonResponse({ message: 'Not Found' }, {}, 404);
    });
    return { client, requests };
}

function withCache(cache: RepositoryContributorCache): RepositoryCandidate {
    return { ...candidate, contributorCache: cache };
}

function logins(count: number, prefix = 'user'): string[] {
    return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

describe('conditional contributor reads', () => {
    test('saves the ETag of a single page that is not full', async () => {
        const server = contributorServer({
            pages: [['alice', 'bob']],
            etag: '"c1"',
        });

        const result = await enrichRepositoryWithEtags(
            server.client,
            candidate,
            university,
        );

        expect(result.contributorsEtag).toBe('"c1"');
        expect(result.record.contributors).toBe('["alice","bob"]');
        expect(server.requests).toEqual([{ page: 1, ifNoneMatch: null }]);
    });

    test('reuses the cached list on a 304 with one free request', async () => {
        const server = contributorServer({
            pages: [['alice', 'bob']],
            etag: '"c1"',
        });

        const result = await enrichRepositoryWithEtags(
            server.client,
            withCache({ etag: '"c1"', logins: ['alice', 'bob'] }),
            university,
        );

        expect(server.requests).toEqual([{ page: 1, ifNoneMatch: '"c1"' }]);
        expect(result.record.contributors).toBe('["alice","bob"]');
        expect(result.record.contributorCount).toBe(2);
        expect(result.contributorsEtag).toBe('"c1"');
    });

    test('replaces the cached list and ETag when the list changed', async () => {
        const server = contributorServer({
            pages: [['alice', 'bob', 'carol']],
            etag: '"c2"',
        });

        const result = await enrichRepositoryWithEtags(
            server.client,
            withCache({ etag: '"c1"', logins: ['alice', 'bob'] }),
            university,
        );

        expect(server.requests).toEqual([{ page: 1, ifNoneMatch: '"c1"' }]);
        expect(result.record.contributors).toBe('["alice","bob","carol"]');
        expect(result.record.contributorCount).toBe(3);
        expect(result.contributorsEtag).toBe('"c2"');
    });

    test('reads every page of a changed list that now spans two pages', async () => {
        const server = contributorServer({
            pages: [logins(100), ['late']],
            etag: '"c2"',
        });

        const result = await enrichRepositoryWithEtags(
            server.client,
            withCache({ etag: '"c1"', logins: logins(99) }),
            university,
        );

        expect(server.requests).toEqual([
            { page: 1, ifNoneMatch: '"c1"' },
            { page: 2, ifNoneMatch: null },
        ]);
        expect(result.record.contributorCount).toBe(101);
        expect(result.contributorsEtag).toBeUndefined();
    });

    test.each([
        { label: 'a multi-page list', pages: [logins(100), ['late']] },
        // A 101st contributor would land on page 2 and leave page 1 unchanged.
        { label: 'one full page', pages: [logins(100)] },
    ])('saves no reusable ETag for $label', async ({ pages }) => {
        const server = contributorServer({ pages, etag: '"c1"' });

        const result = await enrichRepositoryWithEtags(
            server.client,
            candidate,
            university,
        );

        expect(result.contributorsEtag).toBeUndefined();
        expect(result.record.contributorCount).toBe(
            pages.reduce((total, page) => total + page.length, 0),
        );
    });

    test('never sends a conditional request for a cached full page', async () => {
        // Page 1 is unchanged, so a conditional request would answer 304 and
        // hide the contributor that moved onto page 2.
        const server = contributorServer({
            pages: [logins(100), ['late']],
            etag: '"c1"',
        });

        const result = await enrichRepositoryWithEtags(
            server.client,
            withCache({ etag: '"c1"', logins: logins(100) }),
            university,
        );

        expect(server.requests).toEqual([
            { page: 1, ifNoneMatch: null },
            { page: 2, ifNoneMatch: null },
        ]);
        expect(result.record.contributorCount).toBe(101);
        expect(result.contributorsEtag).toBeUndefined();
    });

    test('keeps the 204 empty-list case and caches its ETag', async () => {
        const server = contributorServer({
            pages: [],
            etag: '"empty"',
            noContent: true,
        });

        const result = await enrichRepositoryWithEtags(
            server.client,
            withCache({ etag: '"old"', logins: ['alice'] }),
            university,
        );

        expect(result.record.contributors).toBe('[]');
        expect(result.record.contributorCount).toBe(0);
        expect(result.contributorsEtag).toBe('"empty"');
    });

    test('keeps the contributor size-limit skip for a conditional request', async () => {
        const server = contributorServer({ pages: [], sizeLimit: true });

        await expect(
            enrichRepository(
                server.client,
                withCache({ etag: '"c1"', logins: ['alice'] }),
                university,
            ),
        ).rejects.toMatchObject({
            name: 'RepositoryEnrichmentSkipError',
            skippedRepository: {
                endpoint:
                    'https://api.github.com/repos/slu/project/contributors',
                reasonCode: 'github_contributors_unavailable',
            },
        });
        expect(server.requests).toEqual([{ page: 1, ifNoneMatch: '"c1"' }]);
    });
});

function repository() {
    return {
        id: 77,
        name: 'project',
        full_name: 'slu/project',
        owner: { login: 'slu', type: 'Organization' },
        private: false,
        license: null,
        language: null,
        html_url: 'https://github.com/slu/project',
        description: null,
        fork: false,
        archived: false,
        is_template: false,
        created_at: '2020-01-02T03:04:05Z',
        updated_at: '2024-05-06T07:08:09Z',
        pushed_at: '2024-05-06T07:08:09Z',
        homepage: null,
        size: 0,
        stargazers_count: 0,
        watchers_count: 0,
        forks_count: 0,
        open_issues_count: 0,
        subscribers_count: 0,
    };
}
