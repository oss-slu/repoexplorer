import {
    createEnrichmentOptions,
    enrichRepository,
    refreshRepositoryMetadata,
} from '../enrichRepository';
import { GitHubRequestClient } from '../utils/githubRequest';
import { RepositoryGraphQLBatcher } from '../utils/repositoryGraphQLBatcher';
import type { UniversityConfiguration } from '../types/scraping';
import { createFakeGitHub } from './fakeGitHubRepository';
import type {
    FakeGitHubOptions,
    FakeRepository,
    RecordedRequest,
} from './fakeGitHubRepository';

const university: UniversityConfiguration = {
    key: 'Saint Louis University',
    fullName: 'Saint Louis University',
    acronym: 'SLU',
};
const scrapedAt = new Date('2026-10-20T12:00:00Z');

function metadata(
    name: string,
    id: number,
    overrides: Record<string, unknown> = {},
) {
    return {
        id,
        name,
        full_name: `slu/${name}`,
        owner: { login: 'slu', type: 'Organization' },
        private: false,
        license: { spdx_id: 'MIT', key: 'mit' },
        language: 'TypeScript',
        html_url: `https://github.com/slu/${name}`,
        description: 'A repository',
        fork: false,
        archived: false,
        is_template: false,
        created_at: '2020-01-02T03:04:05-05:00',
        updated_at: '2024-05-06T07:08:09Z',
        pushed_at: '2024-05-06T07:08:09Z',
        homepage: null,
        size: 0,
        stargazers_count: 3,
        watchers_count: 4,
        forks_count: 1,
        open_issues_count: 0,
        subscribers_count: 2,
        ...overrides,
    };
}

function fakeRepository(
    overrides: Partial<FakeRepository> & {
        metadata?: Record<string, unknown>;
    } = {},
    name = 'project',
    id = 77,
): FakeRepository {
    return {
        owner: 'slu',
        name,
        id,
        files: { 'README.md': '# Project' },
        contributors: ['alpha'],
        ...overrides,
        metadata: metadata(name, id, overrides.metadata),
    };
}

/** Enriches like the collection runner: a REST ETag gate, then enrichment. */
async function collect(
    repositories: FakeRepository[],
    graphql: boolean,
    options: FakeGitHubOptions = {},
) {
    const fake = createFakeGitHub(repositories, options);
    const enrichmentOptions = graphql
        ? { graphql: new RepositoryGraphQLBatcher(fake.client) }
        : {};
    const records = await Promise.all(
        repositories.map(async (repository) => {
            const candidate = {
                id: repository.id,
                fullName: `${repository.owner}/${repository.name}`,
            };
            const refreshed = await refreshRepositoryMetadata(
                fake.client,
                candidate,
                university.key,
            );
            if (refreshed.status !== 'modified') {
                throw new Error('Expected a modified repository');
            }
            return enrichRepository(
                fake.client,
                candidate,
                university,
                () => scrapedAt,
                refreshed.metadata,
                enrichmentOptions,
            );
        }),
    );
    return { records, requests: fake.requests };
}

function restRequestsFor(
    requests: readonly RecordedRequest[],
    repository: string,
): string[] {
    return requests
        .filter((request) => request.repository === repository)
        .map((request) => request.path);
}

