import { runCollection } from '../collectionRunner';
import { formatScrapingError } from '../utils/formatScrapingError';
import type { RepositoryCollectionStorePort } from '../collectionRunner';
import type {
    CollectionMode,
    RepositoryCandidate,
    RepositoryCollectionCheckpoint,
    ScrapingConfiguration,
    SkippedOwner,
    UniversityCollectionCheckpoint,
} from '../types/scraping';
import {
    createTestClient,
    jsonResponse,
    searchEnvelope,
} from './githubFixtures';

const configuration: ScrapingConfiguration = {
    universities: [
        { key: 'University One', fullName: 'University One', acronym: 'U1' },
    ],
    repositoryConcurrency: 1,
    databaseBatchSize: 10,
};

function repository(id: number, fullName: string): Record<string, unknown> {
    const [owner] = fullName.split('/');
    return {
        id,
        name: fullName.split('/')[1],
        full_name: fullName,
        owner: { login: owner, type: 'Organization' },
        private: false,
        license: null,
        language: 'TypeScript',
        html_url: `https://github.com/${fullName}`,
        description: null,
        fork: false,
        created_at: '2020-01-01T00:00:00Z',
        updated_at: '2020-01-02T00:00:00Z',
        pushed_at: null,
        homepage: null,
        size: 1,
        stargazers_count: 0,
        watchers_count: 0,
        forks_count: 0,
        open_issues_count: 0,
        subscribers_count: 0,
    };
}

class MemoryCollectionStore implements RepositoryCollectionStorePort {
    readonly runs = new Map<string, UniversityCollectionCheckpoint>();
    readonly known: RepositoryCandidate[] = [];
    publishCalls = 0;

    async startOrLoadUniversityCollection(
        runId: string,
        _university: string,
        mode: CollectionMode,
    ): Promise<UniversityCollectionCheckpoint> {
        const key = `${runId}:${mode}`;
        let checkpoint = this.runs.get(key);
        if (!checkpoint) {
            checkpoint = {
                mode,
                status: 'discovering',
                discovered: 0,
                committed: 0,
                candidates: [],
                skippedOwners: [],
                skippedRepositories: [],
                warnings: [],
            };
            this.runs.set(key, checkpoint);
        }
        return structuredClone(checkpoint);
    }

    async listKnownRepositories(): Promise<RepositoryCandidate[]> {
        return structuredClone(this.known);
    }

    async saveDiscoveryCheckpoint(
        runId: string,
        _university: string,
        candidates: readonly RepositoryCandidate[],
        skippedOwners: readonly SkippedOwner[],
    ): Promise<void> {
        const checkpoint =
            this.runs.get(`${runId}:full`) ?? this.runs.get(`${runId}:refresh`);
        if (!checkpoint) throw new Error(`Missing run for ${_university}`);
        checkpoint.status = 'ready';
        checkpoint.discovered = candidates.length;
        checkpoint.skippedOwners = [...skippedOwners];
        checkpoint.candidates = candidates.map((candidate) => ({
            candidate: structuredClone(candidate),
            status: 'pending',
        }));
    }

    async saveRepositoryCheckpoint(
        runId: string,
        university: string,
        saved: RepositoryCollectionCheckpoint,
    ): Promise<void> {
        const mode = this.runs.get(`${runId}:full`) ? 'full' : 'refresh';
        const checkpoint = this.runs.get(`${runId}:${mode}`);
        if (!checkpoint) throw new Error('Missing run');
        const index = checkpoint.candidates.findIndex(
            (candidate) => candidate.candidate.id === saved.candidate.id,
        );
        if (index < 0) throw new Error(`Missing repository ${university}`);
        checkpoint.candidates[index] = structuredClone(saved);
        if (saved.skippedRepository) {
            checkpoint.skippedRepositories.push(saved.skippedRepository);
        }
        if (saved.warnings) checkpoint.warnings.push(...saved.warnings);
    }

