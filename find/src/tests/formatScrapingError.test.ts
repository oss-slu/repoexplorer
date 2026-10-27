import { formatScrapingError } from '../utils/formatScrapingError';
import { GitHubRequestError } from '../utils/githubRequest';
import {
    RepositoryRecordValidationError,
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
    expect(formatted).toContain('GitHub primary rate limit exhausted; HTTP 403');
    expect(formatted).toContain('search bucket, 0 remaining of 30');
    expect(formatted).toContain('request ID ABC-123');
    expect(formatted).toContain('5 attempts');
    expect(formatted).toContain(
        'retry stopped: rate-limit recovery budget exhausted',
    );
    expect(formatted).not.toContain('secret');
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
    const databaseError = Object.assign(new Error('private row and bind value'), {
        code: '22021',
        detail: 'private database detail',
    });
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
