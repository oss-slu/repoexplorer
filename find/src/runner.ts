import { discoverRepositories } from './discoverRepositories';
import { enrichRepository } from './enrichRepository';
import { mapWithConcurrency } from './utils/concurrency';
import { GitHubRequestClient } from './utils/githubRequest';
import {
    RepositoryEnrichmentSkipError,
    withScrapingContext,
} from './utils/scrapingError';
import { normalizeRepositoryText } from './utils/normalizeRepositoryText';
import type {
    ScrapingProgressCallback,
    ScrapingProgressEvent,
    ScrapingPhase,
} from './types/progress';
import type {
    RepositoryScrapingRecord,
    ScrapingPolicy,
    ScrapingConfiguration,
    ScrapeUniversityOutcome,
    ScrapeUniversityFailure,
    ScrapeUniversityResult,
    ScrapingRunResult,
    SkippedOwner,
    SkippedRepository,
    ScrapingWarning,
    UniversityConfiguration,
} from './types/scraping';

export interface RepositoryStorePort {
    upsertUniversity(
        university: string,
        records: readonly RepositoryScrapingRecord[],
    ): Promise<number>;
}

export type ScrapingRunnerDependencies = {
    client: GitHubRequestClient;
    store: RepositoryStorePort;
    now?: () => Date;
    policy?: ScrapingPolicy;
    signal?: AbortSignal;
    onProgress?: ScrapingProgressCallback;
    onFatalError?: (university: string, error: Error) => void;
    progressNow?: () => number;
};

type RunnerProgressEvent =
    | {
          type: 'phase';
          phase: ScrapingPhase;
          university: string;
      }
    | {
          type: 'progress';
          phase: ScrapingPhase;
          university: string;
          completed: number;
          total: number;
          skipped?: number;
          warnings?: number;
          label?: string;
      };

export async function runScraping(
    configuration: ScrapingConfiguration,
    dependencies: ScrapingRunnerDependencies,
): Promise<ScrapingRunResult> {
    const results: ScrapeUniversityResult[] = [];
    const failures: ScrapeUniversityFailure[] = [];
    const outcomes: ScrapeUniversityOutcome[] = [];
    const startedAt = (dependencies.progressNow ?? Date.now)();
    const elapsedMs = () =>
        Math.max(0, (dependencies.progressNow ?? Date.now)() - startedAt);
    const emit = (event: RunnerProgressEvent) => {
        const eventWithElapsed = { ...event, elapsedMs: elapsedMs() };
        dependencies.onProgress?.(eventWithElapsed);
    };
    for (const university of configuration.universities) {
        if (dependencies.signal?.aborted) break;
        try {
            const result = await scrapeUniversity(
                dependencies.client,
                dependencies.store,
                university,
                configuration.repositoryConcurrency,
                dependencies.now,
                dependencies.policy ?? 'best-effort',
                dependencies.signal,
                emit,
                elapsedMs,
                dependencies.onProgress,
                dependencies.onFatalError,
            );
            results.push(result);
            outcomes.push(result);
        } catch (error) {
            if (error instanceof UniversityScrapeError) {
                const failure: ScrapeUniversityFailure = {
                    status: 'failed',
                    university: university.key,
                    discovered: error.discovered,
                    error: error.scrapeError,
                    skippedOwners: error.skippedOwners,
                    skippedRepositories: error.skippedRepositories,
                    warnings: error.warnings,
                };
                failures.push(failure);
                outcomes.push(failure);
            } else {
                const failure: ScrapeUniversityFailure = {
                    status: 'failed',
                    university: university.key,
                    error: asError(error),
                    skippedOwners: [],
                    skippedRepositories: [],
                    warnings: [],
                };
                failures.push(failure);
                outcomes.push(failure);
            }
            if (dependencies.signal?.aborted) break;
        }
    }

    const completedUniversities = new Set(
        outcomes.map((outcome) => outcome.university),
    );
    for (const university of configuration.universities) {
        if (!completedUniversities.has(university.key)) {
            outcomes.push({ status: 'not_run', university: university.key });
        }
    }

    return {
        elapsedMs: elapsedMs(),
        universitiesProcessed: results.length + failures.length,
        committed: results.reduce(
            (total, result) => total + result.committed,
            0,
        ),
        failed: failures.length,
        partial: results.filter((result) => result.status === 'partial').length,
        results,
        failures,
        outcomes,
    };
}

