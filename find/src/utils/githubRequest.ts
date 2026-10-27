import type { ScrapingProgressCallback } from '../types/progress';

export type GitHubResponseType = 'json' | 'text';

export type GitHubQueryValue =
    | string
    | number
    | boolean
    | null
    | undefined
    | readonly (string | number | boolean)[];

export type GitHubQuery = URLSearchParams | Record<string, GitHubQueryValue>;

export interface GitHubRequestConfig {
    baseUrl?: string;
    token?: string;
    headers?: HeadersInit;
    timeoutMs?: number;
    maxRetries?: number;
    retryBaseDelayMs?: number;
    retryMaxDelayMs?: number;
    maxRateLimitRetries?: number;
    rateLimitResetBufferMs?: number;
    concurrency?: number;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    random?: () => number;
    sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
    onProgress?: ScrapingProgressCallback;
}

export interface GitHubRequestOptions {
    query?: GitHubQuery;
    headers?: HeadersInit;
    signal?: AbortSignal;
    responseType?: GitHubResponseType;
    timeoutMs?: number;
}

export interface GitHubResponse<T> {
    data: T;
    status: number;
    headers: Headers;
    url: string;
}

type RateLimitBucket = 'core' | 'search';
export type GitHubErrorClassification =
    | 'primary rate limit'
    | 'secondary rate limit'
    | 'authentication'
    | 'permission'
    | 'not found'
    | 'other';

export interface GitHubRateLimitDiagnostics {
    bucket: RateLimitBucket;
    classification: 'primary rate limit' | 'secondary rate limit';
    limit?: number;
    remaining?: number;
    resetAt?: number;
    retryAfterMs?: number;
}

interface RateLimitDecision {
    diagnostics: GitHubRateLimitDiagnostics;
    until: number;
    delayMs: number;
}

interface QueuedRequest {
    bucket: RateLimitBucket;
    signal?: AbortSignal;
    run: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    onAbort?: () => void;
}

interface GitHubRequestQueueState {
    activeRequests: number;
    queuedRequests: number;
    waits: Partial<Record<RateLimitBucket, number>>;
}

interface AttemptResult {
    response?: GitHubResponse<unknown>;
    error?: GitHubRequestError;
    rateLimit?: RateLimitDecision;
}

class TransientAttemptError extends Error {
    constructor(
        message: string,
        readonly url: string,
        readonly timedOut: boolean,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'TransientAttemptError';
    }
}

export class GitHubRequestError extends Error {
    readonly method = 'GET';
    readonly requestId?: string;
    readonly classification: GitHubErrorClassification;
    readonly rateLimit?: GitHubRateLimitDiagnostics;
    attemptCount: number;
    retryStopReason?: string;

    constructor(
        message: string,
        readonly status: number,
        readonly data: unknown,
        readonly headers: Headers,
        readonly url: string,
        details: {
            attemptCount?: number;
            requestId?: string;
            classification?: GitHubErrorClassification;
            rateLimit?: GitHubRateLimitDiagnostics;
            retryStopReason?: string;
        } = {},
    ) {
        super(message);
        this.name = 'GitHubRequestError';
        this.attemptCount = details.attemptCount ?? 1;
        this.requestId = details.requestId;
        this.classification = details.classification ?? 'other';
        this.rateLimit = details.rateLimit;
        this.retryStopReason = details.retryStopReason;
    }
}

export class GitHubNetworkError extends Error {
    readonly retryStopReason: string;

    constructor(
        readonly url: string,
        readonly attempts: number,
        options?: ErrorOptions,
        retryStopReason = 'transient retry budget exhausted',
    ) {
        super(
            `GitHub request to ${url} failed after ${attempts} attempts`,
            options,
        );
        this.name = 'GitHubNetworkError';
        this.retryStopReason = retryStopReason;
    }
}

export class GitHubTimeoutError extends GitHubNetworkError {
    constructor(
        url: string,
        attempts: number,
        readonly timeoutMs: number,
        options?: ErrorOptions,
    ) {
        super(url, attempts, options);
        this.message = `GitHub request to ${url} timed out after ${timeoutMs} ms (${attempts} attempts)`;
        this.name = 'GitHubTimeoutError';
    }
}

