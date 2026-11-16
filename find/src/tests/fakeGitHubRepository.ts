import { GitHubRequestClient } from '../utils/githubRequest';
import type { GitHubRequestConfig } from '../utils/githubRequest';
import { jsonResponse, searchEnvelope } from './githubFixtures';

/**
 * A repository file: UTF-8 text, UTF-16LE text stored with a byte order
 * mark, a symlink to another path, binary bytes, or a submodule.
 */
export type FakeFile =
    | string
    | { utf16: string }
    | { symlink: string }
    | { binary: string }
    | { submodule: true };

export type FakeRepository = {
    owner: string;
    name: string;
    id: number;
    metadata: Record<string, unknown>;
    /** Repository-relative file paths; directories are implied. */
    files: Record<string, FakeFile>;
    /** Asset download counts per release. */
    releases?: number[][];
    /** Contributor logins; `null` answers 204 like an empty repository. */
    contributors?: string[] | null;
};

export type FakeGitHubOptions = {
    /** GraphQL error attributed to a repository alias, keyed by `owner/name`. */
    graphqlRepositoryErrors?: Record<string, { type: string }>;
    /** REST status (and body) for the repository resource, keyed by `owner/name`. */
    restRepositoryStatus?: Record<string, { status: number; body?: unknown }>;
    /** Respond to every GraphQL POST with this status, or a validation error. */
    graphqlFailure?: { status: number } | 'validation';
    /** Respond to GraphQL POSTs for batches larger than this with HTTP 502. */
    graphqlTimeoutAboveRepositories?: number;
    /** Reports a different databaseId through GraphQL, as for a same-name replacement. */
    graphqlDatabaseIdOffset?: number;
    /** Replaces the REST response for an exact API path. */
    restOverrides?: Record<string, () => Response>;
};

export type RecordedRequest = {
    method: string;
    path: string;
    /** `owner/name` for REST repository requests; GraphQL requests have none. */
    repository?: string;
    operation?: string;
    repositories?: string[];
};

const API = 'https://api.github.com';
const COMMIT_OID = 'a'.repeat(40);
// Observed on GitHub: REST contents listings stop at 1,000 entries and
// `/readme` searches only those; `/readme` and GraphQL blob text both stop at
// 512,000 bytes, while a raw `/contents` read returns the whole file.
const REST_DIRECTORY_LIMIT = 1000;
const TEXT_LIMIT = 512_000;
const README = /^readme(?:\..*)?$/i;
const COMMUNITY = [
    ['code_of_conduct_file', 'code_of_conduct'],
    ['contributing', 'contributing'],
    ['issue_template', 'issue_template'],
    ['pull_request_template', 'pull_request_template'],
] as const;

/**
 * Serves REST and GraphQL from the same repository models, following the
 * documented GitHub behavior the finder relies on, so both enrichment paths
 * can be compared on identical data.
 */
export function createFakeGitHub(
    repositories: FakeRepository[],
    options: FakeGitHubOptions = {},
    config: GitHubRequestConfig = {},
): { client: GitHubRequestClient; requests: RecordedRequest[] } {
    const requests: RecordedRequest[] = [];
    const byName = new Map(
        repositories.map((repository) => [
            `${repository.owner}/${repository.name}`,
            repository,
        ]),
    );
    const client = new GitHubRequestClient({
        token: 'test-token',
        maxRetries: 0,
        retryBaseDelayMs: 0,
        retryMaxDelayMs: 0,
        sleep: async () => {},
        ...config,
        fetch: (async (input, init) => {
            const url = input instanceof URL ? input : new URL(String(input));
            const method = init?.method ?? 'GET';
            if (url.pathname === '/graphql') {
                const body = JSON.parse(String(init?.body)) as {
                    query: string;
                    variables: Record<string, string>;
                };
                return graphqlResponse(body, byName, options, requests);
            }
            if (url.pathname.startsWith('/search/')) {
                requests.push({ method, path: url.pathname });
                // Discovery: every repository matches; owner searches find none.
                return jsonResponse(
                    searchEnvelope(
                        url.pathname === '/search/repositories'
                            ? repositories.map(({ metadata }) => {
                                  const result = { ...metadata };
                                  delete result.subscribers_count;
                                  return result;
                              })
                            : [],
                    ),
                );
            }
            const match = url.pathname.match(
                /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/,
            );
            if (!match) throw new Error(`Unexpected request: ${url}`);
            const key = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
            requests.push({ method, path: url.pathname, repository: key });
            const override = options.restOverrides?.[url.pathname];
            if (override) return override();
            const repository = byName.get(key);
            if (!repository) return notFound();
            const accept = new Headers(init?.headers).get('accept');
            return restResponse(
                repository,
                match[3] ?? '',
                url,
                accept === 'application/vnd.github.raw+json',
                options.restRepositoryStatus?.[key],
            );
        }) as typeof fetch,
    });
    return { client, requests };
}

