import { trimTrailingSlashes } from './utils/trimTrailingSlashes';
import {
    GitHubRequestClient,
    GitHubRequestError,
    type GitHubResponse,
} from './utils/githubRequest';
import {
    extractGitHubItems,
    getNextGitHubPage,
    paginateGitHub,
} from './utils/githubPagination';
import { allOrThrow, mapWithConcurrency } from './utils/concurrency';
import { RepositoryGraphQLBatcher } from './utils/repositoryGraphQLBatcher';
import type {
    EnrichmentApi,
    RepositoryCandidate,
    RepositoryContributorCache,
    RepositoryScrapingRecord,
    SkippedRepository,
    UniversityConfiguration,
} from './types/scraping';
import {
    describeSkippedRepositoryReason,
    RepositoryEnrichmentSkipError,
    RepositoryRecordValidationError,
} from './utils/scrapingError';
import { sanitizeGitHubEndpoint } from './utils/scrapingDiagnostics';
import type {
    GraphQLGitObject,
    GraphQLRepositorySnapshot,
    GraphQLSnapshotResult,
} from './utils/repositoryGraphQLBatcher';

type RepositoryPayload = {
    id: number;
    name?: string;
    full_name?: string;
    owner: { login: string; type: 'Organization' | 'User' };
    private: boolean;
    license?: { spdx_id?: string | null; key?: string | null } | null;
    language?: string | null;
    html_url?: string | null;
    description?: string | null;
    fork: boolean;
    created_at: string;
    updated_at: string;
    pushed_at?: string | null;
    homepage?: string | null;
    size: number;
    stargazers_count: number;
    watchers_count: number;
    forks_count: number;
    open_issues_count: number;
    subscribers_count: number;
};

type CommunityProfile = {
    files: {
        code_of_conduct_file?: ContentReference | null;
        contributing?: ContentReference | null;
        issue_template?: ContentReference | null;
        pull_request_template?: ContentReference | null;
    };
};

type ContentReference = { url: string };

type ContentEntry = {
    type: 'file' | 'dir';
    path: string;
};

export type EnrichRepositoryOptions = {
    /**
     * Reads README, community files, and releases through batched GraphQL;
     * contributors and the repository resource stay on REST. Omit to read
     * everything through REST.
     */
    graphql?: RepositoryGraphQLBatcher;
};

/**
 * Chooses the enrichment read path for one scraping run. GraphQL needs
 * credentials, so an anonymous client keeps the REST path.
 */
export function createEnrichmentOptions(
    client: GitHubRequestClient,
    api: EnrichmentApi = 'graphql',
): EnrichRepositoryOptions {
    return api === 'graphql' && client.isAuthenticated()
        ? { graphql: new RepositoryGraphQLBatcher(client) }
        : {};
}

export async function enrichRepository(
    client: GitHubRequestClient,
    candidate: RepositoryCandidate,
    university: UniversityConfiguration,
    now: () => Date = () => new Date(),
    repositoryMetadata?: unknown,
    options: EnrichRepositoryOptions = {},
): Promise<RepositoryScrapingRecord> {
    return (
        await enrichRepositoryWithEtags(
            client,
            candidate,
            university,
            now,
            repositoryMetadata,
            options,
        )
    ).record;
}

export type RepositoryEnrichment = {
    record: RepositoryScrapingRecord;
    /** ETag that can revalidate the record's contributor list next time. */
    contributorsEtag?: string;
};

/**
 * Enriches one repository and returns the validators a collection run saves
 * for its next conditional refresh. A candidate's `contributorCache` makes the
 * contributor read conditional.
 */
export async function enrichRepositoryWithEtags(
    client: GitHubRequestClient,
    candidate: RepositoryCandidate,
    university: UniversityConfiguration,
    now: () => Date = () => new Date(),
    repositoryMetadata?: unknown,
    options: EnrichRepositoryOptions = {},
): Promise<RepositoryEnrichment> {
    const endpoint = repositoryEndpoint(candidate.fullName);
    try {
        return await enrichRepositoryRecord(
            client,
            candidate,
            university,
            now,
            endpoint,
            repositoryMetadata,
            options,
        );
    } catch (error) {
        const skippedRepository = decideSkippedRepository(
            error,
            candidate,
            university.key,
            endpoint,
        );
        if (skippedRepository) {
            throw new RepositoryEnrichmentSkipError(skippedRepository, {
                cause: error,
            });
        }
        if (
            error instanceof TypeError &&
            !(error instanceof RepositoryRecordValidationError)
        ) {
            throw new RepositoryRecordValidationError(
                candidate.fullName,
                inferValidationField(error),
                `Repository ${candidate.fullName} data failed validation`,
                { cause: error },
            );
        }
        throw error;
    }
}

export type RepositoryRefreshResult =
    | { status: 'unchanged'; etag?: string }
    | { status: 'modified'; metadata: unknown; etag?: string };

/**
 * Fetches the canonical repository resource, using its saved ETag when
 * available. A known repository that has since become unavailable is a
 * documented skip, as it is during full enrichment.
 */
export async function refreshRepositoryMetadata(
    client: GitHubRequestClient,
    candidate: RepositoryCandidate,
    university: string,
): Promise<RepositoryRefreshResult> {
    const endpoint = repositoryEndpoint(candidate.fullName);
    let response: GitHubResponse<unknown>;
    try {
        response = await client.request<unknown>(endpoint, {
            ...(candidate.etag
                ? { headers: { 'If-None-Match': candidate.etag } }
                : {}),
        });
    } catch (error) {
        const skippedRepository = decideSkippedRepository(
            error,
            candidate,
            university,
            endpoint,
        );
        if (skippedRepository) {
            throw new RepositoryEnrichmentSkipError(skippedRepository, {
                cause: error,
            });
        }
        throw error;
    }
    const responseEtag = response.headers.get('etag') ?? undefined;
    if (response.notModified || response.status === 304) {
        const etag = responseEtag ?? candidate.etag;
        return { status: 'unchanged', ...(etag ? { etag } : {}) };
    }
    return {
        status: 'modified',
        metadata: response.data,
        ...(responseEtag ? { etag: responseEtag } : {}),
    };
}

