import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScrapingConfiguration } from './config';
import { createDatabasePool, getDatabasePoolConfig } from './db/connect';
import { RepositoryStore } from './db/repositoryStore';
import {
    runCollection,
    type RepositoryCollectionStorePort,
} from './collectionRunner';
import {
    GitHubRequestClient,
    type GitHubRequestConfig,
} from './utils/githubRequest';
import {
    createConfigurationGitHubDiagnostic,
    createInterruptedGitHubDiagnostic,
    diagnoseGitHubAccess,
    type GitHubAccessDiagnostic,
} from './utils/githubDiagnostics';
import {
    getCurrentTokenProvenance,
    getGitHubCredentialState,
    loadEnvironmentFile,
    type GitHubTokenProvenance,
} from './utils/environment';
import { formatScrapingError } from './utils/formatScrapingError';
import {
    ScrapingCancellationError,
    ScrapingDatabasePreflightError,
} from './utils/scrapingError';
import {
    formatScrapingDiagnostic,
    sanitizeDiagnosticText,
} from './utils/scrapingDiagnostics';
import { CliProgressRenderer } from './utils/progressRenderer';
import type { ProgressOutput } from './utils/progressRenderer';
import { DEMO_OMITTED_STAGES, runDemo } from './demoRunner';
import {
    createDemoReport,
    writeDemoReport,
} from './utils/demoReport';
import {
    createScrapingReport,
    writeScrapingReport,
} from './utils/scrapingReport';
import type {
    CollectionMode,
    ScrapingConfiguration,
    ScrapingPolicy,
    ScrapeUniversityFailure,
    ScrapingRunResult,
    UniversityConfiguration,
} from './types/scraping';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export interface CliOptions {
    configPath: string;
    verbose: boolean;
    policy: ScrapingPolicy;
    mode: CollectionMode;
    university?: string;
    runId?: string;
    diagnoseGitHub?: boolean;
    owner?: string;
    demo?: boolean;
    demoLimit?: number;
}

export interface CliRuntimeDependencies {
    tokenProvenance?: GitHubTokenProvenance;
    createRequestClient?: (config: GitHubRequestConfig) => GitHubRequestClient;
    createAbortController?: () => AbortController;
    stdout?: Pick<NodeJS.WriteStream, 'write'> &
        Partial<Pick<ProgressOutput, 'isTTY' | 'columns'>>;
    stderr?: Pick<NodeJS.WriteStream, 'write'>;
    reportDirectory?: string;
    createCollectionRuntime?: () => Promise<CliCollectionRuntime> | CliCollectionRuntime;
    signalHandlers?: boolean;
}

export interface CliCollectionRuntime {
    store: RepositoryCollectionStorePort & {
        preflight(): Promise<void>;
        acquireCollectionLock(universities: readonly string[]): Promise<() => Promise<void>>;
    };
    close(): Promise<void>;
}

