import {
    GitHubRequestClient,
    type GitHubRequestOptions,
    type GitHubResponse,
} from './githubRequest';

export interface GitHubPaginatedResponse<T> extends GitHubResponse<T[]> {
    pageCount: number;
    searchTotalCount?: number;
    incompleteResults?: boolean;
}

export class GitHubPaginationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GitHubPaginationError';
    }
}

export type GitHubSearchEndpointKind = 'repositories' | 'users';
export type GitHubSearchKind = 'repository' | 'organization' | 'user';
export type GitHubSearchStage =
    | 'probe'
    | 'pagination'
    | 'partition-aggregation';
export type GitHubSearchFailureReason =
    | 'incomplete-results'
    | 'count-changed'
    | 'short-results'
    | 'invalid-search-metadata'
    | 'created-filter-conflict'
    | 'single-second-overflow'
    | 'partition-limit'
    | 'pagination-cycle'
    | 'page-limit';

export interface GitHubSearchErrorDetails {
    reason: GitHubSearchFailureReason;
    endpointKind: GitHubSearchEndpointKind;
    searchKind: GitHubSearchKind;
    stage: GitHubSearchStage;
    expectedCount?: number;
    observedCount?: number;
    searchAttempts: number;
    maxSearchAttempts: number;
    retriesExhausted?: boolean;
}

/** A safe, structured failure from a logical GitHub search. */
export class GitHubSearchError extends GitHubPaginationError {
    readonly reason: GitHubSearchFailureReason;
    readonly endpointKind: GitHubSearchEndpointKind;
    readonly searchKind: GitHubSearchKind;
    readonly stage: GitHubSearchStage;
    readonly expectedCount?: number;
    readonly observedCount?: number;
    readonly maxSearchAttempts: number;
    searchAttempts: number;
    retriesExhausted: boolean;

    constructor(details: GitHubSearchErrorDetails) {
        super(searchFailureMessage(details.reason));
        this.name = 'GitHubSearchError';
        this.reason = details.reason;
        this.endpointKind = details.endpointKind;
        this.searchKind = details.searchKind;
        this.stage = details.stage;
        this.expectedCount = details.expectedCount;
        this.observedCount = details.observedCount;
        this.searchAttempts = details.searchAttempts;
        this.maxSearchAttempts = details.maxSearchAttempts;
        this.retriesExhausted = details.retriesExhausted ?? false;
    }

    setRetryOutcome(searchAttempts: number, retriesExhausted: boolean): void {
        this.searchAttempts = searchAttempts;
        this.retriesExhausted = retriesExhausted;
    }
}

function searchFailureMessage(reason: GitHubSearchFailureReason): string {
    switch (reason) {
        case 'incomplete-results':
            return 'GitHub marked search results incomplete';
        case 'count-changed':
            return 'GitHub search counts changed during discovery';
        case 'short-results':
            return 'GitHub search pagination returned fewer results than expected';
        case 'invalid-search-metadata':
            return 'GitHub search response contained invalid completeness metadata';
        case 'created-filter-conflict':
            return 'Capped GitHub search already contains a created: filter';
        case 'single-second-overflow':
            return 'GitHub search exceeds the result cap within one second';
        case 'partition-limit':
            return 'GitHub search exceeded its cumulative partition probe limit';
        case 'pagination-cycle':
            return 'GitHub search pagination repeated a page';
        case 'page-limit':
            return 'GitHub search pagination exceeded its page limit';
    }
}

export function extractGitHubItems<T>(data: unknown): T[] {
    if (Array.isArray(data)) {
        return data as T[];
    }
    if (
        data &&
        typeof data === 'object' &&
        'items' in data &&
        Array.isArray((data as { items?: unknown }).items)
    ) {
        return (data as { items: T[] }).items;
    }
    throw new GitHubPaginationError(
        'Expected a GitHub API page to be an array or an object with an items array',
    );
}