async function enrichRepositoryRecord(
    client: GitHubRequestClient,
    candidate: RepositoryCandidate,
    university: UniversityConfiguration,
    now: () => Date,
    endpoint: string,
    repositoryMetadata: unknown,
    options: EnrichRepositoryOptions,
): Promise<RepositoryEnrichment> {
    const repository = parseRepositoryPayload(
        hasRepositoryEnrichmentFields(repositoryMetadata)
            ? repositoryMetadata
            : await requestJson(client, endpoint),
        candidate,
    );
    if (repository.private) {
        throw new Error(`Repository ${candidate.fullName} is no longer public`);
    }

    const rest = new RestRepositoryReader(client, endpoint);
    const reader: RepositoryContentReader = options.graphql
        ? new GraphQLRepositoryReader(
              client,
              rest,
              options.graphql,
              endpoint,
              optionalString(repository.full_name, 'full_name') ??
                  candidate.fullName,
              repository.id,
          )
        : rest;
    const directories = new RepositoryDirectoryIndex((path) =>
        reader.listOptionalDirectory(path),
    );
    const [readme, releaseDownloads, contributors, community] =
        await allOrThrow([
            reader.readme(directories),
            reader.releaseDownloads(),
            getContributors(client, endpoint, candidate.contributorCache),
            repository.fork
                ? getForkCommunityProfile(endpoint, directories)
                : reader.communityProfile(directories),
        ]);

    const [
        codeOfConductFile,
        contributing,
        issueTemplates,
        pullRequestTemplate,
        securityPolicy,
    ] = await allOrThrow([
        readCommunityReference(reader, community?.files.code_of_conduct_file),
        readCommunityReference(reader, community?.files.contributing),
        readIssueTemplates(
            reader,
            directories,
            community?.files.issue_template,
        ),
        readCommunityReference(reader, community?.files.pull_request_template),
        readSecurityPolicy(reader, directories),
    ]);

    const timestamp = now();
    if (Number.isNaN(timestamp.getTime())) {
        throw new TypeError('Scrape clock returned an invalid date');
    }
    const record: RepositoryScrapingRecord = {
        university: university.key,
        id: repository.id,
        fullName:
            optionalString(repository.full_name, 'full_name') ??
            candidate.fullName,
        owner: repository.owner.login,
        license: normalizeLicense(repository.license),
        language: optionalString(repository.language, 'language'),
        htmlUrl: optionalString(repository.html_url, 'html_url'),
        description: optionalString(repository.description, 'description'),
        fork: repository.fork ? 1 : 0,
        createdAt: normalizeTimestamp(repository.created_at, 'created_at'),
        updatedAt: normalizeTimestamp(repository.updated_at, 'updated_at'),
        pushedAt: nullableTimestamp(repository.pushed_at, 'pushed_at'),
        homepage: optionalString(repository.homepage, 'homepage'),
        size: safeNonNegativeInteger(repository.size, 'size'),
        stargazersCount: safeNonNegativeInteger(
            repository.stargazers_count,
            'stargazers_count',
        ),
        readme,
        watchersCount: safeNonNegativeInteger(
            repository.watchers_count,
            'watchers_count',
        ),
        forksCount: safeNonNegativeInteger(
            repository.forks_count,
            'forks_count',
        ),
        openIssuesCount: safeNonNegativeInteger(
            repository.open_issues_count,
            'open_issues_count',
        ),
        watchers: safeNonNegativeInteger(
            repository.watchers_count,
            'watchers_count',
        ),
        organization: repository.owner.type === 'Organization' ? '1' : null,
        releaseDownloads,
        contributors: JSON.stringify(contributors.logins),
        contributorCount: contributors.logins.length,
        busFactor: null,
        codeOfConductFile,
        contributing,
        securityPolicy,
        issueTemplates,
        pullRequestTemplate,
        subscribersCount: safeNonNegativeInteger(
            repository.subscribers_count,
            'subscribers_count',
        ),
        affiliationPredictionGpt5Mini: null,
        typePredictionGpt5Mini: null,
        scrapedAt: timestamp.toISOString(),
    };
    return {
        record,
        ...(contributors.etag ? { contributorsEtag: contributors.etag } : {}),
    };
}

function hasRepositoryEnrichmentFields(value: unknown): boolean {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return [
        'id',
        'full_name',
        'owner',
        'private',
        'license',
        'language',
        'html_url',
        'description',
        'fork',
        'created_at',
        'updated_at',
        'pushed_at',
        'homepage',
        'size',
        'stargazers_count',
        'watchers_count',
        'forks_count',
        'open_issues_count',
        'subscribers_count',
    ].every((field) => Object.hasOwn(record, field));
}

function decideSkippedRepository(
    error: unknown,
    candidate: RepositoryCandidate,
    university: string,
    endpoint: string,
): SkippedRepository | undefined {
    const requestError = findGitHubRequestError(error);
    if (!requestError) return undefined;

    if (
        requestError.status === 403 &&
        isTermsOfServiceBlock(requestError.data) &&
        isRepositoryScopedRequest(requestError, endpoint, false)
    ) {
        return {
            ...skippedRepositoryBase(requestError, candidate, university),
            status: 403,
            reasonCode: 'github_tos_block',
            reason: describeSkippedRepositoryReason('github_tos_block'),
        };
    }
    if (
        requestError.status === 403 &&
        requestError.blockReason === 'github_contributors_size_limit' &&
        requestError.classification === 'permission' &&
        requestError.accessReason === 'unknown-forbidden' &&
        requestError.ssoStatus === undefined &&
        requestError.rateLimit === undefined &&
        isExactRepositoryEndpointRequest(
            requestError,
            `${endpoint}/contributors`,
        )
    ) {
        return {
            ...skippedRepositoryBase(requestError, candidate, university),
            status: 403,
            reasonCode: 'github_contributors_unavailable',
            reason: describeSkippedRepositoryReason(
                'github_contributors_unavailable',
            ),
        };
    }
    if (
        requestError.status === 404 &&
        isRepositoryScopedRequest(requestError, endpoint, true)
    ) {
        return {
            ...skippedRepositoryBase(requestError, candidate, university),
            status: 404,
            reasonCode: 'repository_unavailable_404',
            reason: describeSkippedRepositoryReason(
                'repository_unavailable_404',
            ),
        };
    }
    if (
        requestError.status === 451 &&
        isRepositoryScopedRequest(requestError, endpoint, false)
    ) {
        return {
            ...skippedRepositoryBase(requestError, candidate, university),
            status: 451,
            reasonCode: 'github_legal_restriction',
            reason: describeSkippedRepositoryReason('github_legal_restriction'),
        };
    }
    return undefined;
}