async function scrapeUniversity(
    client: GitHubRequestClient,
    store: RepositoryStorePort,
    university: UniversityConfiguration,
    repositoryConcurrency: number,
    now: (() => Date) | undefined,
    policy: ScrapingPolicy,
    parentSignal: AbortSignal | undefined,
    emit: (event: RunnerProgressEvent) => void,
    elapsedMs: () => number,
    onProgress: ScrapingProgressCallback | undefined,
    onFatalError: ((university: string, error: Error) => void) | undefined,
): Promise<ScrapeUniversityResult> {
    let discovered: number | undefined;
    let skippedOwners: SkippedOwner[] = [];
    const skippedRepositories: SkippedRepository[] = [];
    const warnings: ScrapingWarning[] = [];
    let phase: ScrapingPhase = 'search';
    let fatalReported = false;
    const reportFatal = (error: unknown) => {
        if (fatalReported) return;
        fatalReported = true;
        onFatalError?.(university.key, asError(error));
    };
    const forwardDiscoveryProgress = (event: ScrapingProgressEvent) => {
        if (event.type === 'phase') phase = event.phase;
        onProgress?.({ ...event, elapsedMs: elapsedMs() });
    };
    const controller = new AbortController();
    const abortFromParent = () =>
        controller.abort(parentSignal?.reason ?? new Error('Run cancelled'));
    if (parentSignal?.aborted) {
        abortFromParent();
    } else {
        parentSignal?.addEventListener('abort', abortFromParent, {
            once: true,
        });
    }

    client.setRunSignal(controller.signal);
    try {
        emit({ type: 'phase', phase, university: university.key });
        const discovery = await discoverRepositories(
            client,
            university,
            repositoryConcurrency,
            {
                signal: controller.signal,
                university: university.key,
                policy,
                elapsedMs,
                onProgress: forwardDiscoveryProgress,
                onFatalError: reportFatal,
                onOwnerSkipped(owner) {
                    skippedOwners.push(owner);
                },
            },
        );
        discovered = discovery.candidates.length;
        skippedOwners = discovery.skippedOwners;

        phase = 'enrichment';
        emit({ type: 'phase', phase, university: university.key });
        let completed = 0;
        emit({
            type: 'progress',
            phase,
            university: university.key,
            completed,
            total: discovered,
            skipped: 0,
        });
        let skippedRepositoryCount = 0;
        const enrichmentResults = await mapWithConcurrency(
            discovery.candidates,
            repositoryConcurrency,
            async (candidate) => {
                try {
                    const record = await enrichRepository(
                        client,
                        candidate,
                        university,
                        now,
                    );
                    const normalized = normalizeRepositoryText([record]);
                    warnings.push(...normalized.warnings);
                    for (const warning of normalized.warnings) {
                        onProgress?.({
                            type: 'warning',
                            university: warning.university,
                            repository: warning.repositoryName,
                            field: warning.field,
                            replacementCount: warning.replacementCount,
                            code: warning.code,
                            elapsedMs: elapsedMs(),
                        });
                    }
                    completed += 1;
                    emit({
                        type: 'progress',
                        phase,
                        university: university.key,
                        completed,
                        total: discovered ?? 0,
                        skipped: skippedRepositoryCount,
                        warnings: warnings.length,
                        label: candidate.fullName,
                    });
                    return normalized.records[0];
                } catch (error) {
                    if (error instanceof RepositoryEnrichmentSkipError) {
                        if (policy === 'strict') {
                            throw withScrapingContext(error, {
                                phase: 'enrichment',
                                university: university.key,
                                repository: candidate.fullName,
                            });
                        }
                        skippedRepositories.push(error.skippedRepository);
                        skippedRepositoryCount += 1;
                        completed += 1;
                        emit({
                            type: 'progress',
                            phase,
                            university: university.key,
                            completed,
                            total: discovered ?? 0,
                            skipped: skippedRepositoryCount,
                            label: `${candidate.fullName} (skipped)`,
                        });
                        return undefined;
                    }
                    throw withScrapingContext(error, {
                        phase: 'enrichment',
                        university: university.key,
                        repository: candidate.fullName,
                    });
                }
            },
            (error) => {
                reportFatal(error);
                controller.abort(error);
            },
        );

        const records = enrichmentResults.filter(
            (record): record is RepositoryScrapingRecord =>
                record !== undefined,
        );
        emit({
            type: 'progress',
            phase,
            university: university.key,
            completed,
            total: discovered,
            skipped: skippedRepositoryCount,
            warnings: warnings.length,
        });

        phase = 'database write';
        emit({ type: 'phase', phase, university: university.key });
        const committed = await store.upsertUniversity(
            university.key,
            records,
        );
        return {
            status:
                skippedOwners.length > 0 ||
                skippedRepositories.length > 0 ||
                warnings.length > 0
                    ? 'partial'
                    : 'complete',
            university: university.key,
            discovered,
            committed,
            skippedOwners,
            skippedRepositories,
            warnings,
        };
    } catch (error) {
        if (!controller.signal.aborted) controller.abort(error);
        const contextualError = withScrapingContext(error, {
            phase,
            university: university.key,
        });
        reportFatal(contextualError);
        throw new UniversityScrapeError(
            discovered,
            contextualError,
            skippedOwners,
            skippedRepositories,
            warnings,
        );
    } finally {
        parentSignal?.removeEventListener('abort', abortFromParent);
        client.setRunSignal(undefined);
    }
}

class UniversityScrapeError extends Error {
    constructor(
        readonly discovered: number | undefined,
        readonly scrapeError: Error,
        readonly skippedOwners: SkippedOwner[],
        readonly skippedRepositories: SkippedRepository[],
        readonly warnings: ScrapingWarning[],
    ) {
        super(scrapeError.message, { cause: scrapeError });
        this.name = 'UniversityScrapeError';
    }
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
