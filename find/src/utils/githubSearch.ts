import {
    GitHubSearchError,
    type GitHubSearchEndpointKind,
    type GitHubSearchErrorDetails,
    type GitHubSearchFailureReason,
    type GitHubSearchKind,
    type GitHubSearchStage,
} from './githubPagination';
import { GitHubRequestClient, type GitHubResponse } from './githubRequest';
import type { ScrapingProgressCallback } from '../types/progress';

type SearchResult<T> = { items: T[]; totalCount: number };
type CreationRange = { start: number; end: number };
type SearchEnvelope<T> = {
    items: T[];
    total_count: number;
    incomplete_results: false;
};

const SEARCH_LIMIT = 1_000;
const MAX_PARTITION_PROBES = 4_095;
const MAX_PAGES = 1_000;
const DEFAULT_SEARCH_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000] as const;
const TRANSIENT_SEARCH_FAILURES = new Set<GitHubSearchFailureReason>([
    'incomplete-results',
    'count-changed',
    'short-results',
]);

export type GitHubSearchOptions = {
    signal?: AbortSignal;
    onProgress?: ScrapingProgressCallback;
    university?: string;
    elapsedMs?: () => number;
    maxAttempts?: number;
    partitionProbeBudget?: number;
    pageLimit?: number;
    retryDelaysMs?: readonly number[];
    sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
    now?: () => number;
};

/** Collect complete searches, restarting transiently inconsistent searches from the root. */
export async function searchGitHub<T>(
    client: GitHubRequestClient,
    endpoint: GitHubSearchEndpointKind,
    query: string,
    searchKind: GitHubSearchKind,
    options: GitHubSearchOptions = {},
): Promise<SearchResult<T>> {
    const maxAttempts = validatePositiveInteger(
        options.maxAttempts ?? DEFAULT_SEARCH_ATTEMPTS,
        'maxAttempts',
    );
    if (maxAttempts > DEFAULT_SEARCH_ATTEMPTS) {
        throw new RangeError(
            `maxAttempts must not exceed ${DEFAULT_SEARCH_ATTEMPTS}`,
        );
    }
    const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    for (const delay of retryDelaysMs) {
        validateNonNegativeInteger(delay, 'retry delay');
    }
    const partitionProbeBudget = validatePartitionProbeBudget(
        options.partitionProbeBudget ?? MAX_PARTITION_PROBES,
    );
    const pageLimit = validatePageLimit(options.pageLimit ?? MAX_PAGES);

    // Freeze the upper bound once. Every attempt uses the same partition tree.
    const bounds = {
        start: 0,
        end: Math.floor((options.now ?? Date.now)() / 1_000),
    };
    // This budget is cumulative across retries so inconsistency cannot multiply
    // the existing worst-case probe bound.
    let partitionProbes = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        throwIfAborted(options.signal);
        try {
            return await collectAttempt(attempt);
        } catch (error) {
            if (options.signal?.aborted) throw abortReason(options.signal);
            if (
                !(error instanceof GitHubSearchError) ||
                !TRANSIENT_SEARCH_FAILURES.has(error.reason)
            ) {
                throw error;
            }
            if (attempt === maxAttempts) {
                error.setRetryOutcome(attempt, true);
                throw error;
            }

            options.onProgress?.({
                type: 'search-retry',
                searchKind,
                reason: error.reason,
                attempt: attempt + 1,
                totalAttempts: maxAttempts,
                ...(options.university ? { university: options.university } : {}),
                elapsedMs: options.elapsedMs?.() ?? 0,
            });
            const delayMs = retryDelaysMs[attempt - 1] ?? 0;
            await (options.sleep ?? abortableSleep)(delayMs, options.signal);
        }
    }

    throw new Error('GitHub search exited without a result or failure');

    async function collectAttempt(attempt: number): Promise<SearchResult<T>> {
        const createError = (
            reason: GitHubSearchFailureReason,
            stage: GitHubSearchStage,
            counts: Pick<GitHubSearchErrorDetails, 'expectedCount' | 'observedCount'> = {},
        ) =>
            makeSearchError(
                reason,
                endpoint,
                searchKind,
                stage,
                attempt,
                maxAttempts,
                counts,
            );

        async function collect(
            range?: CreationRange,
        ): Promise<SearchResult<T>> {
            throwIfAborted(options.signal);
            if (partitionProbes >= partitionProbeBudget) {
                throw createError('partition-limit', 'partition-aggregation');
            }
            partitionProbes += 1;

            const partitionQuery = range
                ? `${query} created:${timestamp(range.start)}..${timestamp(range.end)}`
                : query;
            // Probe first so capped searches are subdivided before pagination.
            const probe = await client.request<unknown>(`/search/${endpoint}`, {
                query: { q: partitionQuery, per_page: 1 },
                signal: options.signal,
            });
            const probeEnvelope = readSearchEnvelope<T>(
                probe,
                'probe',
                createError,
            );
            const totalCount = probeEnvelope.total_count;

            if (totalCount > SEARCH_LIMIT) {
                // Adding another created: qualifier would alter custom-query meaning.
                if (/(?:^|\s)-?created:/i.test(query)) {
                    throw createError('created-filter-conflict', 'probe', {
                        expectedCount: SEARCH_LIMIT,
                        observedCount: totalCount,
                    });
                }
                const { start, end } = range ?? bounds;
                if (start >= end) {
                    throw createError(
                        'single-second-overflow',
                        'partition-aggregation',
                        { expectedCount: SEARCH_LIMIT, observedCount: totalCount },
                    );
                }
                const midpoint = Math.floor((start + end) / 2);
                const left = await collect({ start, end: midpoint });
                const right = await collect({ start: midpoint + 1, end });
                const observedCount = left.totalCount + right.totalCount;
                if (observedCount !== totalCount) {
                    throw createError('count-changed', 'partition-aggregation', {
                        expectedCount: totalCount,
                        observedCount,
                    });
                }
                return {
                    items: [...left.items, ...right.items],
                    totalCount,
                };
            }

            if (totalCount === 0) return { items: [], totalCount };
            return paginateSearch<T>(
                client,
                endpoint,
                partitionQuery,
                totalCount,
                options.signal,
                pageLimit,
                createError,
            );
        }

        return collect();
    }
}

