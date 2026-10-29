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
                await expect(queuedCore).resolves.toMatchObject({
                    status: 200,
                });
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

    test('uses the current token provider value for each request', async () => {
        const fetchMock = createFetchMock().mockImplementation(async () =>
            jsonResponse({ ok: true }),
        );
        const tokens = ['first-token', 'renewed-token'];
        const tokenProvider = async () => tokens.shift() ?? 'renewed-token';
        const client = createClient(fetchMock, {
            token: 'initial-token',
            tokenProvider,
        });

        await client.request('/user');
        await client.request('/user');

        expect(
            new Headers(fetchMock.mock.calls[0][1]?.headers).get(
                'Authorization',
            ),
        ).toBe('Bearer first-token');
        expect(
            new Headers(fetchMock.mock.calls[1][1]?.headers).get(
                'Authorization',
            ),
        ).toBe('Bearer renewed-token');
    });

    test('documents default UTF-8 decoding for bytes sent to raw-text endpoints', async () => {
        const binaryResponse = new Response(
            Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
            { headers: { 'content-type': 'application/octet-stream' } },
        );
        const utf16Response = new Response(
            Uint8Array.from([0x41, 0x00, 0x42, 0x00]),
            { headers: { 'content-type': 'text/plain; charset=utf-16le' } },
        );
        const malformedUtf8Response = new Response(
            Uint8Array.from([0xc3, 0x28]),
            { headers: { 'content-type': 'text/plain; charset=utf-8' } },
        );
        const fetchMock = createFetchMock()
            .mockResolvedValueOnce(binaryResponse)
            .mockResolvedValueOnce(utf16Response)
            .mockResolvedValueOnce(malformedUtf8Response);
        const client = createClient(fetchMock);

        await expect(
            client.request('/repos/o/r/binary.md', { responseType: 'text' }),
        ).resolves.toMatchObject({ data: '\uFFFDPNG\u0000' });
        await expect(
            client.request('/repos/o/r/utf16.md', { responseType: 'text' }),
        ).resolves.toMatchObject({ data: 'A\u0000B\u0000' });
        await expect(
            client.request('/repos/o/r/malformed.md', { responseType: 'text' }),
        ).resolves.toMatchObject({ data: '\uFFFD(' });
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

    test.each([
        ['http://api.github.com/repos/octo-org/repo', 'HTTPS'],
        [
            'https://user:password@api.github.com/repos/octo-org/repo',
            'credentials',
        ],
    ])(
        'rejects unsafe API endpoint %s before fetching',
        async (endpoint, detail) => {
            const fetchMock = createFetchMock();
            const client = createClient(fetchMock, { token: 'secret-token' });

            await expect(client.request(endpoint)).rejects.toThrow(detail);
            expect(fetchMock).not.toHaveBeenCalled();
        },
    );

    test.each([408, 500, 502, 503, 504])(
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

    test.each([408, 500, 502, 503, 504])(
        'exhausts the configured transient request bound for HTTP %s',
        async (status) => {
            const fetchMock = createFetchMock().mockImplementation(async () =>
                jsonResponse({ message: 'temporary failure' }, status),
            );
            const client = createClient(fetchMock, { maxRetries: 2 });

            await expect(
                client.request('/repos/octo-org/repo'),
            ).rejects.toMatchObject({
                name: 'GitHubRequestError',
                status,
                attemptCount: 3,
                retryStopReason: 'transient retry budget exhausted',
            });
            expect(fetchMock).toHaveBeenCalledTimes(3);
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

    test('does not retry a precondition failure response', async () => {
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
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test.each([400, 401, 403, 404, 409, 410, 412, 422, 451])(
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

    test.each([
        {
            label: 'JSON',
            response: () =>
                jsonResponse({ message: 'private response detail' }, 451, {
                    'x-github-request-id': 'REQ-451',
                }),
        },
        {
            label: 'text',
            response: () =>
                new Response('legal body sentinel', {
                    status: 451,
                    headers: { 'x-github-request-id': 'REQ-451' },
                }),
        },
        {
            label: 'empty',
            response: () =>
                new Response(null, {
                    status: 451,
                    headers: { 'x-github-request-id': 'REQ-451' },
                }),
        },
    ])(
        'retains HTTP 451 status and request ID for a $label error body',
        async ({ response }) => {
            const fetchMock = createFetchMock().mockResolvedValue(response());
            const client = createClient(fetchMock, { maxRetries: 2 });

            await expect(
                client.request('/repos/octo-org/repo'),
            ).rejects.toMatchObject({
                name: 'GitHubRequestError',
                status: 451,
                requestId: 'REQ-451',
            });
            expect(fetchMock).toHaveBeenCalledTimes(1);
        },
    );

    test.each([
        { label: 'delta seconds', now: 1_000, retryAfter: '2', delay: 2_000 },
        {
            label: 'HTTP date',
            now: 1_000,
            retryAfter: new Date(4_000).toUTCString(),
            delay: Date.parse(new Date(4_000).toUTCString()) - 1_000,
        },
    ])(
        'honors Retry-After on transient HTTP failures ($label)',
        async ({ now, retryAfter, delay }) => {
            const sleeps: number[] = [];
            const fetchMock = createFetchMock()
                .mockResolvedValueOnce(
                    jsonResponse({ message: 'temporary failure' }, 503, {
                        'retry-after': retryAfter,
                    }),
                )
                .mockResolvedValueOnce(jsonResponse({ ok: true }));
            const client = createClient(fetchMock, {
                now: () => now,
                maxRetries: 1,
                retryBaseDelayMs: 100,
                retryMaxDelayMs: 100,
                random: () => 0.5,
                sleep: async (delayMs) => {
                    sleeps.push(delayMs);
                },
            });

            await expect(
                client.request('/repos/octo-org/octo-repo'),
            ).resolves.toMatchObject({
                status: 200,
            });
            expect(sleeps).toEqual([delay]);
            expect(fetchMock).toHaveBeenCalledTimes(2);
        },
    );

    test('uses bounded backoff for a malformed Retry-After value', async () => {
        const sleeps: number[] = [];
        const fetchMock = createFetchMock()
            .mockResolvedValueOnce(
                jsonResponse({ message: 'temporary failure' }, 500, {
                    'retry-after': 'not-a-time',
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ ok: true }));
        const client = createClient(fetchMock, {
            maxRetries: 1,
            retryBaseDelayMs: 100,
            retryMaxDelayMs: 100,
            random: () => 0.5,
            sleep: async (delayMs) => {
                sleeps.push(delayMs);
            },
        });

        await expect(
            client.request('/repos/octo-org/octo-repo'),
        ).resolves.toMatchObject({
            status: 200,
        });
        expect(sleeps).toEqual([50]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('stops when a transient server asks for more than the retry-delay budget', async () => {
        const sleep = jest.fn(async () => undefined);
        const fetchMock = createFetchMock().mockResolvedValue(
            jsonResponse({ message: 'private body' }, 503, {
                'retry-after': '61',
                'x-github-request-id': 'REQ-451',
            }),
        );
        const client = createClient(fetchMock, {
            maxRetries: 2,
            sleep,
        });

        await expect(
            client.request('/repos/octo-org/octo-repo?token=secret'),
        ).rejects.toMatchObject({
            name: 'GitHubRequestError',
            status: 503,
            requestId: 'REQ-451',
            retryAfterMs: 61_000,
            retryStopReason: 'server retry delay exceeds budget',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    test('a zero-retry diagnostic makes one request and never sleeps for Retry-After', async () => {
        const sleep = jest.fn(async () => undefined);
        const fetchMock = createFetchMock().mockResolvedValue(
            jsonResponse({ message: 'temporary failure' }, 500, {
                'retry-after': '30',
            }),
        );
        const client = createClient(fetchMock, { maxRetries: 0, sleep });

        await expect(
            client.request('/repos/octo-org/octo-repo'),
        ).rejects.toMatchObject({
            status: 500,
            attemptCount: 1,
            retryStopReason: 'transient retry budget exhausted',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    test('abort during transient backoff prevents the next request', async () => {
        let markSleepStarted: () => void = () => {};
        const sleepStarted = new Promise<void>((resolve) => {
            markSleepStarted = resolve;
        });
        const fetchMock = createFetchMock().mockResolvedValue(
            jsonResponse({ message: 'temporary failure' }, 503),
        );
        const client = createClient(fetchMock, {
            maxRetries: 1,
            sleep: async (_delayMs, signal) =>
                await new Promise<void>((_resolve, reject) => {
                    markSleepStarted();
                    signal?.addEventListener(
                        'abort',
                        () => reject(signal.reason),
                        { once: true },
                    );
                }),
        });
        const controller = new AbortController();
        const pending = client.request('/repos/octo-org/repo', {
            signal: controller.signal,
        });

        await sleepStarted;
        controller.abort(new DOMException('Aborted', 'AbortError'));
        await expect(pending).rejects.toHaveProperty('name', 'AbortError');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test.each([202, 204, 304])(
        'rejects unexpected successful HTTP status %s without retry',
        async (status) => {
            const fetchMock = createFetchMock().mockResolvedValue(
                status === 202
                    ? jsonResponse({ accepted: true }, status)
                    : new Response(null, { status }),
            );
            const client = createClient(fetchMock, { maxRetries: 2 });

            await expect(
                client.request('/repos/octo-org/octo-repo'),
            ).rejects.toMatchObject({
                name: 'GitHubRequestError',
                status,
            });
            expect(fetchMock).toHaveBeenCalledTimes(1);
        },
    );

    test('accepts 204 only when the endpoint adapter opts into its empty-result contract', async () => {
        const fetchMock = createFetchMock().mockResolvedValue(
            new Response(null, { status: 204 }),
        );

        await expect(
            createClient(fetchMock).request(
                '/repos/octo-org/octo-repo/contributors',
                {
                    allowNoContent: true,
                },
            ),
        ).resolves.toMatchObject({ status: 204, data: null });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('follows same-origin HTTPS rename redirects manually and reports the effective URL', async () => {
        const requests: Array<{ url: string; init?: RequestInit }> = [];
        const fetchMock = createFetchMock(async (input, init) => {
            const url = String(input);
            requests.push({ url, init });
            if (requests.length === 1) {
                return new Response(null, {
                    status: 301,
                    headers: { location: '/repos/octo-org/renamed-repo' },
                });
            }
            return jsonResponse({ id: 7 });
        });
        const client = createClient(fetchMock, { token: 'secret-token' });

        await expect(
            client.request('/repos/octo-org/old-repo'),
        ).resolves.toMatchObject({
            status: 200,
            url: 'https://api.github.com/repos/octo-org/renamed-repo',
        });
        expect(requests).toHaveLength(2);
        expect(requests.map(({ init }) => init?.method)).toEqual([
            'GET',
            'GET',
        ]);
        expect(requests.map(({ init }) => init?.redirect)).toEqual([
            'manual',
            'manual',
        ]);
        expect(
            requests.map(({ init }) =>
                new Headers(init?.headers).get('authorization'),
            ),
        ).toEqual(['Bearer secret-token', 'Bearer secret-token']);
    });

    test.each([301, 302, 303, 307, 308])(
        'keeps GET semantics when following HTTP %s',
        async (status) => {
            const fetchMock = createFetchMock()
                .mockResolvedValueOnce(
                    new Response(null, {
                        status,
                        headers: { location: './renamed' },
                    }),
                )
                .mockResolvedValueOnce(jsonResponse({ ok: true }));

            await expect(
                createClient(fetchMock).request('/repos/octo-org/old'),
            ).resolves.toMatchObject({ status: 200 });
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(
                fetchMock.mock.calls.map(([, init]) => init?.method),
            ).toEqual(['GET', 'GET']);
        },
    );

    test('rejects cross-origin redirects before making a token-bearing request there', async () => {
        const fetchMock = createFetchMock().mockResolvedValue(
            new Response(null, {
                status: 302,
                headers: {
                    location: 'https://outside.example/repos/o/r?token=secret',
                },
            }),
        );
        const client = createClient(fetchMock, { token: 'secret-token' });

        await expect(
            client.request('/repos/octo-org/repo'),
        ).rejects.toMatchObject({
            name: 'GitHubRedirectError',
            reason: 'cross-origin',
            status: 302,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const firstInit = fetchMock.mock.calls[0][1];
        expect(new Headers(firstInit?.headers).get('authorization')).toBe(
            'Bearer secret-token',
        );
    });

    test('resolves relative redirects and uses the final URL for pagination links', async () => {
        const paths: string[] = [];
        const fetchMock = createFetchMock(async (input) => {
            const url = new URL(String(input));
            paths.push(url.pathname + url.search);
            if (url.pathname === '/orgs/old-owner/repos') {
                return new Response(null, {
                    status: 302,
                    headers: { location: '/orgs/new-owner/repos' },
                });
            }
            if (url.pathname === '/orgs/new-owner/repos') {
                if (url.searchParams.has('page')) return jsonResponse([]);
                return jsonResponse([], 200, {
                    link: '<repos?per_page=1&page=2>; rel="next"',
                });
            }
            return jsonResponse([]);
        });
        const response = await paginateGitHub(
            createClient(fetchMock),
            '/orgs/old-owner/repos',
        );

        expect(response.pageCount).toBe(2);
        expect(paths).toEqual([
            '/orgs/old-owner/repos',
            '/orgs/new-owner/repos',
            '/orgs/new-owner/repos?per_page=1&page=2',
        ]);
    });

    test('rejects redirect loops and excessive redirect chains', async () => {
        const loopFetch = createFetchMock().mockResolvedValue(
            new Response(null, {
                status: 301,
                headers: { location: '/repos/octo-org/repo' },
            }),
        );
        await expect(
            createClient(loopFetch).request('/repos/octo-org/repo'),
        ).rejects.toMatchObject({
            name: 'GitHubRedirectError',
            reason: 'redirect-loop',
        });
        expect(loopFetch).toHaveBeenCalledTimes(1);

        let requests = 0;
        const chainFetch = createFetchMock(async () => {
            requests += 1;
            return new Response(null, {
                status: 302,
                headers: { location: `/redirect/${requests}` },
            });
        });
        await expect(
            createClient(chainFetch).request('/redirect/0'),
        ).rejects.toMatchObject({
            name: 'GitHubRedirectError',
            reason: 'hop-limit',
        });
        expect(requests).toBe(6);
    });

    test.each([
        { location: undefined, reason: 'missing-location' },
        { location: 'https://[', reason: 'invalid-location' },
        {
            location: 'http://api.github.com/repos/octo-org/repo',
            reason: 'insecure-protocol',
        },
    ] as const)(
        'rejects unsafe redirect locations: $reason',
        async ({ location, reason }) => {
            const fetchMock = createFetchMock().mockResolvedValue(
                new Response(null, {
                    status: 302,
                    headers: location ? { location } : {},
                }),
            );

            await expect(
                createClient(fetchMock).request('/repos/octo-org/repo'),
            ).rejects.toMatchObject({
                name: 'GitHubRedirectError',
                reason,
                status: 302,
            });
            expect(fetchMock).toHaveBeenCalledTimes(1);
        },
    );

    test('applies one timeout across every redirect hop', async () => {
        let requests = 0;
        const fetchMock = createFetchMock(async (_input, init) => {
            requests += 1;
            if (requests === 1) {
                return new Response(null, {
                    status: 302,
                    headers: { location: '/repos/octo-org/renamed' },
                });
            }
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener(
                    'abort',
                    () => reject(new TypeError('aborted')),
                    { once: true },
                );
            });
        });
        const client = createClient(fetchMock, {
            maxRetries: 0,
            timeoutMs: 5,
        });

        await expect(
            client.request('/repos/octo-org/old'),
        ).rejects.toBeInstanceOf(GitHubTimeoutError);
        expect(requests).toBe(2);
    });

    test.each([
        { name: 'ToS restriction', block: { reason: 'tos' } },
        { name: 'SSO restriction', block: { reason: 'sso' } },
    ])(
        'preserves structured HTTP errors for raw-text responses: $name',
        async (body) => {
            const fetchMock = createFetchMock().mockResolvedValue(
                jsonResponse(
                    { message: 'Repository access blocked', ...body },
                    403,
                ),
            );
            const client = createClient(fetchMock);
            await expect(
                client.request('/repos/octo-org/octo-repo/readme', {
                    responseType: 'text',
                }),
            ).rejects.toMatchObject({
                status: 403,
                classification: 'permission',
                data: { block: body.block },
            });
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

    test.each([
        'ERR_INVALID_URL',
        'ERR_UNSUPPORTED_PROTOCOL',
        'ERR_TLS_CERT_ALTNAME_INVALID',
        'DEPTH_ZERO_SELF_SIGNED_CERT',
    ])('does not retry terminal network error %s', async (code) => {
        const terminalError = Object.assign(new TypeError('private detail'), {
            code,
        });
        const fetchMock = createFetchMock().mockRejectedValue(terminalError);
        const client = createClient(fetchMock, { maxRetries: 3 });

        await expect(
            client.request('/repos/octo-org/octo-repo'),
        ).rejects.toMatchObject({
            name: 'GitHubNetworkError',
            attempts: 1,
            retryStopReason: 'terminal network error',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
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

    test('HTTP 451 with quota-looking headers remains terminal and never enters quota recovery', async () => {
        const fetchMock = createFetchMock().mockResolvedValue(
            jsonResponse({ message: 'Unavailable' }, 451, {
                'x-ratelimit-remaining': '0',
                'retry-after': '2',
            }),
        );
        const client = createClient(fetchMock, {
            maxRetries: 3,
            maxRateLimitRetries: 4,
        });

        await expect(
            client.request('/repos/octo-org/repo'),
        ).rejects.toMatchObject({
            status: 451,
            classification: 'other',
            rateLimit: undefined,
            retryStopReason: 'request is not retryable',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test.each([
        {
            message: 'Resource not accessible by personal access token',
            accessReason: 'token-resource-inaccessible',
        },
        {
            message: 'Resource not accessible by integration',
            accessReason: 'integration-resource-inaccessible',
        },
        {
            message: 'Forbidden',
            accessReason: 'unknown-forbidden',
        },
    ] as const)(
        'classifies only supported 403 response evidence: $accessReason',
        async ({ message, accessReason }) => {
            const fetchMock = createFetchMock().mockResolvedValue(
                jsonResponse(
                    { message, bodySecret: 'must-not-be-projected' },
                    403,
                    {
                        'x-github-request-id': 'ABC:123',
                        'x-ratelimit-resource': 'core',
                        'x-ratelimit-limit': '5000',
                        'x-ratelimit-remaining': '42',
                        'x-ratelimit-reset': '1800000000',
                        'retry-after': '3',
                    },
                ),
            );
            const client = createClient(fetchMock);

            await expect(
                client.request('/orgs/oss-slu/repos'),
            ).rejects.toMatchObject({
                classification: 'permission',
                accessReason,
                status: 403,
                requestId: 'ABC:123',
                rateLimitObservation: {
                    bucket: 'core',
                    limit: 5_000,
                    remaining: 42,
                    resetAt: 1_800_000_000,
                    retryAfterMs: 3_000,
                },
            });
            expect(fetchMock).toHaveBeenCalledTimes(1);
        },
    );

    test('recognizes GitHub’s exact contributor-list size-limit 403 without changing access classification', async () => {
        const fetchMock = createFetchMock().mockResolvedValue(
            jsonResponse(
                {
                    message:
                        'The history or contributor list is too large to list contributors for this repository via the API.',
                },
                403,
                {
                    'x-ratelimit-resource': 'core',
                    'x-ratelimit-limit': '5000',
                    'x-ratelimit-remaining': '1711',
                },
            ),
        );
        const client = createClient(fetchMock);

        await expect(
            client.request('/repos/acme/large/contributors?per_page=100'),
        ).rejects.toMatchObject({
            status: 403,
            classification: 'permission',
            accessReason: 'unknown-forbidden',
            blockReason: 'github_contributors_size_limit',
        });
    });

    test.each([
        {
            label: 'near-match message',
            message:
                'The history or contributor list is too large to list contributors for this repository via the API. Contact support.',
            headers: {} as Record<string, string>,
            expected: undefined,
        },
        {
            label: 'SSO evidence',
            message:
                'The history or contributor list is too large to list contributors for this repository via the API.',
            headers: { 'x-github-sso': 'required' } as Record<string, string>,
            expected: undefined,
        },
        {
            label: 'rate-limit evidence',
            message:
                'The history or contributor list is too large to list contributors for this repository via the API.',
            headers: { 'x-ratelimit-remaining': '0' } as Record<string, string>,
            expected: undefined,
        },
    ])(
        'does not classify a contributor-size block when $label is present',
        async ({ message, headers, expected }) => {
            const fetchMock = createFetchMock().mockResolvedValue(
                jsonResponse({ message }, 403, headers),
            );
            const client = createClient(fetchMock, {
                maxRetries: 0,
                maxRateLimitRetries: 0,
            });

            await expect(
                client.request('/repos/acme/large/contributors'),
            ).rejects.toMatchObject({ blockReason: expected });
        },
    );

    test('uses the allowlisted SSO status and drops its URL', async () => {
        const fetchMock = createFetchMock().mockResolvedValue(
            jsonResponse({ message: 'Forbidden' }, 403, {
                'x-github-sso':
                    'required; url=https://github.com/enterprises/example/sso?secret=header-secret',
                'x-github-request-id': 'SSO-123',
            }),
        );
        const client = createClient(fetchMock);

        await expect(
            client.request('/orgs/oss-slu/repos'),
        ).rejects.toMatchObject({
            classification: 'permission',
            accessReason: 'sso-required',
            ssoStatus: 'required',
        });
    });

    test('recognized rate-limit evidence takes precedence over SSO and generic denial', async () => {
        const fetchMock = createFetchMock().mockResolvedValue(
            jsonResponse({ message: 'API rate limit exceeded' }, 403, {
                'x-github-sso':
                    'required; url=https://secret.invalid/authorize',
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': '1800000000',
            }),
        );
        const client = createClient(fetchMock, {
            maxRateLimitRetries: 0,
        });

        await expect(
            client.request('/search/repositories'),
        ).rejects.toMatchObject({
            classification: 'primary rate limit',
            accessReason: undefined,
            ssoStatus: 'required',
            rateLimit: {
                classification: 'primary rate limit',
                remaining: 0,
            },
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('ignores malformed SSO and quota headers without leaking them', async () => {
        const fetchMock = createFetchMock().mockResolvedValue(
            jsonResponse({ message: 'Forbidden' }, 403, {
                'x-github-sso': 'unexpected; url=not a validated value',
                'x-github-request-id': 'request id contains spaces',
                'x-ratelimit-limit': 'not-a-number',
                'x-ratelimit-remaining': '-1',
                'x-ratelimit-reset': '999999999999999999999',
                'retry-after': 'not-a-date',
            }),
        );
        const client = createClient(fetchMock);

        await expect(
            client.request('/orgs/oss-slu/repos'),
        ).rejects.toMatchObject({
            accessReason: 'unknown-forbidden',
            ssoStatus: undefined,
            requestId: undefined,
            rateLimitObservation: {
                limit: undefined,
                remaining: undefined,
                resetAt: undefined,
                retryAfterMs: undefined,
            },
        });
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

test('provider rejection is terminal and never leaks its underlying error', async () => {
    const fetchMock = createFetchMock();
    let tokenAttempts = 0;
    const client = new GitHubRequestClient({
        fetch: fetchMock,
        maxRetries: 3,
        tokenProvider: async () => {
            tokenAttempts++;
            throw new Error('HTTP 403 provider-secret-sentinel');
        },
    });
    await expect(client.request('/orgs/oss-slu/repos')).rejects.toMatchObject({
        name: 'GitHubCredentialProviderError',
        message:
            'Could not obtain GitHub credentials; check the credential provider configuration and authentication.',
    });
    expect(tokenAttempts).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
});
