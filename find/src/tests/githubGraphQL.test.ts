import { jest } from '@jest/globals';
import {
    GitHubGraphQLError,
    GitHubRequestClient,
} from '../utils/githubRequest';
import type { ScrapingProgressEvent } from '../types/progress';
import { projectScrapingDiagnostic } from '../utils/scrapingDiagnostics';

function jsonResponse(
    data: unknown,
    status = 200,
    headers: Record<string, string> = {},
): Response {
    return new Response(JSON.stringify(data), { status, headers });
}

function createClient(
    fetchImplementation: (url: URL, init: RequestInit) => Promise<Response>,
    events: ScrapingProgressEvent[] = [],
    baseUrl?: string,
): GitHubRequestClient {
    return new GitHubRequestClient({
        ...(baseUrl ? { baseUrl } : {}),
        token: 'test-token',
        fetch: (async (input, init) =>
            fetchImplementation(
                new URL(String(input)),
                init ?? {},
            )) as typeof fetch,
        sleep: async () => undefined,
        random: () => 0,
        retryBaseDelayMs: 0,
        retryMaxDelayMs: 0,
        now: () => Date.now(),
        onProgress: (event) => events.push(event),
    });
}

const resetIn = (ms: number) => String(Math.ceil((Date.now() + ms) / 1_000));

