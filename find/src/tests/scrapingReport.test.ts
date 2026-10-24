import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitHubRequestError } from '../utils/githubRequest';
import {
    createScrapingReport,
    writeScrapingReport,
} from '../utils/scrapingReport';
import type {
    ScrapeUniversityFailure,
    ScrapingRunResult,
    SkippedOwner,
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
    };
    const partial = {
        status: 'partial' as const,
        university: 'University',
        discovered: 0,
        committed: 0,
        skippedOwners: [sensitiveSkippedOwner],
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
            schemaVersion: 1,
            startedAt: '2026-10-24T10:00:00.000Z',
            finishedAt: '2026-10-24T10:02:00.000Z',
            policy: 'best-effort',
            summary: {
                universitiesConfigured: 2,
                partialUniversities: 1,
                failedUniversities: 1,
                committedAssociations: 0,
                skippedOwners: 2,
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
                                'https://api.github.com/orgs/awsslu/repos?page=2&per_page=100',
                            status: 404,
                        },
                    ],
                },
                {
                    university: 'Failed University',
                    status: 'failed',
                    committedAssociations: 0,
                    failureReason: expect.stringContaining('HTTP 403'),
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