function skippedRepositoryBase(
    requestError: GitHubRequestError,
    candidate: RepositoryCandidate,
    university: string,
) {
    return {
        university,
        repositoryId: candidate.id,
        repositoryName: candidate.fullName,
        endpoint: sanitizeGitHubEndpoint(requestError.url),
        ...(requestError.requestId
            ? { requestId: requestError.requestId }
            : {}),
    };
}

/** Check both the original resource and the trusted effective redirect target. */
function isRepositoryScopedRequest(
    error: GitHubRequestError,
    endpoint: string,
    rootOnly: boolean,
): boolean {
    try {
        const requestedUrl = new URL(error.requestedUrl);
        const finalUrl = new URL(error.url);
        if (
            requestedUrl.protocol !== 'https:' ||
            finalUrl.protocol !== 'https:' ||
            requestedUrl.origin !== error.apiOrigin ||
            finalUrl.origin !== error.apiOrigin
        ) {
            return false;
        }
        const rootPath = new URL(
            `${error.apiOrigin}${error.apiBasePath}${endpoint}`,
        ).pathname;
        const requestedPath = requestedUrl.pathname;
        if (
            requestedPath !== rootPath &&
            !requestedPath.startsWith(`${rootPath}/`)
        ) {
            return false;
        }
        if (rootOnly && requestedPath !== rootPath) return false;

        const requestedSuffix = repositoryResourceSuffix(
            requestedPath,
            error.apiBasePath,
        );
        const finalSuffix = repositoryResourceSuffix(
            finalUrl.pathname,
            error.apiBasePath,
        );
        return requestedSuffix !== undefined && requestedSuffix === finalSuffix;
    } catch {
        return false;
    }
}

/** Match only the candidate's exact contributors resource on both URLs. */
function isExactRepositoryEndpointRequest(
    error: GitHubRequestError,
    endpoint: string,
): boolean {
    try {
        const requestedUrl = new URL(error.requestedUrl);
        const finalUrl = new URL(error.url);
        const expectedPath = new URL(
            `${error.apiOrigin}${error.apiBasePath}${endpoint}`,
        ).pathname;
        return [requestedUrl, finalUrl].every(
            (url) =>
                url.protocol === 'https:' &&
                url.origin === error.apiOrigin &&
                !url.username &&
                !url.password &&
                url.pathname === expectedPath,
        );
    } catch {
        return false;
    }
}

function repositoryResourceSuffix(
    pathname: string,
    apiBasePath: string,
): string | undefined {
    const basePath = trimTrailingSlashes(apiBasePath);
    let apiPath = pathname;
    if (basePath) {
        if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
            return undefined;
        }
        apiPath = pathname.slice(basePath.length) || '/';
    }
    const match = apiPath.match(/^\/repos\/[^/]+\/[^/]+(\/.*)?$/);
    return match ? (match[1] ?? '') : undefined;
}

function findGitHubRequestError(
    error: unknown,
): GitHubRequestError | undefined {
    const visited = new Set<unknown>();
    let current: unknown = error;
    while (current instanceof Error && !visited.has(current)) {
        if (current instanceof GitHubRequestError) return current;
        visited.add(current);
        current = current.cause;
    }
    return undefined;
}

function isTermsOfServiceBlock(value: unknown): boolean {
    if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !('block' in value)
    ) {
        return false;
    }
    const block = value.block;
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
        return false;
    }
    return 'reason' in block && block.reason === 'tos';
}

function inferValidationField(error: TypeError): string {
    const knownFields = [
        'stargazers_count',
        'watchers_count',
        'forks_count',
        'open_issues_count',
        'subscribers_count',
        'download_count',
        'contributions',
        'description',
        'language',
        'html_url',
        'homepage',
        'spdx_id',
        'created_at',
        'updated_at',
        'pushed_at',
        'full_name',
        'issue_template',
        'id',
        'owner',
        'login',
        'assets',
        'path',
        'url',
        'content',
    ];
    const field = knownFields.find((candidate) =>
        error.message.includes(candidate),
    );
    return field ?? 'payload';
}

async function getReleaseDownloads(
    client: GitHubRequestClient,
    repositoryEndpointPath: string,
): Promise<number> {
    const releases = await paginateGitHub<unknown>(
        client,
        `${repositoryEndpointPath}/releases`,
        { query: { per_page: 100 } },
    );
    return sumReleaseDownloads(
        releases.data.map((value, releaseIndex) => {
            const release = requireRecord(value, `release ${releaseIndex}`);
            if (!Array.isArray(release.assets)) {
                throw new TypeError(
                    `GitHub release ${releaseIndex} has no assets array`,
                );
            }
            return release.assets.map(
                (assetValue, assetIndex) =>
                    requireRecord(assetValue, `release asset ${assetIndex}`)
                        .download_count,
            );
        }),
    );
}

function sumReleaseDownloads(downloadCounts: readonly unknown[][]): number {
    let total = 0;
    for (const assets of downloadCounts) {
        for (const count of assets) {
            total = addSafeCounts(
                total,
                safeNonNegativeInteger(count, 'download_count'),
                'release download total',
            );
        }
    }
    return total;
}

const CONTRIBUTORS_PER_PAGE = 100;

type ContributorList = {
    logins: string[];
    /** Set only when the list fits in one page that is not full. */
    etag?: string;
};

/**
 * Reads the contributor list, revalidating a cached one with its ETag.
 *
 * A first-page `304` proves only that the first page is unchanged. A list
 * with fewer than `per_page` entries lives entirely on that page, so any
 * added, removed or recounted contributor changes its body and ETag. A full
 * or multi-page list gets no reusable ETag and is always read again.
 */