export function getNextGitHubPage(
    linkHeader: string | null,
): string | undefined {
    if (!linkHeader) {
        return undefined;
    }

    for (const link of linkHeader.split(/,\s*(?=<)/)) {
        const urlMatch = link.match(/<([^>]+)>/);
        const relationMatch = link.match(/\brel\s*=\s*"?([^";\s,]+)"?/i);
        if (urlMatch && relationMatch?.[1].split(/\s+/).includes('next')) {
            return urlMatch[1];
        }
    }

    return undefined;
}

export async function paginateGitHub<T>(
    client: GitHubRequestClient,
    endpoint: string,
    options: Omit<GitHubRequestOptions, 'responseType'> & {
        responseType?: 'json';
    } = {},
    maxPages = 1_000,
): Promise<GitHubPaginatedResponse<T>> {
    if (!Number.isInteger(maxPages) || maxPages <= 0) {
        throw new RangeError('maxPages must be a positive integer');
    }

    const items: T[] = [];
    const visited = new Set<string>();
    let nextPage: string | undefined = endpoint;
    let lastResponse: GitHubResponse<unknown> | undefined;
    let pageCount = 0;
    let searchTotalCount: number | undefined;
    let incompleteResults: boolean | undefined;

    while (nextPage) {
        if (pageCount >= maxPages) {
            throw new GitHubPaginationError(
                `GitHub pagination exceeded the ${maxPages} page limit`,
            );
        }
        if (visited.has(nextPage)) {
            throw new GitHubPaginationError(
                `GitHub pagination repeated page URL: ${nextPage}`,
            );
        }
        visited.add(nextPage);

        const pageOptions =
            pageCount === 0
                ? options
                : {
                      headers: options.headers,
                      signal: options.signal,
                      timeoutMs: options.timeoutMs,
                      allowNoContent: options.allowNoContent,
                  };
        const response: GitHubResponse<unknown> = await client.request<unknown>(
            nextPage,
            pageOptions,
        );
        if (isSearchEnvelope(response.data)) {
            const pageTotalCount = response.data.total_count;
            const pageIncompleteResults = response.data.incomplete_results;
            if (
                typeof pageTotalCount === 'number' &&
                Number.isSafeInteger(pageTotalCount) &&
                pageTotalCount >= 0
            ) {
                if (
                    searchTotalCount !== undefined &&
                    pageTotalCount !== searchTotalCount
                ) {
                    throw new GitHubPaginationError(
                        'GitHub search total_count changed during pagination',
                    );
                }
                searchTotalCount ??= pageTotalCount;
            }
            if (typeof pageIncompleteResults === 'boolean') {
                incompleteResults =
                    incompleteResults === true || pageIncompleteResults;
            }
        }
        // GitHub returns 204 for contributor listings on empty repositories.
        if (response.status !== 204) {
            items.push(...extractGitHubItems<T>(response.data));
        }
        pageCount += 1;
        lastResponse = response;
        nextPage = getNextGitHubPage(response.headers.get('link'));

        if (nextPage) {
            const absoluteNextPage: string = new URL(
                nextPage,
                response.url,
            ).toString();
            if (visited.has(absoluteNextPage)) {
                throw new GitHubPaginationError(
                    `GitHub pagination repeated page URL: ${absoluteNextPage}`,
                );
            }
            nextPage = absoluteNextPage;
        }
    }

    if (!lastResponse) {
        throw new GitHubPaginationError(
            'GitHub pagination did not receive a response',
        );
    }

    return {
        ...lastResponse,
        data: items,
        pageCount,
        searchTotalCount,
        incompleteResults,
    };
}

function isSearchEnvelope(value: unknown): value is {
    items: unknown[];
    total_count?: unknown;
    incomplete_results?: unknown;
} {
    return (
        value !== null &&
        typeof value === 'object' &&
        'items' in value &&
        Array.isArray(value.items)
    );
}