const parityScenarios: [
    string,
    Partial<FakeRepository> & { metadata?: Record<string, unknown> },
][] = [
    ['an empty contributor list (204)', { contributors: null }],
    [
        'archived and template flags',
        { metadata: { archived: true, is_template: true } },
    ],
    [
        'community files, security policy, releases, and contributors',
        {
            files: {
                'CODE_OF_CONDUCT.md': 'Be kind.',
                'CONTRIBUTING.md': 'Open a pull request.',
                'PULL_REQUEST_TEMPLATE.md': '## Summary',
                '.github/ISSUE_TEMPLATE/bug.yml': 'name: Bug',
                '.github/ISSUE_TEMPLATE/feature.md': '---\nname: Feature\n---',
                '.github/SECURITY.md':
                    '# Security\nReport vulnerabilities privately.',
            },
            releases: [[0, 5], [7]],
            contributors: ['alpha', 'beta', 'Alpha'],
        },
    ],
    [
        'directory issue templates without other community files',
        { files: { '.github/ISSUE_TEMPLATE/bug.yml': 'name: Bug' } },
    ],
    ['no community files or template directories', {}],
    [
        'a user-owned fork using directory detection',
        {
            metadata: {
                owner: { login: 'contributor', type: 'User' },
                license: null,
                language: null,
                fork: true,
            },
            files: {
                'CODE_OF_CONDUCT.md': 'Be kind.',
                'CONTRIBUTING.md': 'Open a pull request.',
                'PULL_REQUEST_TEMPLATE.md': '## Summary',
                '.github/ISSUE_TEMPLATE/bug.yml': 'name: Bug',
            },
            contributors: [],
        },
    ],
    [
        'a symlinked root SECURITY.md before nested locations',
        {
            files: {
                'SECURITY.md': { symlink: 'policies/security.md' },
                'policies/security.md': 'root policy',
                '.github/SECURITY.md': 'nested',
            },
        },
    ],
    [
        'docs/SECURITY.md and docs issue templates',
        {
            files: {
                'docs/SECURITY.md': 'docs policy',
                'docs/ISSUE_TEMPLATE/bug.yml': 'name: Bug',
            },
        },
    ],
    [
        'a README preferred from .github over the root',
        { files: { 'README.md': 'root', '.github/README.md': 'github' } },
    ],
    ['a README only in docs', { files: { 'docs/README.rst': 'docs readme' } }],
    [
        'two README variants in the root',
        { files: { 'README.md': 'markdown', 'README.zh.md': 'translated' } },
    ],
    [
        'a README with a UTF-8 byte order mark',
        { files: { 'README.md': '﻿# Project' } },
    ],
    ['a binary README', { files: { 'README.md': { binary: 'ÿþ\u0000x' } } }],
    ['a UTF-16 README', { files: { 'README.md': { utf16: '# DSA\r\n' } } }],
    [
        'a UTF-16 community file',
        { files: { 'CONTRIBUTING.md': { utf16: 'Open a pull request.' } } },
    ],
    [
        'a README over 512,000 bytes',
        { files: { 'README.md': `# Big\n${'é'.repeat(300_000)}` } },
    ],
    [
        'a community file over 512,000 bytes',
        { files: { 'CONTRIBUTING.md': 'x'.repeat(600_000) } },
    ],
    [
        'a README past the first 1,000 root entries',
        {
            files: {
                ...Object.fromEntries(
                    Array.from({ length: 1000 }, (_, index) => [
                        `${String(index).padStart(4, '0')}.txt`,
                        'filler',
                    ]),
                ),
                'CONTRIBUTING.md': 'guide',
                'README.md': '# Hidden from REST',
            },
        },
    ],
    [
        'a symlinked README',
        {
            files: {
                'README.md': { symlink: 'docs/intro.md' },
                'docs/intro.md': 'intro',
            },
        },
    ],
    [
        'community files in .github and docs with precedence',
        {
            files: {
                'docs/CONTRIBUTING.md': 'docs guide',
                '.github/CONTRIBUTING.md': 'github guide',
                'docs/CODE_OF_CONDUCT.md': 'docs conduct',
            },
        },
    ],
    [
        'a pull-request template directory with a nested directory',
        {
            files: {
                '.github/PULL_REQUEST_TEMPLATE/feature.md': 'feature',
                '.github/PULL_REQUEST_TEMPLATE/nested/fix.md': 'fix',
            },
        },
    ],
    [
        'hyphenated community-file names and template directories',
        {
            files: {
                'docs/CODE-OF-CONDUCT.md': 'docs conduct',
                '.github/pull_request-template.md': 'single template',
                '.github/PULL_REQUEST_TEMPLATE/feature.md': 'feature',
                '.github/ISSUE_TEMPLATE/bug.yml': 'name: Bug',
            },
        },
    ],
    [
        'a pull-request template directory without a template file',
        { files: { '.github/pull_request_template/feature.md': 'feature' } },
    ],
    [
        'an unrecognized community-file extension',
        { files: { 'CONTRIBUTING.rst': 'reStructuredText guide' } },
    ],
    [
        'submodules beside community files',
        { files: { 'CONTRIBUTING.md': 'guide', vendor: { submodule: true } } },
    ],
    [
        'more than 100 releases',
        { releases: Array.from({ length: 101 }, (_, index) => [index]) },
    ],
    [
        'a release with more than 100 assets',
        { releases: [Array.from({ length: 101 }, () => 1)] },
    ],
    ['an empty repository', { files: {}, contributors: null }],
];