async function getContributors(
    client: GitHubRequestClient,
    repositoryEndpointPath: string,
    cache?: RepositoryContributorCache,
): Promise<ContributorList> {
    const conditional =
        cache !== undefined && cache.logins.length < CONTRIBUTORS_PER_PAGE;
    const firstPage = await client.request<unknown>(
        `${repositoryEndpointPath}/contributors`,
        {
            query: { per_page: CONTRIBUTORS_PER_PAGE },
            allowNoContent: true,
            ...(conditional
                ? { headers: { 'If-None-Match': cache.etag } }
                : {}),
        },
    );
    const responseEtag = firstPage.headers.get('etag') ?? undefined;
    if (conditional && (firstPage.notModified || firstPage.status === 304)) {
        return { logins: [...cache.logins], etag: responseEtag ?? cache.etag };
    }

    // GitHub returns 204 for contributor listings on empty repositories.
    const firstItems =
        firstPage.status === 204
            ? []
            : extractGitHubItems<unknown>(firstPage.data);
    const nextPage = getNextGitHubPage(firstPage.headers.get('link'));
    const items = nextPage
        ? [
              ...firstItems,
              ...(
                  await paginateGitHub<unknown>(
                      client,
                      new URL(nextPage, firstPage.url).toString(),
                      { allowNoContent: true },
                  )
              ).data,
          ]
        : firstItems;

    const logins: string[] = [];
    const seen = new Set<string>();
    for (const [index, value] of items.entries()) {
        const contributor = requireRecord(value, `contributor ${index}`);
        if (
            typeof contributor.login !== 'string' ||
            contributor.login.trim() === ''
        ) {
            throw new TypeError(`GitHub contributor ${index} has no login`);
        }
        safeNonNegativeInteger(contributor.contributions, 'contributions');
        const login = contributor.login;
        const normalizedLogin = login.toLowerCase();
        if (!seen.has(normalizedLogin)) {
            seen.add(normalizedLogin);
            logins.push(login);
        }
    }
    const reusable =
        !nextPage && firstItems.length < CONTRIBUTORS_PER_PAGE && responseEtag;
    return { logins, ...(reusable ? { etag: responseEtag } : {}) };
}

async function getCommunityProfile(
    client: GitHubRequestClient,
    endpoint: string,
): Promise<CommunityProfile | null> {
    try {
        const value = await requestJson(client, endpoint);
        const profile = requireRecord(value, 'community profile');
        const files = requireRecord(profile.files, 'community profile files');
        return {
            files: {
                code_of_conduct_file: parseContentReference(
                    files.code_of_conduct_file,
                    'code_of_conduct_file',
                ),
                contributing: parseContentReference(
                    files.contributing,
                    'contributing',
                ),
                issue_template: parseContentReference(
                    files.issue_template,
                    'issue_template',
                ),
                pull_request_template: parseContentReference(
                    files.pull_request_template,
                    'pull_request_template',
                ),
            },
        };
    } catch (error) {
        if (isNotFound(error)) {
            return null;
        }
        throw error;
    }
}

async function getForkCommunityProfile(
    endpoint: string,
    directories: RepositoryDirectoryIndex,
): Promise<CommunityProfile> {
    const [rootListing, githubListing] = await Promise.all([
        directories.root(),
        directories.github(),
    ]);
    const entries = [
        ...(rootListing?.entries ?? []),
        ...(githubListing?.entries ?? []),
    ];
    return {
        files: {
            code_of_conduct_file: referenceForFirstPath(endpoint, entries, [
                'CODE_OF_CONDUCT.md',
                'CODE_OF_CONDUCT',
                '.github/CODE_OF_CONDUCT.md',
                '.github/CODE_OF_CONDUCT',
            ]),
            contributing: referenceForFirstPath(endpoint, entries, [
                'CONTRIBUTING.md',
                'CONTRIBUTING',
                '.github/CONTRIBUTING.md',
                '.github/CONTRIBUTING',
            ]),
            issue_template: referenceForFirstPath(endpoint, entries, [
                'ISSUE_TEMPLATE',
                'ISSUE_TEMPLATE.md',
                '.github/ISSUE_TEMPLATE',
                '.github/ISSUE_TEMPLATE.md',
            ]),
            pull_request_template: referenceForFirstPath(endpoint, entries, [
                'PULL_REQUEST_TEMPLATE.md',
                'PULL_REQUEST_TEMPLATE',
                '.github/PULL_REQUEST_TEMPLATE.md',
                '.github/PULL_REQUEST_TEMPLATE',
            ]),
        },
    };
}

type DirectoryListing = {
    entries: ContentEntry[];
    /** Every listed path, including symlinks and submodules omitted from entries. */
    paths: Set<string>;
};

async function listOptionalContentDirectory(
    client: GitHubRequestClient,
    endpoint: string,
): Promise<DirectoryListing | null> {
    try {
        const value = await requestJson(client, endpoint);
        if (!Array.isArray(value)) {
            throw new TypeError(
                `GitHub content directory ${endpoint} did not return an array`,
            );
        }
        const entries: ContentEntry[] = [];
        const paths = new Set<string>();
        value.forEach((entry, index) => {
            const parsed = parseContentEntry(entry, index);
            if (parsed) entries.push(parsed);
            paths.add(
                requireRecord(entry, `content entry ${index}`).path as string,
            );
        });
        return { entries, paths };
    } catch (error) {
        if (isNotFound(error)) {
            return null;
        }
        throw error;
    }
}

/**
 * Lists the root, `.github`, and `docs` directories at most once per
 * repository, so optional-file lookups read only paths GitHub reports instead
 * of probing each candidate path and paying a core request for every 404.
 */
class RepositoryDirectoryIndex {
    private readonly listings = new Map<
        string,
        Promise<DirectoryListing | null>
    >();

    constructor(
        private readonly listDirectory: (
            path: string,
        ) => Promise<DirectoryListing | null>,
    ) {}

    root(): Promise<DirectoryListing | null> {
        return this.list('');
    }

    /** Matches `.github` case-insensitively, as fork community detection did. */
    async github(): Promise<DirectoryListing | null> {
        const directory = (await this.root())?.entries.find(
            (entry) =>
                entry.type === 'dir' && entry.path.toLowerCase() === '.github',
        );
        return directory ? this.list(directory.path) : null;
    }

