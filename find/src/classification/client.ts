import type {
    ClassificationCitationMode,
    ClassificationGenerationSettings,
    ClassificationTask,
} from '../types/scraping';
import { schemaForTask } from './contracts';
import type { PromptMessage } from './prompts';
import {
    deterministicEvidenceResponse,
    emptyWireEvidence,
    preferredProjectCitation,
    readPromptEvidence,
    wireEvidence,
} from './simulation';

export type ClassificationTokenUsage = {
    input: number | null;
    output: number | null;
    total: number | null;
};

export type ClassificationAttemptOutcome =
    | 'reply_received'
    | 'http_retry'
    | 'http_error'
    | 'rate_limit_retry'
    | 'rate_limit_error'
    | 'timeout_retry'
    | 'timeout_error'
    | 'network_retry'
    | 'network_error'
    | 'invalid_completion';

export type ClassificationAttemptDiagnostic = {
    attempt: number;
    outcome: ClassificationAttemptOutcome;
    elapsedMs: number;
    httpStatus?: number;
};

export type ClassificationCompletion = {
    text: string;
    usage?: ClassificationTokenUsage;
    attemptDiagnostics?: ClassificationAttemptDiagnostic[];
    finishReason?: string | null;
    completionStatus?: 'complete' | 'truncated' | 'unknown';
};

export type ClassificationRequestOptions = {
    citationMode?: ClassificationCitationMode;
};

export interface ClassificationClient {
    readonly provider: string;
    readonly model: string;
    readonly simulated: boolean;
    readonly cacheIdentity?: string;
    readonly simulationSeed?: number;
    classifyDetailed?(
        task: ClassificationTask,
        messages: readonly PromptMessage[],
        signal?: AbortSignal,
        requestOptions?: ClassificationRequestOptions,
    ): Promise<ClassificationCompletion>;
    classify(
        task: ClassificationTask,
        messages: readonly PromptMessage[],
        signal?: AbortSignal,
    ): Promise<string>;
}

