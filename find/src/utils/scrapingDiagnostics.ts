import {
    GitHubNetworkError,
    GitHubCredentialProviderError,
    GitHubRequestError,
    GitHubRedirectError,
    GitHubResponseParseError,
    GitHubTimeoutError,
    type GitHubAccessReason,
    type GitHubRateLimitObservation,
    type GitHubSsoStatus,
} from './githubRequest';
import {
    GitHubPaginationError,
    GitHubSearchError,
    type GitHubSearchFailureReason,
} from './githubPagination';
import {
    RepositoryRecordValidationError,
    RepositoryEnrichmentSkipError,
    findScrapingCancellation,
    ScrapingContextError,
    ScrapingDatabasePreflightError,
    ScrapingDatabaseWriteError,
} from './scrapingError';
import type { ScrapingPhase } from '../types/progress';

export type ScrapingDiagnostic = {
    phase?: ScrapingPhase | 'database preflight';
    university?: string;
    owner?: string;
    repository?: string;
    field?: string;
    detail?: string;
    category: string;
    cancellationSource?: 'SIGINT' | 'SIGTERM' | 'caller';
    endpoint?: string;
    status?: number;
    requestId?: string;
    attempts?: number;
    retryStopReason?: string;
    retryAfterMs?: number;
    rateLimit?: {
        bucket: 'core' | 'search';
        classification: 'primary rate limit' | 'secondary rate limit';
        limit?: number;
        remaining?: number;
        resetAt?: number;
        retryAfterMs?: number;
    };
    rateLimitObservation?: GitHubRateLimitObservation;
    accessReason?: GitHubAccessReason;
    ssoStatus?: GitHubSsoStatus;
    search?: {
        reason: GitHubSearchFailureReason;
        endpointKind: 'repositories' | 'users';
        searchKind: 'repository' | 'organization' | 'user';
        stage: 'probe' | 'pagination' | 'partition-aggregation';
        expectedCount?: number;
        observedCount?: number;
        searchAttempts: number;
        maxSearchAttempts: number;
        retriesExhausted: boolean;
        remediationHint: string;
    };
    remediationHint?: string;
    blockReason?: 'tos' | 'github_contributors_size_limit';
    sqlState?: string;
    batchNumber?: number;
    batchSize?: number;
};