export function parseCliOptions(arguments_: readonly string[]): CliOptions {
    let configPath =
        process.env.UNIVERSITIES_CONFIG ?? 'config/universities.json';
    let verbose = false;
    let policy: ScrapingPolicy = 'best-effort';
    let mode: CollectionMode = 'full';
    let university: string | undefined;
    let runId: string | undefined;
    let diagnoseGitHub = false;
    let owner: string | undefined;
    let demo = false;
    let demoLimit = 10;
    let demoLimitUsed = false;
    let strictUsed = false;
    let universityOptionCount = 0;
    let collectionOptionUsed = false;
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (argument === '--config') {
            collectionOptionUsed = true;
            const next = arguments_[index + 1];
            if (!next || next.startsWith('--')) {
                throw new TypeError('--config requires a file path');
            }
            configPath = next;
            index += 1;
        } else if (argument === '--verbose' || argument === '-v') {
            collectionOptionUsed = true;
            verbose = true;
        } else if (argument === '--strict') {
            collectionOptionUsed = true;
            strictUsed = true;
            policy = 'strict';
        } else if (argument === '--mode') {
            collectionOptionUsed = true;
            const next = arguments_[index + 1];
            if (next !== 'full' && next !== 'refresh') {
                throw new TypeError('--mode must be either full or refresh');
            }
            mode = next;
            index += 1;
        } else if (argument === '--university' || argument === '--run-id') {
            collectionOptionUsed = true;
            const next = arguments_[index + 1];
            if (!next || next.startsWith('--')) {
                throw new TypeError(`${argument} requires a value`);
            }
            if (argument === '--university') {
                universityOptionCount += 1;
                university = next;
            }
            else runId = next;
            index += 1;
        } else if (argument === '--diagnose-github') {
            if (diagnoseGitHub) {
                throw new TypeError('--diagnose-github may be supplied only once');
            }
            diagnoseGitHub = true;
        } else if (argument === '--demo') {
            if (demo) throw new TypeError('--demo may be supplied only once');
            collectionOptionUsed = true;
            demo = true;
        } else if (argument === '--demo-limit') {
            collectionOptionUsed = true;
            if (demoLimitUsed) {
                throw new TypeError('--demo-limit may be supplied only once');
            }
            const next = arguments_[index + 1];
            if (!next || next.startsWith('--')) {
                throw new TypeError('--demo-limit requires a number from 1 to 100');
            }
            demoLimit = Number(next);
            if (!Number.isInteger(demoLimit) || demoLimit < 1 || demoLimit > 100) {
                throw new TypeError('--demo-limit must be an integer from 1 to 100');
            }
            demoLimitUsed = true;
            index += 1;
        } else if (argument === '--owner') {
            if (owner !== undefined) {
                throw new TypeError('--owner may be supplied only once');
            }
            const next = arguments_[index + 1];
            if (!next || next.startsWith('--')) {
                throw new TypeError('--owner requires an organization login');
            }
            owner = next;
            index += 1;
        } else if (argument === '--help' || argument === '-h') {
            throw new CliHelpRequested();
        } else {
            throw new TypeError(`Unknown argument: ${argument}`);
        }
    }
    if (owner !== undefined && !diagnoseGitHub) {
        throw new TypeError('--owner is valid only with --diagnose-github');
    }
    if (diagnoseGitHub && collectionOptionUsed) {
        throw new TypeError(
            '--diagnose-github is mutually exclusive with collection options',
        );
    }
    if (!demo && demoLimitUsed) {
        throw new TypeError('--demo-limit is valid only with --demo');
    }
    if (demo) {
        if (!university) {
            throw new TypeError('--demo requires exactly one --university <key>');
        }
        if (universityOptionCount !== 1) {
            throw new TypeError('--demo accepts exactly one --university <key>');
        }
        if (mode === 'refresh') {
            throw new TypeError('--mode refresh cannot be used with --demo');
        }
        if (runId !== undefined) {
            throw new TypeError('--run-id cannot be used with --demo');
        }
        if (strictUsed) {
            throw new TypeError('--strict cannot be used with --demo');
        }
    }
    return {
        configPath,
        verbose,
        policy,
        mode,
        ...(university ? { university } : {}),
        ...(runId ? { runId } : {}),
        ...(diagnoseGitHub ? { diagnoseGitHub: true } : {}),
        ...(owner ? { owner } : {}),
        ...(demo ? { demo: true, demoLimit } : {}),
    };
}

export function parseCliArguments(arguments_: readonly string[]): string {
    return parseCliOptions(arguments_).configPath;
}

export async function withDatabasePreflight<T>(
    preflight: () => Promise<void>,
    scrape: () => Promise<T>,
): Promise<T> {
    await preflight();
    return scrape();
}

