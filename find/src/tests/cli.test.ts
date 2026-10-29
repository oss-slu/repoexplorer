import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    formatCliSummary,
    getCliExitCode,
    parseCliOptions,
    runCli,
    withDatabasePreflight,
} from '../cli';
import type { CliCollectionRuntime } from '../cli';
import type {
    UniversityCollectionCheckpoint,
} from '../types/scraping';
import type { ScrapingRunResult } from '../types/scraping';
import {
    GitHubRequestClient,
    type GitHubRequestConfig,
} from '../utils/githubRequest';
import type { GitHubTokenProvenance } from '../utils/environment';
import { jsonResponse } from './githubFixtures';
import { GitHubAppTokenProvider } from '../utils/githubAppToken';

const skippedOwner = {
    university: 'Saint Louis University',
    login: 'awsslu',
    ownerType: 'Organization' as const,
    endpoint: 'https://api.github.com/orgs/awsslu/repos',
    status: 404 as const,
    reason: 'GitHub returned HTTP 404 for this owner repository listing; the owner was skipped.',
};

const partialResult: ScrapingRunResult = {
    elapsedMs: 1_200,
    universitiesProcessed: 1,
    committed: 3,
    failed: 0,
    interrupted: 0,
    partial: 1,
    results: [
        {
            status: 'partial',
            university: 'Saint Louis University',
            discovered: 3,
            committed: 3,
            skippedOwners: [skippedOwner],
            skippedRepositories: [],
            warnings: [],
        },
    ],
    failures: [],
    outcomes: [
        {
            status: 'partial',
            university: 'Saint Louis University',
            discovered: 3,
            committed: 3,
            skippedOwners: [skippedOwner],
            skippedRepositories: [],
            warnings: [],
        },
    ],
};

function emptyResult(): ScrapingRunResult {
    return {
        elapsedMs: 0,
        universitiesProcessed: 1,
        committed: 0,
        failed: 0,
        interrupted: 0,
        partial: 0,
        results: [
            {
                status: 'complete',
                university: 'Complete University',
                discovered: 0,
                committed: 0,
                skippedOwners: [],
                skippedRepositories: [],
                warnings: [],
            },
        ],
        failures: [],
        outcomes: [
            {
                status: 'complete',
                university: 'Complete University',
                discovered: 0,
                committed: 0,
                skippedOwners: [],
                skippedRepositories: [],
                warnings: [],
            },
        ],
    };
}

test('defaults to best effort and accepts strict mode', () => {
    expect(parseCliOptions([]).policy).toBe('best-effort');
    expect(parseCliOptions(['--strict']).policy).toBe('strict');
});

test('parses the database-free GitHub diagnostic and rejects conflicting options', () => {
    expect(
        parseCliOptions(['--diagnose-github', '--owner', 'oss-slu']),
    ).toMatchObject({ diagnoseGitHub: true, owner: 'oss-slu' });
    expect(() =>
        parseCliOptions([
            '--diagnose-github',
            '--owner',
            'oss-slu',
            '--mode',
            'full',
        ]),
    ).toThrow(/mutually exclusive/);
    expect(() => parseCliOptions(['--owner', 'oss-slu'])).toThrow(
        /only with --diagnose-github/,
    );
});

function outputSink() {
    const chunks: string[] = [];
    return {
        chunks,
        stream: {
            write(value: string) {
                chunks.push(value);
                return true;
            },
        },
    };
}

function requestClient(
    handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
    config: GitHubRequestConfig,
): GitHubRequestClient {
    return new GitHubRequestClient({
        ...config,
        fetch: (async (input, init) => {
            const url = input instanceof URL ? input : new URL(String(input));
            return handler(url, init ?? {});
        }) as typeof fetch,
        sleep: async () => {},
    });
}

const environmentCredential: GitHubTokenProvenance = {
    source: 'environment',
    configured: true,
    usable: true,
};

const authEnvironmentNames = [
    'GITHUB_TOKEN',
    'FINDER_GITHUB_APP_ID',
    'FINDER_GITHUB_APP_PRIVATE_KEY',
    'FINDER_GITHUB_APP_INSTALLATION_ID',
] as const;
const originalAuthEnvironment = new Map(
    authEnvironmentNames.map((name) => [name, process.env[name]]),
);

