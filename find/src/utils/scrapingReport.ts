import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
    OwnerListingPolicy,
    ScrapeUniversityOutcome,
    ScrapingRunResult,
    SkippedOwner,
} from '../types/scraping';
import {
    GitHubNetworkError,
    GitHubRequestError,
    GitHubResponseParseError,
} from './githubRequest';
import { sanitizeGitHubEndpoint } from './formatScrapingError';

export type ScrapingReport = {
    schemaVersion: 1;
    startedAt: string;
    finishedAt: string;
    policy: OwnerListingPolicy;
    summary: {
        universitiesConfigured: number;
        completeUniversities: number;
        partialUniversities: number;
        failedUniversities: number;
        notRunUniversities: number;
        committedAssociations: number;
        skippedOwners: number;
    };
    universities: Array<{
        university: string;
        status: ScrapeUniversityOutcome['status'];
        discoveredRepositories?: number;
        committedAssociations: number;
        skippedOwners: SkippedOwner[];
        failureReason?: string;
    }>;
};

export function createScrapingReport(input: {
    startedAt: Date;
    finishedAt: Date;
    policy: OwnerListingPolicy;
    universityCount: number;
    result: ScrapingRunResult;
}): ScrapingReport {
    const universities = input.result.outcomes.map((outcome) => {
        if (outcome.status === 'not_run') {
            return {
                university: outcome.university,
                status: outcome.status,
                committedAssociations: 0,
                skippedOwners: [],
            };
        }

        if (outcome.status === 'failed') {
            return {
                university: outcome.university,
                status: outcome.status,
                discoveredRepositories: outcome.discovered,
                committedAssociations: 0,
                skippedOwners: sanitizeSkippedOwners(outcome.skippedOwners),
                failureReason: safeFailureReason(outcome.error),
            };
        }

        return {
            university: outcome.university,
            status: outcome.status,
            discoveredRepositories: outcome.discovered,
            committedAssociations: outcome.committed,
            skippedOwners: sanitizeSkippedOwners(outcome.skippedOwners),
        };
    });
    const skippedOwners = universities.reduce(
        (total, university) => total + university.skippedOwners.length,
        0,
    );

    return {
        schemaVersion: 1,
        startedAt: input.startedAt.toISOString(),
        finishedAt: input.finishedAt.toISOString(),
        policy: input.policy,
        summary: {
            universitiesConfigured: input.universityCount,
            completeUniversities: universities.filter(
                (university) => university.status === 'complete',
            ).length,
            partialUniversities: universities.filter(
                (university) => university.status === 'partial',
            ).length,
            failedUniversities: universities.filter(
                (university) => university.status === 'failed',
            ).length,
            notRunUniversities: universities.filter(
                (university) => university.status === 'not_run',
            ).length,
            committedAssociations: input.result.committed,
            skippedOwners,
        },
        universities,
    };
}

export async function writeScrapingReport(
    report: ScrapingReport,
    directory: string,
): Promise<string> {
    const reportDirectory = path.resolve(directory);
    const timestamp = report.finishedAt.replace(/[:.]/g, '-');
    const reportPath = path.join(
        reportDirectory,
        `scrape-report-${timestamp}-${randomUUID()}.json`,
    );
    const temporaryPath = `${reportPath}.${randomUUID()}.tmp`;
    await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
    try {
        await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'wx',
        });
        await rename(temporaryPath, reportPath);
        return reportPath;
    } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

function sanitizeSkippedOwners(owners: readonly SkippedOwner[]): SkippedOwner[] {
    return owners.map((owner) => ({
        university: owner.university,
        login: Array.from(owner.login)
            .map((character) => {
                const code = character.charCodeAt(0);
                return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
                    ? ' '
                    : character;
            })
            .join('')
            .replace(/\s+/g, ' ')
            .trim(),
        ownerType: owner.ownerType,
        endpoint: sanitizeGitHubEndpoint(owner.endpoint),
        status: 404,
        reason: 'GitHub returned HTTP 404 for this owner repository listing; the owner was skipped.',
    }));
}

function safeFailureReason(error: Error): string {
    const visited = new Set<unknown>();
    let current: unknown = error;
    while (current instanceof Error && !visited.has(current)) {
        if (current instanceof GitHubRequestError) {
            return `GitHub request failed with HTTP ${current.status}; ${sanitizeGitHubEndpoint(current.url)}`;
        }
        if (current instanceof GitHubResponseParseError) {
            return `GitHub returned invalid JSON with HTTP ${current.status}; ${sanitizeGitHubEndpoint(current.url)}`;
        }
        if (current instanceof GitHubNetworkError) {
            return `GitHub network request failed after ${current.attempts} attempts; ${sanitizeGitHubEndpoint(current.url)}`;
        }
        visited.add(current);
        current = current.cause;
    }
    return `Scraping failed (${error.name || 'Error'}); see sanitized CLI diagnostics.`;
}