export async function runCli(
    arguments_: readonly string[],
    dependencies: CliRuntimeDependencies = {},
): Promise<number> {
    const diagnosticInvocation = arguments_.includes('--diagnose-github');
    const tokenProvenance =
        dependencies.tokenProvenance ?? getCurrentTokenProvenance();
    let options: CliOptions;
    try {
        options = parseCliOptions(arguments_);
    } catch (error) {
        if (error instanceof CliHelpRequested) throw error;
        if (!diagnosticInvocation) throw error;
        const result = createConfigurationGitHubDiagnostic(
            getGitHubCredentialState(tokenProvenance),
            'invalid-arguments',
            'Use --diagnose-github --owner <organization> by itself, without collection options.',
        );
        writeGitHubDiagnostic(dependencies.stdout, result.diagnostic);
        return result.exitCode;
    }
    if (options.diagnoseGitHub) {
        return runGitHubDiagnosticCli(
            options.owner,
            tokenProvenance,
            dependencies,
        );
    }
    const { configPath, verbose, policy, mode, university, runId } = options;
    const loadedConfiguration = await loadScrapingConfiguration(configPath);
    const selectedUniversities = university
        ? loadedConfiguration.universities.filter(
              (candidate) => candidate.key === university,
          )
        : loadedConfiguration.universities;
    if (selectedUniversities.length === 0) {
        throw new TypeError(
            `University is not configured: ${sanitizeDiagnosticText(university ?? '')}`,
        );
    }
    const configuration = {
        ...loadedConfiguration,
        universities: selectedUniversities,
    };
    if (options.demo) {
        if (selectedUniversities.length !== 1) {
            throw new TypeError('--demo requires exactly one configured university');
        }
        return runDemoCli(
            configuration,
            selectedUniversities[0],
            options.demoLimit ?? 10,
            dependencies,
            verbose,
        );
    }
    const collectionRunId =
        runId ?? (process.env.GITHUB_RUN_ID?.trim() || randomUUID());
    const output = dependencies.stdout ?? process.stdout;
    const errorOutput = dependencies.stderr ?? process.stderr;
    let collectionRuntime: CliCollectionRuntime;
    if (dependencies.createCollectionRuntime) {
        collectionRuntime = await dependencies.createCollectionRuntime();
    } else {
        // Validate all database settings before constructing the client or making requests.
        getDatabasePoolConfig();
        const pool = createDatabasePool();
        collectionRuntime = {
            store: new RepositoryStore(pool, configuration.databaseBatchSize),
            close: () => pool.end(),
        };
    }
    const store = collectionRuntime.store;
    const renderer = verbose
        ? new CliProgressRenderer({ stdout: output })
        : undefined;
    const controller = new AbortController();
    let interruptionExitCode = 130;
    const onInterrupt = () => {
        if (controller.signal.aborted) return;
        interruptionExitCode = 130;
        controller.abort(new ScrapingCancellationError('SIGINT'));
    };
    const onTerminate = () => {
        if (controller.signal.aborted) return;
        interruptionExitCode = 143;
        controller.abort(new ScrapingCancellationError('SIGTERM'));
    };
    const installSignalHandlers = dependencies.signalHandlers !== false;
    if (installSignalHandlers) {
        process.once('SIGINT', onInterrupt);
        process.once('SIGTERM', onTerminate);
    }
    const clientConfig: GitHubRequestConfig = {
        token: process.env.GITHUB_TOKEN,
        concurrency: configuration.repositoryConcurrency,
        onProgress: renderer?.onProgress,
    };
    const client =
        dependencies.createRequestClient?.(clientConfig) ??
        new GitHubRequestClient(clientConfig);
    renderer?.start();
    const failuresReported = new Set<string>();
    const startedAt = new Date();
    let releaseCollectionLock: (() => Promise<void>) | undefined;
    output.write(
        `Collection run ID: ${sanitizeDiagnosticText(collectionRunId)}; mode: ${mode}\n`,
    );
    try {
        const result = await withDatabasePreflight(
            async () => {
                await store.preflight();
                releaseCollectionLock = await store.acquireCollectionLock(
                    configuration.universities.map((university) => university.key),
                );
            },
            () =>
                runCollection(configuration, {
                    client,
                    store,
                    mode,
                    runId: collectionRunId,
                    policy,
                    signal: controller.signal,
                    onProgress: renderer?.onProgress,
                    onFatalError: (university, error) => {
                        failuresReported.add(university);
                        renderer?.clearForOutput();
                        writeImmediateCliFailure(
                            errorOutput,
                            university,
                            error,
                        );
                    },
                }),
        );
        renderer?.finish();

        const finishedAt = new Date();
        let reportPath: string | undefined;
        let reportError: Error | undefined;
        try {
            const report = createScrapingReport({
                startedAt,
                finishedAt,
                policy,
                universityCount: configuration.universities.length,
                result,
            });
            reportPath = await writeScrapingReport(
                report,
                path.resolve(
                    dependencies.reportDirectory ??
                        path.resolve(currentDirectory, '../reports'),
                ),
            );
        } catch (error) {
            reportError = asError(error);
            errorOutput.write(
                `REPORT WRITE FAILED: could not write the scrape report under ${path.resolve(dependencies.reportDirectory ?? path.resolve(currentDirectory, '../reports'))}: ${reportError.message}\n`,
            );
        }

        for (const university of result.results) {
            const coverage =
                university.status === 'partial'
                    ? `PARTIAL; ${university.skippedOwners.length} owners skipped, ${university.skippedRepositories.length} repositories skipped, ${university.warnings.length} text warnings; `
                    : '';
            output.write(
                `${sanitizeDiagnosticText(university.university)}: ${coverage}${university.discovered} unique repositories; ${university.committed} committed\n`,
            );
        }
        for (const failure of result.failures) {
            if (failuresReported.has(failure.university)) continue;
            renderer?.clearForOutput();
            errorOutput.write(`${formatCliFailure(failure)}\n`);
        }
        output.write(
            formatCliSummary(
                result,
                configuration.universities.length,
                policy,
                reportPath,
                controller.signal.aborted,
            ),
        );
        return getCliExitCode(
            result,
            controller.signal.aborted,
            reportError,
            interruptionExitCode,
        );
    } finally {
        renderer?.finish();
        try {
            await releaseCollectionLock?.();
        } finally {
            if (installSignalHandlers) {
                process.removeListener('SIGINT', onInterrupt);
                process.removeListener('SIGTERM', onTerminate);
            }
            await collectionRuntime.close();
        }
    }
}