async function paginateSearch<T>(
    client: GitHubRequestClient,
    endpoint: GitHubSearchEndpointKind,
    query: string,
    expectedCount: number,
    signal: AbortSignal | undefined,
    pageLimit: number,
    createError: (
        reason: GitHubSearchFailureReason,
        stage: GitHubSearchStage,
        counts?: Pick<GitHubSearchErrorDetails, 'expectedCount' | 'observedCount'>,
    ) => GitHubSearchError,
): Promise<SearchResult<T>> {
    const visited = new Set<string>();
    const items: T[] = [];
    let nextPage: string | undefined;
    let pageCount = 0;

    while (true) {
        throwIfAborted(signal);
        if (pageCount >= pageLimit) {
            throw createError('page-limit', 'pagination', {
                expectedCount,
                observedCount: items.length,
            });
        }

        const requestTarget = pageCount === 0 ? `/search/${endpoint}` : nextPage;
        if (!requestTarget) break;
        if (pageCount > 0 && visited.has(requestTarget)) {
            throw createError('pagination-cycle', 'pagination', {
                expectedCount,
                observedCount: items.length,
            });
        }

        const response = await client.request<unknown>(
            requestTarget,
            pageCount === 0
                ? { query: { q: query, per_page: 100 }, signal }
                : { signal },
        );
        if (visited.has(response.url)) {
            throw createError('pagination-cycle', 'pagination', {
                expectedCount,
                observedCount: items.length,
            });
        }
        visited.add(response.url);

        const envelope = readSearchEnvelope<T>(
            response,
            'pagination',
            createError,
            expectedCount,
        );
        items.push(...envelope.items);
        pageCount += 1;

        const next = getNextPage(response.headers.get('link'));
        nextPage = next ? new URL(next, response.url).toString() : undefined;
        if (nextPage && visited.has(nextPage)) {
            throw createError('pagination-cycle', 'pagination', {
                expectedCount,
                observedCount: items.length,
            });
        }
        if (!nextPage) break;
    }

    if (items.length !== expectedCount) {
        throw createError('short-results', 'pagination', {
            expectedCount,
            observedCount: items.length,
        });
    }
    return { items, totalCount: expectedCount };
}