export class GitHubResponseParseError extends Error {
    constructor(
        readonly status: number,
        readonly url: string,
        options?: ErrorOptions,
        readonly attemptCount = 1,
        readonly requestId?: string,
    ) {
        super(
            `GitHub returned invalid JSON for ${url} (status ${status})`,
            options,
        );
        this.name = 'GitHubResponseParseError';
    }
}

const DEFAULT_BASE_URL = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_RETRY_MAX_DELAY_MS = 8_000;
const DEFAULT_CONCURRENCY = 1;
const RATE_LIMIT_FALLBACK_DELAY_MS = 60_000;
const MAX_SECONDARY_RATE_LIMIT_DELAY_MS = 15 * 60_000;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 4;
const MAX_RATE_LIMIT_RESET_HORIZON_MS = 24 * 60 * 60 * 1_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const DEFAULT_RATE_LIMIT_RESET_BUFFER_MS = 1_000;
const RETRYABLE_STATUSES = new Set([409, 412, 502, 503, 504]);

class GitHubRequestQueue {
    private readonly pending: QueuedRequest[] = [];
    private readonly cooldownUntil = new Map<RateLimitBucket, number>();
    private active = 0;
    private cooldownTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly concurrency: number,
        private readonly now: () => number,
        private readonly onChange?: (state: GitHubRequestQueueState) => void,
    ) {}

    dispatch<T>(
        bucket: RateLimitBucket,
        signal: AbortSignal | undefined,
        run: () => Promise<T>,
    ): Promise<T> {
        if (signal?.aborted) {
            return Promise.reject(createAbortError(signal));
        }

        return new Promise<T>((resolve, reject) => {
            const request: QueuedRequest = {
                bucket,
                signal,
                run,
                resolve: (value) => resolve(value as T),
                reject,
            };

            if (signal) {
                request.onAbort = () => {
                    const index = this.pending.indexOf(request);
                    if (index === -1) {
                        return;
                    }

                    this.pending.splice(index, 1);
                    this.removeAbortListener(request);
                    reject(createAbortError(signal));
                    this.drain();
                };
                signal.addEventListener('abort', request.onAbort, {
                    once: true,
                });
            }

            this.pending.push(request);
            this.drain();
        });
    }

    pause(bucket: RateLimitBucket | 'all', until: number): void {
        if (until <= this.now()) {
            return;
        }

        const buckets: RateLimitBucket[] =
            bucket === 'all' ? ['core', 'search'] : [bucket];
        for (const target of buckets) {
            this.cooldownUntil.set(
                target,
                Math.max(this.cooldownUntil.get(target) ?? 0, until),
            );
        }
        this.drain();
    }

    private drain(): void {
        if (this.cooldownTimer) {
            clearTimeout(this.cooldownTimer);
            this.cooldownTimer = undefined;
        }

        for (let index = this.pending.length - 1; index >= 0; index -= 1) {
            const request = this.pending[index];
            if (request.signal?.aborted) {
                this.pending.splice(index, 1);
                this.removeAbortListener(request);
                request.reject(createAbortError(request.signal));
            }
        }

        while (this.active < this.concurrency) {
            const now = this.now();
            const readyIndex = this.pending.findIndex(
                (request) =>
                    (this.cooldownUntil.get(request.bucket) ?? 0) <= now,
            );
            if (readyIndex === -1) {
                break;
            }

            const [request] = this.pending.splice(readyIndex, 1);
            this.removeAbortListener(request);
            this.active += 1;
            void request
                .run()
                .then(request.resolve, request.reject)
                .finally(() => {
                    this.active -= 1;
                    this.drain();
                });
        }

        const nextCooldown = this.pending.reduce((earliest, request) => {
            const cooldown = this.cooldownUntil.get(request.bucket) ?? 0;
            return cooldown > this.now()
                ? Math.min(earliest, cooldown)
                : earliest;
        }, Number.POSITIVE_INFINITY);

        if (Number.isFinite(nextCooldown)) {
            // Node clamps oversized timeout delays to 1ms. Chunk long quota
            // waits so malformed or far-future headers cannot create a hot loop.
            const delay = Math.min(
                MAX_TIMER_DELAY_MS,
                Math.max(1, nextCooldown - this.now()),
            );
            this.cooldownTimer = setTimeout(() => {
                this.cooldownTimer = undefined;
                this.drain();
            }, delay);
        }
        this.onChange?.(this.getState());
    }

    private getState(): GitHubRequestQueueState {
        const now = this.now();
        const waits: Partial<Record<RateLimitBucket, number>> = {};
        for (const bucket of ['core', 'search'] as const) {
            const until = this.cooldownUntil.get(bucket) ?? 0;
            if (until > now) waits[bucket] = until;
        }
        return {
            activeRequests: this.active,
            queuedRequests: this.pending.length,
            waits,
        };
    }

    private removeAbortListener(request: QueuedRequest): void {
        if (request.signal && request.onAbort) {
            request.signal.removeEventListener('abort', request.onAbort);
            request.onAbort = undefined;
        }
    }
}