async function runDemoCli(
    configuration: ScrapingConfiguration,
    university: UniversityConfiguration,
    limit: number,
    dependencies: CliRuntimeDependencies,
    verbose: boolean,
): Promise<number> {
    const output = dependencies.stdout ?? process.stdout;
    const errorOutput = dependencies.stderr ?? process.stderr;
    const renderer = verbose
        ? new CliProgressRenderer({ stdout: output })
        : undefined;
    const controller =
        dependencies.createAbortController?.() ?? new AbortController();
    let interruptionExitCode: 130 | 143 = 130;
    const onInterrupt = () => {
        if (controller.signal.aborted) return;
        interruptionExitCode = 130;
        controller.abort(new ScrapingCancellationError('SIGINT'));
    };
    const onTerminate = () => {
        if (controller.signal.aborted) return;
        interruptionExitCode = 143;
        controller.abort(new ScrapingCancellationError('SIGTERM'));
    };
    const clientConfig: GitHubRequestConfig = {
        token: process.env.GITHUB_TOKEN,
        concurrency: configuration.repositoryConcurrency,
        maxQuotaWaitMs: 5_000,
        onProgress: renderer?.onProgress,
    };
    const client =
        dependencies.createRequestClient?.(clientConfig) ??
        new GitHubRequestClient(clientConfig);
    const installSignalHandlers = dependencies.signalHandlers !== false;
    if (installSignalHandlers) {
        process.once('SIGINT', onInterrupt);
        process.once('SIGTERM', onTerminate);
    }
    const startedAt = new Date();
    renderer?.start();
    output.write(
        `DEMO sampled run for ${sanitizeDiagnosticText(university.key)}; publication: not published\n`,
    );
    output.write(`Stages omitted: ${DEMO_OMITTED_STAGES.join('; ')}\n`);
    try {
        const result = await runDemo(
            client,
            university,
            limit,
            configuration.repositoryConcurrency,
            {
                signal: controller.signal,
                onProgress: renderer?.onProgress,
            },
        );
        renderer?.finish();

        for (const repository of result.repositories) {
            output.write(
                `${repository.repositoryName}: ${repository.status.toUpperCase().replaceAll('_', ' ')}; ${formatScrapingDiagnostic(repository.diagnostic)}\n`,
            );
        }
        if (result.error) {
            const diagnostic = result.diagnostic
                ? formatScrapingDiagnostic(result.diagnostic)
                : formatScrapingError(result.error);
            errorOutput.write(`DEMO ${result.status.toUpperCase()}: ${diagnostic}\n`);
        }

        const finishedAt = new Date();
        let reportPath: string | undefined;
        let reportError: Error | undefined;
        try {
            const report = createDemoReport({ startedAt, finishedAt, result });
            reportPath = await writeDemoReport(
                report,
                path.resolve(
                    dependencies.reportDirectory ??
                        path.resolve(currentDirectory, '../reports'),
                ),
            );
        } catch (error) {
            reportError = asError(error);
            errorOutput.write(
                `DEMO REPORT WRITE FAILED under ${path.resolve(dependencies.reportDirectory ?? path.resolve(currentDirectory, '../reports'))}: ${reportError.message}\n`,
            );
        }

        const counts = {
            succeeded: result.repositories.filter(
                (item) => item.status === 'success',
            ).length,
            skipped: result.repositories.filter(
                (item) => item.status === 'skipped',
            ).length,
            failed: result.repositories.filter(
                (item) => item.status === 'failed',
            ).length,
            notRun: result.repositories.filter(
                (item) => item.status === 'not_run',
            ).length,
        };
        const demoLabel =
            reportError && result.status === 'sampled'
                ? 'FAILED (REPORT WRITE)'
                : result.status.toUpperCase();
        output.write(
            `DEMO ${demoLabel}: GitHub search total: ${result.searchTotal ?? 'unavailable'}; sampled: ${result.sampled}; succeeded: ${counts.succeeded}; skipped: ${counts.skipped}; failed: ${counts.failed}; not run: ${counts.notRun}; warnings: ${result.repositories.reduce((total, item) => total + item.warningCount, 0)}; search time: ${formatDuration(result.searchElapsedMs)}; total time: ${formatDuration(result.elapsedMs)}; publication: not published; report: ${reportPath ?? 'UNAVAILABLE (report write failed)'}\n`,
        );

        if (result.status === 'interrupted') return interruptionExitCode;
        if (result.status === 'failed' || reportError) return 1;
        return 0;
    } finally {
        renderer?.finish();
        if (installSignalHandlers) {
            process.removeListener('SIGINT', onInterrupt);
            process.removeListener('SIGTERM', onTerminate);
        }
    }
}