/** Project only allowlisted, bounded diagnostic values; never include error bodies or SQL text. */
export function projectScrapingDiagnostic(error: unknown): ScrapingDiagnostic {
    const chain = errorChain(error);
    const contexts = chain.filter(
        (item): item is ScrapingContextError =>
            item instanceof ScrapingContextError,
    );
    const diagnostic: ScrapingDiagnostic = { category: 'unexpected' };

    for (const contextError of [...contexts].reverse()) {
        const context = contextError.context;
        diagnostic.phase ??= context.phase;
        diagnostic.university ??= clean(context.university);
        diagnostic.owner ??= clean(context.owner);
        diagnostic.repository ??= clean(context.repository);
        diagnostic.detail ??= clean(context.detail);
    }

    const requestError = chain.find(
        (item): item is GitHubRequestError =>
            item instanceof GitHubRequestError,
    );
    const redirectError = chain.find(
        (item): item is GitHubRedirectError =>
            item instanceof GitHubRedirectError,
    );
    const networkError = chain.find(
        (item): item is GitHubNetworkError =>
            item instanceof GitHubNetworkError,
    );
    const parseError = chain.find(
        (item): item is GitHubResponseParseError =>
            item instanceof GitHubResponseParseError,
    );
    const validationError = chain.find(
        (item): item is RepositoryRecordValidationError =>
            item instanceof RepositoryRecordValidationError,
    );
    const repositorySkipError = chain.find(
        (item): item is RepositoryEnrichmentSkipError =>
            item instanceof RepositoryEnrichmentSkipError,
    );
    const databaseWriteError = chain.find(
        (item): item is ScrapingDatabaseWriteError =>
            item instanceof ScrapingDatabaseWriteError,
    );
    const preflightError = chain.find(
        (item): item is ScrapingDatabasePreflightError =>
            item instanceof ScrapingDatabasePreflightError,
    );
    const paginationError = chain.find(
        (item): item is GitHubPaginationError =>
            item instanceof GitHubPaginationError,
    );
    const searchError = chain.find(
        (item): item is GitHubSearchError => item instanceof GitHubSearchError,
    );

    if (chain.some((item) => item instanceof GitHubCredentialProviderError)) {
        diagnostic.category = 'credential-provider';
        diagnostic.remediationHint =
            'Check the GitHub App private key, App and installation IDs, and installation-token authorization.';
    } else if (requestError) {
        diagnostic.category =
            requestError.classification === 'other'
                ? fallbackHttpCategory(requestError.status)
                : requestError.classification;
        diagnostic.endpoint = sanitizeGitHubEndpoint(requestError.url);
        diagnostic.status = requestError.status;
        diagnostic.requestId = clean(requestError.requestId);
        diagnostic.attempts = requestError.attemptCount;
        diagnostic.retryStopReason = clean(requestError.retryStopReason);
        diagnostic.retryAfterMs = requestError.retryAfterMs;
        diagnostic.rateLimit = requestError.rateLimit;
        diagnostic.rateLimitObservation = requestError.rateLimitObservation;
        diagnostic.accessReason = requestError.accessReason;
        diagnostic.ssoStatus = requestError.ssoStatus;
        diagnostic.remediationHint =
            accessRemediationHint(requestError.accessReason) ??
            httpRemediationHint(requestError.status);
        diagnostic.blockReason =
            requestError.blockReason ??
            (isTermsOfServiceBlock(requestError.data) ? 'tos' : undefined);
    } else if (redirectError) {
        diagnostic.category = 'redirect';
        diagnostic.endpoint = sanitizeGitHubEndpoint(redirectError.url);
        diagnostic.status = redirectError.status;
        diagnostic.requestId = clean(redirectError.requestId);
        diagnostic.attempts = redirectError.attemptCount;
        diagnostic.retryStopReason = `redirect ${redirectError.reason}`;
    } else if (networkError) {
        diagnostic.category =
            networkError instanceof GitHubTimeoutError ? 'timeout' : 'network';
        diagnostic.endpoint = sanitizeGitHubEndpoint(networkError.url);
        diagnostic.attempts = networkError.attempts;
        diagnostic.retryStopReason = clean(networkError.retryStopReason);
    } else if (parseError) {
        diagnostic.category = 'invalid-json';
        diagnostic.endpoint = sanitizeGitHubEndpoint(parseError.url);
        diagnostic.status = parseError.status;
        diagnostic.attempts = parseError.attemptCount;
        diagnostic.requestId = clean(parseError.requestId);
        diagnostic.retryStopReason = 'invalid response body';
    } else if (validationError) {
        diagnostic.category = 'data-validation';
        diagnostic.repository ??= clean(validationError.repository);
        diagnostic.field = clean(validationError.field);
    } else if (repositorySkipError) {
        diagnostic.category =
            repositorySkipError.skippedRepository.reasonCode ===
            'github_legal_restriction'
                ? 'legal-restriction'
                : repositorySkipError.skippedRepository.reasonCode;
        diagnostic.repository ??= clean(
            repositorySkipError.skippedRepository.repositoryName,
        );
        diagnostic.endpoint = repositorySkipError.skippedRepository.endpoint;
        diagnostic.status = repositorySkipError.skippedRepository.status;
        diagnostic.requestId = clean(
            repositorySkipError.skippedRepository.requestId,
        );
        diagnostic.remediationHint = httpRemediationHint(
            repositorySkipError.skippedRepository.status,
        );
        diagnostic.blockReason =
            repositorySkipError.skippedRepository.reasonCode ===
            'github_tos_block'
                ? 'tos'
                : repositorySkipError.skippedRepository.reasonCode ===
                    'github_contributors_unavailable'
                  ? 'github_contributors_size_limit'
                  : undefined;
    } else if (databaseWriteError) {
        diagnostic.category = 'database-write';
        diagnostic.batchNumber = databaseWriteError.batchNumber;
        diagnostic.batchSize = databaseWriteError.batchSize;
        diagnostic.sqlState = safeSqlState(databaseWriteError.sqlState);
    } else if (preflightError) {
        diagnostic.phase = 'database preflight';
        diagnostic.category = `database-preflight-${preflightError.failure}`;
        diagnostic.sqlState = safeSqlState(preflightError.sqlState);
    } else if (searchError) {
        const remediationHint = searchRemediationHint(searchError.reason);
        diagnostic.category = 'incomplete-discovery';
        diagnostic.search = {
            reason: searchError.reason,
            endpointKind: searchError.endpointKind,
            searchKind: searchError.searchKind,
            stage: searchError.stage,
            ...(searchError.expectedCount === undefined
                ? {}
                : { expectedCount: searchError.expectedCount }),
            ...(searchError.observedCount === undefined
                ? {}
                : { observedCount: searchError.observedCount }),
            searchAttempts: searchError.searchAttempts,
            maxSearchAttempts: searchError.maxSearchAttempts,
            retriesExhausted: searchError.retriesExhausted,
            remediationHint,
        };
        diagnostic.remediationHint = remediationHint;
    } else if (paginationError) {
        diagnostic.category = 'incomplete-discovery';
    } else {
        const cancellation = findScrapingCancellation(error);
        if (cancellation) {
            diagnostic.category = 'interrupted';
            diagnostic.cancellationSource = cancellation.source;
        } else {
            const sqlState = findSqlState(chain);
            const leaf = [...chain]
                .reverse()
                .find((item) => !(item instanceof ScrapingContextError));
            if (sqlState) {
                diagnostic.category = 'database';
                diagnostic.sqlState = sqlState;
            } else if (leaf instanceof TypeError) {
                diagnostic.category = 'data-validation';
            } else if (leaf) {
                diagnostic.category = 'unexpected';
            }
        }
    }

    return diagnostic;
}