    async docs(): Promise<DirectoryListing | null> {
        const directory = (await this.root())?.entries.find(
            (entry) => entry.type === 'dir' && entry.path === 'docs',
        );
        return directory ? this.list(directory.path) : null;
    }

    private list(path: string): Promise<DirectoryListing | null> {
        let listing = this.listings.get(path);
        if (!listing) {
            listing = this.listDirectory(path);
            this.listings.set(path, listing);
        }
        return listing;
    }
}

/**
 * The repository reads enrichment needs. Paths are repository-relative and
 * `''` is the root. Optional reads map a 404 to null; required reads let every
 * error reach the HTTP error policy.
 */
interface RepositoryContentReader {
    listOptionalDirectory(path: string): Promise<DirectoryListing | null>;
    listDirectory(path: string): Promise<ContentEntry[]>;
    readText(path: string): Promise<string>;
    readOptionalText(path: string): Promise<string | null>;
    readme(directories: RepositoryDirectoryIndex): Promise<string | null>;
    releaseDownloads(): Promise<number>;
    /** Community files for a non-fork repository. */
    communityProfile(
        directories: RepositoryDirectoryIndex,
    ): Promise<CommunityProfile | null>;
    readReference(reference: ContentReference): Promise<string | null>;
}

class RestRepositoryReader implements RepositoryContentReader {
    constructor(
        private readonly client: GitHubRequestClient,
        private readonly endpoint: string,
    ) {}

    listOptionalDirectory(path: string): Promise<DirectoryListing | null> {
        return listOptionalContentDirectory(
            this.client,
            path
                ? contentPath(this.endpoint, path)
                : `${this.endpoint}/contents`,
        );
    }

    async listDirectory(path: string): Promise<ContentEntry[]> {
        const value = await requestJson(
            this.client,
            contentPath(this.endpoint, path),
        );
        if (!Array.isArray(value)) {
            throw new TypeError(
                `GitHub content directory ${path} did not return an array`,
            );
        }
        return value.flatMap((item, index) => {
            const parsed = parseContentEntry(item, index);
            return parsed ? [parsed] : [];
        });
    }

    readText(path: string): Promise<string> {
        return readRawText(this.client, contentPath(this.endpoint, path));
    }

    readOptionalText(path: string): Promise<string | null> {
        return readOptionalText(this.client, contentPath(this.endpoint, path));
    }

    readme(): Promise<string | null> {
        return readOptionalText(this.client, `${this.endpoint}/readme`);
    }

    releaseDownloads(): Promise<number> {
        return getReleaseDownloads(this.client, this.endpoint);
    }

    communityProfile(): Promise<CommunityProfile | null> {
        return getCommunityProfile(
            this.client,
            `${this.endpoint}/community/profile`,
        );
    }

    readReference(reference: ContentReference): Promise<string | null> {
        return readRestCommunityReference(this.client, reference);
    }
}

type EntryKind = 'file' | 'dir' | 'symlink' | 'submodule';

const SYMLINK_MODE = 0o120000;
/** REST contents listings stop at 1,000 entries, and `/readme` searches only those. */
const REST_DIRECTORY_LIMIT = 1000;
const README_NAME = /^readme(?:\..*)?$/i;
const COMMUNITY_FILES = [
    { field: 'code_of_conduct_file', stem: 'code_of_conduct' },
    { field: 'contributing', stem: 'contributing' },
    { field: 'issue_template', stem: 'issue_template' },
    { field: 'pull_request_template', stem: 'pull_request_template' },
] as const;

/**
 * Answers reads from one batched GraphQL snapshot of the default branch and
 * delegates to REST whenever GraphQL cannot give the REST answer exactly:
 * symlinks, submodules, binary, truncated, or transcoded blobs, directories
 * over REST's listing limit, more than 100 releases or assets, ambiguous
 * README or community files, and unavailable results. A
 * repository-level GraphQL error re-requests the REST repository resource
 * first, so the HTTP error policy decides whether the repository is skipped.
 */
class GraphQLRepositoryReader implements RepositoryContentReader {
    private readonly snapshot: Promise<GraphQLRepositorySnapshot | undefined>;
    private readonly kinds = new Map<string, EntryKind>();
    private readonly inlinedBlobs = new Map<string, GraphQLGitObject>();
    /** Listings built from GraphQL trees, whose entry kinds are known. */
    private readonly graphQLListings = new WeakSet<DirectoryListing>();
    private readonly owner: string;
    private readonly name: string;

    constructor(
        private readonly client: GitHubRequestClient,
        private readonly rest: RestRepositoryReader,
        private readonly batcher: RepositoryGraphQLBatcher,
        private readonly endpoint: string,
        fullName: string,
        private readonly id: number,
    ) {
        [this.owner, this.name] = fullName.split('/');
        this.snapshot = batcher
            .snapshot({ owner: this.owner, name: this.name, id })
            .then((result) => this.resolveSnapshot(result));
        // Every read awaits the snapshot; this only prevents an unobserved rejection.
        this.snapshot.catch(() => undefined);
    }

    async listOptionalDirectory(
        path: string,
    ): Promise<DirectoryListing | null> {
        const snapshot = await this.snapshot;
        if (!snapshot) return this.rest.listOptionalDirectory(path);
        // REST answers 404 for every contents path of an empty repository.
        if (snapshot.commitOid === null) return null;
        const object = await this.object(snapshot, path);
        if (object === null) return null;
        if (!isRestSizedTree(object)) {
            return this.rest.listOptionalDirectory(path);
        }
        return this.toListing(path, object);
    }

    async listDirectory(path: string): Promise<ContentEntry[]> {
        const snapshot = await this.snapshot;
        const object =
            snapshot?.commitOid && (await this.object(snapshot, path));
        if (!object || !isRestSizedTree(object)) {
            return this.rest.listDirectory(path);
        }
        return this.toListing(path, object).entries;
    }

    async readText(path: string): Promise<string> {
        return (await this.readBlob(path)) ?? this.rest.readText(path);
    }

    async readOptionalText(path: string): Promise<string | null> {
        return (await this.readBlob(path)) ?? this.rest.readOptionalText(path);
    }

