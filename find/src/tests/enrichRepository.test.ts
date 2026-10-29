import {
    enrichRepository,
    refreshRepositoryMetadata,
} from '../enrichRepository';
import {
    GitHubRequestClient,
    GitHubRequestError,
} from '../utils/githubRequest';
import type {
    RepositoryCandidate,
    UniversityConfiguration,
} from '../types/scraping';
import {
    createTestClient,
    jsonResponse,
    nextPageHeader,
    textResponse,
} from './githubFixtures';

const university: UniversityConfiguration = {
    key: 'Saint Louis University',
    fullName: 'Saint Louis University',
    acronym: 'SLU',
};
const candidate: RepositoryCandidate = { id: 77, fullName: 'slu/project' };

test('drops a stale ETag when a modified repository response has no ETag', async () => {
    const client = createTestClient((url, init) => {
        expect(url.pathname).toBe('/repos/slu/project');
        expect(new Headers(init.headers).get('if-none-match')).toBe('"old"');
        return jsonResponse(repository({ description: 'Changed' }));
    });

    const result = await refreshRepositoryMetadata(client, {
        ...candidate,
        etag: '"old"',
    });

    expect(result).toEqual({
        status: 'modified',
        metadata: repository({ description: 'Changed' }),
    });
});

function repository(overrides: Record<string, unknown> = {}) {
    return {
        id: 77,
        name: 'project',
        full_name: 'slu/project',
        owner: { login: 'slu', type: 'Organization' },
        private: false,
        license: { spdx_id: 'MIT', key: 'mit' },
        language: 'TypeScript',
        html_url: 'https://github.com/slu/project',
        description: 'A repository',
        fork: false,
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

function pathFromReference(field: string): string {
    return `https://api.github.com/repos/slu/project/contents/${field}`;
}

function commonHandler(
    options: {
        repository?: Record<string, unknown>;
        repositoryStatus?: number;
        repositoryStatusBody?: 'json' | 'text' | 'empty';
        readmeStatus?: number;
        readmeStatusBody?: 'json' | 'text' | 'empty';
        readmeRedirectTo?: string;
        readmeError?:
            'auth' | 'permission' | 'sso' | 'tos' | 'contributors-size-limit';
        releases?: unknown[];
        contributors?: unknown[];
        contributorsError?: {
            status: number;
            message: string;
            page?: number;
            headers?: Record<string, string>;
        };
        contributorsRedirectTo?: string;
        emptyRepository?: boolean;
        community?: unknown;
        issueTemplateStatus?: number;
        issueFileStatus?: number;
        securityPolicy?: string | null;
    } = {},
) {
    return createTestClient((url, init) => {
        const apiPath = url.pathname;
        const accept = new Headers(init.headers).get('accept');
        if (apiPath === '/repos/slu/project-other/contents/README.md') {
            return statusResponse(451, 'text');
        }
        if (apiPath === '/repos/slu/project/contents/SECURITY.md') {
            return jsonResponse({ message: 'Not Found' }, {}, 404);
        }
        if (apiPath === '/repos/slu/project/contents/.github/SECURITY.md') {
            return options.securityPolicy === null ||
                options.securityPolicy === undefined
                ? jsonResponse({ message: 'Not Found' }, {}, 404)
                : textResponse(options.securityPolicy);
        }
        if (
            apiPath === '/repos/slu/project/contents' &&
            options.repository?.fork === true
        ) {
            return jsonResponse([
                { type: 'file', path: 'CODE_OF_CONDUCT.md' },
                { type: 'file', path: 'CONTRIBUTING.md' },
                { type: 'dir', path: '.github' },
                { type: 'file', path: 'PULL_REQUEST_TEMPLATE.md' },
            ]);
        }
        if (
            apiPath === '/repos/slu/project/contents/.github' &&
            options.repository?.fork === true
        ) {
            return jsonResponse([
                { type: 'dir', path: '.github/ISSUE_TEMPLATE' },
            ]);
        }
        if (
            apiPath === '/repos/slu/project/contents/.github/ISSUE_TEMPLATE' &&
            options.repository?.fork === true
        ) {
            return jsonResponse([
                { type: 'file', path: '.github/ISSUE_TEMPLATE/bug.yml' },
            ]);
        }
        if (
            apiPath === '/repos/slu/project/contents/.github/ISSUE_TEMPLATE' &&
            options.issueTemplateStatus !== undefined
        ) {
            return jsonResponse(
                { message: 'Unavailable' },
                {},
                options.issueTemplateStatus,
            );
        }
        if (
            apiPath.startsWith('/repos/slu/project/contents/') &&
            accept === 'application/vnd.github.raw+json'
        ) {
            if (
                options.issueFileStatus !== undefined &&
                apiPath.endsWith('/bug.yml')
            ) {
                return jsonResponse(
                    { message: 'Unavailable' },
                    {},
                    options.issueFileStatus,
                );
            }
            const name = apiPath.split('/').at(-1);
            return textResponse(`raw content for ${name}`);
        }
        if (apiPath === '/repos/slu/project') {
            if (options.repositoryStatus !== undefined) {
                return statusResponse(
                    options.repositoryStatus,
                    options.repositoryStatusBody ?? 'json',
                );
            }
            return jsonResponse(options.repository ?? repository());
        }
        if (
            options.readmeRedirectTo &&
            apiPath === '/repos/slu/project/readme'
        ) {
            return new Response(null, {
                status: 301,
                headers: { location: options.readmeRedirectTo },
            });
        }
        if (
            options.readmeRedirectTo &&
            apiPath === options.readmeRedirectTo.split('?')[0]
        ) {
            return statusResponse(451, options.readmeStatusBody ?? 'json');
        }
        if (apiPath === '/repos/slu/project/readme') {
            if (options.readmeError === 'auth') {
                return jsonResponse({ message: 'Bad credentials' }, {}, 401);
            }
            if (options.readmeError === 'tos') {
                return jsonResponse(
                    {
                        message: 'Repository access blocked',
                        block: { reason: 'tos' },
                    },
                    {},
                    403,
                );
            }
            if (options.readmeError === 'sso') {
                return jsonResponse(
                    {
                        message:
                            'Resource protected by organization SAML enforcement',
                        block: { reason: 'sso' },
                    },
                    {},
                    403,
                );
            }
            if (options.readmeError === 'permission') {
                return jsonResponse(
                    { message: 'Resource not accessible' },
                    {},
                    403,
                );
            }
            if (options.readmeError === 'contributors-size-limit') {
                return jsonResponse(
                    {
                        message:
                            'The history or contributor list is too large to list contributors for this repository via the API.',
                    },
                    {},
                    403,
                );
            }
            return statusResponse(
                options.readmeStatus ?? 404,
                options.readmeStatusBody ?? 'json',
            );
        }
        if (apiPath === '/repos/slu/project/releases') {
            const releases = options.releases ?? [];
            if (url.searchParams.get('page') === '2') {
                return jsonResponse(releases[1] ?? []);
            }
            return jsonResponse(
                releases[0] ?? [],
                releases.length > 1 ? { link: nextPageHeader(url, 2) } : {},
            );
        }
        if (apiPath === '/repos/slu/project/contributors') {
            if (options.contributorsRedirectTo) {
                return new Response(null, {
                    status: 301,
                    headers: { location: options.contributorsRedirectTo },
                });
            }
            const page = Number(url.searchParams.get('page') ?? '1');
            if (
                options.contributorsError &&
                (options.contributorsError.page ?? 1) === page
            ) {
                return jsonResponse(
                    { message: options.contributorsError.message },
                    options.contributorsError.headers,
                    options.contributorsError.status,
                );
            }
            if (options.emptyRepository) {
                return new Response(null, { status: 204 });
            }
            const contributors = options.contributors ?? [];
            if (page === 2) {
                return jsonResponse(contributors[1] ?? []);
            }
            return jsonResponse(
                contributors[0] ?? [],
                contributors.length > 1 ? { link: nextPageHeader(url, 2) } : {},
            );
        }
        if (apiPath === '/repos/slu/project-other/contributors') {
            return jsonResponse(
                {
                    message:
                        'The history or contributor list is too large to list contributors for this repository via the API.',
                },
                {},
                403,
            );
        }
        if (apiPath === '/repos/slu/project/community/profile') {
            if (options.community instanceof Error) {
                throw options.community;
            }
            if (options.community === null) {
                return jsonResponse({ message: 'Not Found' }, {}, 404);
            }
            return jsonResponse(options.community ?? { files: {} });
        }
        if (apiPath === '/repos/slu/project/contents/CODE_OF_CONDUCT.md') {
            return jsonResponse({ type: 'file', path: 'CODE_OF_CONDUCT.md' });
        }
        if (apiPath === '/repos/slu/project/contents/CONTRIBUTING.md') {
            return jsonResponse({ type: 'file', path: 'CONTRIBUTING.md' });
        }
        if (apiPath === '/repos/slu/project/contents/.github/ISSUE_TEMPLATE') {
            return jsonResponse([
                { type: 'file', path: '.github/ISSUE_TEMPLATE/bug.yml' },
            ]);
        }
        if (
            apiPath === '/repos/slu/project/contents/PULL_REQUEST_TEMPLATE.md'
        ) {
            return jsonResponse({
                type: 'file',
                path: 'PULL_REQUEST_TEMPLATE.md',
            });
        }
        if (apiPath.startsWith('/repos/slu/project/contents/')) {
            return jsonResponse({ message: 'Not Found' }, {}, 404);
        }
        throw new Error(`Unexpected request: ${url}`);
    });
}

function statusResponse(
    status: number,
    body: 'json' | 'text' | 'empty',
): Response {
    const headers = { 'x-github-request-id': 'REQ-451' };
    if (body === 'empty') return new Response(null, { status, headers });
    if (body === 'text') {
        return new Response('<html>unavailable</html>', { status, headers });
    }
    return jsonResponse({ message: 'Repository unavailable' }, headers, status);
}

describe('enrichRepository', () => {
    test('stores zero contributors when an empty repository returns 204', async () => {
        const result = await enrichRepository(
            commonHandler({ emptyRepository: true }),
            candidate,
            university,
        );
        expect(result.contributors).toBe('[]');
        expect(result.contributorCount).toBe(0);
    });

    test('normalizes timestamps, zero-valued counts, release assets, contributors, and community file contents', async () => {
        const client = commonHandler({
            readmeStatus: 404,
            releases: [
                [{ assets: [{ download_count: 0 }, { download_count: 5 }] }],
                [{ assets: [{ download_count: 7 }] }],
            ],
            contributors: [
                [{ login: 'alpha', contributions: 2 }],
                [{ login: 'beta', contributions: 1 }],
            ],
            community: {
                files: {
                    code_of_conduct_file: {
                        url: pathFromReference('CODE_OF_CONDUCT.md'),
                    },
                    contributing: { url: pathFromReference('CONTRIBUTING.md') },
                    issue_template: {
                        url: pathFromReference('.github/ISSUE_TEMPLATE'),
                    },
                    pull_request_template: {
                        url: pathFromReference('PULL_REQUEST_TEMPLATE.md'),
                    },
                },
            },
            securityPolicy: '# Security\nReport vulnerabilities privately.',
        });
        const scrapedAt = new Date('2026-10-20T12:00:00Z');

        const result = await enrichRepository(
            client,
            candidate,
            university,
            () => scrapedAt,
        );

        expect(result).toMatchObject({
            university: 'Saint Louis University',
            id: 77,
            fullName: 'slu/project',
            owner: 'slu',
            license: 'mit',
            fork: 0,
            createdAt: '2020-01-02T08:04:05.000Z',
            updatedAt: '2024-05-06T07:08:09.000Z',
            pushedAt: '2024-05-06T07:08:09.000Z',
            size: 0,
            releaseDownloads: 12,
            contributors: '["alpha","beta"]',
            contributorCount: 2,
            organization: '1',
            watchers: 4,
            watchersCount: 4,
            readme: null,
            busFactor: null,
            affiliationPredictionGpt5Mini: null,
            typePredictionGpt5Mini: null,
            scrapedAt: '2026-10-20T12:00:00.000Z',
            codeOfConductFile: 'raw content for CODE_OF_CONDUCT.md',
            contributing: 'raw content for CONTRIBUTING.md',
            pullRequestTemplate: 'raw content for PULL_REQUEST_TEMPLATE.md',
            securityPolicy: '# Security\nReport vulnerabilities privately.',
        });
        expect(JSON.parse(result.issueTemplates ?? 'null')).toEqual([
            {
                path: '.github/ISSUE_TEMPLATE/bug.yml',
                content: 'raw content for bug.yml',
            },
        ]);
    });

    test('collects directory templates when a non-fork community profile omits them', async () => {
        const result = await enrichRepository(
            commonHandler({ community: { files: { issue_template: null } } }),
            candidate,
            university,
        );
        expect(JSON.parse(result.issueTemplates ?? 'null')).toEqual([
            {
                path: '.github/ISSUE_TEMPLATE/bug.yml',
                content: 'raw content for bug.yml',
            },
        ]);
    });

    test('stores null when neither the profile nor template directories exist', async () => {
        const result = await enrichRepository(
            commonHandler({ community: null, issueTemplateStatus: 404 }),
            candidate,
            university,
        );
        expect(result.issueTemplates).toBeNull();
    });

    test('does not hide permission errors while looking for template directories', async () => {
        await expect(
            enrichRepository(
                commonHandler({
                    community: { files: {} },
                    issueTemplateStatus: 403,
                }),
                candidate,
                university,
            ),
        ).rejects.toBeInstanceOf(GitHubRequestError);
    });

    test('preserves null license and language, zero downloads, and marks a user-owned fork', async () => {
        const client = commonHandler({
            repository: repository({
                owner: { login: 'contributor', type: 'User' },
                license: null,
                language: null,
                fork: true,
            }),
        });

        const result = await enrichRepository(client, candidate, university);
        expect(result).toMatchObject({
            license: null,
            language: null,
            readme: null,
            releaseDownloads: 0,
            contributorCount: 0,
            contributors: '[]',
            fork: 1,
            organization: null,
            codeOfConductFile: 'raw content for CODE_OF_CONDUCT.md',
            contributing: 'raw content for CONTRIBUTING.md',
            issueTemplates: JSON.stringify([
                {
                    path: '.github/ISSUE_TEMPLATE/bug.yml',
                    content: 'raw content for bug.yml',
                },
            ]),
            pullRequestTemplate: 'raw content for PULL_REQUEST_TEMPLATE.md',
        });
    });

    test('treats a README 401 as an error instead of an absent README', async () => {
        await expect(
            enrichRepository(
                commonHandler({ readmeError: 'auth' }),
                candidate,
                university,
            ),
        ).rejects.toMatchObject({ status: 401 });
    });

    test('classifies a repository-detail 404 as a skippable unavailable repository', async () => {
        await expect(
            enrichRepository(
                commonHandler({ repositoryStatus: 404 }),
                candidate,
                university,
            ),
        ).rejects.toMatchObject({
            name: 'RepositoryEnrichmentSkipError',
            skippedRepository: {
                repositoryId: 77,
                repositoryName: 'slu/project',
                status: 404,
                reasonCode: 'repository_unavailable_404',
            },
        });
    });

    test('retains a structured ToS 403 from a raw-text endpoint for recovery policy', async () => {
        await expect(
            enrichRepository(
                commonHandler({ readmeError: 'tos' }),
                candidate,
                university,
            ),
        ).rejects.toMatchObject({
            name: 'RepositoryEnrichmentSkipError',
            skippedRepository: {
                status: 403,
                reasonCode: 'github_tos_block',
                endpoint: 'https://api.github.com/repos/slu/project/readme',
            },
        });
    });

    test('skips only the exact GitHub contributor-list size-limit response', async () => {
        await expect(
            enrichRepository(
                commonHandler({
                    contributorsError: {
                        status: 403,
                        message:
                            'The history or contributor list is too large to list contributors for this repository via the API.',
                    },
                }),
                candidate,
                university,
            ),
        ).rejects.toMatchObject({
            name: 'RepositoryEnrichmentSkipError',
            skippedRepository: {
                repositoryName: 'slu/project',
                endpoint:
                    'https://api.github.com/repos/slu/project/contributors',
                status: 403,
                reasonCode: 'github_contributors_unavailable',
                reason: 'GitHub contributor history exceeds the REST API listing limit.',
            },
        });
    });

    test('skips a contributor-size limit found on a later contributor page', async () => {
        await expect(
            enrichRepository(
                commonHandler({
                    contributors: [
                        [{ login: 'alpha', contributions: 1 }],
                        [{ login: 'beta', contributions: 1 }],
                    ],
                    contributorsError: {
                        status: 403,
                        message:
                            'The history or contributor list is too large to list contributors for this repository via the API.',
                        page: 2,
                    },
                }),
                candidate,
                university,
            ),
        ).rejects.toMatchObject({
            name: 'RepositoryEnrichmentSkipError',
            skippedRepository: {
                reasonCode: 'github_contributors_unavailable',
            },
        });
    });

    test.each([
        {
            label: 'generic forbidden body',
            status: 403,
            message: 'Forbidden',
            headers: {} as Record<string, string>,
        },
        {
            label: 'SSO header',
            status: 403,
            message:
                'The history or contributor list is too large to list contributors for this repository via the API.',
            headers: { 'x-github-sso': 'required' } as Record<string, string>,
        },
    ])(
        'keeps contributor 403 fatal for $label',
        async ({ status, message, headers }) => {
            await expect(
                enrichRepository(
                    commonHandler({
                        contributorsError: { status, message, headers },
                    }),
                    candidate,
                    university,
                ),
            ).rejects.toMatchObject({
                name: 'GitHubRequestError',
                status: 403,
            });
        },
    );

    test('does not treat the contributor-size message from another repository endpoint as a skip', async () => {
        await expect(
            enrichRepository(
                commonHandler({ readmeError: 'contributors-size-limit' }),
                candidate,
                university,
            ),
        ).rejects.toMatchObject({
            name: 'GitHubRequestError',
            status: 403,
        });
    });

    test('does not skip a contributor-size response redirected to a sibling repository', async () => {
        await expect(
            enrichRepository(
                commonHandler({
                    contributorsRedirectTo:
                        '/repos/slu/project-other/contributors',
                }),
                candidate,
                university,
            ),
        ).rejects.toMatchObject({
            name: 'GitHubRequestError',
            status: 403,
        });
    });

    test('skips a root repository 451 and retains its safe request ID', async () => {
        await expect(
            enrichRepository(
                commonHandler({
                    repositoryStatus: 451,
                    repositoryStatusBody: 'json',
                }),
                candidate,
                university,
            ),
        ).rejects.toMatchObject({
            name: 'RepositoryEnrichmentSkipError',
            skippedRepository: {
                status: 451,
                reasonCode: 'github_legal_restriction',
                requestId: 'REQ-451',
                reason: 'GitHub returned HTTP 451: repository access is unavailable for legal reasons.',
            },
        });
    });

    test.each(['text', 'empty'] as const)(
        'skips a nested repository 451 with a %s body and discards the in-progress record',
        async (body) => {
            await expect(
                enrichRepository(
                    commonHandler({
                        readmeStatus: 451,
                        readmeStatusBody: body,
                    }),
                    candidate,
                    university,
                ),
            ).rejects.toMatchObject({
                name: 'RepositoryEnrichmentSkipError',
                skippedRepository: {
                    status: 451,
                    reasonCode: 'github_legal_restriction',
                    endpoint: 'https://api.github.com/repos/slu/project/readme',
                    requestId: 'REQ-451',
                },
            });
        },
    );

    test('attributes a same-origin rename redirect 451 to the requested repository', async () => {
        await expect(
            enrichRepository(
                commonHandler({
                    readmeStatusBody: 'empty',
                    readmeRedirectTo: '/repos/slu/renamed-project/readme',
                }),
                candidate,
                university,
            ),
        ).rejects.toMatchObject({
            name: 'RepositoryEnrichmentSkipError',
            skippedRepository: {
                repositoryName: 'slu/project',
                endpoint:
                    'https://api.github.com/repos/slu/renamed-project/readme',
                status: 451,
                reasonCode: 'github_legal_restriction',
            },
        });
    });

    test('classifies repository 451 under a configured API base path', async () => {
        const client = new GitHubRequestClient({
            baseUrl: 'https://api.github.example/api/v3/',
            maxRetries: 0,
            fetch: (async (input) => {
                const url = new URL(String(input));
                if (url.pathname.endsWith('/readme')) {
                    return statusResponse(451, 'text');
                }
                if (url.pathname.endsWith('/contributors')) {
                    return new Response(null, { status: 204 });
                }
                if (url.pathname.endsWith('/community/profile')) {
                    return jsonResponse({ files: {} });
                }
                if (url.pathname.endsWith('/releases')) return jsonResponse([]);
                if (url.pathname.includes('/contents/')) {
                    return jsonResponse({ message: 'Not found' }, {}, 404);
                }
                throw new Error(`Unexpected request: ${url.pathname}`);
            }) as typeof fetch,
            sleep: async () => {},
        });

        await expect(
            enrichRepository(
                client,
                candidate,
                university,
                undefined,
                repository(),
            ),
        ).rejects.toMatchObject({
            name: 'RepositoryEnrichmentSkipError',
            skippedRepository: {
                status: 451,
                reasonCode: 'github_legal_restriction',
                endpoint:
                    'https://api.github.example/api/v3/repos/slu/project/readme',
            },
        });
    });

    test('does not skip a repository for a sibling path-prefix 451', async () => {
        const client = commonHandler({
            community: {
                files: {
                    code_of_conduct_file: {
                        url: 'https://api.github.com/repos/slu/project-other/contents/README.md',
                    },
                },
            },
        });

        await expect(
            enrichRepository(client, candidate, university),
        ).rejects.toMatchObject({
            name: 'GitHubRequestError',
            status: 451,
        });
    });

    test.each(['permission', 'sso'] as const)(
        'keeps unexplained and SSO HTTP 403 errors fatal (%s)',
        async (readmeError) => {
            await expect(
                enrichRepository(
                    commonHandler({ readmeError }),
                    candidate,
                    university,
                ),
            ).rejects.toMatchObject({
                name: 'GitHubRequestError',
                status: 403,
                classification: 'permission',
            });
        },
    );

    test('does not treat a nested content 404 as a repository skip', async () => {
        await expect(
            enrichRepository(
                commonHandler({
                    repository: repository({ fork: true }),
                    issueFileStatus: 404,
                }),
                candidate,
                university,
            ),
        ).rejects.toMatchObject({ name: 'GitHubRequestError', status: 404 });
    });

    test('rejects unsafe GitHub counts instead of coercing them', async () => {
        await expect(
            enrichRepository(
                commonHandler({
                    repository: repository({
                        stargazers_count: Number.MAX_SAFE_INTEGER + 1,
                    }),
                }),
                candidate,
                university,
            ),
        ).rejects.toMatchObject({
            name: 'RepositoryRecordValidationError',
            repository: 'slu/project',
            field: 'stargazers_count',
        });
    });

    test('rejects malformed contributor payloads', async () => {
        await expect(
            enrichRepository(
                commonHandler({
                    contributors: [[{ login: 'alpha', contributions: 'many' }]],
                }),
                candidate,
                university,
            ),
        ).rejects.toMatchObject({
            name: 'RepositoryRecordValidationError',
            repository: 'slu/project',
            field: 'contributions',
        });
    });

    test('reports the repository field for invalid descriptive payload values without exposing content', async () => {
        await expect(
            enrichRepository(
                commonHandler({
                    repository: repository({
                        description: { private: 'value' },
                    }),
                }),
                candidate,
                university,
            ),
        ).rejects.toMatchObject({
            name: 'RepositoryRecordValidationError',
            repository: 'slu/project',
            field: 'description',
        });
    });
});