export class GitHubRequestClient {
    private readonly baseUrl: string;
    private readonly defaultHeaders: Headers;
    private readonly timeoutMs: number;
    private readonly maxRetries: number;
    private readonly maxRateLimitRetries: number;
    private readonly rateLimitResetBufferMs: number;
    private readonly retryBaseDelayMs: number;
    private readonly retryMaxDelayMs: number;
    private readonly fetchImplementation: typeof globalThis.fetch;
    private readonly now: () => number;
    private readonly random: () => number;
    private readonly sleep: (
        delayMs: number,
        signal?: AbortSignal,
    ) => Promise<void>;
    private readonly queue: GitHubRequestQueue;
    private readonly onProgress?: ScrapingProgressCallback;
    private readonly startedAt: number;
    private runSignal?: AbortSignal;

    constructor(config: GitHubRequestConfig = {}) {
        this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
        this.timeoutMs = validatePositiveInteger(
            config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            'timeoutMs',
        );
        this.maxRetries = validateNonNegativeInteger(
            config.maxRetries ?? DEFAULT_MAX_RETRIES,
            'maxRetries',
        );
        this.maxRateLimitRetries = validateNonNegativeInteger(
            config.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES,
            'maxRateLimitRetries',
        );
        this.rateLimitResetBufferMs = validateNonNegativeInteger(
            config.rateLimitResetBufferMs ?? DEFAULT_RATE_LIMIT_RESET_BUFFER_MS,
            'rateLimitResetBufferMs',
        );
        this.retryBaseDelayMs = validateNonNegativeInteger(
            config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
            'retryBaseDelayMs',
        );
        this.retryMaxDelayMs = validateNonNegativeInteger(
            config.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
            'retryMaxDelayMs',
        );
        const concurrency = validatePositiveInteger(
            config.concurrency ?? DEFAULT_CONCURRENCY,
            'concurrency',
        );
        this.fetchImplementation = config.fetch ?? globalThis.fetch;
        this.now = config.now ?? Date.now;
        this.random = config.random ?? Math.random;
        this.sleep = config.sleep ?? abortableSleep;
        this.onProgress = config.onProgress;
        this.startedAt = this.now();
        this.queue = new GitHubRequestQueue(concurrency, this.now, (state) =>
            this.onProgress?.({
                type: 'request-queue',
                ...state,
                elapsedMs: Math.max(0, this.now() - this.startedAt),
            }),
        );

        this.defaultHeaders = new Headers({
            Accept: 'application/vnd.github+json',
        });
        mergeHeaders(this.defaultHeaders, config.headers);
        if (config.token && !this.defaultHeaders.has('Authorization')) {
            this.defaultHeaders.set('Authorization', `Bearer ${config.token}`);
        }
    }

