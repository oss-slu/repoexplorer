import { config as loadDotEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScrapingConfiguration } from './config';
import { createDatabasePool, getDatabasePoolConfig } from './db/connect';
import {
    createEvidenceMockClient,
    OpenAICompatibleClient,
    RandomSimulationClient,
    type ClassificationClient,
} from './classification/client';
import { ClassificationStore } from './classification/store';
import { runClassification } from './classification/runner';
import { writeClassificationReport } from './classification/report';
import { ClassificationProgressPrinter } from './classification/progress';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, '../..');

export type ClassificationCliOptions = {
    configPath: string;
    mode: 'provider' | 'mock' | 'simulate';
    seed?: number;
};

export function parseClassificationCliOptions(
    arguments_: readonly string[],
): ClassificationCliOptions {
    let configPath =
        process.env.UNIVERSITIES_CONFIG ?? 'config/universities.json';
    let mode: ClassificationCliOptions['mode'] = 'provider';
    let selectedMode = false;
    let seed: number | undefined;
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (argument === '--config') {
            const next = arguments_[index + 1];
            if (!next || next.startsWith('--'))
                throw new TypeError('--config requires a file path');
            configPath = next;
            index += 1;
        } else if (argument === '--mock' || argument === '--simulate') {
            if (selectedMode)
                throw new TypeError(
                    '--mock and --simulate are mutually exclusive',
                );
            selectedMode = true;
            mode = argument === '--mock' ? 'mock' : 'simulate';
        } else if (argument === '--seed') {
            const next = arguments_[index + 1];
            if (!next || next.startsWith('--') || !/^-?\d+$/.test(next)) {
                throw new TypeError('--seed requires an integer');
            }
            seed = Number(next);
            if (!Number.isSafeInteger(seed))
                throw new TypeError('--seed must be a safe integer');
            index += 1;
        } else if (argument === '--help' || argument === '-h') {
            throw new ClassificationCliHelpRequested();
        } else {
            throw new TypeError(`Unknown argument: ${argument}`);
        }
    }
    if (mode === 'simulate' && seed === undefined) {
        throw new TypeError(
            '--simulate requires --seed so runs are reproducible',
        );
    }
    if (mode !== 'simulate' && seed !== undefined) {
        throw new TypeError('--seed can only be used with --simulate');
    }
    return { configPath, mode, ...(seed === undefined ? {} : { seed }) };
}

export class ClassificationCliHelpRequested extends Error {
    constructor() {
        super(
            'Usage: npm run classify -- [--config path] [--mock | --simulate --seed integer]',
        );
    }
}

export async function runClassificationCli(
    arguments_: readonly string[],
): Promise<number> {
    loadDotEnv({
        path: path.join(repositoryRoot, '.env'),
        override: false,
        quiet: true,
    });
    const options = parseClassificationCliOptions(arguments_);
    const configuration = await loadScrapingConfiguration(options.configPath);
    if (!configuration.classification) {
        throw new TypeError(
            'The configuration has no classification block; copy one from config/universities.example.json',
        );
    }
    getDatabasePoolConfig();
    const pool = createDatabasePool();
    const controller = new AbortController();
    let interruptionExitCode = 130;
    const onInterrupt = () => {
        interruptionExitCode = 130;
        controller.abort(new Error('Classification interrupted by SIGINT'));
    };
    const onTerminate = () => {
        interruptionExitCode = 143;
        controller.abort(new Error('Classification interrupted by SIGTERM'));
    };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    try {
        const client = createClient(options, configuration.classification);
        // Progress goes to stderr so stdout keeps only the final summary line.
        const progress = new ClassificationProgressPrinter({
            output: process.stderr,
        });
        let report: Awaited<ReturnType<typeof runClassification>>;
        try {
            report = await runClassification({
                store: new ClassificationStore(pool),
                client,
                configuration: configuration.classification,
                universities: configuration.universities,
                signal: controller.signal,
                onProgress: progress.onProgress,
            });
        } finally {
            progress.finish();
        }
        const reportPath = await writeClassificationReport(
            report,
            path.resolve(currentDirectory, '../reports'),
        );
        process.stdout.write(formatClassificationSummary(report, reportPath));
        for (const failure of report.failures) {
            process.stderr.write(
                `${failure.university} #${failure.repositoryId} ${failure.task}: ${failure.message}\n`,
            );
        }
        if (report.interrupted) return interruptionExitCode;
        return report.failures.length > 0 ? 1 : 0;
    } finally {
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onTerminate);
        await pool.end();
    }
}

