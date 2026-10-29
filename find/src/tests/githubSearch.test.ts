import { jest } from '@jest/globals';
import { searchGitHub } from '../utils/githubSearch';
import {
    GitHubRequestError,
} from '../utils/githubRequest';
import {
    createTestClient,
    jsonResponse,
    nextPageHeader,
    searchEnvelope,
} from './githubFixtures';

const fastSearch = {
    now: () => Date.parse('2026-10-27T12:00:00.000Z'),
    sleep: async () => {},
};

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
            fastSearch,
        );
        expect(result.items).toHaveLength(1_000);
        expect(result.totalCount).toBe(1_000);
        expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    test('uses adjacent second boundaries and avoids paginating capped queries', async () => {
        const ranges: [number, number][] = [];
        const query = 'SLU in:login type:org location:USA';
        const client = createTestClient((url) => {
            const q = url.searchParams.get('q') ?? '';
            expect(q.startsWith(query)).toBe(true);
            if (q === query) {
                expect(url.searchParams.get('per_page')).toBe('1');
                return jsonResponse(searchEnvelope([], 1_001));
            }
            const range = q.match(/created:(\S+)\.\.(\S+)/)!;
            if (url.searchParams.get('per_page') === '1') {
                ranges.push([Date.parse(range[1]), Date.parse(range[2])]);
            }
            const count = Date.parse(range[1]) === 0 ? 500 : 501;
            return jsonResponse(
                searchEnvelope(Array.from({ length: count }, (_, id) => ({ id })), count),
            );
        });
        expect(
            (
                await searchGitHub(
                    client,
                    'users',
                    query,
                    'organization',
                    fastSearch,
                )
            ).totalCount,
        ).toBe(1_001);
        expect(ranges).toHaveLength(2);
        expect(ranges[0][0]).toBe(0);
        expect(ranges[1][0]).toBe(ranges[0][1] + 1_000);
    });

    test('retries an explicitly incomplete root probe from the root', async () => {
        let probeAttempts = 0;
        const progress = jest.fn();
        const client = createTestClient((url) => {
            if (url.searchParams.get('per_page') === '1') {
                probeAttempts += 1;
                return jsonResponse(
                    searchEnvelope(
                        [{ id: probeAttempts * 10 }],
                        1,
                        probeAttempts === 1,
                    ),
                );
            }
            const id = probeAttempts * 10 + 1;
            return jsonResponse(searchEnvelope([{ id }], 1));
        });

        const result = await searchGitHub<{ id: number }>(
            client,
            'users',
            'SLU type:user',
            'user',
            { ...fastSearch, onProgress: progress },
        );

        expect(probeAttempts).toBe(2);
        expect(result.items).toEqual([{ id: 21 }]);
        expect(progress).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'search-retry',
                searchKind: 'user',
                reason: 'incomplete-results',
                attempt: 2,
                totalAttempts: 3,
            }),
        );
    });

    test('retries an explicitly incomplete later page and drops failed-page IDs', async () => {
        let attempt = 0;
        const client = createTestClient((url) => {
            if (url.searchParams.get('per_page') === '1') {
                attempt += 1;
                return jsonResponse(searchEnvelope([], 2));
            }
            const page = Number(url.searchParams.get('page') ?? '1');
            if (page === 1) {
                return jsonResponse(
                    searchEnvelope([{ id: attempt * 100 + 1 }], 2),
                    { link: nextPageHeader(url, 2) },
                );
            }
            return jsonResponse(
                searchEnvelope(
                    [{ id: attempt * 100 + 2 }],
                    2,
                    attempt === 1,
                ),
            );
        });

        const result = await searchGitHub<{ id: number }>(
            client,
            'users',
            'SLU',
            'user',
            fastSearch,
        );
        expect(result.items).toEqual([{ id: 201 }, { id: 202 }]);
    });

    test('discards pages from a failed attempt before retrying the entire partition tree', async () => {
        let attempt = 0;
        const query = 'SLU';
        const client = createTestClient((url) => {
            const q = url.searchParams.get('q') ?? '';
            const perPage = url.searchParams.get('per_page');
            if (q === query && perPage === '1') {
                attempt += 1;
                return jsonResponse(searchEnvelope([], 1_001));
            }
            if (perPage === '1') {
                const range = q.match(/created:(\S+)\.\.(\S+)/)!;
                const isRightHalf = Date.parse(range[1]) > 0;
                return jsonResponse(
                    searchEnvelope(
                        [],
                        isRightHalf ? 501 : 500,
                        isRightHalf && attempt === 1,
                    ),
                );
            }
            const range = q.match(/created:(\S+)\.\.(\S+)/)!;
            const isRightHalf = Date.parse(range[1]) > 0;
            const count = isRightHalf ? 501 : 500;
            return jsonResponse(
                searchEnvelope(
                    Array.from({ length: count }, (_, index) => ({
                        id: attempt * 1_000 + (isRightHalf ? 501 : 1) + index,
                    })),
                    count,
                ),
            );
        });

        const result = await searchGitHub<{ id: number }>(
            client,
            'users',
            query,
            'user',
            fastSearch,
        );

        expect(result.items).toHaveLength(1_001);
        expect(result.items.some((item) => item.id < 2_000)).toBe(false);
    });

    test.each([
        ['changed', 'count-changed'],
        ['short', 'short-results'],
    ] as const)(
        'restarts after %s results and returns only the complete attempt',
        async (scenario, reason) => {
            let attempt = 0;
            const progress = jest.fn();
            const client = createTestClient((url) => {
                if (url.searchParams.get('per_page') === '1') {
                    attempt += 1;
                    return jsonResponse(searchEnvelope([], 2));
                }
                if (scenario === 'changed' && attempt === 1) {
                    return jsonResponse(searchEnvelope([{ id: 101 }], 1));
                }
                return jsonResponse(
                    searchEnvelope(
                        attempt === 1 ? [{ id: 101 }] : [{ id: 201 }, { id: 202 }],
                        2,
                    ),
                );
            });

            const result = await searchGitHub<{ id: number }>(
                client,
                'users',
                'SLU',
                'user',
                { ...fastSearch, onProgress: progress },
            );
            expect(result.items).toEqual([{ id: 201 }, { id: 202 }]);
            expect(attempt).toBe(2);
            expect(result.items.map((item) => item.id)).not.toContain(101);
            expect(progress).toHaveBeenCalledWith(
                expect.objectContaining({ reason }),
            );
        },
    );

    test('retries changed counts between partition probes', async () => {
        let attempt = 0;
        const query = 'SLU';
        const client = createTestClient((url) => {
            const q = url.searchParams.get('q') ?? '';
            const perPage = url.searchParams.get('per_page');
            if (q === query && perPage === '1') {
                attempt += 1;
                return jsonResponse(searchEnvelope([], 1_001));
            }
            const range = q.match(/created:(\S+)\.\.(\S+)/)!;
            const isRightHalf = Date.parse(range[1]) > 0;
            if (perPage === '1') {
                const count = isRightHalf ? (attempt === 1 ? 500 : 501) : 500;
                return jsonResponse(searchEnvelope([], count));
            }
            const count = isRightHalf ? 501 : 500;
            return jsonResponse(
                searchEnvelope(Array.from({ length: count }, (_, id) => ({ id })), count),
            );
        });
        const result = await searchGitHub(client, 'users', query, 'user', fastSearch);
        expect(attempt).toBe(2);
        expect(result.totalCount).toBe(1_001);
    });

    test('reports three exhausted transient attempts with structured context', async () => {
        let calls = 0;
        const client = createTestClient(() => {
            calls += 1;
            return jsonResponse(searchEnvelope([], 0, true));
        });

        await expect(
            searchGitHub(client, 'users', 'secret search phrase', 'user', fastSearch),
        ).rejects.toMatchObject({
            name: 'GitHubSearchError',
            reason: 'incomplete-results',
            endpointKind: 'users',
            searchKind: 'user',
            stage: 'probe',
            searchAttempts: 3,
            maxSearchAttempts: 3,
            retriesExhausted: true,
        });
        expect(calls).toBe(3);
    });

    test('keeps malformed metadata and capped created filters non-retryable', async () => {
        const malformed = createTestClient(() =>
            jsonResponse({ items: [], total_count: 0 }),
        );
        await expect(
            searchGitHub(malformed, 'users', 'SLU', 'user', fastSearch),
        ).rejects.toMatchObject({
            reason: 'invalid-search-metadata',
            searchAttempts: 1,
            retriesExhausted: false,
        });

        let calls = 0;
        const customCreated = createTestClient(() => {
            calls += 1;
            return jsonResponse(searchEnvelope([], 1_001));
        });
        await expect(
            searchGitHub(
                customCreated,
                'users',
                'SLU created:>2020-01-01',
                'user',
                fastSearch,
            ),
        ).rejects.toMatchObject({ reason: 'created-filter-conflict' });
        expect(calls).toBe(1);
    });

    test('fails when more than 1,000 matches share one second', async () => {
        let calls = 0;
        const client = createTestClient(() => {
            calls += 1;
            return jsonResponse(searchEnvelope([], 1_001));
        });
        await expect(
            searchGitHub(client, 'users', 'SLU', 'user', {
                ...fastSearch,
                now: () => 1_000,
            }),
        ).rejects.toMatchObject({
            reason: 'single-second-overflow',
            stage: 'partition-aggregation',
            searchAttempts: 1,
        });
        expect(calls).toBe(2);
    });

    test('enforces one cumulative partition probe budget across retries', async () => {
        let calls = 0;
        let attempt = 0;
        const client = createTestClient((url) => {
            calls += 1;
            if (url.searchParams.get('per_page') !== '1') {
                throw new Error('Pagination is not expected');
            }
            const q = url.searchParams.get('q') ?? '';
            if (q === 'SLU') {
                attempt += 1;
                if (attempt === 1) return jsonResponse(searchEnvelope([], 0, true));
                return jsonResponse(searchEnvelope([], 1_001));
            }
            return jsonResponse(searchEnvelope([], 0));
        });

        await expect(
            searchGitHub(client, 'users', 'SLU', 'user', {
                ...fastSearch,
                partitionProbeBudget: 3,
            }),
        ).rejects.toMatchObject({
            reason: 'partition-limit',
            searchAttempts: 2,
            retriesExhausted: false,
        });
        expect(calls).toBe(3);
    });

    test('a pagination cycle fails once and does not replay request-client errors', async () => {
        let calls = 0;
        const cycling = createTestClient((url) => {
            calls += 1;
            if (url.searchParams.get('per_page') === '1') {
                return jsonResponse(searchEnvelope([], 2));
            }
            return jsonResponse(
                searchEnvelope([{ id: 1 }], 2),
                { link: `<${url.toString()}>; rel="next"` },
            );
        });
        await expect(
            searchGitHub(cycling, 'users', 'SLU', 'user', fastSearch),
        ).rejects.toMatchObject({
            reason: 'pagination-cycle',
            searchAttempts: 1,
        });
        expect(calls).toBe(2);

        calls = 0;
        const requestFailure = createTestClient(() => {
            calls += 1;
            return jsonResponse({ message: 'temporary server failure' }, {}, 503);
        });
        await expect(
            searchGitHub(requestFailure, 'users', 'SLU', 'user', fastSearch),
        ).rejects.toBeInstanceOf(GitHubRequestError);
        expect(calls).toBe(1);
    });

    test('page-limit exhaustion is terminal and bounded', async () => {
        let calls = 0;
        const client = createTestClient((url) => {
            calls += 1;
            if (url.searchParams.get('per_page') === '1') {
                return jsonResponse(searchEnvelope([], 2));
            }
            const page = Number(url.searchParams.get('page') ?? '1');
            const next = new URL(url);
            next.searchParams.set('page', String(page + 1));
            return jsonResponse(
                searchEnvelope([{ id: page }], 2),
                { link: `<${next.toString()}>; rel="next"` },
            );
        });
        await expect(
            searchGitHub(client, 'users', 'SLU', 'user', {
                ...fastSearch,
                pageLimit: 2,
            }),
        ).rejects.toMatchObject({
            reason: 'page-limit',
            searchAttempts: 1,
            retriesExhausted: false,
        });
        expect(calls).toBe(3);
    });

    test('aborting during search backoff stops before another probe', async () => {
        const controller = new AbortController();
        let calls = 0;
        let startSleep!: () => void;
        const sleeping = new Promise<void>((resolve) => {
            startSleep = resolve;
        });
        const client = createTestClient(() => {
            calls += 1;
            return jsonResponse(searchEnvelope([], 0, true));
        });
        const abortError = new Error('cancelled');
        const result = searchGitHub(client, 'users', 'SLU', 'user', {
            ...fastSearch,
            signal: controller.signal,
            sleep: (_delay, signal) =>
                new Promise((_, reject) => {
                    startSleep();
                    signal?.addEventListener(
                        'abort',
                        () => reject(signal.reason),
                        { once: true },
                    );
                }),
        });
        await sleeping;
        controller.abort(abortError);
        await expect(result).rejects.toBe(abortError);
        expect(calls).toBe(1);
    });

    test('does not parse custom search text into a failure message', async () => {
        const query = 'secret query must not be emitted';
        const client = createTestClient(() =>
            jsonResponse({ items: [], total_count: 0 }),
        );
        try {
            await searchGitHub(client, 'users', query, 'user', fastSearch);
        } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).not.toContain(query);
        }
    });
});
