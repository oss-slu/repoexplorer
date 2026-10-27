import { enrichRepository } from '../enrichRepository';
import { GitHubRequestError } from '../utils/githubRequest';
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
        readmeStatus?: number;
        readmeError?: 'auth' | 'permission' | 'sso' | 'tos';
        releases?: unknown[];
        contributors?: unknown[];
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
                return jsonResponse({ message: 'Unavailable' }, {}, options.issueFileStatus);
            }
            const name = apiPath.split('/').at(-1);
            return textResponse(`raw content for ${name}`);
        }
        if (apiPath === '/repos/slu/project') {
            if (options.repositoryStatus !== undefined) {
                return jsonResponse(
                    { message: 'Repository not available' },
                    {},
                    options.repositoryStatus,
                );
            }
            return jsonResponse(options.repository ?? repository());
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
                        message: 'Resource protected by organization SAML enforcement',
                        block: { reason: 'sso' },
                    },
                    {},
                    403,
                );
            }
            if (options.readmeError === 'permission') {
                return jsonResponse({ message: 'Resource not accessible' }, {}, 403);
            }
            return jsonResponse(
                { message: 'Not Found' },
                {},
                options.readmeStatus ?? 404,
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
            if (options.emptyRepository) {
                return new Response(null, { status: 204 });
            }
            const contributors = options.contributors ?? [];
            if (url.searchParams.get('page') === '2') {
                return jsonResponse(contributors[1] ?? []);
            }
            return jsonResponse(
                contributors[0] ?? [],
                contributors.length > 1 ? { link: nextPageHeader(url, 2) } : {},
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
                    repository: repository({ description: { private: 'value' } }),
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