export type OpenAICompatibleClientOptions = {
    provider: string;
    baseUrl: string;
    model: string;
    apiKey: string;
    timeoutMs: number;
    maxRetries: number;
    generation?: ClassificationGenerationSettings;
    fetchImplementation?: typeof fetch;
    wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

export class OpenAICompatibleClient implements ClassificationClient {
    readonly simulated = false;
    readonly cacheIdentity: string;
    private readonly endpoint: string;
    private readonly fetchImplementation: typeof fetch;
    private readonly wait: (
        milliseconds: number,
        signal?: AbortSignal,
    ) => Promise<void>;
    private readonly generation: ClassificationGenerationSettings;

    constructor(private readonly options: OpenAICompatibleClientOptions) {
        this.provider = options.provider;
        this.model = options.model;
        this.endpoint = `${options.baseUrl.replace(/\/$/, '')}/chat/completions`;
        this.cacheIdentity = this.endpoint;
        this.generation = options.generation ?? {
            responseFormat: 'text',
            maxOutputTokens: 8192,
            maxOutputTokensField: 'max_completion_tokens',
        };
        this.fetchImplementation = options.fetchImplementation ?? fetch;
        this.wait = options.wait ?? delay;
        if (!options.apiKey.trim()) {
            throw new TypeError(
                'The configured classification API key is empty',
            );
        }
    }

    readonly provider: string;
    readonly model: string;

    async classify(
        task: ClassificationTask,
        messages: readonly PromptMessage[],
        signal?: AbortSignal,
    ): Promise<string> {
        return (await this.classifyDetailed(task, messages, signal)).text;
    }

    async classifyDetailed(
        task: ClassificationTask,
        messages: readonly PromptMessage[],
        signal?: AbortSignal,
        requestOptions: ClassificationRequestOptions = {},
    ): Promise<ClassificationCompletion> {
        const attemptDiagnostics: ClassificationAttemptDiagnostic[] = [];
        for (let attempt = 0; ; attempt += 1) {
            if (signal?.aborted) {
                throw cancelledProviderError(signal, attemptDiagnostics);
            }
            let responseReceived = false;
            const attemptStartedAt = performance.now();
            try {
                const timeoutSignal = AbortSignal.timeout(
                    this.options.timeoutMs,
                );
                const requestSignal = signal
                    ? AbortSignal.any([signal, timeoutSignal])
                    : timeoutSignal;
                const response = await this.fetchImplementation(this.endpoint, {
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${this.options.apiKey}`,
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify(
                        this.createRequestBody(task, messages, requestOptions),
                    ),
                    signal: requestSignal,
                });
                responseReceived = true;
                if (!response.ok) {
                    const retrying =
                        isRetryableStatus(response.status) &&
                        attempt < this.options.maxRetries;
                    const rateLimit = response.status === 429;
                    attemptDiagnostics.push({
                        attempt: attempt + 1,
                        outcome: rateLimit
                            ? retrying
                                ? 'rate_limit_retry'
                                : 'rate_limit_error'
                            : retrying
                              ? 'http_retry'
                              : 'http_error',
                        elapsedMs: elapsedSince(attemptStartedAt),
                        httpStatus: response.status,
                    });
                    if (retrying) {
                        const retryAfter = response.headers.get('retry-after');
                        await response.body?.cancel();
                        await this.wait(
                            retryDelay(attempt, retryAfter),
                            signal,
                        );
                        continue;
                    }
                    await response.body?.cancel();
                    if (
                        (response.status === 400 || response.status === 422) &&
                        this.generation.responseFormat !== 'text'
                    ) {
                        throw new ClassificationProviderError(
                            'provider_unsupported_format',
                            `Provider rejected the requested ${this.generation.responseFormat} response format (HTTP ${response.status}); no fallback was attempted`,
                            attemptDiagnostics,
                            response.status,
                        );
                    }
                    throw new ClassificationProviderError(
                        rateLimit
                            ? 'provider_rate_limit'
                            : 'provider_http_error',
                        `Classification provider returned HTTP ${response.status}`,
                        attemptDiagnostics,
                        response.status,
                    );
                }
                let payload: unknown;
                try {
                    payload = await response.json();
                } catch (error) {
                    // The request timeout also covers reading the body; a
                    // stalled body is a timeout, not a malformed completion.
                    if (!signal?.aborted && isTimeout(error)) {
                        const retrying = attempt < this.options.maxRetries;
                        attemptDiagnostics.push({
                            attempt: attempt + 1,
                            outcome: retrying ? 'timeout_retry' : 'timeout_error',
                            elapsedMs: elapsedSince(attemptStartedAt),
                            httpStatus: response.status,
                        });
                        if (retrying) {
                            await this.wait(retryDelay(attempt), signal);
                            continue;
                        }
                        throw new ClassificationProviderError(
                            'provider_timeout',
                            'Classification provider timed out while sending the response body',
                            attemptDiagnostics,
                            response.status,
                            { cause: error },
                        );
                    }
                    attemptDiagnostics.push({
                        attempt: attempt + 1,
                        outcome: 'invalid_completion',
                        elapsedMs: elapsedSince(attemptStartedAt),
                        httpStatus: response.status,
                    });
                    throw new ClassificationProviderError(
                        'provider_invalid_completion',
                        'Classification provider returned an invalid completion envelope',
                        attemptDiagnostics,
                        response.status,
                        { cause: error },
                    );
                }
                let completion: ClassificationCompletion;
                try {
                    completion = readAssistantCompletion(payload);
                } catch (error) {
                    attemptDiagnostics.push({
                        attempt: attempt + 1,
                        outcome: 'invalid_completion',
                        elapsedMs: elapsedSince(attemptStartedAt),
                        httpStatus: response.status,
                    });
                    throw new ClassificationProviderError(
                        'provider_invalid_completion',
                        'Classification provider returned an invalid completion envelope',
                        attemptDiagnostics,
                        response.status,
                        { cause: error },
                    );
                }
                attemptDiagnostics.push({
                    attempt: attempt + 1,
                    outcome: 'reply_received',
                    elapsedMs: elapsedSince(attemptStartedAt),
                    httpStatus: response.status,
                });
                return { ...completion, attemptDiagnostics };
            } catch (error) {
                if (signal?.aborted) {
                    throw cancelledProviderError(signal, attemptDiagnostics, error);
                }
                if (responseReceived) {
                    throw error instanceof Error
                        ? error
                        : new Error(String(error));
                }
                if (error instanceof ClassificationProviderError) throw error;
                const timeout = isTimeout(error);
                const network = isRetryableNetworkError(error);
                if (timeout || network) {
                    const retrying = attempt < this.options.maxRetries;
                    attemptDiagnostics.push({
                        attempt: attempt + 1,
                        outcome: timeout
                            ? retrying
                                ? 'timeout_retry'
                                : 'timeout_error'
                            : retrying
                              ? 'network_retry'
                              : 'network_error',
                        elapsedMs: elapsedSince(attemptStartedAt),
                    });
                    if (retrying) {
                        await this.wait(retryDelay(attempt), signal);
                        continue;
                    }
                    throw new ClassificationProviderError(
                        timeout ? 'provider_timeout' : 'provider_network_error',
                        timeout
                            ? 'Classification provider request timed out'
                            : 'Classification provider request failed before a response was received',
                        attemptDiagnostics,
                        undefined,
                        { cause: error },
                    );
                }
                throw error instanceof Error ? error : new Error(String(error));
            }
        }
    }

    private createRequestBody(
        task: ClassificationTask,
        messages: readonly PromptMessage[],
        requestOptions: ClassificationRequestOptions,
    ): Record<string, unknown> {
        const body: Record<string, unknown> = {
            model: this.model,
            messages,
            ...(this.generation.temperature === undefined
                ? {}
                : { temperature: this.generation.temperature }),
            [this.generation.maxOutputTokensField]:
                this.generation.maxOutputTokens,
            ...(this.generation.reasoningEffort === undefined
                ? {}
                : { reasoning_effort: this.generation.reasoningEffort }),
            ...(this.generation.seed === undefined
                ? {}
                : { seed: this.generation.seed }),
        };
        if (this.generation.responseFormat === 'json_object') {
            body.response_format = { type: 'json_object' };
        } else if (this.generation.responseFormat === 'json_schema') {
            body.response_format = {
                type: 'json_schema',
                json_schema: {
                    name:
                        task === 'affiliation'
                            ? 'repository_affiliation'
                            : 'repository_project_type',
                    strict: true,
                    schema: schemaForTask(
                        task,
                        requestOptions.citationMode ?? 'exact_quote',
                    ),
                },
            };
        }
        return body;
    }
}

export class ClassificationProviderError extends Error {
    constructor(
        readonly code:
            | 'provider_unsupported_format'
            | 'provider_http_error'
            | 'provider_rate_limit'
            | 'provider_timeout'
            | 'provider_network_error'
            | 'provider_invalid_completion'
            | 'provider_cancelled'
            | 'provider_truncated_completion',
        message: string,
        readonly attemptDiagnostics: ClassificationAttemptDiagnostic[] = [],
        readonly httpStatus?: number,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'ClassificationProviderError';
    }
}

export type FakeResponse =
    | string
    | ((
          task: ClassificationTask,
          messages: readonly PromptMessage[],
      ) => string);

/** Deterministic injectable client for tests and local offline checks. */
export class FakeClassificationClient implements ClassificationClient {
    readonly simulated = true;
    readonly cacheIdentity: string;
    readonly requests: Array<{
        task: ClassificationTask;
        messages: readonly PromptMessage[];
    }> = [];
    private nextIndex = 0;

    constructor(
        private readonly responses: readonly FakeResponse[] = [],
        readonly provider = 'mock',
        readonly model = 'deterministic-fake-v1',
    ) {
        this.cacheIdentity = `${provider}:${model}`;
    }

    async classify(
        task: ClassificationTask,
        messages: readonly PromptMessage[],
        signal?: AbortSignal,
    ): Promise<string> {
        if (signal?.aborted) throw abortError(signal);
        this.requests.push({ task, messages });
        const response =
            this.responses.length === 0
                ? task === 'affiliation'
                    ? '{"decision":"uncertain","relationship":"insufficient_evidence","score":null,"evidence":[],"explanation":"Deterministic simulated response; no conclusion was evaluated."}'
                    : '{"category":"DEV","evidence":[],"explanation":"Deterministic simulated project type response."}'
                : this.responses[
                      Math.min(this.nextIndex, this.responses.length - 1)
                  ];
        this.nextIndex += 1;
        if (response === undefined)
            throw new Error('Fake client has no configured response');
        return typeof response === 'function'
            ? response(task, messages)
            : response;
    }
}

/**
 * Offline client for `npm run classify -- --mock`: deterministic, and able to
 * complete both tasks by citing text the prompt actually contains. The
 * constructor default of FakeClassificationClient stays uncertain-only.
 */
export function createEvidenceMockClient(): FakeClassificationClient {
    return new FakeClassificationClient(
        [deterministicEvidenceResponse],
        'mock',
        'deterministic-evidence-v2',
    );
}

const POSITIVE_RELATIONSHIPS = [
    'institutional_project',
    'research_group',
    'coursework',
    'student_organization',
    'maintainer_affiliation',
] as const;

/**
 * Seeded simulator for explicitly simulated runs; it never contacts a
 * provider. A supported affiliation is sampled only when the prompt shows a
 * passage naming the institution, and cites it (or its catalog ID), so it
 * passes the same validation and evidence gate as a provider response and
 * lets the project-type task run offline.
 */
export class RandomSimulationClient implements ClassificationClient {
    readonly provider = 'random-simulator';
    readonly model = 'seeded-random-v3';
    readonly simulated = true;
    readonly cacheIdentity: string;
    readonly simulationSeed: number;
    private state: number;
    private sampleIndex = 0;

    constructor(seed: number) {
        if (!Number.isSafeInteger(seed)) {
            throw new TypeError('Simulation seed must be a safe integer');
        }
        this.state = seed >>> 0;
        this.cacheIdentity = `seed:${seed}`;
        this.simulationSeed = seed;
    }

    async classify(
        task: ClassificationTask,
        messages: readonly PromptMessage[],
        signal?: AbortSignal,
    ): Promise<string> {
        if (signal?.aborted) throw abortError(signal);
        this.sampleIndex += 1;
        const evidence = readPromptEvidence(messages);
        if (task === 'affiliation') {
            const outcome = this.random();
            // Supported samples cite a passage that names the institution, so
            // they also pass the affiliation evidence gate.
            const citation = evidence?.findInstitutionCitation() ?? null;
            const explanation = `Seeded simulation sample ${this.sampleIndex}; this is not an evaluated affiliation judgment.`;
            if (outcome < 0.4 && citation) {
                return JSON.stringify({
                    decision: 'supported',
                    relationship:
                        POSITIVE_RELATIONSHIPS[
                            Math.floor(
                                this.random() * POSITIVE_RELATIONSHIPS.length,
                            )
                        ],
                    score: roundScore(0.2 + this.random() * 0.8),
                    ...wireEvidence([citation]),
                    explanation,
                });
            }
            if (outcome < 0.7) {
                return JSON.stringify({
                    decision: 'not_supported',
                    relationship: 'incidental_mention',
                    score: roundScore(this.random() * 0.3),
                    ...emptyWireEvidence(evidence),
                    explanation,
                });
            }
            return JSON.stringify({
                decision: 'uncertain',
                relationship: 'insufficient_evidence',
                score: null,
                ...emptyWireEvidence(evidence),
                explanation,
            });
        }
        const categoryIndex = Math.floor(this.random() * 6);
        const categories = ['DEV', 'EDU', 'DOCS', 'WEB', 'DATA', 'OTHER'];
        const citation = preferredProjectCitation(evidence);
        return JSON.stringify({
            category: categories[categoryIndex],
            ...(citation ? wireEvidence([citation]) : emptyWireEvidence(evidence)),
            explanation: `Seeded simulation sample ${this.sampleIndex}; this is not an evaluated project type judgment.`,
        });
    }

    private random(): number {
        this.state = (1664525 * this.state + 1013904223) >>> 0;
        return this.state / 0x1_0000_0000;
    }
}

function roundScore(value: number): number {
    return Math.min(1, Math.max(0, Math.round(value * 100) / 100));
}

function readAssistantCompletion(value: unknown): ClassificationCompletion {
    if (
        !isRecord(value) ||
        !Array.isArray(value.choices) ||
        value.choices.length === 0
    ) {
        throw new TypeError(
            'Classification provider returned an invalid response envelope',
        );
    }
    const choice = value.choices[0];
    if (
        !isRecord(choice) ||
        !isRecord(choice.message) ||
        typeof choice.message.content !== 'string'
    ) {
        throw new TypeError(
            'Classification provider returned no text completion',
        );
    }
    const completion: ClassificationCompletion = {
        text: choice.message.content,
        finishReason:
            typeof choice.finish_reason === 'string'
                ? choice.finish_reason
                : null,
        completionStatus:
            choice.finish_reason === 'length'
                ? 'truncated'
                : typeof choice.finish_reason === 'string'
                  ? 'complete'
                  : 'unknown',
    };
    if (isRecord(value.usage)) {
        completion.usage = {
            input: optionalNonnegativeInteger(value.usage.prompt_tokens),
            output: optionalNonnegativeInteger(value.usage.completion_tokens),
            total: optionalNonnegativeInteger(value.usage.total_tokens),
        };
    }
    return completion;
}

function optionalNonnegativeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
}

function isRetryableStatus(status: number): boolean {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableNetworkError(error: unknown): boolean {
    return (
        error instanceof TypeError ||
        (error instanceof Error && error.name === 'FetchError')
    );
}

function isTimeout(error: unknown): boolean {
    // AbortSignal.timeout() rejects with a DOMException, which is not an
    // `Error` instance in every realm (for example under Jest's VM context).
    return (
        typeof error === 'object' &&
        error !== null &&
        (error as { name?: unknown }).name === 'TimeoutError'
    );
}

function retryDelay(attempt: number, retryAfter: string | null = null): number {
    if (retryAfter !== null && /^\d+(\.\d+)?$/.test(retryAfter.trim())) {
        return Math.min(30_000, Number(retryAfter) * 1000);
    }
    return Math.min(8_000, 250 * 2 ** attempt);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError(signal));
            return;
        }
        const timeout = setTimeout(resolve, milliseconds);
        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(timeout);
                reject(abortError(signal));
            },
            { once: true },
        );
    });
}

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error('Classification cancelled');
}

function cancelledProviderError(
    signal: AbortSignal,
    attempts: ClassificationAttemptDiagnostic[],
    cause?: unknown,
): ClassificationProviderError {
    const error = abortError(signal);
    return new ClassificationProviderError(
        'provider_cancelled',
        error.message,
        attempts,
        undefined,
        { cause: cause ?? error },
    );
}

function elapsedSince(startedAt: number): number {
    return Math.max(0, performance.now() - startedAt);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