    request<T = unknown>(
        endpoint: string,
        options?: Omit<GitHubRequestOptions, 'responseType'> & {
            responseType?: 'json';
        },
    ): Promise<GitHubResponse<T>>;
    request(
        endpoint: string,
        options: Omit<GitHubRequestOptions, 'responseType'> & {
            responseType: 'text';
        },
    ): Promise<GitHubResponse<string>>;
    async request<T = unknown>(
        endpoint: string,
        options: GitHubRequestOptions = {},
    ): Promise<GitHubResponse<T | string>> {
        const url = createRequestUrl(this.baseUrl, endpoint, options.query);
        const bucket = getBucketFromPath(
            url.pathname,
            new URL(this.baseUrl).pathname,
        );
        const requestHeaders = new Headers(this.defaultHeaders);
        mergeHeaders(requestHeaders, options.headers);
        const timeoutMs = validatePositiveInteger(
            options.timeoutMs ?? this.timeoutMs,
            'timeoutMs',
        );
        const responseType = options.responseType ?? 'json';
        const signal = options.signal ?? this.runSignal;
        let attempts = 0;
        let transientRetries = 0;
        let rateLimitRetries = 0;

        while (true) {
            if (signal?.aborted) {
                throw createAbortError(signal);
            }

            try {
                attempts += 1;
                const result = await this.queue.dispatch(bucket, signal, () =>
                    this.executeAttempt(
                        url,
                        requestHeaders,
                        responseType,
                        timeoutMs,
                        signal,
                        bucket,
                        attempts,
                        rateLimitRetries + 1,
                    ),
                );

                if (result.response) {
                    return result.response as GitHubResponse<T | string>;
                }

                const error = result.error;
                if (!error) {
                    throw new Error(
                        'GitHub request completed without a response or an error',
                    );
                }

                error.attemptCount = attempts;
                if (result.rateLimit) {
                    if (rateLimitRetries >= this.maxRateLimitRetries) {
                        error.retryStopReason =
                            'rate-limit recovery budget exhausted';
                        throw error;
                    }
                    rateLimitRetries += 1;
                    continue;
                }

                if (!RETRYABLE_STATUSES.has(error.status)) {
                    error.retryStopReason = 'request is not retryable';
                    throw error;
                }

                if (transientRetries >= this.maxRetries) {
                    error.retryStopReason = 'transient retry budget exhausted';
                    throw error;
                }
                await this.sleep(this.retryDelay(transientRetries), signal);
                transientRetries += 1;
            } catch (error) {
                if (signal?.aborted) {
                    throw createAbortError(signal);
                }

                if (!(error instanceof TransientAttemptError)) {
                    throw error;
                }

                if (transientRetries >= this.maxRetries) {
                    if (error.timedOut) {
                        throw new GitHubTimeoutError(
                            url.toString(),
                            attempts,
                            timeoutMs,
                            {
                                cause: error,
                            },
                        );
                    }
                    throw new GitHubNetworkError(url.toString(), attempts, {
                        cause: error,
                    });
                }

                await this.sleep(this.retryDelay(transientRetries), signal);
                transientRetries += 1;
            }
        }
    }

    private async executeAttempt(
        url: URL,
        headers: Headers,
        responseType: GitHubResponseType,
        timeoutMs: number,
        callerSignal: AbortSignal | undefined,
        requestBucket: RateLimitBucket,
        attemptCount: number,
        rateLimitAttempt: number,
    ): Promise<AttemptResult> {
        const controller = new AbortController();
        let timedOut = false;
        const onCallerAbort = () => controller.abort(callerSignal?.reason);

        if (callerSignal?.aborted) {
            throw createAbortError(callerSignal);
        }
        callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);