async function runGitHubDiagnosticCli(
    owner: string | undefined,
    tokenProvenance: GitHubTokenProvenance,
    dependencies: CliRuntimeDependencies,
): Promise<number> {
    const credential = getGitHubCredentialState(tokenProvenance);
    if (owner === undefined) {
        const result = createConfigurationGitHubDiagnostic(
            credential,
            'invalid-arguments',
            'Pass one organization login with --owner. Usage: npm start -- --diagnose-github --owner <organization>.',
        );
        writeGitHubDiagnostic(dependencies.stdout, result.diagnostic);
        return result.exitCode;
    }

    const clientConfig: GitHubRequestConfig = {
        token: process.env.GITHUB_TOKEN,
        maxRetries: 0,
        maxRateLimitRetries: 0,
    };
    const client =
        dependencies.createRequestClient?.(clientConfig) ??
        new GitHubRequestClient(clientConfig);
    const controller =
        dependencies.createAbortController?.() ?? new AbortController();
    let interruptionExitCode: 130 | 143 = 130;
    const onInterrupt = () => {
        if (controller.signal.aborted) return;
        interruptionExitCode = 130;
        controller.abort(new ScrapingCancellationError('SIGINT'));
    };
    const onTerminate = () => {
        if (controller.signal.aborted) return;
        interruptionExitCode = 143;
        controller.abort(new ScrapingCancellationError('SIGTERM'));
    };
    const installHandlers = dependencies.signalHandlers !== false;
    if (installHandlers) {
        process.once('SIGINT', onInterrupt);
        process.once('SIGTERM', onTerminate);
    }

    try {
        const result = await diagnoseGitHubAccess(
            client,
            owner,
            credential,
            controller.signal,
        );
        writeGitHubDiagnostic(dependencies.stdout, result.diagnostic);
        return result.exitCode;
    } catch (error) {
        if (!controller.signal.aborted) throw error;
        const result = createInterruptedGitHubDiagnostic(
            credential,
            owner,
            interruptionExitCode,
        );
        writeGitHubDiagnostic(dependencies.stdout, result.diagnostic);
        return result.exitCode;
    } finally {
        if (installHandlers) {
            process.removeListener('SIGINT', onInterrupt);
            process.removeListener('SIGTERM', onTerminate);
        }
    }
}

