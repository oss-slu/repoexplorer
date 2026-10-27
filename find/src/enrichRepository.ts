import { GitHubRequestClient, GitHubRequestError } from './utils/githubRequest';
import { paginateGitHub } from './utils/githubPagination';
import { allOrThrow, mapWithConcurrency } from './utils/concurrency';
import type {
    RepositoryCandidate,
    RepositoryScrapingRecord,
    SkippedRepository,
    UniversityConfiguration,
} from './types/scraping';
import {
    RepositoryEnrichmentSkipError,
    RepositoryRecordValidationError,
} from './utils/scrapingError';
import { sanitizeGitHubEndpoint } from './utils/scrapingDiagnostics';

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

export async function enrichRepository(
    client: GitHubRequestClient,
    candidate: RepositoryCandidate,
    university: UniversityConfiguration,
    now: () => Date = () => new Date(),
): Promise<RepositoryScrapingRecord> {
    const endpoint = repositoryEndpoint(candidate.fullName);
    try {
        return await enrichRepositoryRecord(
            client,
            candidate,
            university,
            now,
            endpoint,
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

async function enrichRepositoryRecord(
    client: GitHubRequestClient,
    candidate: RepositoryCandidate,
    university: UniversityConfiguration,
    now: () => Date,
    endpoint: string,
): Promise<RepositoryScrapingRecord> {
    const repository = parseRepositoryPayload(
        await requestJson(client, endpoint),
        candidate,
    );
    if (repository.private) {
        throw new Error(`Repository ${candidate.fullName} is no longer public`);
    }

    const [readme, releaseDownloads, contributors, community] =
        await allOrThrow([
            readOptionalText(client, `${endpoint}/readme`),
            getReleaseDownloads(client, endpoint),
            getContributors(client, endpoint),
            repository.fork
                ? getForkCommunityProfile(client, endpoint)
                : getCommunityProfile(client, `${endpoint}/community/profile`),
        ]);

    const [
        codeOfConductFile,
        contributing,
        issueTemplates,
        pullRequestTemplate,
        securityPolicy,
    ] = await allOrThrow([
        readCommunityReference(client, community?.files.code_of_conduct_file),
        readCommunityReference(client, community?.files.contributing),
        readIssueTemplates(client, endpoint, community?.files.issue_template),
        readCommunityReference(client, community?.files.pull_request_template),
        readFirstOptionalText(client, [
            `${endpoint}/contents/SECURITY.md`,
            `${endpoint}/contents/.github/SECURITY.md`,
            `${endpoint}/contents/docs/SECURITY.md`,
        ]),
    ]);

    const timestamp = now();
    if (Number.isNaN(timestamp.getTime())) {
        throw new TypeError('Scrape clock returned an invalid date');
    }
    return {
        university: university.key,
        id: repository.id,
        fullName: optionalString(repository.full_name, 'full_name') ?? candidate.fullName,
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
        contributors: JSON.stringify(contributors),
        contributorCount: contributors.length,
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
}

function decideSkippedRepository(
    error: unknown,
    candidate: RepositoryCandidate,
    university: string,
    endpoint: string,
): SkippedRepository | undefined {
    const requestError = findGitHubRequestError(error);
    if (!requestError) return undefined;

    let requestPath: string;
    let repositoryPath: string;
    try {
        requestPath = new URL(requestError.url).pathname;
        repositoryPath = new URL(`https://api.github.com${endpoint}`).pathname;
    } catch {
        return undefined;
    }

    let reasonCode: SkippedRepository['reasonCode'] | undefined;
    let reason: string | undefined;
    if (
        requestError.status === 403 &&
        isTermsOfServiceBlock(requestError.data) &&
        (requestPath === repositoryPath ||
            requestPath.startsWith(`${repositoryPath}/`))
    ) {
        reasonCode = 'github_tos_block';
        reason = 'GitHub blocked repository access for a Terms of Service restriction.';
    } else if (
        requestError.status === 404 &&
        requestPath === repositoryPath
    ) {
        reasonCode = 'repository_unavailable_404';
        reason = 'The repository detail endpoint returned HTTP 404 after discovery.';
    }
    if (!reasonCode || !reason) return undefined;

    return {
        university,
        repositoryId: candidate.id,
        repositoryName: candidate.fullName,
        endpoint: sanitizeGitHubEndpoint(requestError.url),
        status: requestError.status as 403 | 404,
        reasonCode,
        reason,
    };
}

function findGitHubRequestError(error: unknown): GitHubRequestError | undefined {
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
    let total = 0;
    for (const [releaseIndex, value] of releases.data.entries()) {
        const release = requireRecord(value, `release ${releaseIndex}`);
        if (!Array.isArray(release.assets)) {
            throw new TypeError(
                `GitHub release ${releaseIndex} has no assets array`,
            );
        }
        for (const [assetIndex, assetValue] of release.assets.entries()) {
            const asset = requireRecord(
                assetValue,
                `release asset ${assetIndex}`,
            );
            total = addSafeCounts(
                total,
                safeNonNegativeInteger(asset.download_count, 'download_count'),
                'release download total',
            );
        }
    }
    return total;
}

async function getContributors(
    client: GitHubRequestClient,
    repositoryEndpointPath: string,
): Promise<string[]> {
    const response = await paginateGitHub<unknown>(
        client,
        `${repositoryEndpointPath}/contributors`,
        { query: { per_page: 100 } },
    );
    const contributors: string[] = [];
    const seen = new Set<string>();
    for (const [index, value] of response.data.entries()) {
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
            contributors.push(login);
        }
    }
    return contributors;
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
    client: GitHubRequestClient,
    endpoint: string,
): Promise<CommunityProfile> {
    const rootEntries = await getOptionalContentDirectory(
        client,
        `${endpoint}/contents`,
    );
    const githubDirectory = rootEntries?.find(
        (entry) =>
            entry.type === 'dir' && entry.path.toLowerCase() === '.github',
    );
    const githubEntries = githubDirectory
        ? await getOptionalContentDirectory(
              client,
              contentPath(endpoint, githubDirectory.path),
          )
        : null;
    const entries = [...(rootEntries ?? []), ...(githubEntries ?? [])];
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

async function getOptionalContentDirectory(
    client: GitHubRequestClient,
    endpoint: string,
): Promise<ContentEntry[] | null> {
    try {
        const value = await requestJson(client, endpoint);
        if (!Array.isArray(value)) {
            throw new TypeError(
                `GitHub content directory ${endpoint} did not return an array`,
            );
        }
        return value.flatMap((entry, index) => {
            const parsed = parseContentEntry(entry, index);
            return parsed ? [parsed] : [];
        });
    } catch (error) {
        if (isNotFound(error)) {
            return null;
        }
        throw error;
    }
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
    client: GitHubRequestClient,
    endpoint: string,
    reference: ContentReference | null | undefined,
): Promise<string | null> {
    if (reference) {
        return readCommunityReference(client, reference);
    }
    // The community profile can omit directory-based templates and issue forms.
    for (const directory of [
        '.github/ISSUE_TEMPLATE',
        'ISSUE_TEMPLATE',
        'docs/ISSUE_TEMPLATE',
    ]) {
        const entries = await getOptionalContentDirectory(
            client,
            contentPath(endpoint, directory),
        );
        if (entries && entries.length > 0) {
            const content = await mapWithConcurrency(
                entries,
                4,
                async (entry) => readContentEntry(client, endpoint, entry),
            );
            return JSON.stringify(content);
        }
    }
    return null;
}

async function readCommunityReference(
    client: GitHubRequestClient,
    reference: ContentReference | null | undefined,
): Promise<string | null> {
    if (!reference) {
        return null;
    }
    const endpoint = apiPathFromUrl(reference.url);
    const repositoryPath = repositoryPathFromContentsEndpoint(endpoint);
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
            readContentEntry(client, repositoryPath, entry),
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
    client: GitHubRequestClient,
    repositoryPath: string,
    entry: ContentEntry,
): Promise<{ path: string; content: string | null }> {
    if (entry.type === 'file') {
        return {
            path: entry.path,
            content: await readRawText(
                client,
                contentPath(repositoryPath, entry.path),
            ),
        };
    }
    const directoryPath = contentPath(repositoryPath, entry.path);
    const value = await requestJson(client, directoryPath);
    if (!Array.isArray(value)) {
        throw new TypeError(
            `GitHub content directory ${entry.path} did not return an array`,
        );
    }
    const nested = value.flatMap((item, index) => {
        const parsed = parseContentEntry(item, index);
        return parsed ? [parsed] : [];
    });
    const content = await mapWithConcurrency(nested, 4, async (child) =>
        readContentEntry(client, repositoryPath, child),
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

async function readFirstOptionalText(
    client: GitHubRequestClient,
    endpoints: readonly string[],
): Promise<string | null> {
    for (const endpoint of endpoints) {
        const text = await readOptionalText(client, endpoint);
        if (text !== null) {
            return text;
        }
    }
    return null;
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
        throw new TypeError(
            'GitHub community file has an invalid content URL',
        );
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
