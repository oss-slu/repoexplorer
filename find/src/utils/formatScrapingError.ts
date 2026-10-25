import {
    GitHubNetworkError,
    GitHubRequestError,
    GitHubResponseParseError,
    GitHubTimeoutError,
} from './githubRequest';
import { ScrapingContextError } from './scrapingError';

const SAFE_QUERY_PARAMETERS = [
    'page',
    'per_page',
    'q',
    'type',
    'sort',
    'direction',
] as const;

/** Format only allowlisted request diagnostics and typed scraping context. */
export function formatScrapingError(error: Error): string {
    const chain = errorChain(error);
    const contexts = chain
        .filter(
            (item): item is ScrapingContextError =>
                item instanceof ScrapingContextError,
        )
        .map((item) => item.context);
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

    const context = [
        ...new Set(
            contexts
                .flatMap((item) => [
                    item.phase,
                    item.university
                        ? `university ${item.university}`
                        : undefined,
                    item.owner ? `owner ${item.owner}` : undefined,
                    item.repository
                        ? `repository ${item.repository}`
                        : undefined,
                    item.detail,
                ])
                .filter((part): part is string => part !== undefined)
                .map(sanitizeTerminalText),
        ),
    ].join(', ');

    const details = requestError
        ? formatGitHubRequestError(requestError)
        : networkError
          ? formatNetworkError(networkError)
          : parseError
            ? `GitHub returned invalid JSON (HTTP ${parseError.status}); GET ${sanitizeGitHubEndpoint(parseError.url)}; ${parseError.attemptCount} attempt${parseError.attemptCount === 1 ? '' : 's'}; retry stopped: invalid response body`
            : safeLeafMessage(chain);
    return [context, details].filter(Boolean).join(': ');
}

function formatNetworkError(error: GitHubNetworkError): string {
    const timeout =
        error instanceof GitHubTimeoutError
            ? ` timed out after ${error.timeoutMs} ms`
            : ' failed';
    return `GitHub network request${timeout}; GET ${sanitizeGitHubEndpoint(error.url)}; ${error.attempts} attempt${error.attempts === 1 ? '' : 's'}; retry stopped: ${sanitizeTerminalText(error.retryStopReason)}`;
}

function formatGitHubRequestError(error: GitHubRequestError): string {
    const category =
        error.classification === 'primary rate limit'
            ? 'primary rate limit exhausted'
            : error.classification === 'secondary rate limit'
              ? 'secondary rate limit reached'
              : error.classification === 'authentication'
                ? 'authentication failed'
                : error.classification === 'permission'
                  ? 'permission denied'
                  : error.classification === 'not found'
                    ? 'resource not found'
                    : 'request failed';
    const parts = [
        `GitHub ${category} (HTTP ${error.status})`,
                `${sanitizeTerminalText(error.method)} ${sanitizeGitHubEndpoint(error.url)}`,
    ];

    if (error.requestId) {
        parts.push(`request ID ${sanitizeTerminalText(error.requestId)}`);
    }
    if (error.rateLimit) {
        const rate = error.rateLimit;
        const quota =
            rate.limit === undefined && rate.remaining === undefined
                ? undefined
                : `${rate.remaining ?? '?'} remaining${rate.limit === undefined ? '' : ` of ${rate.limit}`}`;
        parts.push(
            [
                `${rate.bucket} bucket`,
                quota,
                rate.resetAt === undefined
                    ? undefined
                    : `reset ${formatResetAt(rate.resetAt)}`,
                rate.retryAfterMs === undefined
                    ? undefined
                    : `Retry-After ${formatDuration(rate.retryAfterMs)}`,
            ]
                .filter((part): part is string => part !== undefined)
                .join(', '),
        );
    }
    parts.push(
        `${error.attemptCount} attempt${error.attemptCount === 1 ? '' : 's'}`,
    );
    if (error.retryStopReason) {
        parts.push(
            `retry stopped: ${sanitizeTerminalText(error.retryStopReason)}`,
        );
    }
    return parts.join('; ');
}

export function sanitizeGitHubEndpoint(value: string): string {
    try {
        const url = new URL(value);
        const query = new URLSearchParams();
        for (const key of SAFE_QUERY_PARAMETERS) {
            for (const item of url.searchParams.getAll(key)) {
                query.append(key, sanitizeTerminalText(item));
            }
        }
        const pathname = sanitizeTerminalText(url.pathname);
        return `${url.protocol}//${url.host}${pathname}${query.size ? `?${query.toString()}` : ''}`;
    } catch {
        return '[endpoint unavailable]';
    }
}

function errorChain(error: Error): Error[] {
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

function safeLeafMessage(chain: readonly Error[]): string {
    const leaf = [...chain]
        .reverse()
        .find((item) => !(item instanceof ScrapingContextError));
    return sanitizeTerminalText(leaf?.message ?? 'Unknown scraping failure');
}

function sanitizeTerminalText(value: string): string {
    // Filter control characters so GitHub supplied text cannot alter terminal output.
    const withoutControls = Array.from(value)
        .map((character) => {
            const code = character.charCodeAt(0);
            return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
                ? ' '
                : character;
        })
        .join('');
    return withoutControls.replace(/\s+/g, ' ').trim().slice(0, 1_000);
}

function formatDuration(milliseconds: number): string {
    const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatResetAt(seconds: number): string {
    const milliseconds = seconds * 1_000;
    if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8.64e15) {
        return `${seconds} epoch seconds`;
    }
    return new Date(milliseconds).toISOString();
}