export function sanitizeGitHubEndpoint(value: string): string {
    try {
        const url = new URL(value);
        const pathname = clean(url.pathname) ?? '/';
        return `${url.protocol}//${url.host}${pathname}`;
    } catch {
        return '[endpoint unavailable]';
    }
}

export function formatScrapingDiagnostic(
    diagnostic: ScrapingDiagnostic,
): string {
    const context = [
        diagnostic.phase,
        diagnostic.university
            ? `university ${diagnostic.university}`
            : undefined,
        diagnostic.owner ? `owner ${diagnostic.owner}` : undefined,
        diagnostic.repository
            ? `repository ${diagnostic.repository}`
            : undefined,
        diagnostic.field ? `field ${diagnostic.field}` : undefined,
        diagnostic.detail,
    ]
        .filter((part): part is string => Boolean(part))
        .join(', ');
    const details = [
        diagnostic.category,
        diagnostic.cancellationSource
            ? `source ${diagnostic.cancellationSource}`
            : undefined,
        diagnostic.status === undefined
            ? undefined
            : `HTTP ${diagnostic.status}`,
        diagnostic.endpoint ? `GET ${diagnostic.endpoint}` : undefined,
        diagnostic.requestId ? `request ID ${diagnostic.requestId}` : undefined,
        diagnostic.attempts === undefined
            ? undefined
            : `${diagnostic.attempts} attempt${diagnostic.attempts === 1 ? '' : 's'}`,
        diagnostic.retryStopReason
            ? `retry stopped: ${diagnostic.retryStopReason}`
            : undefined,
        diagnostic.sqlState ? `SQLSTATE ${diagnostic.sqlState}` : undefined,
        diagnostic.batchNumber === undefined
            ? undefined
            : `batch ${diagnostic.batchNumber} (${diagnostic.batchSize ?? 0} records)`,
        diagnostic.blockReason
            ? `GitHub block reason ${diagnostic.blockReason}`
            : undefined,
        diagnostic.search
            ? `reason ${diagnostic.search.reason}; stage ${diagnostic.search.stage}${diagnostic.search.expectedCount === undefined ? '' : `; expected ${diagnostic.search.expectedCount}`}${diagnostic.search.observedCount === undefined ? '' : `; observed ${diagnostic.search.observedCount}`}; search attempts ${diagnostic.search.searchAttempts}/${diagnostic.search.maxSearchAttempts}${diagnostic.search.retriesExhausted ? '; retries exhausted' : ''}`
            : undefined,
        diagnostic.accessReason
            ? `access reason ${diagnostic.accessReason}`
            : undefined,
        diagnostic.ssoStatus ? `SSO status ${diagnostic.ssoStatus}` : undefined,
        diagnostic.rateLimit
            ? formatRateLimit(diagnostic.rateLimit)
            : undefined,
        diagnostic.rateLimitObservation
            ? formatRateLimitObservation(diagnostic.rateLimitObservation)
            : undefined,
        diagnostic.remediationHint,
        diagnostic.retryAfterMs === undefined
            ? undefined
            : `Retry-After ${diagnostic.retryAfterMs} ms`,
    ]
        .filter((part): part is string => part !== undefined)
        .join('; ');
    return [context, details].filter(Boolean).join(': ');
}