function createClient(
    options: ClassificationCliOptions,
    configuration: NonNullable<
        Awaited<ReturnType<typeof loadScrapingConfiguration>>['classification']
    >,
): ClassificationClient {
    if (options.mode === 'mock') return createEvidenceMockClient();
    if (options.mode === 'simulate')
        return new RandomSimulationClient(options.seed!);
    const apiKey = process.env[configuration.apiKeyEnv];
    if (!apiKey || apiKey.trim() === '') {
        throw new TypeError(
            `Set ${configuration.apiKeyEnv} before using the configured provider`,
        );
    }
    return new OpenAICompatibleClient({
        provider: configuration.provider,
        baseUrl: configuration.baseUrl,
        model: configuration.model,
        apiKey,
        timeoutMs: configuration.timeoutMs,
        maxRetries: configuration.maxRetries,
        generation: configuration.generation,
    });
}

export function formatClassificationSummary(
    report: Awaited<ReturnType<typeof runClassification>>,
    reportPath: string,
): string {
    const totals = report.universities.reduce(
        (sum, university) => ({
            candidates: sum.candidates + university.candidates,
            eligible: sum.eligible + university.eligible,
            ineligible: sum.ineligible + university.ineligible,
            affiliationPredicted:
                sum.affiliationPredicted + university.affiliationPredicted,
            belowThreshold: sum.belowThreshold + university.belowThreshold,
            affiliationNotSupported:
                sum.affiliationNotSupported + university.affiliationNotSupported,
            affiliationUncertain:
                sum.affiliationUncertain + university.affiliationUncertain,
            projectTypesPredicted:
                sum.projectTypesPredicted + university.projectTypesPredicted,
            reused: sum.reused + university.reused,
            failed: sum.failed + university.failed,
            citationRepairs: sum.citationRepairs + university.citationRepairs,
            repairedResults: sum.repairedResults + university.repairedResults,
            scoreRetries: sum.scoreRetries + university.scoreRetries,
            scoreRetriesRecovered:
                sum.scoreRetriesRecovered + university.scoreRetriesRecovered,
            downgraded: sum.downgraded + university.downgraded,
            prefiltered: sum.prefiltered + university.prefiltered,
        }),
        {
            candidates: 0,
            eligible: 0,
            ineligible: 0,
            affiliationPredicted: 0,
            belowThreshold: 0,
            affiliationNotSupported: 0,
            affiliationUncertain: 0,
            projectTypesPredicted: 0,
            reused: 0,
            failed: 0,
            citationRepairs: 0,
            repairedResults: 0,
            scoreRetries: 0,
            scoreRetriesRecovered: 0,
            downgraded: 0,
            prefiltered: 0,
        },
    );
    const state = report.interrupted
        ? 'INTERRUPTED'
        : totals.failed
          ? 'FINISHED WITH FAILURES'
          : 'COMPLETED';
    const seed =
        report.simulationSeed === undefined
            ? ''
            : `; simulation seed: ${report.simulationSeed}`;
    return `${state} in ${(report.elapsedMs / 1000).toFixed(1)}s; candidates: ${totals.candidates}; eligible: ${totals.eligible}; ineligible: ${totals.ineligible}; affiliation supported: ${totals.affiliationPredicted}; below threshold: ${totals.belowThreshold}; not supported: ${totals.affiliationNotSupported}; uncertain: ${totals.affiliationUncertain}; downgraded: ${totals.downgraded}; prefiltered: ${totals.prefiltered}; project types: ${totals.projectTypesPredicted}; semantic review: ${report.semanticReviewFindings.length}; repaired citations: ${totals.citationRepairs} in ${totals.repairedResults} results; score retries: ${totals.scoreRetries} (${totals.scoreRetriesRecovered} recovered); resumed: ${totals.reused}; failed: ${totals.failed}; provider: ${report.provider}/${report.model}; simulated: ${report.simulated}${seed}; report: ${reportPath}\n`;
}
