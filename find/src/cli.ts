import { config as loadDotEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScrapingConfiguration } from './config';
import { createDatabasePool, getDatabasePoolConfig } from './db/connect';
import { RepositoryStore } from './db/repositoryStore';
import { runScraping } from './runner';
import { GitHubRequestClient } from './utils/githubRequest';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export function parseCliArguments(arguments_: readonly string[]): string {
    let configPath =
        process.env.UNIVERSITIES_CONFIG ?? 'config/universities.json';
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (argument === '--config') {
            const next = arguments_[index + 1];
            if (!next || next.startsWith('--')) {
                throw new TypeError('--config requires a file path');
            }
            configPath = next;
            index += 1;
        } else if (argument === '--help' || argument === '-h') {
            throw new CliHelpRequested();
        } else {
            throw new TypeError(`Unknown argument: ${argument}`);
        }
    }
    return configPath;
}

export async function runCli(arguments_: readonly string[]): Promise<number> {
    const configPath = parseCliArguments(arguments_);
    const configuration = await loadScrapingConfiguration(configPath);
    // Validate all database settings before constructing the client or making requests.
    getDatabasePoolConfig();
    const pool = createDatabasePool();
    const client = new GitHubRequestClient({
        token: process.env.GITHUB_TOKEN,
        concurrency: configuration.repositoryConcurrency,
    });
    try {
        const result = await runScraping(configuration, {
            client,
            store: new RepositoryStore(pool, configuration.databaseBatchSize),
        });
        for (const university of result.results) {
            console.log(
                `${university.university}: ${university.discovered} unique repositories; ${university.committed} committed`,
            );
        }
        for (const failure of result.failures) {
            const discovered =
                failure.discovered === undefined
                    ? 'repository discovery incomplete'
                    : `${failure.discovered} unique repositories discovered; 0 committed`;
            console.error(
                `${failure.university}: FAILED: ${discovered}: ${failure.error.message}`,
            );
        }
        console.log(
            `Universities processed: ${result.universitiesProcessed}/${configuration.universities.length}; repository associations committed: ${result.committed}; failed universities: ${result.failed}`,
        );
        return result.failed === 0 ? 0 : 1;
    } finally {
        await pool.end();
    }
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
    });
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
                console.log(
                    'Usage: npm start -- --config <path>\nConfiguration contains universities; PG* variables configure PostgreSQL and GITHUB_TOKEN is optional.',
                );
                return;
            }
            console.error(
                error instanceof Error ? error.message : String(error),
            );
            process.exitCode = 1;
        });
}
