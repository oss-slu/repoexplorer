import { config as loadDotEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScrapingConfiguration } from './config';
import { createDatabasePool, getDatabasePoolConfig } from './db/connect';
import { RepositoryStore } from './db/repositoryStore';
import { runScraping } from './runner';
import { GitHubRequestClient } from './utils/githubRequest';
import { formatScrapingError } from './utils/formatScrapingError';
import { CliProgressRenderer } from './utils/progressRenderer';
import {
    createScrapingReport,
    writeScrapingReport,
} from './utils/scrapingReport';
import type {
    OwnerListingPolicy,
    ScrapeUniversityFailure,
    ScrapingRunResult,
} from './types/scraping';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export interface CliOptions {
    configPath: string;
    verbose: boolean;
    policy: OwnerListingPolicy;
}

export function parseCliOptions(arguments_: readonly string[]): CliOptions {
    let configPath =
        process.env.UNIVERSITIES_CONFIG ?? 'config/universities.json';
    let verbose = false;
    let policy: OwnerListingPolicy = 'best-effort';
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (argument === '--config') {
            const next = arguments_[index + 1];
            if (!next || next.startsWith('--')) {
                throw new TypeError('--config requires a file path');
            }
            configPath = next;
            index += 1;
        } else if (argument === '--verbose' || argument === '-v') {
            verbose = true;
        } else if (argument === '--strict') {
            policy = 'strict';
        } else if (argument === '--help' || argument === '-h') {
            throw new CliHelpRequested();
        } else {
            throw new TypeError(`Unknown argument: ${argument}`);
        }
    }
    return { configPath, verbose, policy };
}

export function parseCliArguments(arguments_: readonly string[]): string {
    return parseCliOptions(arguments_).configPath;
}

export async function runCli(arguments_: readonly string[]): Promise<number> {
    const { configPath, verbose, policy } = parseCliOptions(arguments_);
    const configuration = await loadScrapingConfiguration(configPath);
    // Validate all database settings before constructing the client or making requests.
    getDatabasePoolConfig();
    const pool = createDatabasePool();
    const renderer = verbose
        ? new CliProgressRenderer({ stdout: process.stdout })
        : undefined;
    const controller = new AbortController();
    let interruptionExitCode = 130;
    const onInterrupt = () => {
        interruptionExitCode = 130;
        controller.abort(new Error('Scrape interrupted by SIGINT'));
    };
    const onTerminate = () => {
        interruptionExitCode = 143;
        controller.abort(new Error('Scrape interrupted by SIGTERM'));
    };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    const client = new GitHubRequestClient({
        token: process.env.GITHUB_TOKEN,
        concurrency: configuration.repositoryConcurrency,
        onProgress: renderer?.onProgress,
    });
    renderer?.start();
    const failuresReported = new Set<string>();
    const startedAt = new Date();
    try {
        const result = await runScraping(configuration, {
            client,
            store: new RepositoryStore(pool, configuration.databaseBatchSize),
            policy,
            signal: controller.signal,
            onProgress: renderer?.onProgress,
            onFatalError: (university, error) => {
                failuresReported.add(university);
                renderer?.clearForOutput();
                writeImmediateCliFailure(process.stderr, university, error);
            },
        });
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
                path.resolve(currentDirectory, '../reports'),
            );
        } catch (error) {
            reportError = asError(error);
            process.stderr.write(
                `REPORT WRITE FAILED: could not write the scrape report under ${path.resolve(currentDirectory, '../reports')}: ${reportError.message}\n`,
            );
        }

        for (const university of result.results) {
            const coverage =
                university.status === 'partial'
                    ? `PARTIAL; ${university.skippedOwners.length} owners skipped; `
                    : '';
            process.stdout.write(
                `${university.university}: ${coverage}${university.discovered} unique repositories; ${university.committed} committed\n`,
            );
        }
        for (const failure of result.failures) {
            if (failuresReported.has(failure.university)) continue;
            renderer?.clearForOutput();
            process.stderr.write(`${formatCliFailure(failure)}\n`);
        }
        process.stdout.write(
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
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onTerminate);
        await pool.end();
    }
}

export function formatCliFailure(failure: ScrapeUniversityFailure): string {
    const discovered =
        failure.discovered === undefined
            ? 'repository discovery incomplete'
            : `${failure.discovered} unique repositories discovered; 0 committed`;
    const skipped = failure.skippedOwners.length
        ? `; ${failure.skippedOwners.length} owners skipped before failure`
        : '';
    return `${failure.university}: FAILED: ${discovered}${skipped}: ${formatScrapingError(failure.error)}`;
}

export function getCliExitCode(
    result: ScrapingRunResult,
    interrupted: boolean,
    reportError?: Error,
    interruptionExitCode = 130,
): number {
    if (interrupted) return interruptionExitCode;
    if (result.failed > 0 || reportError) return 1;
    if (result.partial > 0) return 2;
    return 0;
}

export function formatCliSummary(
    result: ScrapingRunResult,
    universityCount: number,
    policy: OwnerListingPolicy,
    reportPath: string | undefined,
    interrupted: boolean,
): string {
    const skippedOwners = [...result.results, ...result.failures].reduce(
        (total, university) => total + university.skippedOwners.length,
        0,
    );
    const label = interrupted
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
    return `${label} in ${formatDuration(result.elapsedMs)}. Universities processed: ${result.universitiesProcessed}/${universityCount}; complete: ${result.results.length - result.partial}; partial: ${result.partial}; failed: ${result.failed}; skipped owners: ${skippedOwners}; repository associations committed: ${result.committed}; policy: ${policy}; report: ${reportPath ?? 'UNAVAILABLE (report write failed)'}\n`;
}

export function writeImmediateCliFailure(
    stderr: Pick<NodeJS.WriteStream, 'write'>,
    university: string,
    error: Error,
): void {
    stderr.write(
        `${university}: FAILED; 0 committed; cleaning up: ${formatScrapingError(error)}\n`,
    );
}

class CliHelpRequested extends Error {
    constructor() {
        super('help requested');
    }
}

function loadEnvironmentFile(): void {
    loadDotEnv({
        path: path.resolve(currentDirectory, '../../.env'),
        override: false,
        quiet: true,
    });
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
    loadEnvironmentFile();
    void runCli(process.argv.slice(2))
        .then((exitCode) => {
            process.exitCode = exitCode;
        })
        .catch((error: unknown) => {
            if (error instanceof CliHelpRequested) {
                process.stdout.write(
                    'Usage: npm start -- [--config <path>] [--strict] [--verbose|-v]\nOwner-listing 404s are skipped by default; --strict restores all-or-nothing discovery. Configuration contains universities; PG* variables configure PostgreSQL and GITHUB_TOKEN is optional.\nExit codes: 0 complete, 2 partial coverage, 1 fatal failure; SIGINT/SIGTERM retain 130/143.\n',
                );
                return;
            }
            process.stderr.write(
                `${error instanceof Error ? error.message : String(error)}\n`,
            );
            process.exitCode = 1;
        });
}