    async publishUniversityCollection(
        runId: string,
        _university: string,
    ): Promise<number> {
        this.publishCalls += 1;
        const mode = this.runs.get(`${runId}:full`) ? 'full' : 'refresh';
        const checkpoint = this.runs.get(`${runId}:${mode}`);
        if (!checkpoint) throw new Error(`Missing run for ${_university}`);
        if (
            checkpoint.candidates.some(
                (candidate) => candidate.status === 'pending',
            )
        ) {
            throw new Error('Pending repositories');
        }
        checkpoint.committed = checkpoint.candidates.filter(
            (candidate) => candidate.status === 'complete',
        ).length;
        checkpoint.status = 'complete';
        checkpoint.candidates = [];
        return checkpoint.committed;
    }
}

test('failed discovery stays unpublishable and resume reruns discovery', async () => {
    const store = new MemoryCollectionStore();
    let searchAttempts = 0;
    const failedDiscoveryClient = createTestClient((url) => {
        if (url.pathname === '/search/repositories') {
            searchAttempts += 1;
            return jsonResponse(searchEnvelope([], 0, true));
        }
        if (url.pathname === '/search/users') {
            return jsonResponse(searchEnvelope([]));
        }
        throw new Error(`Unexpected request: ${url}`);
    });
    const failed = await runCollection(configuration, {
        client: failedDiscoveryClient,
        store,
        mode: 'full',
        runId: 'incomplete-discovery',
        searchRetrySleep: async () => {},
    });

    expect(failed.failed).toBe(1);
    expect(searchAttempts).toBe(3);
    expect(store.publishCalls).toBe(0);
    expect(store.runs.get('incomplete-discovery:full')).toMatchObject({
        status: 'discovering',
        candidates: [],
        committed: 0,
    });

    const resumeRequests: Array<{ path: string }> = [];
    const resumed = await runCollection(configuration, {
        client: completeFixture(false, resumeRequests),
        store,
        mode: 'full',
        runId: 'incomplete-discovery',
        searchRetrySleep: async () => {},
        now: () => new Date('2026-10-26T00:00:00Z'),
    });

    expect(resumed).toMatchObject({ failed: 0, committed: 2 });
    expect(store.publishCalls).toBe(1);
    expect(
        resumeRequests.some(({ path }) => path === '/search/repositories'),
    ).toBe(true);
});

test('external cancellation during enrichment is reported as interruption, not repository failure', async () => {
    const store = new MemoryCollectionStore();
    const controller = new AbortController();
    const client = createTestClient((url, init) => {
        if (url.pathname === '/search/repositories') {
            return jsonResponse(
                searchEnvelope([repository(101, 'slu/one')]),
            );
        }
        if (url.pathname === '/search/users') {
            return jsonResponse(searchEnvelope([]));
        }
        if (url.pathname === '/repos/slu/one/readme') {
            return new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener(
                    'abort',
                    () => reject(init.signal?.reason),
                    { once: true },
                );
                setTimeout(
                    () => controller.abort(new Error('private caller reason')),
                    0,
                );
            });
        }
        if (
            url.pathname.endsWith('/releases') ||
            url.pathname.endsWith('/contributors')
        ) {
            return jsonResponse([]);
        }
        if (url.pathname.endsWith('/community/profile')) {
            return jsonResponse({ files: {} });
        }
        if (url.pathname.includes('/contents/')) {
            return jsonResponse({ message: 'Not Found' }, {}, 404);
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
    });

    const result = await runCollection(configuration, {
        client,
        store,
        mode: 'full',
        runId: 'external-cancellation',
        signal: controller.signal,
        searchRetrySleep: async () => {},
    });

    expect(result).toMatchObject({ failed: 0, interrupted: 1 });
    expect(result.failures).toEqual([]);
    expect(result.outcomes).toMatchObject([
        {
            status: 'interrupted',
            university: 'University One',
            phase: 'enrichment',
        },
    ]);
    expect(JSON.stringify(result)).not.toContain('private caller reason');
    expect(store.publishCalls).toBe(0);
    expect(
        store.runs.get('external-cancellation:full')?.candidates.map(
            (item) => item.status,
        ),
    ).toEqual(['pending']);
});

