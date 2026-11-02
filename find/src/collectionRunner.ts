import { discoverRepositories } from './discoverRepositories';
import {
    enrichRepository,
    refreshRepositoryMetadata,
} from './enrichRepository';
import { mapWithConcurrency } from './utils/concurrency';
import { GitHubRequestClient } from './utils/githubRequest';
import {
    cancellationForSignal,
    findScrapingCancellation,
    RepositoryEnrichmentSkipError,
    withScrapingContext,
} from './utils/scrapingError';
import { projectScrapingDiagnostic } from './utils/scrapingDiagnostics';
import { normalizeRepositoryText } from './utils/normalizeRepositoryText';
import type {
    CollectionMode,
    RepositoryCandidate,
    RepositoryCollectionCheckpoint,
    ScrapingPolicy,
    ScrapingConfiguration,
    ScrapingWarning,
    ScrapeUniversityFailure,
    ScrapeUniversityInterruption,
    ScrapeUniversityResult,
    ScrapingRunResult,
    SkippedOwner,
    SkippedRepository,
    UniversityConfiguration,
    UniversityCollectionCheckpoint,
} from './types/scraping';
import type { ScrapingProgressCallback, ScrapingPhase } from './types/progress';

export interface RepositoryCollectionStorePort {
    startOrLoadUniversityCollection(
        runId: string,
        university: string,
        mode: CollectionMode,
    ): Promise<UniversityCollectionCheckpoint>;
    listKnownRepositories(university: string): Promise<RepositoryCandidate[]>;
    saveDiscoveryCheckpoint(
        runId: string,
        university: string,
        candidates: readonly RepositoryCandidate[],
        skippedOwners: readonly SkippedOwner[],
    ): Promise<void>;
    saveRepositoryCheckpoint(
        runId: string,
        university: string,
        checkpoint: RepositoryCollectionCheckpoint,
    ): Promise<void>;
    publishUniversityCollection(
        runId: string,
        university: string,
        signal?: AbortSignal,
    ): Promise<number>;
}

export type CollectionRunnerDependencies = {
    client: GitHubRequestClient;
    store: RepositoryCollectionStorePort;
    runId: string;
    mode: CollectionMode;
    now?: () => Date;
    policy?: ScrapingPolicy;
    signal?: AbortSignal;
    onProgress?: ScrapingProgressCallback;
    onFatalError?: (university: string, error: Error) => void;
    progressNow?: () => number;
    searchRetrySleep?: (
        delayMs: number,
        signal?: AbortSignal,
    ) => Promise<void>;
};

type RunnerProgressEvent =
    | { type: 'phase'; phase: ScrapingPhase; university: string }
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

type UniversityObservedWork = {
    discovered?: number;
    skippedOwners: SkippedOwner[];
    skippedRepositories: SkippedRepository[];
    warnings: ScrapingWarning[];
};

/**
 * Runs discovery or an incremental refresh with durable repository-level
 * checkpoints. Results are published only after every candidate has a saved
 * complete, unchanged, or documented skipped state.
 */
