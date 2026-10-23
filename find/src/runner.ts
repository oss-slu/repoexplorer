import { discoverRepositories } from './discoverRepositories';
import { enrichRepository } from './enrichRepository';
import { mapWithConcurrency } from './utils/concurrency';
import { GitHubRequestClient } from './utils/githubRequest';
import type {
    RepositoryScrapingRecord,
    ScrapingConfiguration,
    ScrapeUniversityFailure,
    ScrapeUniversityResult,
    ScrapingRunResult,
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
};

export async function runScraping(
    configuration: ScrapingConfiguration,
    dependencies: ScrapingRunnerDependencies,
): Promise<ScrapingRunResult> {
    const results: ScrapeUniversityResult[] = [];
    const failures: ScrapeUniversityFailure[] = [];

    for (const university of configuration.universities) {
        try {
            const result = await scrapeUniversity(
                dependencies.client,
                dependencies.store,
                university,
                configuration.repositoryConcurrency,
                dependencies.now,
            );
            results.push(result);
        } catch (error) {
            if (error instanceof UniversityScrapeError) {
                failures.push({
                    university: university.key,
                    discovered: error.discovered,
                    error: error.scrapeError,
                });
            } else {
                failures.push({
                    university: university.key,
                    error: asError(error),
                });
            }
        }
    }

    return {
        universitiesProcessed: results.length + failures.length,
        committed: results.reduce(
            (total, result) => total + result.committed,
            0,
        ),
        failed: failures.length,
        results,
        failures,
    };
}

async function scrapeUniversity(
    client: GitHubRequestClient,
    store: RepositoryStorePort,
    university: UniversityConfiguration,
    repositoryConcurrency: number,
    now?: () => Date,
): Promise<ScrapeUniversityResult> {
    let discovered: number | undefined;
    try {
        const discovery = await discoverRepositories(
            client,
            university,
            repositoryConcurrency,
        );
        discovered = discovery.candidates.length;
        const records = await mapWithConcurrency(
            discovery.candidates,
            repositoryConcurrency,
            async (candidate) =>
                enrichRepository(client, candidate, university, now),
        );
        const committed = await store.upsertUniversity(university.key, records);
        return {
            university: university.key,
            discovered,
            committed,
        };
    } catch (error) {
        throw new UniversityScrapeError(discovered, asError(error));
    }
}

class UniversityScrapeError extends Error {
    constructor(
        readonly discovered: number | undefined,
        readonly scrapeError: Error,
    ) {
        super(scrapeError.message, { cause: scrapeError });
        this.name = 'UniversityScrapeError';
    }
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