beforeEach(() => {
    for (const name of authEnvironmentNames) delete process.env[name];
    process.env.GITHUB_TOKEN = 'synthetic-diagnostic-token';
});

afterAll(() => {
    for (const name of authEnvironmentNames) {
        const value = originalAuthEnvironment.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

test('diagnoses one repository-list page without loading collection config or PostgreSQL', async () => {
    const sink = outputSink();
    let calls = 0;
    const exitCode = await runCli(
        ['--diagnose-github', '--owner', 'oss-slu'],
        {
            tokenProvenance: environmentCredential,
            signalHandlers: false,
            stdout: sink.stream,
            createRequestClient: (config) => {
                expect(config).toMatchObject({
                    maxRetries: 0,
                    maxRateLimitRetries: 0,
                });
                return requestClient((url) => {
                    calls += 1;
                    expect(url.pathname).toBe('/orgs/oss-slu/repos');
                    expect(url.searchParams.get('per_page')).toBe('1');
                    return jsonResponse([], {
                        'x-github-request-id': 'REQ-200',
                        'x-ratelimit-resource': 'core',
                        'x-ratelimit-limit': '5000',
                        'x-ratelimit-remaining': '4000',
                    });
                }, config);
            },
        },
    );
    expect(exitCode).toBe(0);
    expect(calls).toBe(1);
    expect(sink.chunks).toHaveLength(1);
    expect(JSON.parse(sink.chunks[0])).toMatchObject({
        schemaVersion: 1,
        command: 'diagnose-github',
        outcome: 'success',
        credential: {
            source: 'environment',
            configured: true,
            usable: true,
        },
        owner: 'oss-slu',
        endpoint: '/orgs/oss-slu/repos',
        pageSize: 1,
        status: 200,
        requestId: 'REQ-200',
        reason: 'access-confirmed',
        quota: { bucket: 'core', limit: 5_000, remaining: 4_000 },
    });
    expect(sink.chunks[0]).not.toContain('synthetic-diagnostic-token');
});

test('reuses an active GitHub App provider and reports its credential source', async () => {
    process.env.FINDER_GITHUB_APP_ID = 'app-id-secret';
    process.env.FINDER_GITHUB_APP_PRIVATE_KEY = 'private-key-secret';
    process.env.FINDER_GITHUB_APP_INSTALLATION_ID = 'installation-secret';
    const sink = outputSink();
    const exitCode = await runCli(
        ['--diagnose-github', '--owner', 'oss-slu'],
        {
            tokenProvenance: {
                source: 'none',
                configured: false,
                usable: false,
            },
            signalHandlers: false,
            stdout: sink.stream,
            createAppTokenProvider: () =>
                new GitHubAppTokenProvider({
                    appId: process.env.FINDER_GITHUB_APP_ID!,
                    privateKey: process.env.FINDER_GITHUB_APP_PRIVATE_KEY!,
                    installationId:
                        process.env.FINDER_GITHUB_APP_INSTALLATION_ID!,
                    initialToken: 'app-token-secret',
                }),
            createRequestClient: (config) =>
                requestClient((_, init) => {
                    expect(
                        new Headers(init.headers).get('Authorization'),
                    ).toBe('Bearer app-token-secret');
                    return jsonResponse([]);
                }, config),
        },
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(sink.chunks[0]).credential).toEqual({
        source: 'github-app',
        configured: true,
        usable: true,
    });
    for (const secret of [
        'app-token-secret',
        'app-id-secret',
        'private-key-secret',
        'installation-secret',
    ]) {
        expect(sink.chunks[0]).not.toContain(secret);
    }
});

test('reports an incomplete App credential configuration without making a request', async () => {
    process.env.FINDER_GITHUB_APP_ID = 'app-id-secret';
    const sink = outputSink();
    let clientCreated = false;
    const exitCode = await runCli(
        ['--diagnose-github', '--owner', 'oss-slu'],
        {
            tokenProvenance: environmentCredential,
            signalHandlers: false,
            stdout: sink.stream,
            createRequestClient: () => {
                clientCreated = true;
                throw new Error('Request client should not be created');
            },
        },
    );

    expect(exitCode).toBe(1);
    expect(clientCreated).toBe(false);
    expect(sink.chunks).toHaveLength(1);
    expect(JSON.parse(sink.chunks[0])).toMatchObject({
        credential: {
            source: 'github-app',
            configured: true,
            usable: false,
        },
        outcome: 'failure',
        reason: 'invalid-credential-configuration',
    });
    expect(sink.chunks[0]).not.toContain('app-id-secret');
});

test.each<{
    label: string;
    headers: Record<string, string>;
    body: unknown;
    reason: string;
    status: number;
}>([
    {
        label: 'SSO denial',
        headers: {
            'x-github-sso':
                'required; url=https://github.com/authorize?secret=sso-secret',
            'x-github-request-id': 'SSO-403',
        },
        body: { message: 'Forbidden' },
        reason: 'sso-required',
        status: 403,
    },
    {
        label: 'unknown denial',
        headers: {
            'x-github-request-id': 'DENY-403',
            'x-ratelimit-resource': 'core',
            'x-ratelimit-limit': '5000',
            'x-ratelimit-remaining': '87',
            'x-ratelimit-reset': '1800000000',
            'retry-after': '2',
        },
        body: { message: 'Forbidden', token: 'body-secret' },
        reason: 'unknown-forbidden',
        status: 403,
    },
])('reports safe evidence for $label', async ({ headers, body, reason, status }) => {
    const sink = outputSink();
    let calls = 0;
    const exitCode = await runCli(
        ['--diagnose-github', '--owner', 'oss-slu'],
        {
            tokenProvenance: environmentCredential,
            signalHandlers: false,
            stdout: sink.stream,
            createRequestClient: (config) =>
                requestClient(() => {
                    calls += 1;
                    return jsonResponse(body, headers, status);
                }, config),
        },
    );
    expect(exitCode).toBe(1);
    expect(calls).toBe(1);
    expect(sink.chunks).toHaveLength(1);
    const json = sink.chunks[0];
    const diagnostic = JSON.parse(json);
    expect(diagnostic).toMatchObject({
        outcome: 'failure',
        status,
        reason,
        endpoint: '/orgs/oss-slu/repos',
    });
    expect(json).not.toContain('sso-secret');
    expect(json).not.toContain('body-secret');
    expect(json).not.toContain('response-secret');
    expect(json).not.toContain('synthetic-diagnostic-token');
    if (reason === 'unknown-forbidden') {
        expect(diagnostic.quota).toMatchObject({
            bucket: 'core',
            remaining: 87,
            retryAfterMs: 2_000,
        });
        expect(diagnostic.nextStep).toContain('exact cause is unconfirmed');
    } else {
        expect(diagnostic.ssoStatus).toBe('required');
    }
});

test('reports an HTTP 451 without inferring a legal basis or exposing the body', async () => {
    const sink = outputSink();
    let calls = 0;
    const exitCode = await runCli(
        ['--diagnose-github', '--owner', 'oss-slu'],
        {
            tokenProvenance: environmentCredential,
            signalHandlers: false,
            stdout: sink.stream,
            createRequestClient: (config) =>
                requestClient(() => {
                    calls += 1;
                    return jsonResponse(
                        { message: 'private-body-sentinel' },
                        { 'x-github-request-id': 'REQ-451' },
                        451,
                    );
                }, config),
        },
    );

    expect(exitCode).toBe(1);
    expect(calls).toBe(1);
    expect(JSON.parse(sink.chunks[0])).toMatchObject({
        outcome: 'failure',
        status: 451,
        requestId: 'REQ-451',
        reason: 'legal-restriction',
        nextStep: expect.stringContaining(
            'does not establish the specific legal basis',
        ),
    });
    expect(sink.chunks.join('')).not.toContain('private-body-sentinel');
    expect(sink.chunks.join('')).not.toContain('synthetic-diagnostic-token');
});

test.each<{
    label: string;
    handler: (url: URL, init: RequestInit) => Response;
    expectedReason: string;
}>([
    {
        label: 'rate limit',
        handler: () =>
            jsonResponse({ message: 'API rate limit exceeded' }, {
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': '1800000000',
                'x-ratelimit-resource': 'core',
            }, 403),
        expectedReason: 'primary-rate-limit',
    },
    {
        label: 'network error',
        handler: () => {
            throw new TypeError('offline');
        },
        expectedReason: 'network-error',
    },
])('returns promptly for a $label', async ({ handler, expectedReason }) => {
    const sink = outputSink();
    let calls = 0;
    const exitCode = await runCli(
        ['--diagnose-github', '--owner', 'oss-slu'],
        {
            tokenProvenance: environmentCredential,
            signalHandlers: false,
            stdout: sink.stream,
            createRequestClient: (config) =>
                requestClient((url, init) => {
                    calls += 1;
                    return handler(url, init);
                }, config),
        },
    );
    expect(exitCode).toBe(1);
    expect(calls).toBe(1);
    expect(JSON.parse(sink.chunks[0]).reason).toBe(expectedReason);
});

test('invalid owners and conflicting diagnostic options emit one JSON failure without requests', async () => {
    for (const args of [
        ['--diagnose-github', '--owner', 'org/not-a-login'],
        ['--diagnose-github', '--owner', 'oss-slu', '--mode', 'full'],
    ]) {
        const sink = outputSink();
        let clientCreations = 0;
        const exitCode = await runCli(args, {
            tokenProvenance: environmentCredential,
            signalHandlers: false,
            stdout: sink.stream,
            createRequestClient: (config) => {
                clientCreations += 1;
                return requestClient(() => {
                    throw new Error('unexpected HTTP request');
                }, config);
            },
        });
        expect(exitCode).toBe(1);
        expect(sink.chunks).toHaveLength(1);
        expect(JSON.parse(sink.chunks[0]).reason).toMatch(
            /invalid-owner|invalid-arguments/,
        );
        expect(clientCreations).toBe(args.includes('--mode') ? 0 : 1);
    }
});

test('Ctrl-C aborts an in-flight diagnostic and preserves exit code 130', async () => {
    const sink = outputSink();
    const controller = new AbortController();
    const exitCodePromise = runCli(
        ['--diagnose-github', '--owner', 'oss-slu'],
        {
            tokenProvenance: environmentCredential,
            signalHandlers: false,
            createAbortController: () => controller,
            stdout: sink.stream,
            createRequestClient: (config) =>
                requestClient(
                    (_url, init) =>
                        new Promise<Response>((_resolve, reject) => {
                            init.signal?.addEventListener(
                                'abort',
                                () => reject(init.signal?.reason),
                                { once: true },
                            );
                            setTimeout(
                                () => controller.abort(new Error('cancelled')),
                                0,
                            );
                        }),
                    config,
                ),
        },
    );
    await expect(exitCodePromise).resolves.toBe(130);
    expect(sink.chunks).toHaveLength(1);
    expect(JSON.parse(sink.chunks[0])).toMatchObject({
        outcome: 'interrupted',
        reason: 'interrupted',
    });
    expect(sink.chunks[0]).not.toContain('cancelled by SIGINT');
});

test.each([
    { signals: ['SIGINT'] as const, expectedExit: 130, source: 'SIGINT' },
    { signals: ['SIGTERM'] as const, expectedExit: 143, source: 'SIGTERM' },
    {
        signals: ['SIGINT', 'SIGTERM'] as const,
        expectedExit: 130,
        source: 'SIGINT',
    },
])(
    'reports external $source cancellation in the CLI report with exit $expectedExit',
    async ({ signals, expectedExit, source }) => {
        const directory = await mkdtemp(
            path.join(tmpdir(), 'repoexplorer-cli-interruption-'),
        );
        const configPath = path.join(directory, 'universities.json');
        const reportDirectory = path.join(directory, 'reports');
        const output = outputSink();
        const errors = outputSink();
        const checkpoint: UniversityCollectionCheckpoint = {
            mode: 'full',
            status: 'discovering',
            discovered: 0,
            committed: 0,
            candidates: [],
            skippedOwners: [],
            skippedRepositories: [],
            warnings: [],
        };
        let releasedLock = false;
        let closedRuntime = false;
        const runtime: CliCollectionRuntime = {
            store: {
                async preflight() {},
                async acquireCollectionLock(universities) {
                    expect(universities).toEqual(['University One']);
                    return async () => {
                        releasedLock = true;
                    };
                },
                async startOrLoadUniversityCollection() {
                    return structuredClone(checkpoint);
                },
                async listKnownRepositories() {
                    return [];
                },
                async saveDiscoveryCheckpoint() {
                    throw new Error('cancelled discovery must not be saved');
                },
                async saveRepositoryCheckpoint() {
                    throw new Error('enrichment must not start');
                },
                async publishUniversityCollection() {
                    throw new Error('interrupted run must not publish');
                },
            },
            async close() {
                closedRuntime = true;
            },
        };
        await writeFile(
            configPath,
            JSON.stringify({
                repositoryConcurrency: 1,
                databaseBatchSize: 10,
                universities: [
                    {
                        key: 'University One',
                        fullName: 'University One',
                        acronym: 'U1',
                    },
                    {
                        key: 'University Two',
                        fullName: 'University Two',
                        acronym: 'U2',
                    },
                ],
            }),
        );

        try {
            const exitCodePromise = runCli(['--config', configPath, '--university', 'University One'], {
                stdout: output.stream,
                stderr: errors.stream,
                reportDirectory,
                createCollectionRuntime: () => runtime,
                createRequestClient: (config) =>
                    requestClient((_url, init) => {
                        return new Promise<Response>((_resolve, reject) => {
                            const rejectOnAbort = () =>
                                reject(init.signal?.reason);
                            if (init.signal?.aborted) {
                                rejectOnAbort();
                                return;
                            }
                            init.signal?.addEventListener(
                                'abort',
                                rejectOnAbort,
                                { once: true },
                            );
                            for (const signal of signals) {
                                process.emit(signal);
                            }
                        });
                    }, config),
            });
            await expect(exitCodePromise).resolves.toBe(expectedExit);

            const reportFiles = await readdir(reportDirectory);
            expect(reportFiles).toHaveLength(1);
            const contents = await readFile(
                path.join(reportDirectory, reportFiles[0]),
                'utf8',
            );
            expect(JSON.parse(contents)).toMatchObject({
                schemaVersion: 3,
                summary: {
                    universitiesConfigured: 1,
                    interruptedUniversities: 1,
                    failedUniversities: 0,
                    notRunUniversities: 0,
                },
                universities: [
                    {
                        university: 'University One',
                        status: 'interrupted',
                        diagnostics: {
                            category: 'interrupted',
                            cancellationSource: source,
                        },
                    },
                ],
            });
            expect(contents).not.toContain('private caller reason');
            expect(releasedLock).toBe(true);
            expect(closedRuntime).toBe(true);
            expect(errors.chunks.join('')).not.toContain('FAILED:');
            expect(output.chunks.join('')).toContain('INTERRUPTED');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);

test('does not start scraping or make GitHub requests after preflight failure', async () => {
    let githubRequests = 0;
    const scrape = async () => {
        githubRequests += 1;
        return emptyResult();
    };

    await expect(
        withDatabasePreflight(
            async () => {
                throw new Error('preflight failed');
            },
            scrape,
        ),
    ).rejects.toThrow('preflight failed');
    expect(githubRequests).toBe(0);
});

test('uses documented exit codes with fatal failures taking precedence over partial results', () => {
    expect(getCliExitCode(emptyResult(), false)).toBe(0);
    expect(getCliExitCode(partialResult, false)).toBe(2);

    const failedAndPartial: ScrapingRunResult = {
        ...partialResult,
        failed: 1,
    };
    expect(getCliExitCode(failedAndPartial, false)).toBe(1);
    expect(getCliExitCode(emptyResult(), false, new Error('report failed'))).toBe(
        1,
    );
    expect(getCliExitCode(failedAndPartial, true, undefined, 143)).toBe(1);
    expect(getCliExitCode(emptyResult(), true, new Error('report failed'), 143)).toBe(143);
});

test('prints an explicit partial-success summary with skipped owners and report path', () => {
    const summary = formatCliSummary(
        partialResult,
        1,
        'best-effort',
        '/tmp/scrape-report.json',
        false,
    );

    expect(summary).toContain('PARTIAL SUCCESS');
    expect(summary).toContain('partial: 1');
    expect(summary).toContain('skipped owners: 1');
    expect(summary).toContain('repository associations committed: 3');
    expect(summary).toContain('report: /tmp/scrape-report.json');
    expect(summary).not.toContain('missing repositories');
});

test('labels a zero-row partial run and a mixed partial/fatal run clearly', () => {
    const zeroRowPartial: ScrapingRunResult = {
        ...partialResult,
        committed: 0,
        results: [
            {
                ...partialResult.results[0],
                discovered: 0,
                committed: 0,
            },
        ],
        outcomes: [
            {
                status: 'partial',
                university: 'Saint Louis University',
                discovered: 0,
                committed: 0,
                skippedOwners: [skippedOwner],
                skippedRepositories: [],
                warnings: [],
            },
        ],
    };
    expect(getCliExitCode(zeroRowPartial, false)).toBe(2);
    expect(
        formatCliSummary(
            zeroRowPartial,
            1,
            'best-effort',
            '/tmp/zero-row-report.json',
            false,
        ),
    ).toContain('PARTIAL COMPLETION');

    const mixedResult: ScrapingRunResult = {
        ...partialResult,
        failed: 1,
    };
    expect(getCliExitCode(mixedResult, false)).toBe(1);
    expect(
        formatCliSummary(
            mixedResult,
            2,
            'best-effort',
            '/tmp/mixed-report.json',
            false,
        ),
    ).toContain('FAILED WITH PARTIAL COVERAGE');
    expect(
        formatCliSummary(
            mixedResult,
            2,
            'best-effort',
            '/tmp/mixed-interrupted-report.json',
            true,
        ),
    ).toContain('FAILED AND INTERRUPTED');
});

test.each(['environment', 'root-env-file'] as const)(
    'reports the actual %s initial token separately from the App refresh provider',
    async (source) => {
        process.env.GITHUB_TOKEN = 'initial-secret-sentinel';
        process.env.FINDER_GITHUB_APP_ID = '123';
        process.env.FINDER_GITHUB_APP_PRIVATE_KEY = 'unused-key';
        process.env.FINDER_GITHUB_APP_INSTALLATION_ID = '456';
        const sink = outputSink();
        let requests = 0;
        const exitCode = await runCli(['--diagnose-github', '--owner', 'oss-slu'], {
            tokenProvenance: { source, configured: true, usable: true },
            signalHandlers: false,
            stdout: sink.stream,
            createRequestClient: (config) => requestClient((_, init) => {
                requests++;
                expect(new Headers(init.headers).get('Authorization')).toBe('Bearer initial-secret-sentinel');
                return jsonResponse([]);
            }, config),
        });
        expect(exitCode).toBe(0);
        expect(requests).toBe(1);
        expect(JSON.parse(sink.chunks[0]).credential).toEqual({
            source, refreshProvider: 'github-app', configured: true, usable: true,
        });
        expect(sink.chunks.join('')).not.toContain('initial-secret-sentinel');
    },
);

test('invalid App signing key reports credential failure without an organization request', async () => {
    delete process.env.GITHUB_TOKEN;
    process.env.FINDER_GITHUB_APP_ID = '123';
    process.env.FINDER_GITHUB_APP_PRIVATE_KEY = 'invalid-key-secret-sentinel';
    process.env.FINDER_GITHUB_APP_INSTALLATION_ID = '456';
    const sink = outputSink();
    let requests = 0;
    const exitCode = await runCli(['--diagnose-github', '--owner', 'oss-slu'], {
        signalHandlers: false,
        stdout: sink.stream,
        createRequestClient: (config) => requestClient(() => {
            requests++;
            return jsonResponse([]);
        }, config),
    });
    expect(exitCode).toBe(1);
    expect(requests).toBe(0);
    expect(JSON.parse(sink.chunks[0]).reason).toBe('credential-provider');
    expect(sink.chunks.join('')).not.toContain('invalid-key-secret-sentinel');
    expect(sink.chunks.join('')).not.toContain('network-error');
});