test('cancellation during a search backoff wait keeps the university interrupted', async () => {
    const store = new MemoryCollectionStore();
    const controller = new AbortController();
    const result = await runCollection(configuration, {
        client: createTestClient((url) => {
            if (url.pathname === '/search/repositories') {
                return jsonResponse(searchEnvelope([], 0, true));
            }
            if (url.pathname === '/search/users') {
                return jsonResponse(searchEnvelope([]));
            }
            throw new Error(`Unexpected request: ${url.pathname}`);
        }),
        store,
        mode: 'full',
        runId: 'backoff-cancellation',
        signal: controller.signal,
        searchRetrySleep: async () => {
            controller.abort(new Error('private quota wait reason'));
        },
    });

    expect(result).toMatchObject({ failed: 0, interrupted: 1 });
    expect(result.outcomes[0]).toMatchObject({
        status: 'interrupted',
        cancellationSource: 'caller',
        phase: 'search',
    });
    expect(JSON.stringify(result)).not.toContain('private quota wait reason');
    expect(store.publishCalls).toBe(0);
});

test('interruption retains completed repository checkpoints and resume skips them', async () => {
    const store = new MemoryCollectionStore();
    const controller = new AbortController();
    const initialRequests: string[] = [];
    const interrupted = await runCollection(
        { ...configuration, repositoryConcurrency: 1 },
        {
            client: createTestClient((url, init) => {
                initialRequests.push(url.pathname);
                if (url.pathname === '/search/repositories') {
                    return jsonResponse(
                        searchEnvelope([
                            repository(101, 'slu/one'),
                            repository(102, 'slu/two'),
                        ]),
                    );
                }
                if (url.pathname === '/search/users') {
                    return jsonResponse(searchEnvelope([]));
                }
                if (url.pathname === '/repos/slu/two/readme') {
                    return new Promise<Response>((_resolve, reject) => {
                        const rejectOnAbort = () =>
                            reject(init.signal?.reason);
                        if (init.signal?.aborted) {
                            rejectOnAbort();
                            return;
                        }
                        init.signal?.addEventListener('abort', rejectOnAbort, {
                            once: true,
                        });
                        setTimeout(
                            () => controller.abort(new Error('stop on second repository')),
                            0,
                        );
                    });
                }
                if (url.pathname.endsWith('/readme')) {
                    return jsonResponse({ message: 'Not Found' }, {}, 404);
                }
                if (
                    url.pathname.endsWith('/releases') ||
                    url.pathname.endsWith('/contributors')
                ) {
                    return jsonResponse([]);
                }
                if (url.pathname.endsWith('/community/profile')) {
                    return jsonResponse({ files: {} });
                }
                if (url.pathname.includes('/contents/')) {
                    return jsonResponse({ message: 'Not Found' }, {}, 404);
                }
                throw new Error(`Unexpected request: ${url.pathname}`);
            }),
            store,
            mode: 'full',
            runId: 'resume-after-interruption',
            signal: controller.signal,
        },
    );

    expect(interrupted).toMatchObject({ failed: 0, interrupted: 1 });
    expect(
        store.runs
            .get('resume-after-interruption:full')
            ?.candidates.map((item) => [item.candidate.fullName, item.status]),
    ).toEqual([
        ['slu/one', 'complete'],
        ['slu/two', 'pending'],
    ]);

    const resumeRequests: Array<{ path: string }> = [];
    const resumed = await runCollection(configuration, {
        client: completeFixture(false, resumeRequests),
        store,
        mode: 'full',
        runId: 'resume-after-interruption',
        now: () => new Date('2026-10-26T00:00:00Z'),
    });

    expect(resumed).toMatchObject({ failed: 0, interrupted: 0, committed: 2 });
    expect(
        resumeRequests.some(({ path }) => path.startsWith('/repos/slu/one')),
    ).toBe(false);
    expect(
        resumeRequests.some(({ path }) => path.startsWith('/repos/slu/two')),
    ).toBe(true);
    expect(store.publishCalls).toBe(1);
    expect(initialRequests).toContain('/repos/slu/one/readme');
});