function formatRateLimit(
    rate: NonNullable<ScrapingDiagnostic['rateLimit']>,
): string {
    const quota =
        rate.limit === undefined && rate.remaining === undefined
            ? undefined
            : `${rate.remaining ?? '?'} remaining${rate.limit === undefined ? '' : ` of ${rate.limit}`}`;
    return [
        `${rate.bucket} bucket`,
        quota,
        rate.resetAt === undefined ? undefined : `reset ${rate.resetAt}`,
        rate.retryAfterMs === undefined
            ? undefined
            : `Retry-After ${rate.retryAfterMs} ms`,
    ]
        .filter((part): part is string => part !== undefined)
        .join(', ');
}

function formatRateLimitObservation(
    observation: GitHubRateLimitObservation,
): string {
    const quota =
        observation.limit === undefined && observation.remaining === undefined
            ? undefined
            : `${observation.remaining ?? '?'} remaining${observation.limit === undefined ? '' : ` of ${observation.limit}`}`;
    return [
        `${observation.bucket} quota observed`,
        quota,
        observation.resetAt === undefined
            ? undefined
            : `reset ${observation.resetAt}`,
        observation.retryAfterMs === undefined
            ? undefined
            : `Retry-After ${observation.retryAfterMs} ms`,
    ]
        .filter((part): part is string => part !== undefined)
        .join(', ');
}

function searchRemediationHint(reason: GitHubSearchFailureReason): string {
    switch (reason) {
        case 'incomplete-results':
            return 'The search restarted from its root; narrow or review the query if results remain incomplete.';
        case 'count-changed':
            return 'The search restarted from its root; retry later or narrow the query if counts keep changing.';
        case 'short-results':
            return 'The search restarted from its root; retry later or narrow the query if pagination remains short.';
        case 'invalid-search-metadata':
            return 'GitHub returned invalid completeness metadata; this failure is not retried.';
        case 'created-filter-conflict':
            return 'Remove the created: filter or narrow the custom query.';
        case 'single-second-overflow':
            return 'Narrow the query so no single second contains more than 1,000 matches.';
        case 'partition-limit':
            return 'Narrow the query; the cumulative partition probe limit was reached.';
        case 'pagination-cycle':
            return 'Retry later and check the GitHub search pagination response.';
        case 'page-limit':
            return 'Narrow the query; GitHub search pagination exceeded its page limit.';
    }
}

