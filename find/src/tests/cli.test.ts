import {
    formatCliSummary,
    getCliExitCode,
    parseCliOptions,
    withDatabasePreflight,
} from '../cli';
import type { ScrapingRunResult } from '../types/scraping';

const skippedOwner = {
    university: 'Saint Louis University',
    login: 'awsslu',
    ownerType: 'Organization' as const,
    endpoint: 'https://api.github.com/orgs/awsslu/repos',
    status: 404 as const,
    reason: 'GitHub returned HTTP 404 for this owner repository listing; the owner was skipped.',
};

const partialResult: ScrapingRunResult = {
    elapsedMs: 1_200,
    universitiesProcessed: 1,
    committed: 3,
    failed: 0,
    partial: 1,
    results: [
        {
            status: 'partial',
            university: 'Saint Louis University',
            discovered: 3,
            committed: 3,
            skippedOwners: [skippedOwner],
            skippedRepositories: [],
            warnings: [],
        },
    ],
    failures: [],
    outcomes: [
        {
            status: 'partial',
            university: 'Saint Louis University',
            discovered: 3,
            committed: 3,
            skippedOwners: [skippedOwner],
            skippedRepositories: [],
            warnings: [],
        },
    ],
};

function emptyResult(): ScrapingRunResult {
    return {
        elapsedMs: 0,
        universitiesProcessed: 1,
        committed: 0,
        failed: 0,
        partial: 0,
        results: [
            {
                status: 'complete',
                university: 'Complete University',
                discovered: 0,
                committed: 0,
                skippedOwners: [],
                skippedRepositories: [],
                warnings: [],
            },
        ],
        failures: [],
        outcomes: [
            {
                status: 'complete',
                university: 'Complete University',
                discovered: 0,
                committed: 0,
                skippedOwners: [],
                skippedRepositories: [],
                warnings: [],
            },
        ],
    };
}

test('defaults to best effort and accepts strict mode', () => {
    expect(parseCliOptions([]).policy).toBe('best-effort');
    expect(parseCliOptions(['--strict']).policy).toBe('strict');
});

test('does not start scraping or make GitHub requests after preflight failure', async () => {
    let githubRequests = 0;
    const scrape = async () => {
        githubRequests += 1;
        return emptyResult();
    };

    await expect(
        withDatabasePreflight(
            async () => {
                throw new Error('preflight failed');
            },
            scrape,
        ),
    ).rejects.toThrow('preflight failed');
    expect(githubRequests).toBe(0);
});

test('uses documented exit codes with fatal failures taking precedence over partial results', () => {
    expect(getCliExitCode(emptyResult(), false)).toBe(0);
    expect(getCliExitCode(partialResult, false)).toBe(2);

    const failedAndPartial: ScrapingRunResult = {
        ...partialResult,
        failed: 1,
    };
    expect(getCliExitCode(failedAndPartial, false)).toBe(1);
    expect(getCliExitCode(emptyResult(), false, new Error('report failed'))).toBe(
        1,
    );
    expect(getCliExitCode(failedAndPartial, true, undefined, 143)).toBe(143);
});

test('prints an explicit partial-success summary with skipped owners and report path', () => {
    const summary = formatCliSummary(
        partialResult,
        1,
        'best-effort',
        '/tmp/scrape-report.json',
        false,
    );

    expect(summary).toContain('PARTIAL SUCCESS');
    expect(summary).toContain('partial: 1');
    expect(summary).toContain('skipped owners: 1');
    expect(summary).toContain('repository associations committed: 3');
    expect(summary).toContain('report: /tmp/scrape-report.json');
    expect(summary).not.toContain('missing repositories');
});

test('labels a zero-row partial run and a mixed partial/fatal run clearly', () => {
    const zeroRowPartial: ScrapingRunResult = {
        ...partialResult,
        committed: 0,
        results: [
            {
                ...partialResult.results[0],
                discovered: 0,
                committed: 0,
            },
        ],
        outcomes: [
            {
                status: 'partial',
                university: 'Saint Louis University',
                discovered: 0,
                committed: 0,
                skippedOwners: [skippedOwner],
                skippedRepositories: [],
                warnings: [],
            },
        ],
    };
    expect(getCliExitCode(zeroRowPartial, false)).toBe(2);
    expect(
        formatCliSummary(
            zeroRowPartial,
            1,
            'best-effort',
            '/tmp/zero-row-report.json',
            false,
        ),
    ).toContain('PARTIAL COMPLETION');

    const mixedResult: ScrapingRunResult = {
        ...partialResult,
        failed: 1,
    };
    expect(getCliExitCode(mixedResult, false)).toBe(1);
    expect(
        formatCliSummary(
            mixedResult,
            2,
            'best-effort',
            '/tmp/mixed-report.json',
            false,
        ),
    ).toContain('FAILED WITH PARTIAL COVERAGE');
});