    /**
     * Answers only when the README is unambiguous: none in `.github`, the
     * root, or `docs`, or exactly one regular file in the root whose text
     * GraphQL holds whole. Other layouts use REST's preferred-README
     * resolution, which also truncates large READMEs.
     */
    async readme(
        directories: RepositoryDirectoryIndex,
    ): Promise<string | null> {
        const snapshot = await this.snapshot;
        if (!snapshot) return this.rest.readme();
        if (snapshot.commitOid === null) return null;
        const [github, root, docs] = await allOrThrow([
            directories.github(),
            directories.root(),
            directories.docs(),
        ]);
        if (!root || !this.allFromGraphQL([github, root, docs])) {
            return this.rest.readme();
        }
        const candidates = [github, root, docs].flatMap((listing) =>
            [...(listing?.paths ?? [])].filter((path) => {
                const kind = this.kinds.get(path);
                return (
                    (kind === 'file' || kind === 'symlink') &&
                    README_NAME.test(baseName(path))
                );
            }),
        );
        if (candidates.length === 0) return null;
        const [path] = candidates;
        if (
            candidates.length === 1 &&
            root.paths.has(path) &&
            this.kinds.get(path) === 'file'
        ) {
            return (await this.readBlob(path)) ?? this.rest.readme();
        }
        return this.rest.readme();
    }

    async releaseDownloads(): Promise<number> {
        const snapshot = await this.snapshot;
        if (!snapshot || snapshot.releases.hasMore) {
            return this.rest.releaseDownloads();
        }
        return sumReleaseDownloads(snapshot.releases.assetDownloadCounts);
    }

    /**
     * Applies GitHub's documented `.github`, root, `docs` precedence to
     * `CODE_OF_CONDUCT`, `CONTRIBUTING`, `ISSUE_TEMPLATE`, and
     * `PULL_REQUEST_TEMPLATE` files with no extension or `.md`, treating `-`
     * and `_` alike. As observed from the REST profile, directories are not
     * reported; issue-template directories are found by the directory search.
     * Any other extension, a symlink, or two matches in one directory uses the
     * REST community profile.
     */
    async communityProfile(
        directories: RepositoryDirectoryIndex,
    ): Promise<CommunityProfile | null> {
        const snapshot = await this.snapshot;
        if (!snapshot) return this.rest.communityProfile();
        if (snapshot.commitOid === null) return { files: {} };
        const listings = await allOrThrow([
            directories.github(),
            directories.root(),
            directories.docs(),
        ]);
        if (!this.allFromGraphQL(listings)) return this.rest.communityProfile();
        const files: CommunityProfile['files'] = {};
        for (const { field, stem } of COMMUNITY_FILES) {
            files[field] = null;
            for (const listing of listings) {
                const matches = [...(listing?.paths ?? [])].filter((path) => {
                    if (this.kinds.get(path) === 'dir') return false;
                    const name = communityName(path);
                    return name === stem || name.startsWith(`${stem}.`);
                });
                if (matches.length === 0) continue;
                const [path] = matches;
                const name = communityName(path);
                if (
                    matches.length > 1 ||
                    (name !== stem && name !== `${stem}.md`) ||
                    this.kinds.get(path) !== 'file'
                ) {
                    return this.rest.communityProfile();
                }
                files[field] = { url: contentPath(this.endpoint, path) };
                break;
            }
        }
        return { files };
    }

    async readReference(reference: ContentReference): Promise<string | null> {
        const snapshot = await this.snapshot;
        const path = snapshot ? this.repositoryPath(reference.url) : undefined;
        const kind = path === undefined ? undefined : this.kinds.get(path);
        if (path !== undefined && kind === 'file') return this.readText(path);
        if (path !== undefined && kind === 'dir') {
            const entries = await this.listDirectory(path);
            if (entries.length === 0) return null;
            const content = await mapWithConcurrency(entries, 4, (entry) =>
                readContentEntry(this, entry),
            );
            return JSON.stringify(content);
        }
        return this.rest.readReference(reference);
    }

    private async resolveSnapshot(
        result: GraphQLSnapshotResult,
    ): Promise<GraphQLRepositorySnapshot | undefined> {
        if (result.status === 'ok') return result.snapshot;
        if (result.status === 'partial-error') {
            // GraphQL error types do not carry REST's ToS, 451, or redirect
            // evidence, so the REST resource decides whether to skip.
            await requestJson(this.client, this.endpoint);
        }
        return undefined;
    }

    private object(
        snapshot: GraphQLRepositorySnapshot,
        path: string,
    ): Promise<GraphQLGitObject | null | undefined> {
        if (snapshot.objects.has(path)) {
            return Promise.resolve(snapshot.objects.get(path));
        }
        return this.batcher.object({
            owner: this.owner,
            name: this.name,
            id: this.id,
            commitOid: snapshot.commitOid as string,
            path,
        });
    }

    /** Text of a listed regular file when GraphQL holds all of it; otherwise undefined. */
    private async readBlob(path: string): Promise<string | undefined> {
        if (this.kinds.get(path) !== 'file') return undefined;
        const snapshot = await this.snapshot;
        if (!snapshot?.commitOid) return undefined;
        const object =
            this.inlinedBlobs.get(path) ?? (await this.object(snapshot, path));
        if (
            object?.kind !== 'blob' ||
            object.text === null ||
            object.isBinary !== false ||
            object.isTruncated ||
            // GitHub transcodes UTF-16 and other encodings to UTF-8; REST
            // returns the stored bytes, which Response.text() decodes as UTF-8.
            Buffer.byteLength(object.text) !== object.byteSize
        ) {
            return undefined;
        }
        // REST raw reads decode with Response.text(), which drops a UTF-8 BOM.
        return object.text.startsWith('\uFEFF')
            ? object.text.slice(1)
            : object.text;
    }