function accessRemediationHint(
    reason: GitHubAccessReason | undefined,
): string | undefined {
    switch (reason) {
        case 'sso-required':
            return 'Authorize the effective token for this organization’s SAML SSO requirement if the account requires it.';
        case 'token-resource-inaccessible':
            return 'Check the effective personal access token’s access to this resource and endpoint.';
        case 'integration-resource-inaccessible':
            return 'Check that the GitHub App installation includes this resource and can access the endpoint.';
        case 'unknown-forbidden':
            return 'Verify the effective token and organization access with --diagnose-github; the exact cause is unconfirmed.';
        default:
            return undefined;
    }
}

function errorChain(error: unknown): Error[] {
    const chain: Error[] = [];
    const visited = new Set<unknown>();
    let current: unknown = error;
    while (current instanceof Error && !visited.has(current)) {
        chain.push(current);
        visited.add(current);
        current = current.cause;
    }
    return chain;
}

function clean(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    return Array.from(value)
        .map((character) => {
            const code = character.charCodeAt(0);
            return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
                ? ' '
                : character;
        })
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1_000);
}

export function sanitizeDiagnosticText(value: string): string {
    return clean(value) ?? '';
}

function findSqlState(chain: readonly Error[]): string | undefined {
    for (const error of chain) {
        const code = (error as Error & { code?: unknown }).code;
        const sqlState = safeSqlState(code);
        if (sqlState) return sqlState;
    }
    return undefined;
}

function safeSqlState(value: unknown): string | undefined {
    return typeof value === 'string' && /^[0-9A-Z]{5}$/.test(value)
        ? value
        : undefined;
}

function fallbackHttpCategory(status: number): string {
    if (status === 401) return 'authentication';
    if (status === 403) return 'permission';
    if (status === 404) return 'not found';
    if (status === 400 || status === 422) return 'invalid-request';
    if (status === 409) return 'conflict';
    if (status === 410) return 'gone';
    if (status === 412) return 'precondition-failed';
    if (status === 451) return 'legal-restriction';
    if (status === 408) return 'request-timeout';
    if (status >= 500 && status <= 599) return 'server-error';
    if (status >= 300 && status <= 399) return 'unexpected-http-status';
    if (status === 202 || status === 204 || status === 304) {
        return 'unexpected-http-status';
    }
    if (status >= 400 && status <= 499) return 'unexpected-http-status';
    return 'other';
}

function httpRemediationHint(status: number): string | undefined {
    if (status === 400 || status === 422) {
        return 'Review the endpoint parameters and request context; the request was not rewritten automatically.';
    }
    if (status === 409) {
        return 'Review the conflicting resource state before retrying this request.';
    }
    if (status === 410) {
        return 'The requested resource is gone; verify that discovery still points to a current resource.';
    }
    if (status === 412) {
        return 'Review the request precondition and saved snapshot before retrying.';
    }
    if (status === 451) {
        return 'GitHub reports that this resource is unavailable for legal reasons; this response does not establish the specific legal basis.';
    }
    if (status === 202) {
        return 'This endpoint returned an asynchronous response that the finder does not support.';
    }
    if (status === 204) {
        return 'This endpoint returned no content outside a documented empty-result contract.';
    }
    if (status === 304) {
        return 'A not-modified response requires a conditional refresh request and a saved repository snapshot.';
    }
    if (status === 408 || status >= 500) {
        return 'Retry the collection later if the bounded request retry budget was exhausted.';
    }
    return undefined;
}

function isTermsOfServiceBlock(value: unknown): boolean {
    if (!isRecord(value) || !isRecord(value.block)) return false;
    return value.block.reason === 'tos';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