test('a signal arriving after a real failure does not relabel the failure', async () => {
    const store = new MemoryCollectionStore();
    const controller = new AbortController();
    const result = await runCollection(configuration, {
        client: createTestClient((url) => {
            if (url.pathname === '/search/repositories') {
                return jsonResponse({ message: 'Forbidden' }, {}, 403);
            }
            if (url.pathname === '/search/users') {
                return jsonResponse(searchEnvelope([]));
            }
            throw new Error(`Unexpected request: ${url.pathname}`);
        }),
        store,
        mode: 'full',
        runId: 'late-signal-after-failure',
        signal: controller.signal,
        onFatalError: () => {
            controller.abort(new Error('late private signal reason'));
        },
    });

    expect(result).toMatchObject({ failed: 1, interrupted: 0 });
    expect(result.outcomes[0].status).toBe('failed');
    expect(formatScrapingError(result.failures[0].error)).toContain(
        'HTTP 403',
    );
    expect(JSON.stringify(result)).not.toContain('late private signal reason');
});

test('a signal before the first university leaves it not-run', async () => {
    const store = new MemoryCollectionStore();
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled before collection'));

    const result = await runCollection(configuration, {
        client: createTestClient(() => {
            throw new Error('a not-run university must not request GitHub');
        }),
        store,
        mode: 'full',
        runId: 'cancel-before-start',
        signal: controller.signal,
    });

    expect(result).toMatchObject({
        universitiesProcessed: 0,
        interrupted: 0,
        outcomes: [{ status: 'not_run', university: 'University One' }],
    });
});

test('a signal between universities preserves the completed result and leaves later work not-run', async () => {
    const controller = new AbortController();
    const runs = new Map<string, UniversityCollectionCheckpoint>();
    let publishCalls = 0;
    const store: RepositoryCollectionStorePort = {
        async startOrLoadUniversityCollection(_runId, university, mode) {
            const key = `${university}:${mode}`;
            let checkpoint = runs.get(key);
            if (!checkpoint) {
                checkpoint = {
                    mode,
                    status: 'discovering',
                    discovered: 0,
                    committed: 0,
                    candidates: [],
                    skippedOwners: [],
                    skippedRepositories: [],
                    warnings: [],
                };
                runs.set(key, checkpoint);
            }
            return structuredClone(checkpoint);
        },
        async listKnownRepositories() {
            return [];
        },
        async saveDiscoveryCheckpoint(_runId, university, candidates, owners) {
            const checkpoint = runs.get(`${university}:full`)!;
            checkpoint.status = 'ready';
            checkpoint.discovered = candidates.length;
            checkpoint.candidates = [];
            checkpoint.skippedOwners = [...owners];
        },
        async saveRepositoryCheckpoint() {},
        async publishUniversityCollection(_runId, university) {
            publishCalls += 1;
            const checkpoint = runs.get(`${university}:full`)!;
            checkpoint.status = 'complete';
            checkpoint.committed = 0;
            if (publishCalls === 1) {
                controller.abort(new Error('signal between universities'));
            }
            return 0;
        },
    };
    const result = await runCollection(
        {
            ...configuration,
            universities: [
                configuration.universities[0],
                {
                    key: 'University Two',
                    fullName: 'University Two',
                    acronym: 'U2',
                },
            ],
        },
        {
            client: createTestClient((url) => {
                if (
                    url.pathname === '/search/repositories' ||
                    url.pathname === '/search/users'
                ) {
                    return jsonResponse(searchEnvelope([]));
                }
                throw new Error(`Unexpected request: ${url.pathname}`);
            }),
            store,
            mode: 'full',
            runId: 'between-universities',
            signal: controller.signal,
        },
    );

    expect(result).toMatchObject({
        universitiesProcessed: 1,
        committed: 0,
        failed: 0,
        interrupted: 0,
        outcomes: [
            { status: 'complete', university: 'University One' },
            { status: 'not_run', university: 'University Two' },
        ],
    });
    expect(publishCalls).toBe(1);
});

