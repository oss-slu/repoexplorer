import { searchGitHub } from '../utils/githubSearch';
import {
    createTestClient,
    jsonResponse,
    nextPageHeader,
    searchEnvelope,
} from './githubFixtures';

describe('searchGitHub', () => {
    test('accepts exactly 1,000 results and follows all ten pages', async () => {
        const pages: number[] = [];
        const client = createTestClient((url) => {
            if (url.searchParams.get('per_page') === '1') {
                return jsonResponse(searchEnvelope([{ id: 1 }], 1_000));
            }
            const page = Number(url.searchParams.get('page') ?? '1');
            pages.push(page);
            return jsonResponse(
                searchEnvelope(
                    Array.from({ length: 100 }, (_, i) => ({
                        id: (page - 1) * 100 + i + 1,
                    })),
                    1_000,
                ),
                page < 10 ? { link: nextPageHeader(url, page + 1) } : {},
            );
        });
        const result = await searchGitHub<{ id: number }>(
            client,
            'users',
            'SLU type:user',
            'user',
        );
        expect(result.items).toHaveLength(1_000);
        expect(result.totalCount).toBe(1_000);
        expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    test('uses adjacent second boundaries, keeps custom terms, and avoids paginating capped queries', async () => {
        const ranges: [number, number][] = [];
        const query = 'SLU in:login type:org location:USA';
        const client = createTestClient((url) => {
            const q = url.searchParams.get('q') ?? '';
            expect(q.startsWith(query)).toBe(true);
            if (q === query) {
                expect(url.searchParams.get('per_page')).toBe('1');
                return jsonResponse(searchEnvelope([], 1_001), {
                    link: nextPageHeader(url, 2),
                });
            }
            const range = q.match(/created:(\S+)\.\.(\S+)/)!;
            if (url.searchParams.get('per_page') === '1') {
                ranges.push([Date.parse(range[1]), Date.parse(range[2])]);
            }
            const count = Date.parse(range[1]) === 0 ? 500 : 501;
            // One synthetic page is enough to exercise partition aggregation.
            return jsonResponse(
                searchEnvelope(
                    Array.from({ length: count }, (_, id) => ({ id })),
                    count,
                ),
            );
        });
        expect(
            (await searchGitHub(client, 'users', query, 'organization'))
                .totalCount,
        ).toBe(1_001);
        expect(ranges).toHaveLength(2);
        expect(ranges[0][0]).toBe(0);
        expect(ranges[1][0]).toBe(ranges[0][1] + 1_000);
    });

    test('terminates when more than 1,000 matches share one second', async () => {
        let calls = 0;
        const client = createTestClient(() => {
            calls++;
            return jsonResponse(searchEnvelope([], 1_001));
        });
        await expect(
            searchGitHub(client, 'users', 'SLU', 'user'),
        ).rejects.toThrow(/within one second/);
        expect(calls).toBeLessThan(40);
    });

    test('fails if counts change across partitions', async () => {
        const client = createTestClient((url) =>
            jsonResponse(
                searchEnvelope(
                    [],
                    url.searchParams.get('q')?.includes('created:') ? 0 : 1_001,
                ),
            ),
        );
        await expect(
            searchGitHub(client, 'users', 'SLU', 'user'),
        ).rejects.toThrow(/changed across partitions/);
    });

    test('does not replace an existing creation filter on a capped custom query', async () => {
        const client = createTestClient(() =>
            jsonResponse(searchEnvelope([], 1_001)),
        );
        await expect(
            searchGitHub(client, 'users', 'SLU created:>2020-01-01', 'user'),
        ).rejects.toThrow(/already contains a created: qualifier/);
    });

    test.each([
        { items: [], total_count: -1, incomplete_results: false },
        { items: [], total_count: 0 },
        { items: [], total_count: 0, incomplete_results: true },
        { total_count: 0, incomplete_results: false },
    ])('rejects missing, invalid, or incomplete metadata: %j', async (body) => {
        const client = createTestClient(() => jsonResponse(body));
        await expect(
            searchGitHub(client, 'users', 'SLU', 'user'),
        ).rejects.toThrow();
    });

    test.each(['short', 'changed', 'incomplete'])(
        'rejects a %s result after the probe',
        async (scenario) => {
            const client = createTestClient((url) =>
                jsonResponse(
                    url.searchParams.get('per_page') === '1'
                        ? searchEnvelope([{ id: 1 }], 2)
                        : searchEnvelope(
                              [{ id: 1 }],
                              scenario === 'changed' ? 1 : 2,
                              scenario === 'incomplete',
                          ),
                ),
            );
            await expect(
                searchGitHub(client, 'users', 'SLU', 'user'),
            ).rejects.toThrow();
        },
    );
});
