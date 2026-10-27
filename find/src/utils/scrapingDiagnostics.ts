import {
    GitHubNetworkError,
    GitHubRequestError,
    GitHubResponseParseError,
    GitHubTimeoutError,
} from './githubRequest';
import { GitHubPaginationError } from './githubPagination';
import {
    RepositoryRecordValidationError,
    RepositoryEnrichmentSkipError,
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
    endpoint?: string;
    status?: number;
    requestId?: string;
    attempts?: number;
    retryStopReason?: string;
    rateLimit?: {
        bucket: 'core' | 'search';
        classification: 'primary rate limit' | 'secondary rate limit';
        limit?: number;
        remaining?: number;
        resetAt?: number;
        retryAfterMs?: number;
    };
    blockReason?: 'tos';
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

    if (requestError) {
        diagnostic.category =
            requestError.classification === 'other'
                ? fallbackHttpCategory(requestError.status)
                : requestError.classification;
        diagnostic.endpoint = sanitizeGitHubEndpoint(requestError.url);
        diagnostic.status = requestError.status;
        diagnostic.requestId = clean(requestError.requestId);
        diagnostic.attempts = requestError.attemptCount;
        diagnostic.retryStopReason = clean(requestError.retryStopReason);
        diagnostic.rateLimit = requestError.rateLimit;
        if (isTermsOfServiceBlock(requestError.data)) {
            diagnostic.blockReason = 'tos';
        }
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
        diagnostic.category = repositorySkipError.skippedRepository.reasonCode;
        diagnostic.repository ??= clean(
            repositorySkipError.skippedRepository.repositoryName,
        );
        diagnostic.endpoint = repositorySkipError.skippedRepository.endpoint;
        diagnostic.status = repositorySkipError.skippedRepository.status;
        diagnostic.blockReason =
            repositorySkipError.skippedRepository.reasonCode ===
            'github_tos_block'
                ? 'tos'
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
    } else if (paginationError) {
        diagnostic.category = 'incomplete-discovery';
    } else {
        const sqlState = findSqlState(chain);
        const leaf = [...chain].reverse().find(
            (item) => !(item instanceof ScrapingContextError),
        );
        if (sqlState) {
            diagnostic.category = 'database';
            diagnostic.sqlState = sqlState;
        } else if (leaf instanceof TypeError) {
            diagnostic.category = 'data-validation';
        } else if (leaf) {
            diagnostic.category = 'unexpected';
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
        diagnostic.status === undefined
            ? undefined
            : `HTTP ${diagnostic.status}`,
        diagnostic.endpoint ? `GET ${diagnostic.endpoint}` : undefined,
        diagnostic.requestId
            ? `request ID ${diagnostic.requestId}`
            : undefined,
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
        diagnostic.rateLimit
            ? formatRateLimit(diagnostic.rateLimit)
            : undefined,
    ]
        .filter((part): part is string => part !== undefined)
        .join('; ');
    return [context, details].filter(Boolean).join(': ');
}

function formatRateLimit(rate: NonNullable<ScrapingDiagnostic['rateLimit']>): string {
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
    return 'other';
}

function isTermsOfServiceBlock(value: unknown): boolean {
    if (!isRecord(value) || !isRecord(value.block)) return false;
    return value.block.reason === 'tos';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