function writeGitHubDiagnostic(
    output: Pick<NodeJS.WriteStream, 'write'> | undefined,
    diagnostic: GitHubAccessDiagnostic,
): void {
    (output ?? process.stdout).write(`${JSON.stringify(diagnostic, null, 2)}\n`);
}

export function formatCliFailure(failure: ScrapeUniversityFailure): string {
    const discovered =
        failure.discovered === undefined
            ? 'repository discovery incomplete'
            : `${failure.discovered} unique repositories discovered; 0 committed`;
    const skipped = failure.skippedOwners.length
        ? `; ${failure.skippedOwners.length} owners skipped before failure`
        : '';
    const skippedRepositories = failure.skippedRepositories.length
        ? `; ${failure.skippedRepositories.length} repositories skipped before failure`
        : '';
    const warnings = failure.warnings.length
        ? `; ${failure.warnings.length} text warnings before failure`
        : '';
    return `${sanitizeDiagnosticText(failure.university)}: FAILED: ${discovered}${skipped}${skippedRepositories}${warnings}: ${formatScrapingError(failure.error)}`;
}

export function getCliExitCode(
    result: ScrapingRunResult,
    interrupted: boolean,
    reportError?: Error,
    interruptionExitCode = 130,
): number {
    if (result.failed > 0) return 1;
    if (interrupted) return interruptionExitCode;
    if (reportError) return 1;
    if (result.partial > 0) return 2;
    return 0;
}

