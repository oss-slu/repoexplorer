import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitHubRequestError } from '../utils/githubRequest';
import {
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
        skippedRepositories: [sensitiveSkippedRepository],
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
        partial: 1,
        results: [partial],
        failures: [failure],
        outcomes: [partial, failure],
    };
}

test('writes a machine-readable report with outcomes, counts, and sanitized owner and error details', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'repoexplorer-report-'));
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
            schemaVersion: 2,
            startedAt: '2026-10-24T10:00:00.000Z',
            finishedAt: '2026-10-24T10:02:00.000Z',
            policy: 'best-effort',
            summary: {
                universitiesConfigured: 2,
                partialUniversities: 1,
                failedUniversities: 1,
                committedAssociations: 0,
                skippedOwners: 2,
                skippedRepositories: 1,
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

test('surfaces report-writing failures to the caller', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'repoexplorer-report-'));
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
        notRunUniversities: 1,
        committedAssociations: 2,
        textWarnings: 1,
    });
});