describe('GitHub GraphQL requests', () => {
    test('posts the query and returns attributed partial errors', async () => {
        let request: { url: URL; init: RequestInit } | undefined;
        const client = createClient(async (url, init) => {
            request = { url, init };
            return jsonResponse({
                data: { r0: null, r1: { databaseId: 1 } },
                errors: [
                    { type: 'NOT_FOUND', path: ['r0'], message: 'missing' },
                ],
            });
        });

        const response = await client.graphql('query { r0 }', { o0: 'slu' });

        expect(request?.url.pathname).toBe('/graphql');
        expect(request?.init.method).toBe('POST');
        expect(JSON.parse(String(request?.init.body))).toEqual({
            query: 'query { r0 }',
            variables: { o0: 'slu' },
        });
        expect(new Headers(request?.init.headers).get('authorization')).toBe(
            'Bearer test-token',
        );
        expect(response.errors).toEqual([
            { type: 'NOT_FOUND', path: ['r0'], message: 'missing' },
        ]);
    });

    test('uses the GitHub Enterprise Server GraphQL path beside /api/v3', async () => {
        let path: string | undefined;
        const client = createClient(
            async (url) => {
                path = url.pathname;
                return jsonResponse({ data: {} });
            },
            [],
            'https://github.example/api/v3',
        );
        await client.graphql('query { viewer { login } }', {});
        expect(path).toBe('/api/graphql');
    });

    test('throws a safe error for unattributed GraphQL errors', async () => {
        const client = createClient(async () =>
            jsonResponse(
                {
                    data: null,
                    errors: [
                        { message: 'Something went wrong; secret detail' },
                    ],
                },
                200,
                { 'x-github-request-id': 'REQ-1' },
            ),
        );
        const error = await client
            .graphql('query { viewer { login } }', {})
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(GitHubGraphQLError);
        expect(error).toMatchObject({ validation: false, requestId: 'REQ-1' });
        const diagnostic = projectScrapingDiagnostic(error);
        expect(diagnostic).toMatchObject({
            category: 'graphql-error',
            requestId: 'REQ-1',
        });
        expect(JSON.stringify(diagnostic)).not.toContain('secret detail');
    });

    test('rejects POST outside the GraphQL endpoint', async () => {
        const client = createClient(async () => jsonResponse({}));
        await expect(
            client.request('/repos/slu/project', { method: 'POST' }),
        ).rejects.toThrow('Only GitHub GraphQL queries may use POST');
    });

    test('waits in the graphql bucket for a RATE_LIMITED 200 without pausing core', async () => {
        jest.useFakeTimers();
        try {
            const events: ScrapingProgressEvent[] = [];
            let graphqlCalls = 0;
            const client = createClient(async (url) => {
                if (url.pathname === '/graphql') {
                    graphqlCalls += 1;
                    if (graphqlCalls === 1) {
                        return jsonResponse(
                            {
                                errors: [
                                    {
                                        type: 'RATE_LIMITED',
                                        message:
                                            'API rate limit exceeded for user ID 1.',
                                    },
                                ],
                            },
                            200,
                            {
                                'x-ratelimit-resource': 'graphql',
                                'x-ratelimit-remaining': '0',
                                'x-ratelimit-limit': '5000',
                                'x-ratelimit-reset': resetIn(2_000),
                            },
                        );
                    }
                    return jsonResponse({ data: { ok: true } });
                }
                return jsonResponse({ id: 1 });
            }, events);

            const query = client.graphql('query { ok }', {});
            await jest.advanceTimersByTimeAsync(0);
            expect(graphqlCalls).toBe(1);
            await expect(
                client.request('/repos/slu/project'),
            ).resolves.toMatchObject({
                status: 200,
            });
            await jest.advanceTimersByTimeAsync(2_000);
            expect(graphqlCalls).toBe(1);
            await jest.advanceTimersByTimeAsync(2_000);
            await expect(query).resolves.toMatchObject({ data: { ok: true } });
            expect(graphqlCalls).toBe(2);
            expect(events).toContainEqual(
                expect.objectContaining({
                    type: 'rate-limit-wait',
                    bucket: 'graphql',
                    reason: 'primary',
                }),
            );
        } finally {
            jest.useRealTimers();
        }
    });

    test('reports graphql quota diagnostics after the recovery budget is exhausted', async () => {
        const client = new GitHubRequestClient({
            token: 'test-token',
            maxRateLimitRetries: 0,
            fetch: (async () =>
                jsonResponse(
                    {
                        errors: [
                            {
                                type: 'RATE_LIMITED',
                                message:
                                    'API rate limit exceeded for user ID 1.',
                            },
                        ],
                    },
                    200,
                    {
                        'x-ratelimit-resource': 'graphql',
                        'x-ratelimit-remaining': '0',
                        'x-ratelimit-limit': '5000',
                        'x-github-request-id': 'REQ-RL',
                    },
                )) as typeof fetch,
        });
        const error = await client
            .graphql('query { ok }', {})
            .catch((caught: unknown) => caught);
        expect(error).toMatchObject({
            name: 'GitHubRequestError',
            method: 'POST',
            classification: 'primary rate limit',
            retryStopReason: 'rate-limit recovery budget exhausted',
            rateLimit: { bucket: 'graphql', limit: 5000, remaining: 0 },
        });
        expect(projectScrapingDiagnostic(error)).toMatchObject({
            category: 'primary rate limit',
            requestId: 'REQ-RL',
            rateLimit: { bucket: 'graphql' },
        });
    });

    test('pauses every bucket for a GraphQL secondary rate limit', async () => {
        jest.useFakeTimers();
        try {
            const events: ScrapingProgressEvent[] = [];
            let graphqlCalls = 0;
            const client = createClient(async (url) => {
                if (url.pathname === '/graphql') {
                    graphqlCalls += 1;
                    return graphqlCalls === 1
                        ? jsonResponse(
                              {
                                  message:
                                      'You have exceeded a secondary rate limit.',
                              },
                              403,
                              {
                                  'x-ratelimit-resource': 'graphql',
                                  'retry-after': '3',
                              },
                          )
                        : jsonResponse({ data: { ok: true } });
                }
                return jsonResponse({ id: 1 });
            }, events);

            const query = client.graphql('query { ok }', {});
            await jest.advanceTimersByTimeAsync(0);
            let restDone = false;
            const rest = client.request('/repos/slu/project').then(() => {
                restDone = true;
            });
            await jest.advanceTimersByTimeAsync(2_000);
            expect(restDone).toBe(false);
            await jest.advanceTimersByTimeAsync(2_000);
            await rest;
            await expect(query).resolves.toMatchObject({ data: { ok: true } });
            expect(events).toContainEqual(
                expect.objectContaining({
                    type: 'rate-limit-wait',
                    bucket: 'all',
                    reason: 'secondary',
                }),
            );
        } finally {
            jest.useRealTimers();
        }
    });

    test('pauses only the graphql bucket when a successful response exhausts it', async () => {
        jest.useFakeTimers();
        try {
            const events: ScrapingProgressEvent[] = [];
            const client = createClient(
                async (url) =>
                    url.pathname === '/graphql'
                        ? jsonResponse({ data: {} }, 200, {
                              'x-ratelimit-resource': 'graphql',
                              'x-ratelimit-remaining': '0',
                              'x-ratelimit-reset': resetIn(5_000),
                          })
                        : jsonResponse({ id: 1 }),
                events,
            );
            await client.graphql('query { ok }', {});
            await expect(
                client.request('/repos/slu/project'),
            ).resolves.toMatchObject({
                status: 200,
            });
            expect(events).toContainEqual(
                expect.objectContaining({
                    type: 'rate-limit-wait',
                    bucket: 'graphql',
                }),
            );
            expect(events).toContainEqual(
                expect.objectContaining({
                    type: 'request-queue',
                    waits: { graphql: expect.any(Number) },
                }),
            );
        } finally {
            jest.useRealTimers();
        }
    });
});
