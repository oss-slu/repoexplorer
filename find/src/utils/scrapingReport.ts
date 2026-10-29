import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
    ScrapingPolicy,
    ScrapeUniversityOutcome,
    ScrapeUniversityInterruption,
    ScrapingRunResult,
    SkippedOwner,
    SkippedRepository,
    ScrapingWarning,
} from '../types/scraping';
import {
    formatScrapingDiagnostic,
    projectScrapingDiagnostic,
    sanitizeGitHubEndpoint,
    type ScrapingDiagnostic,
} from './scrapingDiagnostics';
import { describeSkippedRepositoryReason } from './scrapingError';

export type ScrapingReport = {
    schemaVersion: 3;
    startedAt: string;
    finishedAt: string;
    policy: ScrapingPolicy;
    summary: {
        universitiesConfigured: number;
        completeUniversities: number;
        partialUniversities: number;
        failedUniversities: number;
        interruptedUniversities: number;
        notRunUniversities: number;
        committedAssociations: number;
        skippedOwners: number;
        skippedRepositories: number;
        textWarnings: number;
        nulReplacements: number;
    };
    universities: Array<{
        university: string;
        status: ScrapeUniversityOutcome['status'];
        discoveredRepositories?: number;
        committedAssociations: number;
        skippedOwners: SkippedOwner[];
        skippedRepositories: SkippedRepository[];
        warnings: ScrapingWarning[];
        failureReason?: string;
        diagnostics?: ScrapingDiagnostic;
    }>;
};

export function createScrapingReport(input: {
    startedAt: Date;
    finishedAt: Date;
    policy: ScrapingPolicy;
    universityCount: number;
    result: ScrapingRunResult;
}): ScrapingReport {
    const universities = input.result.outcomes.map((outcome) => {
        if (outcome.status === 'not_run') {
            return {
                university: clean(outcome.university),
                status: outcome.status,
                committedAssociations: 0,
                skippedOwners: [],
                skippedRepositories: [],
                warnings: [],
            };
        }

        if (outcome.status === 'failed') {
            const diagnostics = projectScrapingDiagnostic(outcome.error);
            return {
                university: clean(outcome.university),
                status: outcome.status,
                discoveredRepositories: outcome.discovered,
                committedAssociations: 0,
                skippedOwners: sanitizeSkippedOwners(outcome.skippedOwners),
                skippedRepositories: sanitizeSkippedRepositories(
                    outcome.skippedRepositories,
                ),
                warnings: sanitizeWarnings(outcome.warnings),
                failureReason: formatScrapingDiagnostic(diagnostics),
                diagnostics,
            };
        }

        if (outcome.status === 'interrupted') {
            return {
                university: clean(outcome.university),
                status: outcome.status,
                discoveredRepositories: outcome.discovered,
                committedAssociations: 0,
                skippedOwners: sanitizeSkippedOwners(outcome.skippedOwners),
                skippedRepositories: sanitizeSkippedRepositories(
                    outcome.skippedRepositories,
                ),
                warnings: sanitizeWarnings(outcome.warnings),
                diagnostics: interruptionDiagnostic(outcome),
            };
        }

        return {
            university: clean(outcome.university),
            status: outcome.status,
            discoveredRepositories: outcome.discovered,
            committedAssociations: outcome.committed,
            skippedOwners: sanitizeSkippedOwners(outcome.skippedOwners),
            skippedRepositories: sanitizeSkippedRepositories(
                outcome.skippedRepositories,
            ),
            warnings: sanitizeWarnings(outcome.warnings),
        };
    });
    const skippedOwners = universities.reduce(
        (total, university) => total + university.skippedOwners.length,
        0,
    );
    const skippedRepositories = universities.reduce(
        (total, university) => total + university.skippedRepositories.length,
        0,
    );
    const warnings = universities.flatMap((university) => university.warnings);

    return {
        schemaVersion: 3,
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
            interruptedUniversities: universities.filter(
                (university) => university.status === 'interrupted',
            ).length,
            notRunUniversities: universities.filter(
                (university) => university.status === 'not_run',
            ).length,
            committedAssociations: input.result.committed,
            skippedOwners,
            skippedRepositories,
            textWarnings: warnings.length,
            nulReplacements: warnings.reduce(
                (total, warning) => total + warning.replacementCount,
                0,
            ),
        },
        universities,
    };
}

function interruptionDiagnostic(
    outcome: ScrapeUniversityInterruption,
): ScrapingDiagnostic {
    return {
        category: 'interrupted',
        cancellationSource: outcome.cancellationSource,
        university: clean(outcome.university),
        ...(outcome.phase ? { phase: outcome.phase } : {}),
        ...(outcome.owner ? { owner: clean(outcome.owner) } : {}),
        ...(outcome.repository ? { repository: clean(outcome.repository) } : {}),
        ...(outcome.detail ? { detail: clean(outcome.detail) } : {}),
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

function sanitizeSkippedOwners(
    owners: readonly SkippedOwner[],
): SkippedOwner[] {
    return owners.map((owner) => ({
        university: clean(owner.university),
        login: clean(owner.login),
        ownerType: owner.ownerType,
        endpoint: sanitizeGitHubEndpoint(owner.endpoint),
        status: 404,
        reason: 'GitHub returned HTTP 404 for this owner repository listing; the owner was skipped.',
    }));
}

function sanitizeSkippedRepositories(
    repositories: readonly SkippedRepository[],
): SkippedRepository[] {
    return repositories.map((repository) => {
        const sanitized = {
            university: clean(repository.university),
            repositoryId: repository.repositoryId,
            repositoryName: clean(repository.repositoryName),
            endpoint: sanitizeGitHubEndpoint(repository.endpoint),
            ...(repository.requestId
                ? { requestId: clean(repository.requestId) }
                : {}),
        };
        switch (repository.reasonCode) {
            case 'github_tos_block':
                return {
                    ...sanitized,
                    status: 403,
                    reasonCode: repository.reasonCode,
                    reason: describeSkippedRepositoryReason(
                        repository.reasonCode,
                    ),
                };
            case 'github_contributors_unavailable':
                return {
                    ...sanitized,
                    status: 403,
                    reasonCode: repository.reasonCode,
                    reason: describeSkippedRepositoryReason(
                        repository.reasonCode,
                    ),
                };
            case 'repository_unavailable_404':
                return {
                    ...sanitized,
                    status: 404,
                    reasonCode: repository.reasonCode,
                    reason: describeSkippedRepositoryReason(
                        repository.reasonCode,
                    ),
                };
            case 'github_legal_restriction':
                return {
                    ...sanitized,
                    status: 451,
                    reasonCode: repository.reasonCode,
                    reason: describeSkippedRepositoryReason(
                        repository.reasonCode,
                    ),
                };
        }
    });
}

function sanitizeWarnings(
    warnings: readonly ScrapingWarning[],
): ScrapingWarning[] {
    return warnings.map((warning) => ({
        university: clean(warning.university),
        repositoryId: warning.repositoryId,
        repositoryName: clean(warning.repositoryName),
        field: clean(warning.field),
        replacementCount: warning.replacementCount,
        code: warning.code,
    }));
}

function clean(value: string): string {
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