function completeFixture(
    failSecondReadme: boolean,
    requests: Array<{ path: string; etag?: string | null }>,
    firstDescription = null as string | null,
    secondReadmeStatus = 500,
) {
    return createTestClient((url, init) => {
        const headers = new Headers(init.headers);
        requests.push({
            path: url.pathname,
            etag: headers.get('if-none-match'),
        });
        if (url.pathname === '/search/repositories') {
            const first = repository(101, 'slu/one');
            first.description = firstDescription;
            return jsonResponse(
                searchEnvelope([first, repository(102, 'slu/two')]),
            );
        }
        if (url.pathname === '/search/users') {
            return jsonResponse(searchEnvelope([]));
        }
        if (url.pathname.endsWith('/readme')) {
            if (
                failSecondReadme &&
                url.pathname.startsWith('/repos/slu/two/')
            ) {
                return jsonResponse(
                    { message: 'temporarily unavailable' },
                    secondReadmeStatus === 451
                        ? { 'x-github-request-id': 'REQ-LEGAL-451' }
                        : {},
                    secondReadmeStatus,
                );
            }
            return jsonResponse({ message: 'Not Found' }, {}, 404);
        }
        if (
            url.pathname.endsWith('/releases') ||
            url.pathname.endsWith('/contributors')
        ) {
            return jsonResponse([]);
        }
        if (url.pathname.endsWith('/community/profile')) {
            return jsonResponse({ files: {} });
        }
        if (url.pathname.includes('/contents/')) {
            return jsonResponse({ message: 'Not Found' }, {}, 404);
        }
        throw new Error(`Unexpected request: ${url}`);
    });
}

function contributorLimitFixture(requests: string[]) {
    const candidates = [
        repository(201, 'slu/one'),
        repository(202, 'slu/large-history'),
        repository(203, 'sntyo/chatlog_alpha'),
    ];
    return createTestClient((url) => {
        requests.push(url.pathname);
        if (url.pathname === '/search/repositories') {
            return jsonResponse(searchEnvelope(candidates));
        }
        if (url.pathname === '/search/users') {
            return jsonResponse(searchEnvelope([]));
        }
        if (url.pathname === '/repos/slu/large-history/contributors') {
            return jsonResponse(
                {
                    message:
                        'The history or contributor list is too large to list contributors for this repository via the API.',
                },
                { 'x-github-request-id': 'SIZE-LIMIT-403' },
                403,
            );
        }
        if (url.pathname.endsWith('/readme')) {
            return jsonResponse({ message: 'Not Found' }, {}, 404);
        }
        if (
            url.pathname.endsWith('/releases') ||
            url.pathname.endsWith('/contributors')
        ) {
            return jsonResponse([]);
        }
        if (url.pathname.endsWith('/community/profile')) {
            return jsonResponse({ files: {} });
        }
        if (url.pathname.includes('/contents/')) {
            return jsonResponse({ message: 'Not Found' }, {}, 404);
        }
        throw new Error(`Unexpected request: ${url}`);
    });
}

test('checkpoints contributor-size skips, reaches later candidates, and resumes without re-fetching completed work', async () => {
    const store = new MemoryCollectionStore();
    const publishNormally = store.publishUniversityCollection.bind(store);
    let interruptPublication = true;
    store.publishUniversityCollection = async (runId, university) => {
        const checkpoint = store.runs.get(`${runId}:full`);
        expect(checkpoint?.candidates.map(({ status }) => status)).toEqual([
            'complete',
            'skipped',
            'complete',
        ]);
        if (interruptPublication) {
            interruptPublication = false;
            throw new Error('synthetic interruption after checkpoints');
        }
        return publishNormally(runId, university);
    };

    const firstRequests: string[] = [];
    const failed = await runCollection(configuration, {
        client: contributorLimitFixture(firstRequests),
        store,
        mode: 'full',
        runId: 'contributor-size-recovery',
        policy: 'best-effort',
    });
    expect(failed.failed).toBe(1);
    expect(firstRequests).toContain('/repos/sntyo/chatlog_alpha/contributors');
    expect(
        store.runs.get('contributor-size-recovery:full')?.candidates,
    ).toMatchObject([
        { status: 'complete', record: { fullName: 'slu/one' } },
        {
            status: 'skipped',
            skippedRepository: {
                status: 403,
                reasonCode: 'github_contributors_unavailable',
                requestId: 'SIZE-LIMIT-403',
            },
        },
        { status: 'complete', record: { fullName: 'sntyo/chatlog_alpha' } },
    ]);
    expect(
        store.runs.get('contributor-size-recovery:full')?.candidates[1],
    ).not.toHaveProperty('record');

    const resumeRequests: string[] = [];
    const resumed = await runCollection(configuration, {
        client: createTestClient((url) => {
            resumeRequests.push(url.pathname);
            throw new Error(`Unexpected GitHub request on resume: ${url}`);
        }),
        store,
        mode: 'full',
        runId: 'contributor-size-recovery',
        policy: 'best-effort',
    });
    expect(resumed).toMatchObject({ failed: 0, committed: 2, partial: 1 });
    expect(resumeRequests).toEqual([]);
});

