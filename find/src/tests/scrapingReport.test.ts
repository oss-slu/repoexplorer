import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitHubRequestError } from '../utils/githubRequest';
import { GitHubSearchError } from '../utils/githubPagination';
import { formatScrapingDiagnostic } from '../utils/scrapingDiagnostics';
import {
    ScrapingCancellationError,
    ScrapingDatabaseWriteError,
    withScrapingContext,
} from '../utils/scrapingError';
import {
    createScrapingReport,
    writeScrapingReport,
} from '../utils/scrapingReport';
import type {
    ScrapeUniversityFailure,
    ScrapingRunResult,
    SkippedOwner,
    SkippedRepository,
    ScrapingWarning,
} from '../types/scraping';

const sensitiveSkippedOwner: SkippedOwner = {
    university: 'University',
    login: 'awsslu',
    ownerType: 'Organization',
    endpoint:
        'https://report-user:report-password@api.github.com/orgs/awsslu/repos?page=2&access_token=query-secret&per_page=100',
    status: 404,
    reason: 'This caller-supplied reason is replaced with a safe fixed description.',
};

const sensitiveSkippedRepository: SkippedRepository = {
    university: 'Failed University',
    repositoryId: 77,
    repositoryName: 'failed/private-repo',
    endpoint:
        'https://repo-user:repo-password@api.github.com/repos/failed/private-repo?access_token=repo-token',
    status: 403,
    reasonCode: 'github_tos_block',
    requestId: 'REQ-REPORT',
    reason: 'untrusted reason text',
};

const contributorSizeSkippedRepository: SkippedRepository = {
    university: 'Failed University',
    repositoryId: 78,
    repositoryName: 'failed/large-history',
    endpoint:
        'https://api.github.com/repos/failed/large-history/contributors?per_page=100&access_token=query-secret',
    status: 403,
    reasonCode: 'github_contributors_unavailable',
    requestId: 'REQ-SIZE-LIMIT',
    reason: 'untrusted reason text',
};

const safeWarning: ScrapingWarning = {
    university: 'Failed University',
    repositoryId: 77,
    repositoryName: 'failed/private-repo',
    field: 'readme',
    replacementCount: 2,
    code: 'nul_replaced',
};

function reportResult(): ScrapingRunResult {
    const requestError = new GitHubRequestError(
        'response body must not be stored',
        403,
        { message: 'private-response-secret' },
        new Headers({ authorization: 'header-secret' }),
        'https://url-user:url-password@api.github.com/orgs/failed/repos?access_token=endpoint-secret',
    );
    const failure: ScrapeUniversityFailure = {
        status: 'failed',
        university: 'Failed University',
        discovered: 0,
        error: requestError,
        skippedOwners: [sensitiveSkippedOwner],
        skippedRepositories: [
            sensitiveSkippedRepository,
            contributorSizeSkippedRepository,
        ],
        warnings: [safeWarning],
    };
    const partial = {
        status: 'partial' as const,
        university: 'University',
        discovered: 0,
        committed: 0,
        skippedOwners: [sensitiveSkippedOwner],
        skippedRepositories: [],
        warnings: [],
    };
    return {
        elapsedMs: 0,
        universitiesProcessed: 2,
        committed: 0,
        failed: 1,
        interrupted: 0,
        partial: 1,
        results: [partial],
        failures: [failure],
        outcomes: [partial, failure],
    };
}