describe('GraphQL repository enrichment', () => {
    test.each(parityScenarios)(
        'matches the REST record for %s',
        async (_label, overrides) => {
            const repository = fakeRepository(overrides);
            const rest = await collect([repository], false);
            const graphql = await collect([repository], true);
            expect(graphql.records[0]).toEqual(rest.records[0]);
        },
    );

    test('reduces per-repository core requests to the ETag check and contributors', async () => {
        const repositories = [
            fakeRepository(
                {
                    files: {
                        'README.md': '# One',
                        'CONTRIBUTING.md': 'guide',
                        '.github/SECURITY.md': 'policy',
                        '.github/ISSUE_TEMPLATE/bug.yml': 'name: Bug',
                    },
                    releases: [[1, 2]],
                },
                'one',
                1,
            ),
            fakeRepository(
                {
                    files: {
                        'README.md': '# Two',
                        'docs/CODE_OF_CONDUCT.md': 'kind',
                    },
                },
                'two',
                2,
            ),
            fakeRepository({}, 'three', 3),
        ];

        const rest = await collect(repositories, false);
        const graphql = await collect(repositories, true);

        expect(graphql.records).toEqual(rest.records);
        for (const repository of repositories) {
            const name = `slu/${repository.name}`;
            expect(restRequestsFor(graphql.requests, name)).toEqual([
                `/repos/${name}`,
                `/repos/${name}/contributors`,
            ]);
            expect(
                restRequestsFor(rest.requests, name).length,
            ).toBeGreaterThanOrEqual(6);
        }
        const graphqlRequests = graphql.requests.filter(
            (request) => request.path === '/graphql',
        );
        expect(graphqlRequests[0]).toMatchObject({
            operation: 'RepositoryEnrichmentSnapshot',
            repositories: ['slu/one', 'slu/two', 'slu/three'],
        });
        // Object reads follow README, community-file, and template
        // dependencies, but each wave is one query shared by the batch.
        const objectQueries = graphqlRequests.slice(1);
        expect(objectQueries.length).toBeLessThanOrEqual(2);
        expect(
            objectQueries.every(
                (request) =>
                    request.operation === 'RepositoryEnrichmentObjects' &&
                    (request.repositories?.length ?? 0) >= 2,
            ),
        ).toBe(true);
    });

    test('reads a root README.md from the snapshot without another query', async () => {
        const repository = fakeRepository({
            files: { 'README.md': '# Project', 'src/index.ts': 'export {};' },
        });
        const rest = await collect([repository], false);
        const graphql = await collect([repository], true);
        expect(graphql.records).toEqual(rest.records);
        expect(
            graphql.requests
                .filter((request) => request.path === '/graphql')
                .map((request) => request.operation),
        ).toEqual(['RepositoryEnrichmentSnapshot']);
    });

    test.each([
        {
            label: 'a 404',
            status: 404,
            reasonCode: 'repository_unavailable_404',
        },
        {
            label: 'a structured ToS 403',
            status: 403,
            body: {
                message: 'Repository access blocked',
                block: { reason: 'tos' },
            },
            reasonCode: 'github_tos_block',
        },
        {
            label: 'a 451',
            status: 451,
            reasonCode: 'github_legal_restriction',
        },
    ])(
        'applies the REST policy to a repository GraphQL error when the repository resource returns $label',
        async ({ status, body, reasonCode }) => {
            const repository = fakeRepository();
            const fake = createFakeGitHub([repository], {
                graphqlRepositoryErrors: {
                    'slu/project': { type: 'FORBIDDEN' },
                },
                restRepositoryStatus: { 'slu/project': { status, body } },
            });
            await expect(
                enrichRepository(
                    fake.client,
                    { id: 77, fullName: 'slu/project' },
                    university,
                    () => scrapedAt,
                    repository.metadata,
                    { graphql: new RepositoryGraphQLBatcher(fake.client) },
                ),
            ).rejects.toMatchObject({
                name: 'RepositoryEnrichmentSkipError',
                skippedRepository: {
                    status,
                    reasonCode,
                    endpoint: 'https://api.github.com/repos/slu/project',
                    requestId: 'REQ-REST',
                },
            });
        },
    );

    test('reads through REST when a repository GraphQL error is not confirmed by REST', async () => {
        const repository = fakeRepository({
            files: { 'README.md': '# Project', 'CONTRIBUTING.md': 'guide' },
        });
        const rest = await collect([repository], false);
        const graphql = await collect([repository], true, {
            graphqlRepositoryErrors: { 'slu/project': { type: 'NOT_FOUND' } },
        });
        expect(graphql.records).toEqual(rest.records);
        expect(restRequestsFor(graphql.requests, 'slu/project')).toContain(
            '/repos/slu/project/readme',
        );
    });

    test('treats a same-name replacement repository as a repository GraphQL error', async () => {
        const repository = fakeRepository();
        const rest = await collect([repository], false);
        const graphql = await collect([repository], true, {
            graphqlDatabaseIdOffset: 1,
        });
        expect(graphql.records).toEqual(rest.records);
        expect(
            restRequestsFor(graphql.requests, 'slu/project').filter(
                (path) => path === '/repos/slu/project',
            ),
        ).toHaveLength(2);
    });

    test('splits a timed-out batch and reads only the failing repository through REST', async () => {
        const repositories = [
            fakeRepository({}, 'one', 1),
            fakeRepository({}, 'two', 2),
        ];
        const rest = await collect(repositories, false);
        const graphql = await collect(repositories, true, {
            graphqlTimeoutAboveRepositories: 1,
        });
        expect(graphql.records).toEqual(rest.records);
        const snapshots = graphql.requests.filter(
            (request) => request.operation === 'RepositoryEnrichmentSnapshot',
        );
        expect(snapshots.map((request) => request.repositories)).toEqual([
            ['slu/one', 'slu/two'],
            ['slu/one'],
            ['slu/two'],
        ]);
        expect(restRequestsFor(graphql.requests, 'slu/one')).toEqual([
            '/repos/slu/one',
            '/repos/slu/one/contributors',
        ]);
    });

    test('reads a repository through REST when its single-repository query still fails', async () => {
        const repository = fakeRepository();
        const rest = await collect([repository], false);
        const graphql = await collect([repository], true, {
            graphqlFailure: { status: 504 },
        });
        expect(graphql.records).toEqual(rest.records);
    });

    test('fails when GitHub rejects the GraphQL query', async () => {
        await expect(
            collect([fakeRepository()], true, { graphqlFailure: 'validation' }),
        ).rejects.toMatchObject({
            name: 'GitHubGraphQLError',
            validation: true,
        });
    });

    test.each([401, 403])(
        'keeps a GraphQL HTTP %s fatal instead of falling back to REST',
        async (status) => {
            await expect(
                collect([fakeRepository()], true, {
                    graphqlFailure: { status },
                }),
            ).rejects.toMatchObject({ name: 'GitHubRequestError', status });
        },
    );

    test('keeps the contributor size-limit skip on the GraphQL path', async () => {
        const repository = fakeRepository();
        const fake = createFakeGitHub([repository], {
            restOverrides: {
                '/repos/slu/project/contributors': () =>
                    new Response(
                        JSON.stringify({
                            message:
                                'The history or contributor list is too large to list contributors for this repository via the API.',
                        }),
                        { status: 403 },
                    ),
            },
        });
        await expect(
            enrichRepository(
                fake.client,
                { id: 77, fullName: 'slu/project' },
                university,
                () => scrapedAt,
                repository.metadata,
                { graphql: new RepositoryGraphQLBatcher(fake.client) },
            ),
        ).rejects.toMatchObject({
            name: 'RepositoryEnrichmentSkipError',
            skippedRepository: {
                reasonCode: 'github_contributors_unavailable',
            },
        });
    });
});

describe('createEnrichmentOptions', () => {
    test('uses GraphQL only for an authenticated client', () => {
        expect(createEnrichmentOptions(new GitHubRequestClient())).toEqual({});
        expect(
            createEnrichmentOptions(new GitHubRequestClient({ token: 'token' }))
                .graphql,
        ).toBeInstanceOf(RepositoryGraphQLBatcher);
    });

    test('keeps REST when the configuration selects it', () => {
        expect(
            createEnrichmentOptions(
                new GitHubRequestClient({ token: 'token' }),
                'rest',
            ),
        ).toEqual({});
    });
});