export async function runCollection(
    configuration: ScrapingConfiguration,
    dependencies: CollectionRunnerDependencies,
): Promise<ScrapingRunResult> {
    if (!dependencies.runId.trim()) {
        throw new TypeError('Collection run ID must not be empty');
    }
    const results: ScrapeUniversityResult[] = [];
    const failures: ScrapeUniversityFailure[] = [];
    const outcomes: ScrapingRunResult['outcomes'] = [];
    const runController = new AbortController();
    const abortFromCaller = () => {
        const cancellation = cancellationForSignal(dependencies.signal);
        if (cancellation && !runController.signal.aborted) {
            runController.abort(cancellation);
        }
    };
    if (dependencies.signal?.aborted) abortFromCaller();
    else
        dependencies.signal?.addEventListener('abort', abortFromCaller, {
            once: true,
        });
    const runSignal = runController.signal;
    const startedAt = (dependencies.progressNow ?? Date.now)();
    const elapsedMs = () =>
        Math.max(0, (dependencies.progressNow ?? Date.now)() - startedAt);
    const emit = (event: RunnerProgressEvent) =>
        dependencies.onProgress?.({ ...event, elapsedMs: elapsedMs() });

    try {
        for (const university of configuration.universities) {
            if (runSignal.aborted) break;
            const observed: UniversityObservedWork = {
                skippedOwners: [],
                skippedRepositories: [],
                warnings: [],
            };
            try {
                const result = await collectUniversity(
                    configuration,
                    university,
                    { ...dependencies, signal: runSignal },
                    emit,
                    elapsedMs,
                    observed,
                );
                results.push(result);
                outcomes.push(result);
            } catch (error) {
                let saved: UniversityCollectionCheckpoint | undefined;
                try {
                    saved =
                        await dependencies.store.startOrLoadUniversityCollection(
                            dependencies.runId,
                            university.key,
                            dependencies.mode,
                        );
                } catch {
                    // Preserve the original outcome if the database is unavailable.
                }
                const cancellation = findScrapingCancellation(error);
                if (cancellation) {
                    const diagnostic = projectScrapingDiagnostic(error);
                    const interruption: ScrapeUniversityInterruption = {
                        status: 'interrupted',
                        university: university.key,
                        ...(saved && saved.status !== 'discovering'
                            ? { discovered: saved.discovered }
                            : observed.discovered !== undefined
                              ? { discovered: observed.discovered }
                              : {}),
                        cancellationSource: cancellation.source,
                        ...(diagnostic.phase && diagnostic.phase !== 'database preflight'
                            ? { phase: diagnostic.phase }
                            : {}),
                        ...(diagnostic.owner ? { owner: diagnostic.owner } : {}),
                        ...(diagnostic.repository
                            ? { repository: diagnostic.repository }
                            : {}),
                        ...(diagnostic.detail ? { detail: diagnostic.detail } : {}),
                        skippedOwners: mergeByKey(
                            observed.skippedOwners,
                            saved?.skippedOwners ?? [],
                            (item) => `${item.ownerType}:${item.login.toLowerCase()}`,
                        ),
                        skippedRepositories: mergeByKey(
                            observed.skippedRepositories,
                            saved?.skippedRepositories ?? [],
                            (item) => `${item.repositoryId}:${item.reasonCode}`,
                        ),
                        warnings: mergeByKey(
                            observed.warnings,
                            saved?.warnings ?? [],
                            (item) => `${item.repositoryId}:${item.field}:${item.code}`,
                        ),
                    };
                    outcomes.push(interruption);
                    break;
                }
                const failure: ScrapeUniversityFailure = {
                    status: 'failed',
                    university: university.key,
                    ...(saved && saved.status !== 'discovering'
                        ? { discovered: saved.discovered }
                        : {}),
                    error: asError(error),
                    skippedOwners: saved?.skippedOwners ?? [],
                    skippedRepositories: saved?.skippedRepositories ?? [],
                    warnings: saved?.warnings ?? [],
                };
                failures.push(failure);
                outcomes.push(failure);
                dependencies.onFatalError?.(university.key, failure.error);
                if (runSignal.aborted) break;
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
    } finally {
        dependencies.signal?.removeEventListener('abort', abortFromCaller);
    }
    return {
        elapsedMs: elapsedMs(),
        universitiesProcessed:
            results.length + failures.length +
            outcomes.filter((outcome) => outcome.status === 'interrupted').length,
        committed: results.reduce(
            (total, result) => total + result.committed,
            0,
        ),
        failed: failures.length,
        interrupted: outcomes.filter((outcome) => outcome.status === 'interrupted').length,
        partial: results.filter((result) => result.status === 'partial').length,
        results,
        failures,
        outcomes,
    };
}

async function collectUniversity(
    configuration: ScrapingConfiguration,
    university: UniversityConfiguration,
    dependencies: CollectionRunnerDependencies,
    emit: (event: RunnerProgressEvent) => void,
    elapsedMs: () => number,
    observed: UniversityObservedWork,
): Promise<ScrapeUniversityResult> {
    const { client, store, runId, mode } = dependencies;
    const policy = dependencies.policy ?? 'best-effort';
    let checkpoint = await store.startOrLoadUniversityCollection(
        runId,
        university.key,
        mode,
    );
    if (checkpoint.status === 'complete') {
        if (policy === 'strict') {
            throwStrictSkip(checkpoint, university.key);
        }
        return resultFromCheckpoint(checkpoint, university.key);
    }
    if (checkpoint.status !== 'discovering') {
        observed.discovered = checkpoint.discovered;
        observed.skippedOwners.push(...checkpoint.skippedOwners);
        observed.skippedRepositories.push(...checkpoint.skippedRepositories);
        observed.warnings.push(...checkpoint.warnings);
    }
    const initialCancellation = cancellationForSignal(dependencies.signal);
    if (initialCancellation) {
        throw withScrapingContext(initialCancellation, {
            phase:
                checkpoint.status === 'discovering' && mode === 'full'
                    ? 'search'
                    : 'enrichment',
            university: university.key,
        });
    }

    if (checkpoint.status === 'discovering') {
        emit({
            type: 'phase',
            phase: mode === 'full' ? 'search' : 'enrichment',
            university: university.key,
        });
        const discovery =
            mode === 'full'
                ? await discoverRepositories(
                      client,
                      university,
                      configuration.repositoryConcurrency,
                      {
                          signal: dependencies.signal,
                          university: university.key,
                          policy,
                          elapsedMs,
                          searchRetrySleep: dependencies.searchRetrySleep,
                          onProgress: dependencies.onProgress,
                          onOwnerSkipped: (owner) => {
                              observed.skippedOwners.push(owner);
                          },
                      },
                  )
                : {
                      candidates: await store.listKnownRepositories(
                          university.key,
                      ),
                      skippedOwners: [] as SkippedOwner[],
                  };
        observed.discovered = discovery.candidates.length;
        observed.skippedOwners.push(...discovery.skippedOwners);
        await store.saveDiscoveryCheckpoint(
            runId,
            university.key,
            discovery.candidates,
            discovery.skippedOwners,
        );
        checkpoint = await store.startOrLoadUniversityCollection(
            runId,
            university.key,
            mode,
        );
    }

    const candidates = checkpoint.candidates;
    let completed = candidates.filter(
        (item) => item.status !== 'pending',
    ).length;
    let skippedRepositoryCount = candidates.filter(
        (item) => item.status === 'skipped',
    ).length;
    const warnings = candidates.flatMap((item) => item.warnings ?? []);
    observed.discovered = checkpoint.discovered;
    observed.skippedOwners.push(...checkpoint.skippedOwners);
    observed.skippedRepositories.push(...checkpoint.skippedRepositories);
    observed.warnings.push(...warnings);
    emit({ type: 'phase', phase: 'enrichment', university: university.key });
    emit({
        type: 'progress',
        phase: 'enrichment',
        university: university.key,
        completed,
        total: candidates.length,
        skipped: skippedRepositoryCount,
        warnings: warnings.length,
    });

    const controller = new AbortController();
    const abortFromParent = () => {
        const cancellation = cancellationForSignal(dependencies.signal);
        if (cancellation && !controller.signal.aborted) {
            controller.abort(cancellation);
        }
    };
    if (dependencies.signal?.aborted) abortFromParent();
    else
        dependencies.signal?.addEventListener('abort', abortFromParent, {
            once: true,
        });
    client.setRunSignal(controller.signal);
    try {
        await mapWithConcurrency(
            candidates.filter((item) => item.status === 'pending'),
            configuration.repositoryConcurrency,
            async (item) => {
                const candidate = item.candidate;
                try {
                    let metadata = candidate.metadata;
                    let etag = candidate.etag;
                    if (mode === 'refresh') {
                        const refreshed = await refreshRepositoryMetadata(
                            client,
                            candidate,
                        );
                        if (refreshed.status === 'unchanged') {
                            await store.saveRepositoryCheckpoint(
                                runId,
                                university.key,
                                {
                                    candidate,
                                    status: 'unchanged',
                                    ...(refreshed.etag
                                        ? { etag: refreshed.etag }
                                        : {}),
                                },
                            );
                            completed += 1;
                            emit({
                                type: 'progress',
                                phase: 'enrichment',
                                university: university.key,
                                completed,
                                total: candidates.length,
                                skipped: skippedRepositoryCount,
                                warnings: warnings.length,
                                label: `${candidate.fullName} (unchanged)`,
                            });
                            return;
                        }
                        metadata = refreshed.metadata;
                        etag = refreshed.etag;
                    }

                    const record = await enrichRepository(
                        client,
                        candidate,
                        university,
                        dependencies.now,
                        metadata,
                    );
                    const normalized = normalizeRepositoryText([record]);
                    const repositoryWarnings = [
                        ...(candidate.metadataWarnings ?? []),
                        ...normalized.warnings,
                    ];
                    warnings.push(...repositoryWarnings);
                    observed.warnings.push(...repositoryWarnings);
                    for (const warning of repositoryWarnings) {
                        dependencies.onProgress?.({
                            type: 'warning',
                            university: warning.university,
                            repository: warning.repositoryName,
                            field: warning.field,
                            replacementCount: warning.replacementCount,
                            code: warning.code,
                            elapsedMs: elapsedMs(),
                        });
                    }
                    await store.saveRepositoryCheckpoint(
                        runId,
                        university.key,
                        {
                            candidate,
                            status: 'complete',
                            record: normalized.records[0],
                            ...(etag ? { etag } : {}),
                            warnings: repositoryWarnings,
                        },
                    );
                    completed += 1;
                    emit({
                        type: 'progress',
                        phase: 'enrichment',
                        university: university.key,
                        completed,
                        total: candidates.length,
                        skipped: skippedRepositoryCount,
                        warnings: warnings.length,
                        label: candidate.fullName,
                    });
                } catch (error) {
                    if (error instanceof RepositoryEnrichmentSkipError) {
                        await store.saveRepositoryCheckpoint(
                            runId,
                            university.key,
                            {
                                candidate,
                                status: 'skipped',
                                skippedRepository: error.skippedRepository,
                            },
                        );
                        skippedRepositoryCount += 1;
                        observed.skippedRepositories.push(
                            error.skippedRepository,
                        );
                        completed += 1;
                        emit({
                            type: 'progress',
                            phase: 'enrichment',
                            university: university.key,
                            completed,
                            total: candidates.length,
                            skipped: skippedRepositoryCount,
                            warnings: warnings.length,
                            label: `${candidate.fullName} (skipped)`,
                        });
                        if (policy === 'best-effort') return;
                    }
                    throw withScrapingContext(error, {
                        phase: 'enrichment',
                        university: university.key,
                        repository: candidate.fullName,
                    });
                }
            },
            (error) => controller.abort(error),
        );
    } finally {
        dependencies.signal?.removeEventListener('abort', abortFromParent);
        client.setRunSignal(undefined);
    }

    const beforePublicationCancellation = cancellationForSignal(
        dependencies.signal,
    );
    if (beforePublicationCancellation) {
        throw withScrapingContext(beforePublicationCancellation, {
            phase: 'database write',
            university: university.key,
        });
    }

    const completedCheckpoint = await store.startOrLoadUniversityCollection(
        runId,
        university.key,
        mode,
    );
    if (policy === 'strict') {
        throwStrictSkip(completedCheckpoint, university.key);
    }
    emit({
        type: 'phase',
        phase: 'database write',
        university: university.key,
    });
    let committed: number;
    try {
        committed = await store.publishUniversityCollection(
            runId,
            university.key,
            dependencies.signal,
        );
    } catch (error) {
        throw withScrapingContext(error, {
            phase: 'database write',
            university: university.key,
        });
    }
    return {
        ...resultFromCheckpoint(completedCheckpoint, university.key),
        committed,
    };
}

function mergeByKey<T>(
    first: readonly T[],
    second: readonly T[],
    keyOf: (value: T) => string,
): T[] {
    const merged = new Map<string, T>();
    for (const value of [...first, ...second]) merged.set(keyOf(value), value);
    return [...merged.values()];
}

function throwStrictSkip(
    checkpoint: UniversityCollectionCheckpoint,
    university: string,
): void {
    const skippedRepository = checkpoint.skippedRepositories[0];
    if (skippedRepository) {
        throw withScrapingContext(
            new RepositoryEnrichmentSkipError(skippedRepository),
            {
                phase: 'enrichment',
                university,
                repository: skippedRepository.repositoryName,
            },
        );
    }
    const skippedOwner = checkpoint.skippedOwners[0];
    if (skippedOwner) {
        throw withScrapingContext(
            new Error(
                'GitHub returned HTTP 404 for an owner repository listing; strict collection policy stopped.',
            ),
            {
                phase: 'owner listing',
                university,
                owner: `${skippedOwner.ownerType} ${skippedOwner.login}`,
                detail: `HTTP ${skippedOwner.status}; strict policy does not publish an incomplete university`,
            },
        );
    }
}

function resultFromCheckpoint(
    checkpoint: UniversityCollectionCheckpoint,
    university: string,
): ScrapeUniversityResult {
    return {
        status:
            checkpoint.skippedOwners.length > 0 ||
            checkpoint.skippedRepositories.length > 0 ||
            checkpoint.warnings.length > 0
                ? 'partial'
                : 'complete',
        university,
        discovered: checkpoint.discovered,
        committed: checkpoint.committed,
        skippedOwners: checkpoint.skippedOwners,
        skippedRepositories: checkpoint.skippedRepositories,
        warnings: checkpoint.warnings,
    };
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
