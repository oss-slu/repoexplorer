import { enrichRepository } from './enrichRepository';
import { sampleRepositorySearch } from './discoverRepositories';
import type {
    RepositoryCandidate,
    UniversityConfiguration,
} from './types/scraping';
import type {
    ScrapingPhase,
    ScrapingProgressCallback,
} from './types/progress';
import {
    cancellationForSignal,
    RepositoryEnrichmentSkipError,
    ScrapingCancellationError,
    withScrapingContext,
} from './utils/scrapingError';
import {
    projectScrapingDiagnostic,
    sanitizeDiagnosticText,
    type ScrapingDiagnostic,
} from './utils/scrapingDiagnostics';
import { normalizeRepositoryText } from './utils/normalizeRepositoryText';
import { GitHubRequestClient } from './utils/githubRequest';

export type DemoRepositoryStatus =
    | 'success'
    | 'skipped'
    | 'failed'
    | 'not_run';

export type DemoRepositoryResult = {
    repositoryId: number;
    repositoryName: string;
    status: DemoRepositoryStatus;
    elapsedMs: number;
    warningCount: number;
    diagnostic: ScrapingDiagnostic;
};

export type DemoRunResult = {
    status: 'sampled' | 'failed' | 'interrupted';
    university: string;
    searchTotal?: number;
    sampled: number;
    elapsedMs: number;
    searchElapsedMs: number;
    repositories: DemoRepositoryResult[];
    error?: Error;
    diagnostic?: ScrapingDiagnostic;
};

const DEMO_OMITTED_STAGES = [
    'organization and user searches',
    'owner enumeration and owner repository listings',
    'complete-search retries, pagination, and partitioning',
    'database preflight, checkpoints, and publication',
] as const;

export { DEMO_OMITTED_STAGES };