        try {
            let response: Response;
            let rawBody: string;
            try {
                response = await this.fetchImplementation(url, {
                    method: 'GET',
                    headers,
                    signal: controller.signal,
                });
                rawBody = await response.text();
            } catch (cause) {
                if (callerSignal?.aborted) {
                    throw createAbortError(callerSignal);
                }
                throw new TransientAttemptError(
                    timedOut
                        ? `GitHub request timed out after ${timeoutMs} ms`
                        : 'GitHub network request failed',
                    url.toString(),
                    timedOut,
                    { cause },
                );
            }

            if (callerSignal?.aborted) {
                throw createAbortError(callerSignal);
            }

            let data: unknown;
            try {
                data = parseResponseBody(
                    rawBody,
                    responseType,
                    response.status,
                    url.toString(),
                    attemptCount,
                    response.headers.get('x-github-request-id') ?? undefined,
                );
            } catch (error) {
                // HTTP status and headers still govern retries for HTML or text errors.
                if (
                    response.ok ||
                    !(error instanceof GitHubResponseParseError)
                ) {
                    throw error;
                }
                data = rawBody;
            }
            const githubResponse: GitHubResponse<unknown> = {
                data,
                status: response.status,
                headers: response.headers,
                url: url.toString(),
            };

            if (response.ok) {
                if (response.headers.get('x-ratelimit-remaining') === '0') {
                    const responseBucket = getBucketFromResource(
                        response.headers,
                        requestBucket,
                    );
                    const now = this.now();
                    const until = primaryRateLimitDeadline(
                        response.headers,
                        now,
                        this.rateLimitResetBufferMs,
                        parseRetryAfter(
                            response.headers.get('retry-after'),
                            now,
                        ),
                    );
                    this.emitRateLimitWait(responseBucket, until, 'primary');
                    this.queue.pause(responseBucket, until);
                }
                return { response: githubResponse };
            }

            const rateLimit = getRateLimitDecision(
                response.status,
                response.headers,
                data,
                this.now(),
                rateLimitAttempt,
                requestBucket,
                this.rateLimitResetBufferMs,
                this.retryBaseDelayMs,
                this.retryMaxDelayMs,
            );
            const classification =
                rateLimit?.diagnostics.classification ??
                classifyHttpError(response.status, response.headers, data);
            const error = new GitHubRequestError(
                describeHttpError(response.status, data),
                response.status,
                data,
                response.headers,
                url.toString(),
                {
                    attemptCount,
                    requestId:
                        response.headers.get('x-github-request-id') ??
                        undefined,
                    classification,
                    rateLimit: rateLimit?.diagnostics,
                },
            );

            if (rateLimit) {
                const pauseBucket =
                    classification === 'primary rate limit'
                        ? rateLimit.diagnostics.bucket
                        : 'all';
                this.emitRateLimitWait(
                    pauseBucket,
                    rateLimit.until,
                    rateLimit.diagnostics.classification ===
                        'primary rate limit'
                        ? 'primary'
                        : 'secondary',
                );
                this.queue.pause(pauseBucket, rateLimit.until);
            }

            return { error, rateLimit };
        } finally {
            clearTimeout(timeout);
            callerSignal?.removeEventListener('abort', onCallerAbort);
        }
    }

    private retryDelay(attempt: number): number {
        const exponential = Math.min(
            this.retryMaxDelayMs,
            this.retryBaseDelayMs * 2 ** Math.min(attempt, 30),
        );
        const randomValue = Math.min(0.999_999_999, Math.max(0, this.random()));
        return Math.floor(exponential * randomValue);
    }

    private emitRateLimitWait(
        bucket: RateLimitBucket | 'all',
        until: number,
        reason: 'primary' | 'secondary',
    ): void {
        this.onProgress?.({
            type: 'rate-limit-wait',
            bucket,
            until,
            reason,
            elapsedMs: Math.max(0, this.now() - this.startedAt),
        });
    }

    /** Set the active scrape's signal; scrapes sharing this client run serially. */
    setRunSignal(signal?: AbortSignal): void {
        this.runSignal = signal;
    }
}

function validatePositiveInteger(value: number, name: string): number {
    if (!Number.isInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive integer`);
    }
    return value;
}

function validateNonNegativeInteger(value: number, name: string): number {
    if (!Number.isInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative integer`);
    }
    return value;
}

function mergeHeaders(target: Headers, source?: HeadersInit): void {
    if (!source) {
        return;
    }
    new Headers(source).forEach((value, name) => target.set(name, value));
}

function createRequestUrl(
    baseUrl: string,
    endpoint: string,
    query?: GitHubQuery,
): URL {
    const parsedBaseUrl = new URL(baseUrl);
    const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const url = /^https?:\/\//i.test(endpoint)
        ? new URL(endpoint)
        : new URL(endpoint.replace(/^\/+/, ''), normalizedBaseUrl);

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new TypeError(
            `Unsupported GitHub API URL protocol: ${url.protocol}`,
        );
    }
    if (url.origin !== parsedBaseUrl.origin) {
        throw new TypeError(
            'GitHub API endpoints must use the configured base URL origin',
        );
    }

    if (query instanceof URLSearchParams) {
        query.forEach((value, key) => url.searchParams.append(key, value));
    } else if (query) {
        for (const [key, value] of Object.entries(query)) {
            if (Array.isArray(value)) {
                url.searchParams.delete(key);
                for (const item of value) {
                    url.searchParams.append(key, String(item));
                }
            } else if (value === null || value === undefined) {
                url.searchParams.delete(key);
            } else {
                url.searchParams.set(key, String(value));
            }
        }
    }

    return url;
}