export function formatCliSummary(
    result: ScrapingRunResult,
    universityCount: number,
    policy: ScrapingPolicy,
    reportPath: string | undefined,
    interrupted: boolean,
): string {
    const interruptedUniversities = result.outcomes.filter(
        (outcome) => outcome.status === 'interrupted',
    );
    const allObservedUniversities = [
        ...result.results,
        ...result.failures,
        ...interruptedUniversities,
    ];
    const skippedOwners = allObservedUniversities.reduce(
        (total, university) => total + university.skippedOwners.length,
        0,
    );
    const skippedRepositories = allObservedUniversities.reduce(
        (total, university) => total + university.skippedRepositories.length,
        0,
    );
    const warnings = allObservedUniversities.reduce(
        (total, university) => total + university.warnings.length,
        0,
    );
    const label = result.failed > 0 && interrupted
        ? 'FAILED AND INTERRUPTED'
        : interrupted
          ? 'INTERRUPTED'
          : reportPath === undefined
          ? 'FAILED (REPORT WRITE)'
          : result.failed > 0 && result.partial > 0
            ? 'FAILED WITH PARTIAL COVERAGE'
            : result.failed > 0
              ? 'FINISHED WITH FAILURES'
              : result.partial > 0 && result.committed > 0
                ? 'PARTIAL SUCCESS'
                : result.partial > 0
                  ? 'PARTIAL COMPLETION'
                  : 'COMPLETED';
    return `${label} in ${formatDuration(result.elapsedMs)}. Universities processed: ${result.universitiesProcessed}/${universityCount}; complete: ${result.results.length - result.partial}; partial: ${result.partial}; failed: ${result.failed}; interrupted: ${result.interrupted}; not run: ${result.outcomes.filter((outcome) => outcome.status === 'not_run').length}; skipped owners: ${skippedOwners}; skipped repositories: ${skippedRepositories}; text warnings: ${warnings}; repository associations committed: ${result.committed}; policy: ${policy}; report: ${reportPath ?? 'UNAVAILABLE (report write failed)'}\n`;
}

export function writeImmediateCliFailure(
    stderr: Pick<NodeJS.WriteStream, 'write'>,
    university: string,
    error: Error,
): void {
    stderr.write(
        `${sanitizeDiagnosticText(university)}: FAILED; 0 committed; cleaning up: ${formatScrapingError(error)}\n`,
    );
}

class CliHelpRequested extends Error {
    constructor() {
        super('help requested');
    }
}

function formatDuration(milliseconds: number): string {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    return hours
        ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
        : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function isDirectExecution(moduleUrl: string): boolean {
    const invokedPath = process.argv[1];
    return (
        invokedPath !== undefined &&
        path.resolve(invokedPath) === fileURLToPath(moduleUrl)
    );
}

if (isDirectExecution(import.meta.url)) {
    const tokenProvenance = loadEnvironmentFile(
        path.resolve(currentDirectory, '../../.env'),
    );
    void runCli(process.argv.slice(2), { tokenProvenance })
        .then((exitCode) => {
            process.exitCode = exitCode;
        })
        .catch((error: unknown) => {
            if (error instanceof CliHelpRequested) {
                process.stdout.write(
                    'Usage: npm start -- [--config <path>] [--mode full|refresh] [--university <key>] [--run-id <id>] [--strict] [--verbose|-v]\n       npm start -- --config <path> --university <key> --demo [--demo-limit 10] [--verbose]\n       npm start -- --diagnose-github --owner <organization>\nThe diagnostic checks one page of GET /orgs/{owner}/repos using the credential selected by the finder. It does not use PostgreSQL or run a collection.\nDemo mode requires one configured university and samples at most the first 100 repository search results (10 by default). It omits organization/user searches, owner enumeration, complete discovery, and all database operations. It writes a demo report under find/reports and never publishes data. Quota waits are capped at 5 seconds; longer waits fail promptly.\nFull mode discovers and enriches repositories. Refresh mode conditionally checks known repositories and enriches changed ones. --university limits a collection to one configured university; --run-id resumes durable PostgreSQL checkpoints. Best-effort skips documented unavailable owners and repository-level access failures; --strict fails instead of skipping. Descriptive NUL text is normalized and reported under both policies. PG* variables configure PostgreSQL and GITHUB_TOKEN is optional.\nExit codes: 0 complete collection or successful sampled demo, 2 partial collection coverage, 1 fatal failure; SIGINT/SIGTERM retain 130/143.\n',
                );
                return;
            }
            process.stderr.write(
                `${error instanceof ScrapingDatabasePreflightError ? formatScrapingError(error) : error instanceof Error ? error.message : String(error)}\n`,
            );
            process.exitCode = 1;
        });
}