test('strict policy checkpoints contributor-size skip but does not publish', async () => {
    const store = new MemoryCollectionStore();
    const requests: string[] = [];
    const result = await runCollection(configuration, {
        client: contributorLimitFixture(requests),
        store,
        mode: 'full',
        runId: 'strict-contributor-size',
        policy: 'strict',
    });

    expect(result.failed).toBe(1);
    expect(store.publishCalls).toBe(0);
    expect(
        store.runs
            .get('strict-contributor-size:full')
            ?.candidates.map(({ status }) => status),
    ).toEqual(['complete', 'skipped', 'pending']);
    expect(result.failures[0].skippedRepositories).toMatchObject([
        {
            status: 403,
            reasonCode: 'github_contributors_unavailable',
            requestId: 'SIZE-LIMIT-403',
        },
    ]);
});

test('keeps unknown contributor 403 fatal and does not publish in best-effort mode', async () => {
    const store = new MemoryCollectionStore();
    const result = await runCollection(configuration, {
        client: completeFixture(true, [], null, 403),
        store,
        mode: 'full',
        runId: 'unknown-contributor-403',
        policy: 'best-effort',
    });

    expect(result.failed).toBe(1);
    expect(store.publishCalls).toBe(0);
    expect(
        store.runs
            .get('unknown-contributor-403:full')
            ?.candidates.map(({ status }) => status),
    ).toEqual(['complete', 'pending']);
    expect(result.failures[0].skippedRepositories).toEqual([]);
});

test('uses discovered repository metadata and resumes completed repository checkpoints', async () => {
    const store = new MemoryCollectionStore();
    const firstRequests: Array<{ path: string; etag?: string | null }> = [];
    const firstRun = await runCollection(configuration, {
        client: completeFixture(true, firstRequests, 'description\u0000tail'),
        store,
        mode: 'full',
        runId: 'full-101',
        now: () => new Date('2026-10-26T00:00:00Z'),
    });

    expect(firstRun.failed).toBe(1);
    expect(firstRun.failures[0].warnings).toMatchObject([
        { field: 'description', replacementCount: 1 },
    ]);
    expect(firstRequests.some(({ path }) => path === '/repos/slu/one')).toBe(
        false,
    );
    expect(
        store.runs.get('full-101:full')?.candidates.map((item) => item.status),
    ).toEqual(['complete', 'pending']);

    const resumeRequests: Array<{ path: string; etag?: string | null }> = [];
    const resumed = await runCollection(configuration, {
        client: completeFixture(false, resumeRequests),
        store,
        mode: 'full',
        runId: 'full-101',
        now: () => new Date('2026-10-26T00:00:00Z'),
    });

    expect(resumed.failed).toBe(0);
    expect(resumed.committed).toBe(2);
    expect(resumeRequests.some(({ path }) => path.startsWith('/search/'))).toBe(
        false,
    );
    expect(
        resumeRequests.some(({ path }) => path.startsWith('/repos/slu/one')),
    ).toBe(false);
    expect(
        resumeRequests.some(({ path }) => path.startsWith('/repos/slu/two')),
    ).toBe(true);
});

