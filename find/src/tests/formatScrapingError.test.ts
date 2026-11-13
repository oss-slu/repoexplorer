import { formatScrapingError } from '../utils/formatScrapingError';
import {
    GitHubRedirectError,
    GitHubRequestError,
} from '../utils/githubRequest';
import { GitHubSearchError } from '../utils/githubPagination';
import {
    RepositoryRecordValidationError,
    ScrapingCancellationError,
    ScrapingDatabaseWriteError,
    withScrapingContext,
} from '../utils/scrapingError';

test('reports endpoint and attempts without credentials, headers, or response data', () => {
    const error = new GitHubRequestError(
        'untrusted-secret-message',
        404,
        { token: 'body-secret' },
        new Headers({ authorization: 'header-secret' }),
        'https://user:password@api.github.com/users/missing-owner/repos?page=2&per_page=100&access_token=query-secret',
        { attemptCount: 2, retryStopReason: 'request is not retryable' },
    );
    expect(formatScrapingError(error)).toBe(
        'GitHub resource not found; HTTP 404; GET https://api.github.com/users/missing-owner/repos; 2 attempts; retry stopped: request is not retryable',
    );
    for (const secret of [
        'password',
        'query-secret',
        'header-secret',
        'body-secret',
        'untrusted-secret-message',
    ]) {
        expect(formatScrapingError(error)).not.toContain(secret);
    }
});

test('reports the stable contributor-size block reason without the private response message', () => {
    const error = new GitHubRequestError(
        'private response message',
        403,
        {
            message:
                'The history or contributor list is too large to list contributors for this repository via the API.',
        },
        new Headers(),
        'https://api.github.com/repos/slu/project/contributors?per_page=100',
        {
            classification: 'permission',
            accessReason: 'unknown-forbidden',
            blockReason: 'github_contributors_size_limit',
        },
    );

    expect(formatScrapingError(error)).toContain(
        'GitHub block reason github_contributors_size_limit',
    );
    expect(formatScrapingError(error)).not.toContain(
        'history or contributor list',
    );
});

test.each([
    [400, 'GitHub request was invalid'],
    [422, 'GitHub request was invalid'],
    [409, 'GitHub reported a conflict'],
    [410, 'GitHub resource is gone'],
    [412, 'GitHub request precondition failed'],
    [451, 'GitHub reports legal unavailability'],
    [202, 'GitHub returned an unexpected HTTP status'],
    [204, 'GitHub returned an unexpected HTTP status'],
    [304, 'GitHub returned an unexpected HTTP status'],
] as const)('uses a static diagnostic label for HTTP %s', (status, label) => {
    const error = new GitHubRequestError(
        'private message must not appear',
        status,
        { message: 'private response body' },
        new Headers(),
        'https://api.github.com/repos/octo-org/repo?token=query-secret',
        { requestId: 'REQ-STATIC', retryAfterMs: 2_500 },
    );
    const formatted = formatScrapingError(error);

    expect(formatted).toContain(label);
    expect(formatted).toContain(`HTTP ${status}`);
    expect(formatted).toContain('request ID REQ-STATIC');
    expect(formatted).toContain('Retry-After 2500 ms');
    expect(formatted).not.toContain('private');
    expect(formatted).not.toContain('query-secret');
    if (status === 451) {
        expect(formatted).toContain('specific legal basis');
        expect(formatted).not.toContain('GitHub block reason tos');
    }
});

test('formats redirect failures without exposing a Location query string', () => {
    const error = new GitHubRedirectError(
        302,
        'https://api.github.com/repos/octo-org/repo?source=original',
        'cross-origin',
        1,
        'REDIR-123',
    );
    const formatted = formatScrapingError(error);

    expect(formatted).toContain('GitHub API redirect rejected');
    expect(formatted).toContain('HTTP 302');
    expect(formatted).toContain('request ID REDIR-123');
    expect(formatted).toContain('redirect cross-origin');
    expect(formatted).not.toContain('source=original');
});

test('retains safe search context and adds typed phase and owner context', () => {
    const request = new GitHubRequestError(
        'untrusted message',
        403,
        { message: 'secret body' },
        new Headers({ 'x-github-request-id': 'secret-header' }),
        'https://api.github.com/search/users?q=SLU&type=user',
        {
            classification: 'primary rate limit',
            requestId: 'ABC-123',
            attemptCount: 5,
            retryStopReason: 'rate-limit recovery budget exhausted',
            rateLimit: {
                bucket: 'search',
                classification: 'primary rate limit',
                limit: 30,
                remaining: 0,
                resetAt: 1_800_000_000,
                retryAfterMs: 4_000,
            },
        },
    );
    const error = withScrapingContext(
        withScrapingContext(request, {
            phase: 'search',
            owner: 'Organization slu-team',
        }),
        { phase: 'search', university: 'Saint Louis\nUniversity' },
    );
    const formatted = formatScrapingError(error);
    expect(formatted).toContain('search, university Saint Louis University');
    expect(formatted).toContain('owner Organization slu-team');
    expect(formatted).toContain(
        'GitHub primary rate limit exhausted; HTTP 403',
    );
    expect(formatted).toContain('search bucket, 0 remaining of 30');
    expect(formatted).toContain('request ID ABC-123');
    expect(formatted).toContain('5 attempts');
    expect(formatted).toContain(
        'retry stopped: rate-limit recovery budget exhausted',
    );
    expect(formatted).not.toContain('secret');
});

