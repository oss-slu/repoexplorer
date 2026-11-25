import { jest } from '@jest/globals';
import { OpenAICompatibleClient } from '../classification/client';

describe('classification clients', () => {
    test('omits temperature and reasoning effort unless they are configured', async () => {
        const bodies: Array<Record<string, unknown>> = [];
        const fetchImplementation: typeof fetch = async (_input, init) => {
            bodies.push(
                JSON.parse(String(init?.body)) as Record<string, unknown>,
            );
            return Response.json({
                choices: [
                    { message: { content: '{}' }, finish_reason: 'stop' },
                ],
            });
        };
        const messages = [{ role: 'user' as const, content: 'prompt' }];
        const reasoningDefaults = new OpenAICompatibleClient({
            provider: 'openai-compatible',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-5-mini',
            apiKey: 'secret',
            timeoutMs: 1000,
            maxRetries: 0,
            fetchImplementation,
        });
        await reasoningDefaults.classify('affiliation', messages);
        const configured = new OpenAICompatibleClient({
            provider: 'openai-compatible',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-5-mini',
            apiKey: 'secret',
            timeoutMs: 1000,
            maxRetries: 0,
            generation: {
                responseFormat: 'text',
                maxOutputTokens: 4096,
                maxOutputTokensField: 'max_completion_tokens',
                reasoningEffort: 'low',
            },
            fetchImplementation,
        });
        await configured.classify('affiliation', messages);
        expect(bodies[0]).not.toHaveProperty('temperature');
        expect(bodies[0]).not.toHaveProperty('reasoning_effort');
        expect(bodies[0]?.max_completion_tokens).toBe(8192);
        expect(bodies[1]).not.toHaveProperty('temperature');
        expect(bodies[1]).toMatchObject({
            max_completion_tokens: 4096,
            reasoning_effort: 'low',
        });
    });

    test('does not silently downgrade rejected structured output', async () => {
        const fetchImplementation = jest.fn<typeof fetch>(
            async () =>
                new Response(
                    '{"error":"response_format json_schema unsupported"}',
                    {
                        status: 400,
                    },
                ),
        );
        const client = new OpenAICompatibleClient({
            provider: 'legacy-provider',
            baseUrl: 'https://example.test/v1',
            model: 'model',
            apiKey: 'secret',
            timeoutMs: 1000,
            maxRetries: 2,
            generation: {
                responseFormat: 'json_schema',
                temperature: 0,
                maxOutputTokens: 128,
                maxOutputTokensField: 'max_tokens',
            },
            fetchImplementation,
        });
        await expect(
            client.classify('affiliation', [
                { role: 'user', content: 'prompt' },
            ]),
        ).rejects.toMatchObject({
            code: 'provider_unsupported_format',
            attemptDiagnostics: [
                expect.objectContaining({
                    outcome: 'http_error',
                    httpStatus: 400,
                }),
            ],
        });
        expect(fetchImplementation).toHaveBeenCalledTimes(1);
    });

    test('retries transient provider responses and sends the configured model', async () => {
        let calls = 0;
        const fetchImplementation = jest.fn<typeof fetch>(
            async (_input, init) => {
                calls += 1;
                if (calls === 1)
                    return new Response('{}', {
                        status: 429,
                        headers: { 'retry-after': '0' },
                    });
                expect(JSON.parse(String(init?.body))).toMatchObject({
                    model: 'test-model',
                });
                return Response.json({
                    choices: [{ message: { content: '{"score":0.9}' } }],
                });
            },
        );
        const wait = jest.fn<
            (milliseconds: number, signal?: AbortSignal) => Promise<void>
        >(async () => undefined);
        const client = new OpenAICompatibleClient({
            provider: 'local-compatible',
            baseUrl: 'http://localhost:1234/v1',
            model: 'test-model',
            apiKey: 'test-secret',
            timeoutMs: 1000,
            maxRetries: 2,
            fetchImplementation,
            wait,
        });
        const completion = await client.classifyDetailed('affiliation', [
            { role: 'user', content: 'prompt' },
        ]);
        expect(completion.text).toBe('{"score":0.9}');
        expect(calls).toBe(2);
        expect(wait).toHaveBeenCalledTimes(1);
        expect(
            completion.attemptDiagnostics?.map((attempt) => attempt.outcome),
        ).toEqual(['rate_limit_retry', 'reply_received']);
    });

    test('stops after the configured retry budget and respects pre-cancellation', async () => {
        let calls = 0;
        const fetchImplementation = jest.fn<typeof fetch>(async () => {
            calls += 1;
            return new Response('{}', { status: 503 });
        });
        const wait = jest.fn<
            (milliseconds: number, signal?: AbortSignal) => Promise<void>
        >(async () => undefined);
        const client = new OpenAICompatibleClient({
            provider: 'test',
            baseUrl: 'https://example.test/v1',
            model: 'model',
            apiKey: 'secret',
            timeoutMs: 1000,
            maxRetries: 2,
            fetchImplementation,
            wait,
        });
        await expect(
            client.classify('affiliation', [
                { role: 'user', content: 'prompt' },
            ]),
        ).rejects.toMatchObject({
            code: 'provider_http_error',
            httpStatus: 503,
            attemptDiagnostics: [
                expect.objectContaining({
                    attempt: 1,
                    outcome: 'http_retry',
                    httpStatus: 503,
                }),
                expect.objectContaining({
                    attempt: 2,
                    outcome: 'http_retry',
                    httpStatus: 503,
                }),
                expect.objectContaining({
                    attempt: 3,
                    outcome: 'http_error',
                    httpStatus: 503,
                }),
            ],
        });
        expect(calls).toBe(3);
        expect(wait).toHaveBeenCalledTimes(2);

        const controller = new AbortController();
        controller.abort(new Error('cancel now'));
        await expect(
            client.classify('affiliation', [], controller.signal),
        ).rejects.toThrow('cancel now');
        expect(calls).toBe(3);
    });

    test('aborts an in-flight provider request when the run is cancelled', async () => {
        const fetchImplementation = jest.fn<typeof fetch>(
            async (_input, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener(
                        'abort',
                        () =>
                            reject(init.signal?.reason ?? new Error('aborted')),
                        { once: true },
                    );
                }),
        );
        const client = new OpenAICompatibleClient({
            provider: 'test',
            baseUrl: 'https://example.test/v1',
            model: 'model',
            apiKey: 'secret',
            timeoutMs: 1000,
            maxRetries: 2,
            fetchImplementation,
        });
        const controller = new AbortController();
        const pending = client.classify('affiliation', [], controller.signal);
        controller.abort(new Error('cancel in-flight request'));
        await expect(pending).rejects.toThrow('cancel in-flight request');
        expect(fetchImplementation).toHaveBeenCalledTimes(1);
    });
});