    private toListing(
        path: string,
        tree: Extract<GraphQLGitObject, { kind: 'tree' }>,
    ): DirectoryListing {
        const entries: ContentEntry[] = [];
        const paths = new Set<string>();
        for (const entry of tree.entries) {
            const entryPath = path ? `${path}/${entry.name}` : entry.name;
            const kind: EntryKind =
                entry.type === 'tree'
                    ? 'dir'
                    : entry.type === 'commit'
                      ? 'submodule'
                      : (entry.mode & 0o170000) === SYMLINK_MODE
                        ? 'symlink'
                        : 'file';
            this.kinds.set(entryPath, kind);
            if (entry.blob) this.inlinedBlobs.set(entryPath, entry.blob);
            paths.add(entryPath);
            if (kind === 'file' || kind === 'dir') {
                entries.push({ type: kind, path: entryPath });
            }
        }
        const listing = { entries, paths };
        this.graphQLListings.add(listing);
        return listing;
    }

    private allFromGraphQL(
        listings: readonly (DirectoryListing | null)[],
    ): boolean {
        return listings.every(
            (listing) => listing === null || this.graphQLListings.has(listing),
        );
    }

    /** The repository-relative path of a contents URL for this repository. */
    private repositoryPath(url: string): string | undefined {
        try {
            const apiPath = apiPathFromUrl(url);
            const prefix = `${this.endpoint}/contents/`;
            if (!apiPath.startsWith(prefix) || apiPath.includes('?')) {
                return undefined;
            }
            return apiPath
                .slice(prefix.length)
                .split('/')
                .map(decodeURIComponent)
                .join('/');
        } catch {
            return undefined;
        }
    }
}

function isRestSizedTree(
    object: GraphQLGitObject | undefined,
): object is Extract<GraphQLGitObject, { kind: 'tree' }> {
    return (
        object?.kind === 'tree' && object.entries.length <= REST_DIRECTORY_LIMIT
    );
}