function restResponse(
    repository: FakeRepository,
    suffix: string,
    url: URL,
    raw: boolean,
    statusOverride: { status: number; body?: unknown } | undefined,
): Response {
    if (suffix === '') {
        if (statusOverride) {
            return jsonResponse(
                statusOverride.body ?? { message: 'Unavailable' },
                { 'x-github-request-id': 'REQ-REST' },
                statusOverride.status,
            );
        }
        return jsonResponse(repository.metadata, { etag: '"etag-1"' });
    }
    if (suffix === '/readme') {
        const path = preferredReadme(repository);
        return path ? textOf(repository, path, TEXT_LIMIT) : notFound();
    }
    if (suffix === '/releases') {
        const releases = repository.releases ?? [];
        const page = Number(url.searchParams.get('page') ?? '1');
        const slice = releases.slice((page - 1) * 100, page * 100);
        const headers: Record<string, string> = {};
        if (page * 100 < releases.length) {
            const next = new URL(url);
            next.searchParams.set('page', String(page + 1));
            headers.link = `<${next.toString()}>; rel="next"`;
        }
        return jsonResponse(
            slice.map((assets) => ({
                assets: assets.map((count) => ({ download_count: count })),
            })),
            headers,
        );
    }
    if (suffix === '/contributors') {
        if (repository.contributors === null) {
            return new Response(null, { status: 204 });
        }
        return jsonResponse(
            (repository.contributors ?? []).map((login) => ({
                login,
                contributions: 1,
            })),
        );
    }
    if (suffix === '/community/profile') {
        const files: Record<string, { url: string } | null> = {};
        for (const [field, stem] of COMMUNITY) {
            const path = preferredCommunityPath(repository, stem);
            files[field] = path
                ? {
                      url: `${API}/repos/${repository.owner}/${repository.name}/contents/${path}`,
                  }
                : null;
        }
        return jsonResponse({ files });
    }
    if (suffix === '/contents' || suffix.startsWith('/contents/')) {
        const path = suffix
            .slice('/contents/'.length)
            .split('/')
            .map(decodeURIComponent)
            .join('/');
        if (Object.keys(repository.files).length === 0) return notFound();
        const children = listDirectory(repository, path);
        if (children) {
            return jsonResponse(
                children.slice(0, REST_DIRECTORY_LIMIT).map((child) => ({
                    type:
                        child.type === 'tree'
                            ? 'dir'
                            : child.type === 'commit'
                              ? 'submodule'
                              : child.mode === 0o120000
                                ? 'symlink'
                                : 'file',
                    path: path ? `${path}/${child.name}` : child.name,
                })),
            );
        }
        if (!(path in repository.files)) return notFound();
        if (raw) return textOf(repository, path);
        return jsonResponse({ type: 'file', path });
    }
    throw new Error(`Unexpected REST request: ${url}`);
}