function getBucketFromPath(
    pathname: string,
    basePath: string,
): RateLimitBucket {
    const prefix = basePath.endsWith('/') ? basePath : `${basePath}/`;
    const apiPath = pathname.startsWith(prefix)
        ? pathname.slice(prefix.length)
        : pathname;
    return /^search(?:\/|$)/i.test(apiPath) ? 'search' : 'core';
}

function getBucketFromResource(
    headers: Headers,
    fallback: RateLimitBucket,
): RateLimitBucket {
    const resource = headers.get('x-ratelimit-resource')?.toLowerCase();
    if (resource === 'search') {
        return 'search';
    }
    return resource ? 'core' : fallback;
}

function parseResponseBody(
    rawBody: string,
    responseType: GitHubResponseType,
    status: number,
    url: string,
    attemptCount: number,
    requestId?: string,
): unknown {
    // Error responses keep structured GitHub fields even for raw-text endpoints.
    if (status >= 400) {
        if (rawBody.trim() === '') return null;
        try {
            return JSON.parse(rawBody) as unknown;
        } catch {
            return rawBody;
        }
    }
    if (responseType === 'text') {
        return rawBody;
    }
    if (rawBody.trim() === '') {
        return null;
    }
    try {
        return JSON.parse(rawBody) as unknown;
    } catch (cause) {
        throw new GitHubResponseParseError(
            status,
            url,
            { cause },
            attemptCount,
            requestId,
        );
    }
}

function describeHttpError(status: number, data: unknown): string {
    if (data && typeof data === 'object' && 'message' in data) {
        const message = (data as { message?: unknown }).message;
        if (typeof message === 'string' && message.length > 0) {
            return `GitHub API error (${status}): ${message}`;
        }
    }
    return `GitHub API request failed with status ${status}`;
}

function getRateLimitDecision(
    status: number,
    headers: Headers,
    data: unknown,
    now: number,
    rateLimitAttempt: number,
    requestBucket: RateLimitBucket,
    resetBufferMs: number,
    retryBaseDelayMs: number,
    retryMaxDelayMs: number,
): RateLimitDecision | undefined {
    if (status !== 403 && status !== 429) return undefined;
    const remaining = parseSafeInteger(headers.get('x-ratelimit-remaining'));
    const message = getErrorMessage(data);
    const resetAt = parseRateLimitResetAt(
        headers.get('x-ratelimit-reset'),
        now,
    );
    const retryAfterMs = parseRetryAfter(headers.get('retry-after'), now);
    const primaryLimit =
        remaining === 0 || message.includes('api rate limit exceeded');
    const secondaryMessage =
        message.includes('secondary rate limit') ||
        message.includes('abuse detection');
    const secondaryLimit =
        secondaryMessage || (status === 429 && retryAfterMs !== undefined);

    let classification: GitHubRateLimitDiagnostics['classification'];
    if (primaryLimit && !secondaryMessage) {
        classification = 'primary rate limit';
    } else if (status === 429 || (status === 403 && secondaryLimit)) {
        classification = 'secondary rate limit';
    } else {
        return undefined;
    }

    const bucket = getBucketFromResource(headers, requestBucket);
    const exponential = Math.min(
        retryMaxDelayMs,
        retryBaseDelayMs * 2 ** Math.min(rateLimitAttempt - 1, 30),
    );
    const backoff = Math.max(1_000, exponential);
    let until: number;

    if (classification === 'primary rate limit') {
        until = primaryRateLimitDeadline(
            headers,
            now,
            resetBufferMs,
            retryAfterMs,
        );
    } else {
        const retryDeadline =
            retryAfterMs === undefined ? 0 : now + retryAfterMs;
        const resetDeadline =
            remaining === 0
                ? primaryRateLimitDeadline(
                      headers,
                      now,
                      resetBufferMs,
                      retryAfterMs,
                  )
                : 0;
        const secondaryBackoff =
            retryAfterMs === undefined
                ? Math.min(
                      MAX_SECONDARY_RATE_LIMIT_DELAY_MS,
                      RATE_LIMIT_FALLBACK_DELAY_MS *
                          2 ** Math.min(rateLimitAttempt - 1, 30),
                  )
                : backoff;
        const fallbackDeadline = now + secondaryBackoff;
        until = Math.max(retryDeadline, resetDeadline, fallbackDeadline);
    }

    const delayMs = Math.max(0, until - now);
    return {
        diagnostics: {
            bucket,
            classification,
            limit: parseSafeInteger(headers.get('x-ratelimit-limit')),
            remaining,
            resetAt,
            retryAfterMs,
        },
        until,
        delayMs,
    };
}

