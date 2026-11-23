import { config as loadDotEnv } from 'dotenv';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateClassificationConfiguration } from './config';
import { OpenAICompatibleClient } from './classification/client';
import {
    parseEvaluationCases,
    runClassificationEvaluation,
} from './classification/evaluation';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, '../..');

export type ClassificationEvaluationCliOptions = {
    fixturesPath: string;
    configPath: string;
    outputPath: string;
};

export function parseClassificationEvaluationCliOptions(
    arguments_: readonly string[],
): ClassificationEvaluationCliOptions {
    const values: Partial<ClassificationEvaluationCliOptions> = {};
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (
            argument !== '--fixtures' &&
            argument !== '--config' &&
            argument !== '--output'
        ) {
            if (argument === '--help' || argument === '-h') {
                throw new ClassificationEvaluationCliHelpRequested();
            }
            throw new TypeError(`Unknown argument: ${argument}`);
        }
        const next = arguments_[index + 1];
        if (!next || next.startsWith('--')) {
            throw new TypeError(`${argument} requires a file path`);
        }
        const key =
            argument === '--fixtures'
                ? 'fixturesPath'
                : argument === '--config'
                  ? 'configPath'
                  : 'outputPath';
        if (values[key]) throw new TypeError(`${argument} may only be specified once`);
        values[key] = path.resolve(next);
        index += 1;
    }
    if (!values.fixturesPath || !values.configPath || !values.outputPath) {
        throw new TypeError(
            'Usage: npm run evaluate:classification -- --fixtures <file> --config <file> --output <file>',
        );
    }
    const outputRelativeToRepository = path.relative(
        repositoryRoot,
        values.outputPath,
    );
    const outputIsInsideRepository =
        outputRelativeToRepository === '' ||
        (outputRelativeToRepository !== '..' &&
            !outputRelativeToRepository.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(outputRelativeToRepository));
    if (
        outputIsInsideRepository &&
        !outputRelativeToRepository.startsWith(`find${path.sep}reports${path.sep}`)
    ) {
        throw new TypeError(
            'Write evaluation output outside the checkout or under find/reports/, which is ignored',
        );
    }
    return values as ClassificationEvaluationCliOptions;
}

export class ClassificationEvaluationCliHelpRequested extends Error {
    constructor() {
        super(
            'Usage: npm run evaluate:classification -- --fixtures <file> --config <file> --output <file>',
        );
    }
}

export async function runClassificationEvaluationCli(
    arguments_: readonly string[],
): Promise<number> {
    loadDotEnv({
        path: path.join(repositoryRoot, '.env'),
        override: false,
        quiet: true,
    });
    const options = parseClassificationEvaluationCliOptions(arguments_);
    const [fixtureText, configurationText] = await Promise.all([
        readFile(options.fixturesPath, 'utf8'),
        readFile(options.configPath, 'utf8'),
    ]);
    const fixtures = parseEvaluationCases(parseJson(fixtureText, 'fixtures'));
    const rawConfiguration = parseJson(configurationText, 'evaluation config');
    const configuration = validateClassificationConfiguration(
        isRecord(rawConfiguration) && rawConfiguration.classification !== undefined
            ? rawConfiguration.classification
            : rawConfiguration,
    );
    const apiKey = process.env[configuration.apiKeyEnv] ?? '';
    const client = new OpenAICompatibleClient({
        provider: configuration.provider,
        baseUrl: configuration.baseUrl,
        model: configuration.model,
        apiKey: apiKey || (isLoopbackEndpoint(configuration.baseUrl) ? 'ollama' : ''),
        timeoutMs: configuration.timeoutMs,
        maxRetries: configuration.maxRetries,
        generation: configuration.generation,
    });
    const controller = new AbortController();
    let interruptionExitCode = 130;
    const onInterrupt = () => {
        interruptionExitCode = 130;
        controller.abort(new Error('Evaluation interrupted by SIGINT'));
    };
    const onTerminate = () => {
        interruptionExitCode = 143;
        controller.abort(new Error('Evaluation interrupted by SIGTERM'));
    };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    try {
        const report = await runClassificationEvaluation({
            cases: fixtures,
            client,
            configuration,
            concurrency: configuration.concurrency,
            signal: controller.signal,
        });
        await writeEvaluationReport(report, options.outputPath);
        process.stdout.write(
            `Evaluation ${report.interrupted ? 'interrupted' : 'completed'}: ${report.caseCount}/${fixtures.length} cases; provider replies ${report.providerResults.success}/${report.providerResults.logicalRequests}; HTTP attempts ${report.providerResults.transportAttempts.count ?? 'partially unavailable'}; production pipeline accepted ${report.productionPipeline.accepted.affiliation.valid + report.productionPipeline.accepted.projectType.valid}/${report.caseCount * 2} (${report.productionPipeline.followUpRequests} follow-up requests); report: ${options.outputPath}\n`,
        );
        return report.interrupted ? interruptionExitCode : 0;
    } finally {
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onTerminate);
    }
}

export async function writeEvaluationReport(
    report: Awaited<ReturnType<typeof runClassificationEvaluation>>,
    outputPath: string,
): Promise<void> {
    await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
    });
    await chmod(outputPath, 0o600);
}

function parseJson(value: string, label: string): unknown {
    try {
        return JSON.parse(value);
    } catch (error) {
        throw new TypeError(`${label} file must contain valid JSON`, { cause: error });
    }
}

function isLoopbackEndpoint(value: string): boolean {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
        hostname === 'localhost' ||
        hostname === '::1' ||
        hostname === '[::1]' ||
        /^127(?:\.\d{1,3}){3}$/.test(hostname)
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
