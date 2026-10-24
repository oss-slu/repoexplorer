import {
    GitHubNetworkError,
    GitHubRequestClient,
    GitHubRequestError,
    GitHubResponseParseError,
    GitHubTimeoutError,
} from '../utils/githubRequest';
import {
    GitHubPaginationError,
    paginateGitHub,
} from '../utils/githubPagination';
import { jest } from '@jest/globals';

function createFetchMock(
    implementation?: (
        ...args: Parameters<typeof fetch>
    ) => ReturnType<typeof fetch>,
) {
    return jest.fn(
        implementation ?? (async () => new Response()),
    ) as unknown as jest.Mock<
        (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>
    >;
}

function jsonResponse(
    data: unknown,
    status = 200,
    headers?: HeadersInit,
): Response {
    return new Response(JSON.stringify(data), { status, headers });
}

function createClient(
    fetchImplementation: typeof fetch,
    config: ConstructorParameters<typeof GitHubRequestClient>[0] = {},
): GitHubRequestClient {
    return new GitHubRequestClient({
        fetch: fetchImplementation,
        sleep: async () => undefined,
        random: () => 0,
        retryBaseDelayMs: 0,
        retryMaxDelayMs: 0,
        now: () => Date.now(),
        ...config,
    });
}

describe('GitHubRequestClient', () => {
    test.each(['https://api.github.com', 'https://github.example/api/v3/'])(
        'keeps repositories named search in the core cooldown at %s',
        async (baseUrl) => {
            jest.useFakeTimers();
            try {
                const fetchMock = createFetchMock()
                    .mockResolvedValueOnce(
                        jsonResponse({ ok: true }, 200, {
                            'x-ratelimit-remaining': '0',
                            'x-ratelimit-reset': String(
                                Math.ceil((Date.now() + 2_000) / 1_000),
                            ),
                            'x-ratelimit-resource': 'core',
                        }),
                    )
                    .mockImplementation(async () => jsonResponse({ ok: true }));
                const client = createClient(fetchMock, { baseUrl });
                const first = client.request('/repos/acme/search');
                const second = client.request('/repos/acme/search/issues');
                await jest.advanceTimersByTimeAsync(0);
                await expect(first).resolves.toMatchObject({ status: 200 });
                expect(fetchMock).toHaveBeenCalledTimes(1);
                await jest.advanceTimersByTimeAsync(2_900);
                expect(fetchMock).toHaveBeenCalledTimes(1);
                await jest.advanceTimersByTimeAsync(1_200);
                await expect(second).resolves.toMatchObject({ status: 200 });
            } finally {
                jest.useRealTimers();
            }
        },
    );

    test.each([
        {
            label: 'numeric Retry-After later than reset',
            retryAfter: '30',
            resetAt: '110',
            expectedDeadline: 130_000,
        },
        {
            label: 'HTTP-date Retry-After later than reset',
            retryAfter: new Date(130_000).toUTCString(),
            resetAt: '110',
            expectedDeadline: 130_000,
        },
        {
            label: 'reset later than Retry-After',
            retryAfter: '5',
            resetAt: '110',
            expectedDeadline: 111_000,
        },
        {
            label: 'malformed Retry-After',
            retryAfter: 'not-a-time',
            resetAt: '110',
            expectedDeadline: 111_000,
        },
        {
            label: 'past HTTP-date Retry-After',
            retryAfter: new Date(90_000).toUTCString(),
            resetAt: '110',
            expectedDeadline: 111_000,
        },
        {
            label: 'missing reset data',
            retryAfter: '30',
            resetAt: undefined,
            expectedDeadline: 160_000,
        },
    ])(
        'schedules successful zero-quota responses using the later deadline: $label',
        async ({ retryAfter, resetAt, expectedDeadline }) => {
            jest.useFakeTimers();
            jest.setSystemTime(100_000);
            let coreRequests = 0;
            const waitDeadlines: number[] = [];
            const fetchMock = createFetchMock(async (input) => {
                const url = new URL(String(input));
                if (url.pathname.startsWith('/search/')) {
                    return jsonResponse({ ok: true });
                }

                coreRequests += 1;
                if (coreRequests > 1) return jsonResponse({ ok: true });
                const headers = new Headers({
                    'x-ratelimit-remaining': '0',
                    'x-ratelimit-resource': 'core',
                    ...(retryAfter === undefined
                        ? {}
                        : { 'retry-after': retryAfter }),
                    ...(resetAt === undefined
                        ? {}
                        : { 'x-ratelimit-reset': resetAt }),
                });
                return jsonResponse({ ok: true }, 200, headers);
            });
            const client = createClient(fetchMock, {
                now: () => Date.now(),
                onProgress: (event) => {
                    if (
                        event.type === 'rate-limit-wait' &&
                        event.bucket === 'core'
                    ) {
                        waitDeadlines.push(event.until);
                    }
                },
            });
            const first = client.request('/repos/acme/first');
            const queuedCore = client.request('/repos/acme/second');
            const availableSearch = client.request('/search/repositories');

            try {
                await jest.advanceTimersByTimeAsync(0);
                await expect(first).resolves.toMatchObject({ status: 200 });
                await expect(availableSearch).resolves.toMatchObject({
                    status: 200,
                });
                expect(fetchMock).toHaveBeenCalledTimes(2);
                expect(waitDeadlines).toEqual([expectedDeadline]);

                await jest.advanceTimersByTimeAsync(
                    expectedDeadline - 100_000 - 1,
                );
                expect(fetchMock).toHaveBeenCalledTimes(2);
                await jest.advanceTimersByTimeAsync(1);
                await expect(queuedCore).resolves.toMatchObject({ status: 200 });
                expect(fetchMock).toHaveBeenCalledTimes(3);
            } finally {
                jest.useRealTimers();
            }
        },
    );

    test.each([403, 429])(
        'backs off secondary limits (%s) independently of an unexhausted primary reset',
        async (status) => {
            jest.useFakeTimers();
            try {
                const fetchMock = createFetchMock()
                    .mockImplementationOnce(async () =>
                        jsonResponse(
                            {
                                message:
                                    'You have exceeded a secondary rate limit.',
                            },
                            status,
                            {
                                'x-ratelimit-remaining': '100',
                                'x-ratelimit-reset': String(
                                    Math.ceil((Date.now() + 2_000) / 1_000),
                                ),
                            },
                        ),
                    )
                    .mockImplementationOnce(async () =>
                        jsonResponse(
                            {
                                message:
                                    'You have exceeded a secondary rate limit.',
                            },
                            status,
                        ),
                    )
                    .mockImplementation(async () => jsonResponse({ ok: true }));
                const pending = createClient(fetchMock, {
                    maxRetries: 2,
                }).request('/users/octocat');
                await jest.advanceTimersByTimeAsync(59_999);
                expect(fetchMock).toHaveBeenCalledTimes(1);
                await jest.advanceTimersByTimeAsync(1);
                expect(fetchMock).toHaveBeenCalledTimes(2);
                await jest.advanceTimersByTimeAsync(119_999);
                expect(fetchMock).toHaveBeenCalledTimes(2);
                await jest.advanceTimersByTimeAsync(1);
                await expect(pending).resolves.toMatchObject({ status: 200 });
                expect(fetchMock).toHaveBeenCalledTimes(3);
            } finally {
                jest.useRealTimers();
            }
        },
    );

    test('adds query parameters and merges injected authentication and request headers', async () => {
        const fetchMock = createFetchMock().mockResolvedValue(
            jsonResponse({ total_count: 1 }, 200, {
                'x-github-request-id': 'request-1',
            }),
        );
        const client = createClient(fetchMock, {
            token: 'test-token',
            headers: { 'X-Shared': 'from-config' },
        });

        const result = await client.request<{ total_count: number }>(
            '/search/repositories',
            {
                query: {
                    q: 'language:typescript',
                    per_page: 100,
                    preview: false,
                    omitted: null,
                },
                headers: { 'X-Request': 'from-call' },
            },
        );

        expect(result.data).toEqual({ total_count: 1 });
        expect(result.status).toBe(200);
        const [input, init] = fetchMock.mock.calls[0];
        const requestUrl = new URL(String(input));
        const requestHeaders = new Headers(init?.headers);
        expect(requestUrl.searchParams.get('q')).toBe('language:typescript');
        expect(requestUrl.searchParams.get('per_page')).toBe('100');
        expect(requestUrl.searchParams.get('preview')).toBe('false');
        expect(requestUrl.searchParams.has('omitted')).toBe(false);
        expect(requestHeaders.get('Authorization')).toBe('Bearer test-token');
        expect(requestHeaders.get('X-Shared')).toBe('from-config');
        expect(requestHeaders.get('X-Request')).toBe('from-call');
        expect(result.headers.get('x-github-request-id')).toBe('request-1');
    });

    test('returns repository content as text when requested', async () => {
        const fetchMock = createFetchMock().mockResolvedValue(
            new Response('# Hello\n', { status: 200 }),
        );
        const client = createClient(fetchMock);

        const result = await client.request(
            '/repos/octo-org/octo-repo/contents/README.md',
            {
                responseType: 'text',
                headers: { Accept: 'application/vnd.github.raw+json' },
            },
        );

        expect(result.data).toBe('# Hello\n');
        expect(result.status).toBe(200);
    });

    test('rejects endpoints on a different origin before sending credentials', async () => {
        const fetchMock = createFetchMock();
        const client = createClient(fetchMock, { token: 'test-token' });

        await expect(
            client.request('https://example.com/repos/octo-org/octo-repo'),
        ).rejects.toThrow('configured base URL origin');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test.each([409, 412, 502, 503, 504])(
        'retries HTTP %s and returns the later response',
        async (status) => {
            const fetchMock = createFetchMock()
                .mockResolvedValueOnce(
                    jsonResponse({ message: 'temporary failure' }, status),
                )
                .mockResolvedValueOnce(jsonResponse({ ok: true }));
            const client = createClient(fetchMock, { maxRetries: 1 });

            await expect(
                client.request('/repos/octo-org/octo-repo'),
            ).resolves.toMatchObject({
                data: { ok: true },
                status: 200,
            });
            expect(fetchMock).toHaveBeenCalledTimes(2);
        },
    );

    test('retries a gateway error even when the error body is HTML', async () => {
        const status = 502;
        const fetchMock = createFetchMock()
            .mockResolvedValueOnce(
                new Response('<html>Temporary failure</html>', { status }),
            )
            .mockResolvedValueOnce(jsonResponse({ ok: true }));
        const client = createClient(fetchMock, { maxRetries: 1 });

        await expect(
            client.request('/repos/octo-org/octo-repo'),
        ).resolves.toMatchObject({ data: { ok: true } });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('preserves the HTTP status and raw body after HTML retries are exhausted', async () => {
        const fetchMock = createFetchMock().mockImplementation(
            async () => new Response('Bad Gateway', { status: 502 }),
        );
        const client = createClient(fetchMock, { maxRetries: 1 });
        await expect(client.request('/users/octocat')).rejects.toMatchObject({
            name: 'GitHubRequestError',
            status: 502,
            data: 'Bad Gateway',
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('still rejects invalid JSON on a successful response', async () => {
        const fetchMock = createFetchMock().mockResolvedValue(
            new Response('invalid JSON', { status: 200 }),
        );
        await expect(
            createClient(fetchMock).request('/users/octocat'),
        ).rejects.toBeInstanceOf(GitHubResponseParseError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('throws the final conflict instead of converting it to an empty result', async () => {
        const fetchMock = createFetchMock().mockImplementation(async () =>
            jsonResponse({ message: 'precondition failed' }, 412),
        );
        const client = createClient(fetchMock, { maxRetries: 2 });

        await expect(
            client.request('/repos/octo-org/octo-repo'),
        ).rejects.toMatchObject({
            name: 'GitHubRequestError',
            status: 412,
            data: { message: 'precondition failed' },
        });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    test.each([401, 403, 404, 422])(
        'surfaces ordinary HTTP %s errors after one attempt',
        async (status) => {
            const fetchMock = createFetchMock().mockResolvedValue(
                jsonResponse({ message: 'not allowed' }, status),
            );
            const client = createClient(fetchMock);

            await expect(
                client.request('/repos/octo-org/octo-repo'),
            ).rejects.toBeInstanceOf(GitHubRequestError);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        },
    );

    test('retries transient network failures and reports exhausted attempts', async () => {
        const fetchMock = createFetchMock().mockRejectedValue(
            new TypeError('offline'),
        );
        const client = createClient(fetchMock, { maxRetries: 2 });
        const pending = client.request('/repos/octo-org/octo-repo');

        await expect(pending).rejects.toBeInstanceOf(GitHubNetworkError);
        await expect(pending).rejects.toMatchObject({ attempts: 3 });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    test('distinguishes a primary rate limit from an ordinary permission error', async () => {
        jest.useFakeTimers();
        const fetchMock = createFetchMock()
            .mockResolvedValueOnce(
                jsonResponse({ message: 'API rate limit exceeded' }, 403, {
                    'x-ratelimit-remaining': '0',
                    'x-ratelimit-reset': String(
                        Math.ceil((Date.now() + 2_000) / 1_000),
                    ),
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ ok: true }));
        const client = createClient(fetchMock, { maxRetries: 1 });

        const pending = client.request('/repos/octo-org/octo-repo');
        try {
            await jest.advanceTimersByTimeAsync(0);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            await jest.advanceTimersByTimeAsync(4_100);
            await expect(pending).resolves.toMatchObject({
                data: { ok: true },
            });
            expect(fetchMock).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });

    test('ordinary permission 403 responses fail promptly without quota waits or retries', async () => {
        const fetchMock = createFetchMock().mockResolvedValue(
            jsonResponse(
                { message: 'Resource not accessible by integration' },
                403,
                {
                    'x-ratelimit-remaining': '100',
                    'retry-after': '2',
                },
            ),
        );
        const client = createClient(fetchMock, { maxRetries: 3 });

        await expect(
            client.request('/repos/octo-org/private'),
        ).rejects.toMatchObject({
            classification: 'permission',
            attemptCount: 1,
            retryStopReason: 'request is not retryable',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('primary quota recovery does not consume the transient retry budget', async () => {
        jest.useFakeTimers();
        const reset = Math.ceil((Date.now() + 2_000) / 1_000);
        const fetchMock = createFetchMock()
            .mockResolvedValueOnce(
                jsonResponse({ message: 'API rate limit exceeded' }, 403, {
                    'x-ratelimit-remaining': '0',
                    'x-ratelimit-reset': String(reset),
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ message: 'temporary' }, 502))
            .mockResolvedValueOnce(jsonResponse({ ok: true }));
        const client = createClient(fetchMock, {
            maxRetries: 1,
            maxRateLimitRetries: 1,
        });
        const pending = client.request('/repos/octo-org/repo');
        try {
            await jest.advanceTimersByTimeAsync(4_100);
            await expect(pending).resolves.toMatchObject({
                data: { ok: true },
            });
            expect(fetchMock).toHaveBeenCalledTimes(3);
        } finally {
            jest.useRealTimers();
        }
    });

    test('bounds repeated primary quota recovery separately and reports the stop reason', async () => {
        jest.useFakeTimers();
        const fetchMock = createFetchMock().mockImplementation(async () =>
            jsonResponse({ message: 'API rate limit exceeded' }, 403, {
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': String(
                    Math.ceil((Date.now() + 1_000) / 1_000),
                ),
                'x-github-request-id': 'request-2',
            }),
        );
        const client = createClient(fetchMock, {
            maxRetries: 0,
            maxRateLimitRetries: 1,
        });
        const pending = client.request('/search/repositories');
        const rejection = expect(pending).rejects.toMatchObject({
            attemptCount: 2,
            requestId: 'request-2',
            retryStopReason: 'rate-limit recovery budget exhausted',
        });
        try {
            await jest.advanceTimersByTimeAsync(3_100);
            await rejection;
            expect(fetchMock).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });

    test.each(['malformed', 'past', 'far future'] as const)(
        'uses a bounded conservative wait for a %s reset header',
        async (kind) => {
            jest.useFakeTimers();
            const reset =
                kind === 'past'
                    ? String(Math.floor(Date.now() / 1_000) - 1)
                    : kind === 'far future'
                      ? String(
                            Math.ceil(
                                (Date.now() + 365 * 24 * 60 * 60 * 1_000) /
                                    1_000,
                            ),
                        )
                      : 'not-a-time';
            const fetchMock = createFetchMock()
                .mockResolvedValueOnce(
                    jsonResponse({ message: 'API rate limit exceeded' }, 403, {
                        'x-ratelimit-remaining': '0',
                        'x-ratelimit-reset': reset,
                    }),
                )
                .mockResolvedValueOnce(jsonResponse({ ok: true }));
            const pending = createClient(fetchMock, {
                maxRetries: 0,
                maxRateLimitRetries: 1,
            }).request('/repos/octo-org/repo');
            try {
                await jest.advanceTimersByTimeAsync(59_999);
                expect(fetchMock).toHaveBeenCalledTimes(1);
                await jest.advanceTimersByTimeAsync(1);
                await expect(pending).resolves.toMatchObject({
                    data: { ok: true },
                });
                expect(fetchMock).toHaveBeenCalledTimes(2);
            } finally {
                jest.useRealTimers();
            }
        },
    );

    test('waits until the later Retry-After or primary reset deadline', async () => {
        jest.useFakeTimers();
        const reset = Math.ceil((Date.now() + 10_000) / 1_000);
        const fetchMock = createFetchMock()
            .mockResolvedValueOnce(
                jsonResponse(
                    { message: 'secondary rate limit exceeded' },
                    429,
                    {
                        'retry-after': '5',
                        'x-ratelimit-remaining': '0',
                        'x-ratelimit-reset': String(reset),
                    },
                ),
            )
            .mockResolvedValueOnce(jsonResponse({ ok: true }));
        const pending = createClient(fetchMock, {
            maxRateLimitRetries: 1,
        }).request('/repos/octo-org/repo');
        try {
            await jest.advanceTimersByTimeAsync(5_000);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            await jest.advanceTimersByTimeAsync(8_000);
            await expect(pending).resolves.toMatchObject({
                data: { ok: true },
            });
            expect(fetchMock).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });

    test('removes a canceled request from the cooldown queue', async () => {
        const fetchMock = createFetchMock()
            .mockResolvedValueOnce(
                jsonResponse({ message: 'slow down' }, 429, {
                    'retry-after': '2',
                }),
            )
            .mockImplementation(async () => jsonResponse({ ok: true }));
        const client = createClient(fetchMock, {
            maxRetries: 1,
            concurrency: 1,
        });

        jest.useFakeTimers();
        const first = client.request('/repos/octo-org/first');
        try {
            await jest.advanceTimersByTimeAsync(0);
            const controller = new AbortController();
            const queued = client.request('/users/octocat', {
                signal: controller.signal,
            });
            controller.abort();
            await expect(queued).rejects.toHaveProperty('name', 'AbortError');
            expect(fetchMock).toHaveBeenCalledTimes(1);

            await jest.advanceTimersByTimeAsync(2_000);
            await expect(first).resolves.toMatchObject({ data: { ok: true } });
            expect(fetchMock).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });

    test.each(['https://api.github.com', 'https://github.example/api/v3/'])(
        'keeps primary search cooldown separate at %s',
        async (baseUrl) => {
            jest.useFakeTimers();
            const fetchMock = createFetchMock()
                .mockResolvedValueOnce(
                    jsonResponse({ message: 'API rate limit exceeded' }, 403, {
                        'x-ratelimit-remaining': '0',
                        'x-ratelimit-reset': String(
                            Math.ceil((Date.now() + 2_000) / 1_000),
                        ),
                        'x-ratelimit-resource': 'search',
                    }),
                )
                .mockImplementation(async () => jsonResponse({ ok: true }));
            const client = createClient(fetchMock, {
                maxRetries: 1,
                concurrency: 1,
                baseUrl,
            });

            const search = client.request('/search/repositories', {
                query: { q: 'octo' },
            });
            const ordinary = client.request('/repos/octo-org/octo-repo');
            try {
                await jest.advanceTimersByTimeAsync(0);
                await expect(ordinary).resolves.toMatchObject({
                    data: { ok: true },
                });
                expect(fetchMock).toHaveBeenCalledTimes(2);
                await jest.advanceTimersByTimeAsync(4_100);
                await expect(search).resolves.toMatchObject({
                    data: { ok: true },
                });
                expect(fetchMock).toHaveBeenCalledTimes(3);
            } finally {
                jest.useRealTimers();
            }
        },
    );

    test.each([403, 429])(
        'pauses core callers after a search secondary limit (%s)',
        async (status) => {
            const fetchMock = createFetchMock()
                .mockResolvedValueOnce(
                    new Response('You have exceeded a secondary rate limit.', {
                        status,
                        headers: {
                            'retry-after': '2',
                            'x-ratelimit-resource': 'search',
                        },
                    }),
                )
                .mockImplementation(async () => jsonResponse({ ok: true }));
            const client = createClient(fetchMock, { maxRetries: 1 });
            jest.useFakeTimers();
            try {
                const search = client.request('/search/repositories');
                const ordinary = client.request('/users/octocat');
                await jest.advanceTimersByTimeAsync(0);
                expect(fetchMock).toHaveBeenCalledTimes(1);
                await jest.advanceTimersByTimeAsync(1_999);
                expect(fetchMock).toHaveBeenCalledTimes(1);
                await jest.advanceTimersByTimeAsync(1);
                await expect(
                    Promise.all([search, ordinary]),
                ).resolves.toHaveLength(2);
                expect(fetchMock).toHaveBeenCalledTimes(3);
            } finally {
                jest.useRealTimers();
            }
        },
    );

    test('times out and retries a request before throwing a timeout error', async () => {
        const fetchMock = createFetchMock(
            (_input, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener(
                        'abort',
                        () => reject(new DOMException('Aborted', 'AbortError')),
                        { once: true },
                    );
                }),
        );
        const client = createClient(fetchMock, {
            timeoutMs: 10,
            maxRetries: 1,
        });

        jest.useFakeTimers();
        const pending = expect(
            client.request('/repos/octo-org/octo-repo'),
        ).rejects.toBeInstanceOf(GitHubTimeoutError);
        try {
            await jest.advanceTimersByTimeAsync(20);
            await pending;
            expect(fetchMock).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });

    test('cancels an active request without retrying', async () => {
        const fetchMock = createFetchMock(
            (_input, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener(
                        'abort',
                        () => reject(new DOMException('Aborted', 'AbortError')),
                        { once: true },
                    );
                }),
        );
        const client = createClient(fetchMock);
        const controller = new AbortController();
        const pending = client.request('/repos/octo-org/octo-repo', {
            signal: controller.signal,
        });

        controller.abort();

        await expect(pending).rejects.toHaveProperty('name', 'AbortError');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('paginateGitHub', () => {
    test.each([
        [
            '/search/repositories',
            { items: [{ id: 1 }] },
            { items: [{ id: 2 }] },
        ],
        ['/orgs/octo-org/repos', [{ id: 1 }], [{ id: 2 }]],
    ])(
        'collects all pages from %s',
        async (endpoint, firstPage, secondPage) => {
            const fetchMock = createFetchMock()
                .mockResolvedValueOnce(
                    jsonResponse(firstPage, 200, {
                        Link: `<https://api.github.com${endpoint}?page=2>; rel="next"`,
                    }),
                )
                .mockResolvedValueOnce(
                    jsonResponse(secondPage, 200, { 'x-last-page': 'true' }),
                );
            const client = createClient(fetchMock);

            const result = await paginateGitHub<{ id: number }>(
                client,
                endpoint,
                {
                    query: endpoint.startsWith('/search')
                        ? { q: 'language:typescript' }
                        : undefined,
                },
            );

            expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
            expect(result.pageCount).toBe(2);
            expect(result.headers.get('x-last-page')).toBe('true');
            expect(fetchMock).toHaveBeenCalledTimes(2);
        },
    );

    test('surfaces a later page failure instead of returning partial results', async () => {
        const fetchMock = createFetchMock()
            .mockResolvedValueOnce(
                jsonResponse([{ id: 1 }], 200, {
                    Link: '<https://api.github.com/orgs/octo-org/repos?page=2>; rel="next"',
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ message: 'Not Found' }, 404));
        const client = createClient(fetchMock);

        await expect(
            paginateGitHub(client, '/orgs/octo-org/repos'),
        ).rejects.toMatchObject({
            name: 'GitHubRequestError',
            status: 404,
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('rejects an unexpected page shape', async () => {
        const fetchMock = createFetchMock().mockResolvedValue(
            jsonResponse({ repositories: [] }),
        );
        const client = createClient(fetchMock);

        await expect(
            paginateGitHub(client, '/orgs/octo-org/repos'),
        ).rejects.toBeInstanceOf(GitHubPaginationError);
    });
});