function baseName(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

/** GitHub detects `CODE-OF-CONDUCT.md` and `pull_request-template.md` alike. */
function communityName(path: string): string {
    return baseName(path).toLowerCase().replaceAll('-', '_');
}

async function readSecurityPolicy(
    reader: RepositoryContentReader,
    directories: RepositoryDirectoryIndex,
): Promise<string | null> {
    const locations = [
        { path: 'SECURITY.md', listing: () => directories.root() },
        { path: '.github/SECURITY.md', listing: () => directories.github() },
        { path: 'docs/SECURITY.md', listing: () => directories.docs() },
    ];
    for (const location of locations) {
        if (!(await location.listing())?.paths.has(location.path)) continue;
        const text = await reader.readOptionalText(location.path);
        if (text !== null) return text;
    }
    return null;
}

function referenceForFirstPath(
    repositoryPath: string,
    entries: readonly ContentEntry[],
    candidatePaths: readonly string[],
): ContentReference | null {
    const byPath = new Map(
        entries.map((entry) => [entry.path.toLowerCase(), entry]),
    );
    for (const candidatePath of candidatePaths) {
        const entry = byPath.get(candidatePath.toLowerCase());
        if (entry) {
            return { url: contentPath(repositoryPath, entry.path) };
        }
    }
    return null;
}

async function readIssueTemplates(
    reader: RepositoryContentReader,
    directories: RepositoryDirectoryIndex,
    reference: ContentReference | null | undefined,
): Promise<string | null> {
    if (reference) {
        return readCommunityReference(reader, reference);
    }
    // The community profile can omit directory-based templates and issue forms.
    for (const { directory, listing } of [
        {
            directory: '.github/ISSUE_TEMPLATE',
            listing: () => directories.github(),
        },
        { directory: 'ISSUE_TEMPLATE', listing: () => directories.root() },
        { directory: 'docs/ISSUE_TEMPLATE', listing: () => directories.docs() },
    ]) {
        const parent = await listing();
        if (
            !parent?.entries.some(
                (entry) => entry.type === 'dir' && entry.path === directory,
            )
        ) {
            continue;
        }
        const entries = (await reader.listOptionalDirectory(directory))
            ?.entries;
        if (entries && entries.length > 0) {
            const content = await mapWithConcurrency(
                entries,
                4,
                async (entry) => readContentEntry(reader, entry),
            );
            return JSON.stringify(content);
        }
    }
    return null;
}

async function readCommunityReference(
    reader: RepositoryContentReader,
    reference: ContentReference | null | undefined,
): Promise<string | null> {
    return reference ? reader.readReference(reference) : null;
}

/** A community reference may name another repository, so it carries its own repository path. */
async function readRestCommunityReference(
    client: GitHubRequestClient,
    reference: ContentReference,
): Promise<string | null> {
    const endpoint = apiPathFromUrl(reference.url);
    const repository = new RestRepositoryReader(
        client,
        repositoryPathFromContentsEndpoint(endpoint),
    );
    const value = await requestJson(client, endpoint);
    if (Array.isArray(value)) {
        const entries = value.flatMap((entry, index) => {
            const parsed = parseContentEntry(entry, index);
            return parsed ? [parsed] : [];
        });
        if (entries.length === 0) {
            return null;
        }
        const content = await mapWithConcurrency(entries, 4, async (entry) =>
            readContentEntry(repository, entry),
        );
        return JSON.stringify(content);
    }
    const record = requireRecord(value, 'community content');
    if (record.type !== 'file') {
        throw new TypeError(
            'GitHub community content was neither a file nor a directory',
        );
    }
    return readRawText(client, endpoint);
}

async function readContentEntry(
    reader: RepositoryContentReader,
    entry: ContentEntry,
): Promise<{ path: string; content: string | null }> {
    if (entry.type === 'file') {
        return { path: entry.path, content: await reader.readText(entry.path) };
    }
    const nested = await reader.listDirectory(entry.path);
    const content = await mapWithConcurrency(nested, 4, async (child) =>
        readContentEntry(reader, child),
    );
    return { path: entry.path, content: JSON.stringify(content) };
}

async function readOptionalText(
    client: GitHubRequestClient,
    endpoint: string,
): Promise<string | null> {
    try {
        return await readRawText(client, endpoint);
    } catch (error) {
        if (isNotFound(error)) {
            return null;
        }
        throw error;
    }
}

async function readRawText(
    client: GitHubRequestClient,
    endpoint: string,
): Promise<string> {
    const response = await client.request(endpoint, {
        responseType: 'text',
        headers: { Accept: 'application/vnd.github.raw+json' },
    });
    return response.data;
}

async function requestJson(
    client: GitHubRequestClient,
    endpoint: string,
): Promise<unknown> {
    const response = await client.request<unknown>(endpoint);
    return response.data;
}

function parseRepositoryPayload(
    value: unknown,
    candidate: RepositoryCandidate,
): RepositoryPayload {
    const record = requireRecord(value, 'repository details');
    if (
        typeof record.id !== 'number' ||
        !Number.isSafeInteger(record.id) ||
        record.id <= 0
    ) {
        throw new TypeError(
            `Repository ${candidate.fullName} has an invalid or unsafe ID`,
        );
    }
    if (record.id !== candidate.id) {
        throw new RepositoryRecordValidationError(
            candidate.fullName,
            'id',
            'Repository ID no longer matches the discovered repository',
        );
    }
    if (
        record.full_name !== undefined &&
        record.full_name !== null &&
        (typeof record.full_name !== 'string' ||
            record.full_name.includes('\u0000') ||
            !/^[^/]+\/[^/]+$/.test(record.full_name) ||
            record.full_name.split('/').some((part) => part.trim() === ''))
    ) {
        throw new TypeError(
            `Repository ${candidate.fullName} has an invalid full_name`,
        );
    }
    const owner = requireRecord(record.owner, 'repository owner');
    if (
        typeof owner.login !== 'string' ||
        owner.login.trim() === '' ||
        owner.login.includes('\u0000') ||
        (owner.type !== 'Organization' && owner.type !== 'User')
    ) {
        throw new TypeError(
            `Repository ${candidate.fullName} has an invalid owner`,
        );
    }
    if (
        typeof record.private !== 'boolean' ||
        typeof record.fork !== 'boolean'
    ) {
        throw new TypeError(
            `Repository ${candidate.fullName} has invalid visibility or fork data`,
        );
    }
    return record as unknown as RepositoryPayload;
}

function parseContentReference(
    value: unknown,
    field: string,
): ContentReference | null {
    if (value === undefined || value === null) {
        return null;
    }
    const record = requireRecord(value, `community file ${field}`);
    if (
        typeof record.url !== 'string' ||
        record.url.trim() === '' ||
        record.url.includes('\u0000')
    ) {
        throw new TypeError(
            `GitHub community file ${field} has no content URL`,
        );
    }
    return { url: record.url };
}

function parseContentEntry(value: unknown, index: number): ContentEntry | null {
    const record = requireRecord(value, `content entry ${index}`);
    if (
        typeof record.path !== 'string' ||
        record.path.trim() === '' ||
        record.path.includes('\u0000')
    ) {
        throw new TypeError(`GitHub content entry ${index} is malformed`);
    }
    if (record.type === 'symlink' || record.type === 'submodule') {
        return null;
    }
    if (record.type !== 'file' && record.type !== 'dir') {
        throw new TypeError(
            `GitHub content entry ${index} has an unsupported type`,
        );
    }
    return { type: record.type, path: record.path };
}

function repositoryEndpoint(fullName: string): string {
    const [owner, repository] = fullName.split('/');
    if (
        !owner ||
        !repository ||
        owner.trim() === '' ||
        repository.trim() === '' ||
        fullName.includes('\u0000') ||
        fullName.split('/').length !== 2
    ) {
        throw new TypeError(`Invalid GitHub repository name: ${fullName}`);
    }
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
}

function contentPath(
    repositoryPath: string,
    repositoryRelativePath: string,
): string {
    const encoded = repositoryRelativePath
        .split('/')
        .map(encodeURIComponent)
        .join('/');
    return `${repositoryPath}/contents/${encoded}`;
}

function repositoryPathFromContentsEndpoint(endpoint: string): string {
    const match = endpoint.match(
        /^(.*\/repos\/[^/]+\/[^/]+)\/contents(?:\/|$)/,
    );
    if (!match) {
        throw new TypeError(
            'GitHub community file URL is not a contents endpoint',
        );
    }
    return match[1];
}

function apiPathFromUrl(value: string): string {
    if (value.includes('\u0000')) {
        throw new TypeError('GitHub community file has an invalid content URL');
    }
    let url: URL;
    try {
        url = new URL(value, 'https://api.github.com');
    } catch (error) {
        throw new TypeError(
            'GitHub community file has an invalid content URL',
            {
                cause: error,
            },
        );
    }
    const repositoryPath = url.pathname.match(/(?:^|\/)(repos\/.*)$/)?.[1];
    if (!repositoryPath) {
        throw new TypeError(
            'GitHub community file URL is not a repository contents URL',
        );
    }
    return `/${repositoryPath}${url.search}`;
}

function normalizeLicense(value: unknown): string | null {
    if (value === null || value === undefined) {
        return null;
    }
    const license = requireRecord(value, 'repository license');
    const spdxId = optionalString(license.spdx_id, 'spdx_id');
    if (!spdxId || spdxId.toUpperCase() === 'NOASSERTION') {
        return 'other';
    }
    return spdxId.toLowerCase();
}

function normalizeTimestamp(value: unknown, name: string): string {
    if (typeof value !== 'string') {
        throw new TypeError(`GitHub ${name} must be a timestamp string`);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new TypeError(`GitHub ${name} is not a valid timestamp`);
    }
    return date.toISOString();
}

function nullableTimestamp(value: unknown, name: string): string | null {
    if (value === null || value === undefined) {
        return null;
    }
    return normalizeTimestamp(value, name);
}

function optionalString(value: unknown, field: string): string | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value !== 'string') {
        throw new TypeError(`GitHub ${field} field was not a string or null`);
    }
    return value;
}

function safeNonNegativeInteger(value: unknown, name: string): number {
    if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0
    ) {
        throw new TypeError(
            `GitHub ${name} must be a non-negative safe integer`,
        );
    }
    return value;
}

function addSafeCounts(
    current: number,
    increment: number,
    name: string,
): number {
    const total = current + increment;
    if (!Number.isSafeInteger(total)) {
        throw new TypeError(
            `GitHub ${name} exceeds JavaScript's safe integer range`,
        );
    }
    return total;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`GitHub ${label} was not an object`);
    }
    return value as Record<string, unknown>;
}

function isNotFound(error: unknown): boolean {
    return error instanceof GitHubRequestError && error.status === 404;
}