test('checkpoints a 451 skip, resumes without re-requesting it, and retries it in a fresh run', async () => {
    const store = new MemoryCollectionStore();
    const publishNormally = store.publishUniversityCollection.bind(store);
    let failFirstPublication = true;
    store.publishUniversityCollection = async (runId, university) => {
        if (failFirstPublication) {
            failFirstPublication = false;
            throw new Error('synthetic publication interruption');
        }
        return publishNormally(runId, university);
    };

    const firstRequests: Array<{ path: string; etag?: string | null }> = [];
    const first = await runCollection(configuration, {
        client: completeFixture(true, firstRequests, null, 451),
        store,
        mode: 'full',
        runId: 'legal-checkpoint',
        policy: 'best-effort',
    });
    expect(first.failed).toBe(1);
    expect(
        store.runs
            .get('legal-checkpoint:full')
            ?.candidates.map((item) => item.status),
    ).toEqual(['complete', 'skipped']);
    expect(
        store.runs.get('legal-checkpoint:full')?.skippedRepositories,
    ).toMatchObject([{ status: 451, requestId: 'REQ-LEGAL-451' }]);

    const resumeRequests: Array<{ path: string }> = [];
    const resumed = await runCollection(configuration, {
        client: createTestClient((url) => {
            resumeRequests.push({ path: url.pathname });
            throw new Error(`Unexpected retry during resume: ${url.pathname}`);
        }),
        store,
        mode: 'full',
        runId: 'legal-checkpoint',
        policy: 'best-effort',
    });
    expect(resumeRequests).toEqual([]);
    expect(resumed).toMatchObject({ failed: 0, partial: 1, committed: 1 });
    expect(resumed.results[0].skippedRepositories).toMatchObject([
        { status: 451, requestId: 'REQ-LEGAL-451' },
    ]);

    const freshRequests: Array<{ path: string }> = [];
    const fresh = await runCollection(configuration, {
        client: completeFixture(false, freshRequests),
        store,
        mode: 'full',
        runId: 'legal-fresh-run',
        policy: 'best-effort',
    });
    expect(fresh).toMatchObject({ failed: 0, partial: 0, committed: 2 });
    expect(
        freshRequests.some(({ path }) => path === '/repos/slu/two/readme'),
    ).toBe(true);
});

test('strict policy does not publish healthy checkpoints when a sibling returns 451', async () => {
    const store = new MemoryCollectionStore();
    const requests: Array<{ path: string; etag?: string | null }> = [];
    const result = await runCollection(configuration, {
        client: completeFixture(true, requests, null, 451),
        store,
        mode: 'full',
        runId: 'strict-legal-checkpoint',
        policy: 'strict',
    });

    expect(result.failed).toBe(1);
    expect(store.publishCalls).toBe(0);
    expect(
        store.runs
            .get('strict-legal-checkpoint:full')
            ?.candidates.map((item) => item.status),
    ).toEqual(['complete', 'skipped']);
    expect(result.failures[0].skippedRepositories).toMatchObject([
        { status: 451, reasonCode: 'github_legal_restriction' },
    ]);
});

test('strict mode reports a saved legal skip instead of accepting a completed checkpoint', async () => {
    const store = new MemoryCollectionStore();
    await runCollection(configuration, {
        client: completeFixture(true, [], null, 451),
        store,
        mode: 'full',
        runId: 'strict-saved-skip',
        policy: 'best-effort',
    });
    const strict = await runCollection(configuration, {
        client: createTestClient(() => {
            throw new Error('completed checkpoint must not re-request GitHub');
        }),
        store,
        mode: 'full',
        runId: 'strict-saved-skip',
        policy: 'strict',
    });

    expect(strict.failed).toBe(1);
    const message = formatScrapingError(strict.failures[0].error);
    expect(message).toContain('HTTP 451');
    expect(message).toContain('legal unavailability');
    expect(message).not.toContain('Terms of Service');
});

test('refresh sends the saved ETag and publishes no data when GitHub returns 304', async () => {
    const store = new MemoryCollectionStore();
    store.known.push({ id: 201, fullName: 'slu/known', etag: '"cached"' });
    const requests: Array<{ path: string; etag?: string | null }> = [];
    const client = createTestClient((url, init) => {
        const headers = new Headers(init.headers);
        requests.push({
            path: url.pathname,
            etag: headers.get('if-none-match'),
        });
        if (url.pathname === '/repos/slu/known') {
            return new Response(null, {
                status: 304,
                headers: { etag: '"cached"' },
            });
        }
        throw new Error(`Unexpected request: ${url}`);
    });

    const result = await runCollection(configuration, {
        client,
        store,
        mode: 'refresh',
        runId: 'refresh-201',
    });

    expect(requests).toEqual([{ path: '/repos/slu/known', etag: '"cached"' }]);
    expect(result).toMatchObject({ failed: 0, committed: 0 });
    expect(store.runs.get('refresh-201:refresh')?.status).toBe('complete');
});
