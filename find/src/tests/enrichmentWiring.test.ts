import { runCollection } from '../collectionRunner';
import type { RepositoryCollectionStorePort } from '../collectionRunner';
import { runScraping } from '../runner';
import type { RepositoryStorePort } from '../runner';
import type {
    CollectionMode,
    EnrichmentApi,
    RepositoryCandidate,
    RepositoryCollectionCheckpoint,
    RepositoryScrapingRecord,
    ScrapingConfiguration,
    UniversityCollectionCheckpoint,
} from '../types/scraping';
import { createFakeGitHub } from './fakeGitHubRepository';
import type { FakeRepository, RecordedRequest } from './fakeGitHubRepository';

const now = () => new Date('2026-11-02T00:00:00Z');

function configuration(enrichmentApi?: EnrichmentApi): ScrapingConfiguration {
    return {
        universities: [
            {
                key: 'Saint Louis University',
                fullName: 'Saint Louis University',
                acronym: 'SLU',
                queries: {
                    repositories: 'org:slu',
                    organizations: 'slu type:org',
                    users: 'slu type:user',
                },
            },
        ],
        repositoryConcurrency: 2,
        databaseBatchSize: 10,
        ...(enrichmentApi ? { enrichmentApi } : {}),
    };
}

function fakeRepository(name: string, id: number): FakeRepository {
    return {
        owner: 'slu',
        name,
        id,
        files: { 'README.md': `# ${name}`, 'CONTRIBUTING.md': 'guide' },
        contributors: ['alpha'],
        releases: [[3]],
        metadata: {
            id,
            name,
            full_name: `slu/${name}`,
            owner: { login: 'slu', type: 'Organization' },
            private: false,
            license: null,
            language: 'TypeScript',
            html_url: `https://github.com/slu/${name}`,
            description: 'A repository',
            fork: false,
            archived: false,
            is_template: false,
            created_at: '2020-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            pushed_at: '2024-01-01T00:00:00Z',
            homepage: null,
            size: 1,
            stargazers_count: 1,
            watchers_count: 1,
            forks_count: 0,
            open_issues_count: 0,
            subscribers_count: 1,
        },
    };
}

const repositories = [fakeRepository('one', 1), fakeRepository('two', 2)];

function enrichmentRequests(requests: readonly RecordedRequest[]) {
    return {
        graphql: requests.filter((request) => request.path === '/graphql')
            .length,
        restFiles: requests.filter((request) =>
            /\/(readme|releases|community\/profile|contents)/.test(
                request.path,
            ),
        ).length,
    };
}

/** Keeps one run's checkpoints in memory and records the published records. */
class MemoryCollectionStore implements RepositoryCollectionStorePort {
    private checkpoint: UniversityCollectionCheckpoint | undefined;
    readonly published: RepositoryScrapingRecord[] = [];

    async startOrLoadUniversityCollection(
        _runId: string,
        _university: string,
        mode: CollectionMode,
    ): Promise<UniversityCollectionCheckpoint> {
        this.checkpoint ??= {
            mode,
            status: 'discovering',
            discovered: 0,
            committed: 0,
            candidates: [],
            skippedOwners: [],
            skippedRepositories: [],
            warnings: [],
        };
        return structuredClone(this.checkpoint);
    }

    async listKnownRepositories(): Promise<RepositoryCandidate[]> {
        return [];
    }

    async saveDiscoveryCheckpoint(
        _runId: string,
        _university: string,
        candidates: readonly RepositoryCandidate[],
    ): Promise<void> {
        if (!this.checkpoint) throw new Error('Missing run');
        this.checkpoint.status = 'ready';
        this.checkpoint.discovered = candidates.length;
        this.checkpoint.candidates = candidates.map((candidate) => ({
            candidate: structuredClone(candidate),
            status: 'pending',
        }));
    }

    async saveRepositoryCheckpoint(
        _runId: string,
        _university: string,
        saved: RepositoryCollectionCheckpoint,
    ): Promise<void> {
        if (!this.checkpoint) throw new Error('Missing run');
        const index = this.checkpoint.candidates.findIndex(
            (item) => item.candidate.id === saved.candidate.id,
        );
        this.checkpoint.candidates[index] = structuredClone(saved);
    }

    async publishUniversityCollection(): Promise<number> {
        if (!this.checkpoint) throw new Error('Missing run');
        for (const item of this.checkpoint.candidates) {
            if (item.status === 'complete' && item.record) {
                this.published.push(item.record);
            }
        }
        return this.published.length;
    }
}

describe('runner enrichment wiring', () => {
    test.each([
        {
            label: 'an authenticated client',
            authenticated: true,
            api: undefined,
            graphql: true,
        },
        {
            label: 'enrichmentApi rest',
            authenticated: true,
            api: 'rest' as const,
            graphql: false,
        },
        {
            label: 'an anonymous client',
            authenticated: false,
            api: undefined,
            graphql: false,
        },
    ])(
        'runCollection reads file content through GraphQL only for $label',
        async ({ authenticated, api, graphql }) => {
            const fake = createFakeGitHub(
                repositories,
                {},
                authenticated ? {} : { token: '' },
            );
            const store = new MemoryCollectionStore();

            const result = await runCollection(configuration(api), {
                client: fake.client,
                store,
                mode: 'full',
                runId: 'wiring',
                now,
                searchRetrySleep: async () => {},
            });

            expect(result).toMatchObject({ failed: 0, committed: 2 });
            const counts = enrichmentRequests(fake.requests);
            if (graphql) {
                expect(counts.graphql).toBeGreaterThan(0);
                expect(counts.restFiles).toBe(0);
            } else {
                expect(counts.graphql).toBe(0);
                expect(counts.restFiles).toBeGreaterThan(0);
            }
            expect(store.published).toEqual([
                expect.objectContaining({
                    fullName: 'slu/one',
                    readme: '# one',
                    contributing: 'guide',
                    releaseDownloads: 3,
                }),
                expect.objectContaining({
                    fullName: 'slu/two',
                    readme: '# two',
                }),
            ]);
        },
    );

    test.each([
        { label: 'an authenticated client', api: undefined, graphql: true },
        { label: 'enrichmentApi rest', api: 'rest' as const, graphql: false },
    ])(
        'runScraping reads file content through GraphQL only for $label',
        async ({ api, graphql }) => {
            const fake = createFakeGitHub(repositories);
            const upserted: RepositoryScrapingRecord[] = [];
            const store: RepositoryStorePort = {
                async upsertUniversity(_university, records) {
                    upserted.push(...records);
                    return records.length;
                },
            };

            const result = await runScraping(configuration(api), {
                client: fake.client,
                store,
                now,
                searchRetrySleep: async () => {},
            });

            expect(result).toMatchObject({ failed: 0 });
            const counts = enrichmentRequests(fake.requests);
            expect(counts.graphql > 0).toBe(graphql);
            expect(counts.restFiles > 0).toBe(!graphql);
            expect(upserted.map((record) => record.readme).sort()).toEqual([
                '# one',
                '# two',
            ]);
        },
    );
});