function graphqlResponse(
    body: { query: string; variables: Record<string, string> },
    repositories: Map<string, FakeRepository>,
    options: FakeGitHubOptions,
    requests: RecordedRequest[],
): Response {
    const operation = body.query.match(/^query (\w+)/)?.[1] ?? 'unknown';
    const aliases = Object.keys(body.variables)
        .filter((name) => /^o\d+$/.test(name))
        .map((name) => name.slice(1));
    const names = aliases.map(
        (index) =>
            `${body.variables[`o${index}`]}/${body.variables[`n${index}`]}`,
    );
    requests.push({
        method: 'POST',
        path: '/graphql',
        operation,
        repositories: names,
    });
    const headers = {
        'x-ratelimit-resource': 'graphql',
        'x-github-request-id': 'REQ-GRAPHQL',
    };
    if (options.graphqlFailure === 'validation') {
        return jsonResponse(
            {
                errors: [
                    {
                        path: ['query', 'repository', 'unknownField'],
                        extensions: { code: 'undefinedField' },
                        message: "Field 'unknownField' doesn't exist",
                    },
                ],
            },
            headers,
        );
    }
    if (options.graphqlFailure) {
        return jsonResponse(
            { message: 'Unavailable' },
            headers,
            options.graphqlFailure.status,
        );
    }
    if (
        options.graphqlTimeoutAboveRepositories !== undefined &&
        names.length > options.graphqlTimeoutAboveRepositories
    ) {
        return jsonResponse({ message: 'Timeout' }, headers, 502);
    }
    const data: Record<string, unknown> = {};
    const errors: unknown[] = [];
    aliases.forEach((index, position) => {
        const alias = `r${index}`;
        const key = names[position];
        const repository = repositories.get(key);
        const injected = options.graphqlRepositoryErrors?.[key];
        if (!repository || injected) {
            data[alias] = null;
            errors.push({
                type: injected?.type ?? 'NOT_FOUND',
                path: [alias],
                message: 'Could not resolve to a Repository',
            });
            return;
        }
        const databaseId =
            repository.id + (options.graphqlDatabaseIdOffset ?? 0);
        const empty = Object.keys(repository.files).length === 0;
        if (operation === 'RepositoryEnrichmentSnapshot') {
            const releases = repository.releases ?? [];
            data[alias] = {
                databaseId,
                defaultBranchRef: empty
                    ? null
                    : { target: { oid: COMMIT_OID } },
                root: empty ? null : gitObject(repository, ''),
                github: empty ? null : gitObject(repository, '.github'),
                docs: empty ? null : gitObject(repository, 'docs'),
                readme: empty ? null : gitObject(repository, 'README.md'),
                releases: {
                    pageInfo: { hasNextPage: releases.length > 100 },
                    nodes: releases.slice(0, 100).map((assets) => ({
                        releaseAssets: {
                            pageInfo: { hasNextPage: assets.length > 100 },
                            nodes: assets
                                .slice(0, 100)
                                .map((count) => ({ downloadCount: count })),
                        },
                    })),
                },
            };
            return;
        }
        const node: Record<string, unknown> = { databaseId };
        for (const [name, expression] of Object.entries(body.variables)) {
            const field = name.match(new RegExp(`^e${index}_(\\d+)$`));
            if (!field) continue;
            const [oid, ...pathParts] = expression.split(':');
            if (oid !== COMMIT_OID) throw new Error('Unpinned object read');
            node[`f${field[1]}`] = gitObject(
                repository,
                pathParts.join(':'),
                body.query.includes('object { __typename'),
            );
        }
        data[alias] = node;
    });
    return jsonResponse(
        errors.length > 0 ? { data, errors } : { data },
        headers,
    );
}

type TreeEntry = {
    name: string;
    type: 'blob' | 'tree' | 'commit';
    mode: number;
};