export async function runDemo(
    client: GitHubRequestClient,
    university: UniversityConfiguration,
    limit: number,
    concurrency: number,
    options: {
        signal?: AbortSignal;
        now?: () => number;
        onProgress?: ScrapingProgressCallback;
    } = {},
): Promise<DemoRunResult> {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new RangeError('demo concurrency must be a positive integer');
    }
    const now = options.now ?? Date.now;
    const startedAt = now();
    const controller = new AbortController();
    const abortFromParent = () =>
        controller.abort(
            options.signal?.reason ?? new ScrapingCancellationError('caller'),
        );
    if (options.signal?.aborted) abortFromParent();
    else options.signal?.addEventListener('abort', abortFromParent, { once: true });
    client.setRunSignal(controller.signal);

    let searchTotal: number | undefined;
    let candidates: RepositoryCandidate[] = [];
    let failure: Error | undefined;
    let repositories: DemoRepositoryResult[] = [];
    let phase: ScrapingPhase = 'search';
    try {
        options.onProgress?.({
            type: 'phase',
            phase: 'search',
            university: university.key,
            elapsedMs: Math.max(0, now() - startedAt),
        });
        const searchStartedAt = now();
        try {
            const sample = await sampleRepositorySearch(
                client,
                university,
                limit,
                controller.signal,
            );
            candidates = sample.candidates;
            searchTotal = sample.searchTotal;
        } catch (error) {
            failure = asError(
                withScrapingContext(error, {
                    phase: 'search',
                    university: university.key,
                    detail: 'demo repository search',
                }),
            );
        }
        const searchElapsedMs = Math.max(0, now() - searchStartedAt);

        if (failure || controller.signal.aborted) {
            const interruption = cancellationForSignal(options.signal);
            if (interruption) {
                return createInterruptedResult(
                    university.key,
                    searchTotal,
                    candidates.length,
                    now() - startedAt,
                    searchElapsedMs,
                    interruption,
                    repositories,
                    phase,
                );
            }
            return createFailedResult(
                university.key,
                searchTotal,
                candidates.length,
                now() - startedAt,
                searchElapsedMs,
                failure ?? asError(controller.signal.reason),
                repositories,
            );
        }

        phase = 'enrichment';
        repositories = candidates.map((candidate) => ({
            repositoryId: candidate.id,
            repositoryName: sanitizeDiagnosticText(candidate.fullName),
            status: 'not_run',
            elapsedMs: 0,
            warningCount: candidate.metadataWarnings?.length ?? 0,
            diagnostic: { category: 'not-run' },
        }));
        options.onProgress?.({
            type: 'phase',
            phase: 'enrichment',
            university: university.key,
            elapsedMs: Math.max(0, now() - startedAt),
        });
        options.onProgress?.({
            type: 'progress',
            phase: 'enrichment',
            university: university.key,
            completed: 0,
            total: candidates.length,
            elapsedMs: Math.max(0, now() - startedAt),
        });

        let nextIndex = 0;
        let completed = 0;
        const workers = Array.from(
            { length: Math.min(concurrency, candidates.length) },
            async () => {
                while (!controller.signal.aborted && failure === undefined) {
                    const index = nextIndex;
                    nextIndex += 1;
                    if (index >= candidates.length) return;
                    const candidate = candidates[index];
                    const repositoryStartedAt = now();
                    try {
                        const record = await enrichRepository(
                            client,
                            candidate,
                            university,
                            () => new Date(now()),
                            candidate.metadata,
                        );
                        const normalized = normalizeRepositoryText([record]);
                        const warningCount =
                            (candidate.metadataWarnings?.length ?? 0) +
                            normalized.warnings.length;
                        repositories[index] = {
                            repositoryId: candidate.id,
                            repositoryName: sanitizeDiagnosticText(
                                candidate.fullName,
                            ),
                            status: 'success',
                            elapsedMs: Math.max(0, now() - repositoryStartedAt),
                            warningCount,
                            diagnostic: { category: 'success' },
                        };
                    } catch (error) {
                        if (error instanceof RepositoryEnrichmentSkipError) {
                            const contextual = withScrapingContext(error, {
                                phase: 'enrichment',
                                university: university.key,
                                repository: candidate.fullName,
                            });
                            repositories[index] = {
                                repositoryId: candidate.id,
                                repositoryName: sanitizeDiagnosticText(
                                    candidate.fullName,
                                ),
                                status: 'skipped',
                                elapsedMs: Math.max(
                                    0,
                                    now() - repositoryStartedAt,
                                ),
                                warningCount:
                                    candidate.metadataWarnings?.length ?? 0,
                                diagnostic:
                                    projectScrapingDiagnostic(contextual),
                            };
                        } else if (!failure && !options.signal?.aborted) {
                            failure = asError(
                                withScrapingContext(error, {
                                    phase: 'enrichment',
                                    university: university.key,
                                    repository: candidate.fullName,
                                }),
                            );
                            repositories[index] = {
                                repositoryId: candidate.id,
                                repositoryName: sanitizeDiagnosticText(
                                    candidate.fullName,
                                ),
                                status: 'failed',
                                elapsedMs: Math.max(
                                    0,
                                    now() - repositoryStartedAt,
                                ),
                                warningCount:
                                    candidate.metadataWarnings?.length ?? 0,
                                diagnostic: projectScrapingDiagnostic(failure),
                            };
                            controller.abort(failure);
                        }
                    }
                    if (repositories[index].status !== 'not_run') completed += 1;
                    options.onProgress?.({
                        type: 'progress',
                        phase: 'enrichment',
                        university: university.key,
                        completed,
                        total: candidates.length,
                        skipped: repositories.filter(
                            (item) => item.status === 'skipped',
                        ).length,
                        label: candidate.fullName,
                        elapsedMs: Math.max(0, now() - startedAt),
                    });
                }
            },
        );
        await Promise.all(workers);

        const interruption = cancellationForSignal(options.signal);
        if (interruption) {
            return createInterruptedResult(
                university.key,
                searchTotal,
                candidates.length,
                now() - startedAt,
                searchElapsedMs,
                interruption,
                repositories,
                phase,
            );
        }
        if (failure) {
            return createFailedResult(
                university.key,
                searchTotal,
                candidates.length,
                now() - startedAt,
                searchElapsedMs,
                failure,
                repositories,
            );
        }
        return {
            status: 'sampled',
            university: sanitizeDiagnosticText(university.key),
            ...(searchTotal === undefined ? {} : { searchTotal }),
            sampled: candidates.length,
            elapsedMs: Math.max(0, now() - startedAt),
            searchElapsedMs,
            repositories,
        };
    } finally {
        options.signal?.removeEventListener('abort', abortFromParent);
        client.setRunSignal(undefined);
    }
}

function createFailedResult(
    university: string,
    searchTotal: number | undefined,
    sampled: number,
    elapsedMs: number,
    searchElapsedMs: number,
    error: Error,
    repositories: DemoRepositoryResult[],
): DemoRunResult {
    return {
        status: 'failed',
        university: sanitizeDiagnosticText(university),
        ...(searchTotal === undefined ? {} : { searchTotal }),
        sampled,
        elapsedMs: Math.max(0, elapsedMs),
        searchElapsedMs,
        repositories,
        error,
        diagnostic: projectScrapingDiagnostic(error),
    };
}

function createInterruptedResult(
    university: string,
    searchTotal: number | undefined,
    sampled: number,
    elapsedMs: number,
    searchElapsedMs: number,
    error: ScrapingCancellationError,
    repositories: DemoRepositoryResult[],
    phase: ScrapingPhase,
): DemoRunResult {
    const contextual = withScrapingContext(error, {
        phase,
        university,
    });
    return {
        status: 'interrupted',
        university: sanitizeDiagnosticText(university),
        ...(searchTotal === undefined ? {} : { searchTotal }),
        sampled,
        elapsedMs: Math.max(0, elapsedMs),
        searchElapsedMs,
        repositories,
        error,
        diagnostic: projectScrapingDiagnostic(contextual),
    };
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