test('formats structured search recovery outcomes without query text', () => {
    const error = withScrapingContext(
        new GitHubSearchError({
            reason: 'incomplete-results',
            endpointKind: 'repositories',
            searchKind: 'repository',
            stage: 'pagination',
            expectedCount: 800,
            observedCount: 790,
            searchAttempts: 3,
            maxSearchAttempts: 3,
            retriesExhausted: true,
        }),
        {
            phase: 'search',
            university: 'Saint Louis University',
            detail: 'repository search',
        },
    );
    const formatted = formatScrapingError(error);
    expect(formatted).toContain('repository search: incomplete-discovery');
    expect(formatted).toContain('reason incomplete-results');
    expect(formatted).toContain('stage pagination');
    expect(formatted).toContain('expected 800; observed 790');
    expect(formatted).toContain('search attempts 3/3; retries exhausted');
    expect(formatted).toContain('narrow or review the query');
    expect(formatted).not.toContain('secret search phrase');
});

test('formats unknown 403 evidence without claiming a missing permission', () => {
    const error = new GitHubRequestError(
        'response body must not be exposed',
        403,
        { message: 'body-secret' },
        new Headers({
            'x-github-sso': 'required; url=https://sso.invalid/secret',
        }),
        'https://api.github.com/orgs/oss-slu/repos?page=1&token=query-secret',
        {
            classification: 'permission',
            requestId: 'REQ-123',
            accessReason: 'unknown-forbidden',
            rateLimitObservation: {
                bucket: 'core',
                limit: 5_000,
                remaining: 100,
                resetAt: 1_800_000_000,
                retryAfterMs: 2_000,
            },
        },
    );
    const formatted = formatScrapingError(error);
    expect(formatted).toContain(
        'GitHub access forbidden; exact reason unconfirmed',
    );
    expect(formatted).toContain('access reason unknown-forbidden');
    expect(formatted).toContain('core quota observed, 100 remaining of 5000');
    expect(formatted).toContain('--diagnose-github');
    for (const secret of [
        'body-secret',
        'sso.invalid',
        'query-secret',
        'response body must not be exposed',
    ]) {
        expect(formatted).not.toContain(secret);
    }
});

test.each([
    ['SIGINT', 'scraping interrupted by SIGINT'],
    ['SIGTERM', 'scraping interrupted by SIGTERM'],
    ['caller', 'scraping cancelled by caller'],
] as const)('formats %s cancellation as interruption without caller text', (source, label) => {
    const cancellation = new ScrapingCancellationError(source);
    const wrapped = withScrapingContext(
        new Error('private wrapper', { cause: cancellation }),
        {
            phase: 'enrichment',
            university: 'University One',
            repository: 'owner/repository',
        },
    );
    const formatted = formatScrapingError(wrapped);

    expect(formatted).toContain('enrichment, university University One');
    expect(formatted).toContain('repository owner/repository');
    expect(formatted).toContain(label);
    expect(formatted).not.toContain('private wrapper');
});

test('distinguishes authentication, permission, and secondary rate limit failures', () => {
    const error = (
        status: number,
        classification:
            'authentication' | 'permission' | 'secondary rate limit',
    ) =>
        new GitHubRequestError(
            'body is not shown',
            status,
            {},
            new Headers(),
            'https://api.github.com/repos/o/r',
            { classification },
        );
    expect(formatScrapingError(error(401, 'authentication'))).toContain(
        'authentication failed',
    );
    expect(formatScrapingError(error(403, 'permission'))).toContain(
        'permission denied',
    );
    expect(formatScrapingError(error(429, 'secondary rate limit'))).toContain(
        'secondary rate limit reached',
    );
});

test('handles malformed URLs and terminal controls without throwing', () => {
    const malformed = new GitHubRequestError(
        'Database unavailable\u001b[2K',
        500,
        null,
        new Headers(),
        'not a URL\u001b[2K',
    );
    expect(formatScrapingError(malformed)).toContain(
        'GET [endpoint unavailable]',
    );
    expect(formatScrapingError(new Error('Database\n unavailable'))).toBe(
        'unexpected scraping error',
    );
});

test('projects safe SQLSTATE and batch context without database details', () => {
    const databaseError = Object.assign(
        new Error('private row and bind value'),
        {
            code: '22021',
            detail: 'private database detail',
        },
    );
    const error = withScrapingContext(
        new ScrapingDatabaseWriteError(4, 16, '22021', {
            cause: databaseError,
        }),
        { phase: 'database write', university: 'University' },
    );
    const formatted = formatScrapingError(error);
    expect(formatted).toContain('database write, university University');
    expect(formatted).toContain('SQLSTATE 22021');
    expect(formatted).toContain('batch 4 (16 records)');
    expect(formatted).not.toContain('private');
});

test('projects repository and field for validation errors without content', () => {
    const error = new RepositoryRecordValidationError(
        'owner/repository',
        'readme',
        'raw text content must not appear in diagnostics',
    );
    const formatted = formatScrapingError(error);
    expect(formatted).toBe(
        'repository owner/repository, field readme: repository data validation failed',
    );
    expect(formatted).not.toContain('raw text content');
});

test('walks cyclic cause chains without throwing and keeps phase context', () => {
    const error = new Error('untrusted cyclic message');
    (error as Error & { cause?: unknown }).cause = error;
    const formatted = formatScrapingError(
        withScrapingContext(error, {
            phase: 'enrichment',
            university: 'University',
        }),
    );
    expect(formatted).toBe(
        'enrichment, university University: unexpected scraping error',
    );
    expect(formatted).not.toContain('untrusted');
});