function listDirectory(
    repository: FakeRepository,
    path: string,
): TreeEntry[] | undefined {
    const prefix = path ? `${path}/` : '';
    const children = new Map<string, TreeEntry>();
    for (const [filePath, file] of Object.entries(repository.files)) {
        if (!filePath.startsWith(prefix)) continue;
        const [name, ...rest] = filePath.slice(prefix.length).split('/');
        if (rest.length > 0) {
            children.set(name, { name, type: 'tree', mode: 0o040000 });
        } else if (typeof file === 'object' && 'submodule' in file) {
            children.set(name, { name, type: 'commit', mode: 0o160000 });
        } else {
            children.set(name, {
                name,
                type: 'blob',
                mode:
                    typeof file === 'object' && 'symlink' in file
                        ? 0o120000
                        : 0o100644,
            });
        }
    }
    if (children.size === 0 && path !== '') return undefined;
    return [...children.values()].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
}

function gitObject(
    repository: FakeRepository,
    path: string,
    inlineBlobs = false,
): unknown {
    const children = listDirectory(repository, path);
    if (children) {
        return {
            __typename: 'Tree',
            entries: inlineBlobs
                ? children.map((child) => ({
                      ...child,
                      object:
                          child.type === 'blob'
                              ? gitObject(
                                    repository,
                                    path ? `${path}/${child.name}` : child.name,
                                )
                              : {
                                    __typename:
                                        child.type === 'tree'
                                            ? 'Tree'
                                            : 'Commit',
                                },
                  }))
                : children,
        };
    }
    const file = repository.files[path];
    if (file === undefined) return null;
    if (typeof file === 'object' && 'submodule' in file) {
        return { __typename: 'Commit' };
    }
    const bytes = storedBytes(file);
    const blob = {
        __typename: 'Blob',
        isTruncated: bytes.length > TEXT_LIMIT,
        byteSize: bytes.length,
    };
    if (typeof file === 'object' && 'binary' in file) {
        return { ...blob, text: null, isBinary: true };
    }
    // GitHub transcodes UTF-16 to UTF-8 text, keeping the byte order mark.
    const text =
        typeof file === 'object' && 'utf16' in file
            ? `\uFEFF${file.utf16}`
            : bytes.subarray(0, TEXT_LIMIT).toString('utf8');
    return { ...blob, text, isBinary: false };
}

function storedBytes(file: Exclude<FakeFile, { submodule: true }>): Buffer {
    if (typeof file === 'string') return Buffer.from(file);
    if ('symlink' in file) return Buffer.from(file.symlink);
    if ('binary' in file) return Buffer.from(file.binary, 'latin1');
    return Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(file.utf16, 'utf16le'),
    ]);
}

function textOf(
    repository: FakeRepository,
    path: string,
    limit = Infinity,
): Response {
    const file = repository.files[path];
    if (file === undefined) return notFound();
    if (typeof file === 'object' && 'symlink' in file) {
        return textOf(repository, file.symlink, limit);
    }
    if (typeof file === 'object' && 'submodule' in file) return notFound();
    return new Response(new Uint8Array(storedBytes(file).subarray(0, limit)));
}

/** `.github`, root, then `docs`, matching GitHub's documented README precedence. */
function preferredReadme(repository: FakeRepository): string | undefined {
    for (const directory of ['.github', '', 'docs']) {
        const match = (listDirectory(repository, directory) ?? [])
            .slice(0, REST_DIRECTORY_LIMIT)
            .find((entry) => entry.type === 'blob' && README.test(entry.name));
        if (match) return directory ? `${directory}/${match.name}` : match.name;
    }
    return undefined;
}

function preferredCommunityPath(
    repository: FakeRepository,
    stem: string,
): string | undefined {
    for (const directory of ['.github', '', 'docs']) {
        // Observed on GitHub: files only, with `-` and `_` treated alike.
        const match = (listDirectory(repository, directory) ?? []).find(
            (entry) => {
                const name = entry.name.toLowerCase().replaceAll('-', '_');
                return (
                    entry.type === 'blob' &&
                    entry.mode !== 0o120000 &&
                    (name === stem || name === `${stem}.md`)
                );
            },
        );
        if (match) return directory ? `${directory}/${match.name}` : match.name;
    }
    return undefined;
}

function notFound(): Response {
    return jsonResponse({ message: 'Not Found' }, {}, 404);
}
