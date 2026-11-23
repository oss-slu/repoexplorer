import { jest } from '@jest/globals';
import {
    FakeClassificationClient,
    OpenAICompatibleClient,
    RandomSimulationClient,
} from '../classification/client';

describe('classification clients', () => {
    test('fake client returns deterministic fixture responses and records prompts', async () => {
        const client = new FakeClassificationClient();
        const messages = [{ role: 'user' as const, content: 'prompt' }];
        const first = await client.classify('affiliation', messages);
        const second = await client.classify('project_type', messages);
        expect(first).toContain('uncertain');
        expect(second).toContain('DEV');
        expect(client.requests).toHaveLength(2);
    });

    test('sends task-specific strict schemas and the configured generation fields', async () => {
        const bodies: Array<Record<string, unknown>> = [];
        const client = new OpenAICompatibleClient({
            provider: 'local-compatible',
            baseUrl: 'http://127.0.0.1:1234/v1',
            model: 'test-model',
            apiKey: 'test-secret',
            timeoutMs: 1000,
            maxRetries: 0,
            generation: {
                responseFormat: 'json_schema',
                temperature: 0,
                maxOutputTokens: 512,
                maxOutputTokensField: 'max_tokens',
                seed: 42,
            },
            fetchImplementation: async (_input, init) => {
                bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
                return Response.json({
                    choices: [{ message: { content: '{}' } }],
                    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
                });
            },
        });
        const messages = [{ role: 'user' as const, content: 'prompt' }];
        const completion = await client.classifyDetailed('affiliation', messages);
        await client.classify('project_type', messages);
        await client.classifyDetailed('affiliation', messages, undefined, {
            citationMode: 'evidence_id',
        });
        expect(completion.usage).toEqual({ input: 12, output: 7, total: 19 });
        expect(completion.attemptDiagnostics).toEqual([
            expect.objectContaining({ attempt: 1, outcome: 'reply_received', httpStatus: 200 }),
        ]);
        expect(completion.completionStatus).toBe('unknown');
        expect(completion.finishReason).toBeNull();
        expect(bodies[0]).toMatchObject({
            model: 'test-model',
            temperature: 0,
            max_tokens: 512,
            seed: 42,
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'repository_affiliation',
                    strict: true,
                    schema: {
                        properties: expect.objectContaining({
                            decision: expect.any(Object),
                            relationship: expect.any(Object),
                        }),
                        additionalProperties: false,
                    },
                },
            },
        });
        expect(bodies[1]).toMatchObject({
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'repository_project_type',
                    strict: true,
                    schema: {
                        properties: expect.objectContaining({ category: expect.any(Object) }),
                    },
                },
            },
        });
        expect(bodies[2]).toMatchObject({
            response_format: {
                json_schema: {
                    schema: {
                        properties: expect.objectContaining({
                            evidenceIds: expect.any(Object),
                        }),
                        required: expect.arrayContaining(['evidenceIds']),
                    },
                },
            },
        });
        expect(JSON.stringify(bodies[2]?.response_format)).not.toContain(
            '"evidence":',
        );
    });

    test('omits temperature and reasoning effort unless they are configured', async () => {
        const bodies: Array<Record<string, unknown>> = [];
        const fetchImplementation: typeof fetch = async (_input, init) => {
            bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            return Response.json({
                choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
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

    test('retries a timeout while reading the response body', async () => {
        let calls = 0;
        const stalledBody = (signal: AbortSignal | null | undefined) =>
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"choices":'));
                    signal?.addEventListener(
                        'abort',
                        () => controller.error(signal.reason),
                        { once: true },
                    );
                },
            });
        const client = (maxRetries: number) =>
            new OpenAICompatibleClient({
                provider: 'openai-compatible',
                baseUrl: 'https://example.test/v1',
                model: 'model',
                apiKey: 'secret',
                timeoutMs: 20,
                maxRetries,
                wait: async () => {},
                fetchImplementation: async (_input, init) => {
                    calls += 1;
                    if (calls === 1 || maxRetries === 0) {
                        return new Response(stalledBody(init?.signal), {
                            status: 200,
                        });
                    }
                    return Response.json({
                        choices: [
                            { message: { content: '{}' }, finish_reason: 'stop' },
                        ],
                    });
                },
            });
        const messages = [{ role: 'user' as const, content: 'prompt' }];

        const recovered = await client(1).classifyDetailed('affiliation', messages);
        expect(calls).toBe(2);
        expect(recovered.attemptDiagnostics).toEqual([
            expect.objectContaining({ attempt: 1, outcome: 'timeout_retry', httpStatus: 200 }),
            expect.objectContaining({ attempt: 2, outcome: 'reply_received' }),
        ]);

        calls = 0;
        await expect(
            client(0).classify('affiliation', messages),
        ).rejects.toMatchObject({
            code: 'provider_timeout',
            attemptDiagnostics: [
                expect.objectContaining({ outcome: 'timeout_error', httpStatus: 200 }),
            ],
        });
        expect(calls).toBe(1);
    });

    test('keeps a malformed response body as an invalid completion', async () => {
        const fetchImplementation = jest.fn<typeof fetch>(
            async () => new Response('{"choices":', { status: 200 }),
        );
        const client = new OpenAICompatibleClient({
            provider: 'openai-compatible',
            baseUrl: 'https://example.test/v1',
            model: 'model',
            apiKey: 'secret',
            timeoutMs: 1000,
            maxRetries: 2,
            fetchImplementation,
        });
        await expect(
            client.classify('affiliation', [{ role: 'user', content: 'prompt' }]),
        ).rejects.toMatchObject({
            code: 'provider_invalid_completion',
            attemptDiagnostics: [
                expect.objectContaining({ outcome: 'invalid_completion' }),
            ],
        });
        expect(fetchImplementation).toHaveBeenCalledTimes(1);
    });

    test('does not silently downgrade rejected structured output', async () => {
        const fetchImplementation = jest.fn<typeof fetch>(async () =>
            new Response('{"error":"response_format json_schema unsupported"}', {
                status: 400,
            }),
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
                expect.objectContaining({ outcome: 'http_error', httpStatus: 400 }),
            ],
        });
        expect(fetchImplementation).toHaveBeenCalledTimes(1);
    });

    test('seeded simulator repeats results for the same seed', async () => {
        const first = new RandomSimulationClient(42);
        const second = new RandomSimulationClient(42);
        const messages = [{ role: 'user' as const, content: 'prompt' }];
        expect(await first.classify('affiliation', messages)).toBe(
            await second.classify('affiliation', messages),
        );
        expect(await first.classify('project_type', messages)).toBe(
            await second.classify('project_type', messages),
        );
        expect(first.cacheIdentity).toBe('seed:42');
        expect(first.simulationSeed).toBe(42);
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
        expect(completion.attemptDiagnostics?.map((attempt) => attempt.outcome)).toEqual([
            'rate_limit_retry',
            'reply_received',
        ]);
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
                expect.objectContaining({ attempt: 1, outcome: 'http_retry', httpStatus: 503 }),
                expect.objectContaining({ attempt: 2, outcome: 'http_retry', httpStatus: 503 }),
                expect.objectContaining({ attempt: 3, outcome: 'http_error', httpStatus: 503 }),
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

    test('does not retry a successful HTTP response with an invalid envelope', async () => {
        const fetchImplementation = jest.fn<typeof fetch>(async () =>
            Response.json({ choices: [] }),
        );
        const client = new OpenAICompatibleClient({
            provider: 'test',
            baseUrl: 'https://example.test/v1',
            model: 'model',
            apiKey: 'secret',
            timeoutMs: 1000,
            maxRetries: 2,
            fetchImplementation,
            wait: async () => undefined,
        });
        await expect(
            client.classify('affiliation', [
                { role: 'user', content: 'prompt' },
            ]),
        ).rejects.toMatchObject({
            code: 'provider_invalid_completion',
            attemptDiagnostics: [
                expect.objectContaining({ outcome: 'invalid_completion', httpStatus: 200 }),
            ],
        });
        expect(fetchImplementation).toHaveBeenCalledTimes(1);
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