function classifyHttpError(
    status: number,
    headers: Headers,
    data: unknown,
): GitHubErrorClassification {
    const message = getErrorMessage(data);
    const remaining = headers.get('x-ratelimit-remaining');
    if (status === 401) return 'authentication';
    const secondaryMessage =
        message.includes('secondary rate limit') ||
        message.includes('abuse detection');
    if (
        (status === 403 || status === 429) &&
        !secondaryMessage &&
        (remaining === '0' || message.includes('api rate limit exceeded'))
    ) {
        return 'primary rate limit';
    }
    if (
        status === 429 ||
        message.includes('secondary rate limit') ||
        message.includes('abuse detection')
    ) {
        return 'secondary rate limit';
    }
    if ((status === 403 || status === 429) && remaining === '0') {
        return 'primary rate limit';
    }
    if (status === 403) return 'permission';
    if (status === 404) return 'not found';
    return 'other';
}

function getErrorMessage(data: unknown): string {
    let errorData = data;
    if (typeof errorData === 'string') {
        try {
            errorData = JSON.parse(errorData) as unknown;
        } catch {
            return String(errorData).toLowerCase();
        }
    }
    if (errorData && typeof errorData === 'object' && 'message' in errorData) {
        return String(
            (errorData as { message?: unknown }).message ?? '',
        ).toLowerCase();
    }
    return '';
}

function parseRetryAfter(
    value: string | null,
    now: number,
): number | undefined {
    if (value === null || value.trim() === '') {
        return undefined;
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        const milliseconds = seconds * 1_000;
        return Number.isFinite(milliseconds) && milliseconds <= 8.64e15
            ? milliseconds
            : undefined;
    }
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function parseRateLimitResetAt(
    value: string | null,
    now: number,
): number | undefined {
    if (value === null || value.trim() === '') {
        return undefined;
    }
    const resetAt = Number(value);
    if (!Number.isSafeInteger(resetAt) || resetAt <= 0) return undefined;
    return resetAt * 1_000 - now <= MAX_RATE_LIMIT_RESET_HORIZON_MS
        ? resetAt
        : undefined;
}

function primaryRateLimitDeadline(
    headers: Headers,
    now: number,
    resetBufferMs: number,
    retryAfterMs: number | undefined,
): number {
    const resetAt = parseRateLimitResetAt(
        headers.get('x-ratelimit-reset'),
        now,
    );
    const resetDeadline = resetAt !== undefined && resetAt * 1_000 > now
        ? resetAt * 1_000 + resetBufferMs
        : now + RATE_LIMIT_FALLBACK_DELAY_MS;
    const retryAfterDeadline =
        retryAfterMs === undefined ? 0 : now + retryAfterMs;
    return Math.max(resetDeadline, retryAfterDeadline);
}

function parseSafeInteger(value: string | null): number | undefined {
    if (value === null || !/^\d+$/.test(value.trim())) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function createAbortError(signal: AbortSignal): unknown {
    if (signal.reason !== undefined) {
        return signal.reason;
    }
    return new DOMException('The operation was aborted', 'AbortError');
}

function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(createAbortError(signal));
    }

    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, delayMs);
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            if (signal) {
                reject(createAbortError(signal));
            }
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