test('writes a machine-readable report with outcomes, counts, and sanitized owner and error details', async () => {
    const directory = await mkdtemp(
        path.join(tmpdir(), 'repoexplorer-report-'),
    );
    try {
        const report = createScrapingReport({
            startedAt: new Date('2026-10-24T10:00:00.000Z'),
            finishedAt: new Date('2026-10-24T10:02:00.000Z'),
            policy: 'best-effort',
            universityCount: 2,
            result: reportResult(),
        });
        const reportPath = await writeScrapingReport(report, directory);
        const contents = await readFile(reportPath, 'utf8');
        const parsed = JSON.parse(contents) as typeof report;

        expect(parsed).toMatchObject({
            schemaVersion: 3,
            startedAt: '2026-10-24T10:00:00.000Z',
            finishedAt: '2026-10-24T10:02:00.000Z',
            policy: 'best-effort',
            summary: {
                universitiesConfigured: 2,
                partialUniversities: 1,
                failedUniversities: 1,
                interruptedUniversities: 0,
                committedAssociations: 0,
                skippedOwners: 2,
                skippedRepositories: 2,
                textWarnings: 1,
                nulReplacements: 2,
            },
            universities: [
                {
                    university: 'University',
                    status: 'partial',
                    discoveredRepositories: 0,
                    committedAssociations: 0,
                    skippedOwners: [
                        {
                            login: 'awsslu',
                            ownerType: 'Organization',
                            endpoint:
                                'https://api.github.com/orgs/awsslu/repos',
                            status: 404,
                        },
                    ],
                },
                {
                    university: 'Failed University',
                    status: 'failed',
                    committedAssociations: 0,
                    failureReason: expect.stringContaining('HTTP 403'),
                    skippedRepositories: [
                        {
                            repositoryId: 77,
                            repositoryName: 'failed/private-repo',
                            endpoint:
                                'https://api.github.com/repos/failed/private-repo',
                            status: 403,
                            reasonCode: 'github_tos_block',
                            requestId: 'REQ-REPORT',
                        },
                        {
                            repositoryId: 78,
                            repositoryName: 'failed/large-history',
                            endpoint:
                                'https://api.github.com/repos/failed/large-history/contributors',
                            status: 403,
                            reasonCode: 'github_contributors_unavailable',
                            requestId: 'REQ-SIZE-LIMIT',
                        },
                    ],
                    warnings: [
                        {
                            field: 'readme',
                            replacementCount: 2,
                            code: 'nul_replaced',
                        },
                    ],
                    diagnostics: {
                        category: 'permission',
                        status: 403,
                        endpoint: 'https://api.github.com/orgs/failed/repos',
                    },
                },
            ],
        });
        expect(parsed.universities[1].skippedRepositories[0].requestId).toBe(
            'REQ-REPORT',
        );
        expect(parsed.universities[1].skippedRepositories[1]).toMatchObject({
            reasonCode: 'github_contributors_unavailable',
            reason: 'GitHub contributor history exceeds the REST API listing limit.',
            requestId: 'REQ-SIZE-LIMIT',
        });
        expect(contents).not.toContain('report-user');
        expect(contents).not.toContain('report-password');
        expect(contents).not.toContain('query-secret');
        expect(contents).not.toContain('url-user');
        expect(contents).not.toContain('url-password');
        expect(contents).not.toContain('endpoint-secret');
        expect(contents).not.toContain('header-secret');
        expect(contents).not.toContain('private-response-secret');
        expect(contents).not.toContain('response body must not be stored');
        expect(contents).not.toContain('repo-user');
        expect(contents).not.toContain('repo-password');
        expect(contents).not.toContain('repo-token');
        expect(contents).not.toContain('untrusted reason text');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('schema v3 reports interruption separately from failure and not-run outcomes', () => {
    const cancellation = new ScrapingCancellationError('SIGTERM');
    const interrupted = {
        status: 'interrupted' as const,
        university: 'Interrupted University',
        discovered: 12,
        cancellationSource: cancellation.source,
        phase: 'enrichment' as const,
        repository: 'safe-owner/in-flight',
        skippedOwners: [sensitiveSkippedOwner],
        skippedRepositories: [sensitiveSkippedRepository],
        warnings: [safeWarning],
    };
    const report = createScrapingReport({
        startedAt: new Date('2026-10-28T18:00:00.000Z'),
        finishedAt: new Date('2026-10-28T18:01:00.000Z'),
        policy: 'best-effort',
        universityCount: 3,
        result: {
            elapsedMs: 60_000,
            universitiesProcessed: 1,
            committed: 0,
            failed: 0,
            interrupted: 1,
            partial: 0,
            results: [],
            failures: [],
            outcomes: [
                interrupted,
                { status: 'not_run', university: 'Later University' },
                { status: 'not_run', university: 'Last University' },
            ],
        },
    });
    const contents = JSON.stringify(report);

    expect(report.schemaVersion).toBe(3);
    expect(report.summary).toMatchObject({
        universitiesConfigured: 3,
        completeUniversities: 0,
        partialUniversities: 0,
        failedUniversities: 0,
        interruptedUniversities: 1,
        notRunUniversities: 2,
        skippedOwners: 1,
        skippedRepositories: 1,
        textWarnings: 1,
    });
    expect(
        report.summary.completeUniversities +
            report.summary.partialUniversities +
            report.summary.failedUniversities +
            report.summary.interruptedUniversities +
            report.summary.notRunUniversities,
    ).toBe(report.summary.universitiesConfigured);
    expect(report.universities[0]).toMatchObject({
        status: 'interrupted',
        discoveredRepositories: 12,
        committedAssociations: 0,
        diagnostics: {
            category: 'interrupted',
            cancellationSource: 'SIGTERM',
            phase: 'enrichment',
            repository: 'safe-owner/in-flight',
        },
    });
    expect(contents).not.toContain('private caller reason');
    expect(contents).not.toContain('repo-password');
});

test('reports legal skips with a static reason and preserves the safe request ID', () => {
    const legalSkip: SkippedRepository = {
        university: 'University',
        repositoryId: 451,
        repositoryName: 'owner/unavailable',
        endpoint: 'https://api.github.com/repos/owner/unavailable/readme',
        status: 451,
        reasonCode: 'github_legal_restriction',
        requestId: 'LEGAL-451',
        reason: 'caller supplied reason must be replaced',
    };
    const partial = {
        status: 'partial' as const,
        university: 'University',
        discovered: 1,
        committed: 0,
        skippedOwners: [],
        skippedRepositories: [legalSkip],
        warnings: [],
    };
    const report = createScrapingReport({
        startedAt: new Date('2026-10-27T10:00:00.000Z'),
        finishedAt: new Date('2026-10-27T10:01:00.000Z'),
        policy: 'best-effort',
        universityCount: 1,
        result: {
            elapsedMs: 0,
            universitiesProcessed: 1,
            committed: 0,
            failed: 0,
            interrupted: 0,
            partial: 1,
            results: [partial],
            failures: [],
            outcomes: [partial],
        },
    });
    const skipped = report.universities[0].skippedRepositories[0];

    expect(skipped).toMatchObject({
        status: 451,
        reasonCode: 'github_legal_restriction',
        requestId: 'LEGAL-451',
        reason: 'GitHub returned HTTP 451: repository access is unavailable for legal reasons.',
    });
    expect(JSON.stringify(skipped)).not.toContain('caller supplied reason');
    expect(JSON.stringify(skipped)).not.toContain('Terms of Service');
    expect(report.summary).toMatchObject({
        partialUniversities: 1,
        skippedRepositories: 1,
        committedAssociations: 0,
    });
});

test('surfaces report-writing failures to the caller', async () => {
    const directory = await mkdtemp(
        path.join(tmpdir(), 'repoexplorer-report-'),
    );
    const filePath = path.join(directory, 'not-a-directory');
    await writeFile(filePath, 'block mkdir');
    const report = createScrapingReport({
        startedAt: new Date('2026-10-24T10:00:00.000Z'),
        finishedAt: new Date('2026-10-24T10:02:00.000Z'),
        policy: 'strict',
        universityCount: 0,
        result: {
            elapsedMs: 0,
            universitiesProcessed: 0,
            committed: 0,
            failed: 0,
            interrupted: 0,
            partial: 0,
            results: [],
            failures: [],
            outcomes: [],
        },
    });

    try {
        await expect(writeScrapingReport(report, filePath)).rejects.toThrow();
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('serializes additive search and access diagnostics without private evidence', () => {
    const searchError = withScrapingContext(
        new GitHubSearchError({
            reason: 'count-changed',
            endpointKind: 'repositories',
            searchKind: 'repository',
            stage: 'partition-aggregation',
            expectedCount: 1_001,
            observedCount: 1_000,
            searchAttempts: 3,
            maxSearchAttempts: 3,
            retriesExhausted: true,
        }),
        {
            phase: 'search',
            university: 'Search University',
            detail: 'repository search',
        },
    );
    const accessError = new GitHubRequestError(
        'private response body',
        403,
        { message: 'private response body', token: 'response-secret' },
        new Headers({
            'x-github-sso':
                'required; url=https://github.com/authorize?secret=sso-url-secret',
            authorization: 'header-secret',
        }),
        'https://api.github.com/orgs/oss-slu/repos?access_token=query-secret',
        {
            classification: 'permission',
            accessReason: 'sso-required',
            ssoStatus: 'required',
            requestId: 'REQ-123',
            rateLimitObservation: {
                bucket: 'core',
                limit: 5_000,
                remaining: 80,
                resetAt: 1_800_000_000,
                retryAfterMs: 1_000,
            },
        },
    );
    const report = createScrapingReport({
        startedAt: new Date('2026-10-27T10:00:00.000Z'),
        finishedAt: new Date('2026-10-27T10:01:00.000Z'),
        policy: 'best-effort',
        universityCount: 2,
        result: {
            elapsedMs: 0,
            universitiesProcessed: 2,
            committed: 0,
            failed: 2,
            interrupted: 0,
            partial: 0,
            results: [],
            failures: [
                {
                    status: 'failed',
                    university: 'Search University',
                    discovered: 0,
                    error: searchError,
                    skippedOwners: [],
                    skippedRepositories: [],
                    warnings: [],
                },
                {
                    status: 'failed',
                    university: 'Access University',
                    discovered: 0,
                    error: accessError,
                    skippedOwners: [],
                    skippedRepositories: [],
                    warnings: [],
                },
            ],
            outcomes: [
                {
                    status: 'failed',
                    university: 'Search University',
                    discovered: 0,
                    error: searchError,
                    skippedOwners: [],
                    skippedRepositories: [],
                    warnings: [],
                },
                {
                    status: 'failed',
                    university: 'Access University',
                    discovered: 0,
                    error: accessError,
                    skippedOwners: [],
                    skippedRepositories: [],
                    warnings: [],
                },
            ],
        },
    });
    const contents = JSON.stringify(report);

    expect(report.schemaVersion).toBe(3);
    expect(report.universities[0]).toMatchObject({
        failureReason: formatScrapingDiagnostic(
            report.universities[0].diagnostics!,
        ),
        diagnostics: {
            category: 'incomplete-discovery',
            search: {
                reason: 'count-changed',
                stage: 'partition-aggregation',
                expectedCount: 1_001,
                observedCount: 1_000,
                searchAttempts: 3,
                maxSearchAttempts: 3,
                retriesExhausted: true,
            },
        },
    });
    expect(report.universities[1].diagnostics).toMatchObject({
        accessReason: 'sso-required',
        ssoStatus: 'required',
        rateLimitObservation: {
            bucket: 'core',
            limit: 5_000,
            remaining: 80,
        },
    });
    for (const secret of [
        'private response body',
        'response-secret',
        'header-secret',
        'sso-url-secret',
        'query-secret',
    ]) {
        expect(contents).not.toContain(secret);
    }
});

test('reports database batch diagnostics without SQL values or PostgreSQL details', () => {
    const databaseError = Object.assign(
        new Error('private bind value and row text'),
        { code: '22021', detail: 'private postgres detail' },
    );
    const failure: ScrapeUniversityFailure = {
        status: 'failed',
        university: 'Failed University',
        discovered: 6,
        error: withScrapingContext(
            new ScrapingDatabaseWriteError(3, 2, '22021', {
                cause: databaseError,
            }),
            { phase: 'database write', university: 'Failed University' },
        ),
        skippedOwners: [],
        skippedRepositories: [],
        warnings: [],
    };
    const report = createScrapingReport({
        startedAt: new Date('2026-10-24T10:00:00.000Z'),
        finishedAt: new Date('2026-10-24T10:02:00.000Z'),
        policy: 'best-effort',
        universityCount: 1,
        result: {
            elapsedMs: 120_000,
            universitiesProcessed: 1,
            committed: 0,
            failed: 1,
            interrupted: 0,
            partial: 0,
            results: [],
            failures: [failure],
            outcomes: [failure],
        },
    });
    const serialized = JSON.stringify(report);

    expect(report.universities[0].diagnostics).toMatchObject({
        phase: 'database write',
        category: 'database-write',
        sqlState: '22021',
        batchNumber: 3,
        batchSize: 2,
    });
    expect(report.universities[0].committedAssociations).toBe(0);
    expect(serialized).not.toContain('private bind value');
    expect(serialized).not.toContain('private postgres detail');
});

test('counts complete, partial, failed, and not-run universities independently', () => {
    const complete = {
        status: 'complete' as const,
        university: 'Complete',
        discovered: 1,
        committed: 1,
        skippedOwners: [],
        skippedRepositories: [],
        warnings: [],
    };
    const partial = {
        status: 'partial' as const,
        university: 'Partial',
        discovered: 1,
        committed: 1,
        skippedOwners: [],
        skippedRepositories: [],
        warnings: [safeWarning],
    };
    const failed: ScrapeUniversityFailure = {
        status: 'failed',
        university: 'Failed',
        discovered: 1,
        error: new Error('unexpected failure'),
        skippedOwners: [],
        skippedRepositories: [],
        warnings: [],
    };
    const report = createScrapingReport({
        startedAt: new Date('2026-10-24T10:00:00.000Z'),
        finishedAt: new Date('2026-10-24T10:02:00.000Z'),
        policy: 'best-effort',
        universityCount: 4,
        result: {
            elapsedMs: 120_000,
            universitiesProcessed: 3,
            committed: 2,
            failed: 1,
            interrupted: 0,
            partial: 1,
            results: [complete, partial],
            failures: [failed],
            outcomes: [
                complete,
                partial,
                failed,
                { status: 'not_run', university: 'Not Run' },
            ],
        },
    });

    expect(report.summary).toMatchObject({
        universitiesConfigured: 4,
        completeUniversities: 1,
        partialUniversities: 1,
        failedUniversities: 1,
        interruptedUniversities: 0,
        notRunUniversities: 1,
        committedAssociations: 2,
        textWarnings: 1,
    });
});