function readSearchEnvelope<T>(
    response: GitHubResponse<unknown>,
    stage: 'probe' | 'pagination',
    createError: (
        reason: GitHubSearchFailureReason,
        stage: GitHubSearchStage,
        counts?: Pick<GitHubSearchErrorDetails, 'expectedCount' | 'observedCount'>,
    ) => GitHubSearchError,
    expectedCount?: number,
): SearchEnvelope<T> {
    const value = response.data;
    if (!isRecord(value)) {
        throw createError('invalid-search-metadata', stage, {
            ...(expectedCount === undefined ? {} : { expectedCount }),
        });
    }

    const incompleteResults = value.incomplete_results;
    const count = value.total_count;
    const validCount =
        typeof count === 'number' &&
        Number.isSafeInteger(count) &&
        count >= 0;
    const counts = {
        ...(expectedCount === undefined ? {} : { expectedCount }),
        ...(validCount ? { observedCount: count } : {}),
    };

    // An explicit incomplete flag is transient even if another field is absent.
    if (incompleteResults === true) {
        throw createError('incomplete-results', stage, counts);
    }
    if (
        incompleteResults !== false ||
        !validCount ||
        !Array.isArray(value.items)
    ) {
        throw createError('invalid-search-metadata', stage, counts);
    }
    if (expectedCount !== undefined && count !== expectedCount) {
        throw createError('count-changed', stage, {
            expectedCount,
            observedCount: count,
        });
    }
    return {
        items: value.items as T[],
        total_count: count,
        incomplete_results: false,
    };
}

function makeSearchError(
    reason: GitHubSearchFailureReason,
    endpointKind: GitHubSearchEndpointKind,
    searchKind: GitHubSearchKind,
    stage: GitHubSearchStage,
    searchAttempts: number,
    maxSearchAttempts: number,
    counts: Pick<GitHubSearchErrorDetails, 'expectedCount' | 'observedCount'> = {},
): GitHubSearchError {
    return new GitHubSearchError({
        reason,
        endpointKind,
        searchKind,
        stage,
        ...counts,
        searchAttempts,
        maxSearchAttempts,
    });
}

function getNextPage(linkHeader: string | null): string | undefined {
    if (!linkHeader) return undefined;
    for (const link of linkHeader.split(/,\s*(?=<)/)) {
        const urlMatch = link.match(/<([^>]+)>/);
        const relationMatch = link.match(/\brel\s*=\s*"?([^";\s,]+)"?/i);
        if (urlMatch && relationMatch?.[1].split(/\s+/).includes('next')) {
            return urlMatch[1];
        }
    }
    return undefined;
}

function timestamp(seconds: number): string {
    return new Date(seconds * 1_000).toISOString().replace('.000Z', 'Z');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function validatePartitionProbeBudget(value: number): number {
    if (
        !Number.isInteger(value) ||
        value <= 0 ||
        value > MAX_PARTITION_PROBES
    ) {
        throw new RangeError(
            `partitionProbeBudget must be between 1 and ${MAX_PARTITION_PROBES}`,
        );
    }
    return value;
}

function validatePageLimit(value: number): number {
    if (!Number.isInteger(value) || value <= 0 || value > MAX_PAGES) {
        throw new RangeError(`pageLimit must be between 1 and ${MAX_PAGES}`);
    }
    return value;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            reject(abortReason(signal!));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, delayMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}
