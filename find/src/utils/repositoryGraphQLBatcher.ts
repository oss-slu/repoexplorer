import {
    GitHubGraphQLError,
    GitHubNetworkError,
    GitHubRequestError,
    GitHubResponseParseError,
} from './githubRequest';
import type {
    GitHubGraphQLErrorEntry,
    GitHubRequestClient,
} from './githubRequest';

export type GraphQLBlob = {
    kind: 'blob';
    text: string | null;
    isBinary: boolean | null;
    isTruncated: boolean;
    byteSize: number;
};

export type GraphQLTreeEntry = {
    name: string;
    type: 'blob' | 'tree' | 'commit';
    mode: number;
    /** Inlined for trees read after the snapshot, whose files are read whole. */
    blob?: GraphQLBlob;
};

export type GraphQLGitObject =
    | { kind: 'tree'; entries: GraphQLTreeEntry[] }
    | GraphQLBlob
    | { kind: 'other' };

export type GraphQLRepositorySnapshot = {
    /** Default-branch commit that later object reads are pinned to; null for an empty repository. */
    commitOid: string | null;
    /** Prefetched root, `.github`, and `docs` trees and root `README.md`; null means absent. */
    objects: ReadonlyMap<string, GraphQLGitObject | null>;
    releases: {
        /** True when releases or any release's assets exceed one page. */
        hasMore: boolean;
        assetDownloadCounts: unknown[][];
    };
};

/**
 * `partial-error`: GitHub attributed an error to this repository, so the
 * caller re-checks the REST repository resource to apply the HTTP policy.
 * `unavailable`: the query could not be completed for this repository, so the
 * caller reads it through REST.
 */
export type GraphQLSnapshotResult =
    | { status: 'ok'; snapshot: GraphQLRepositorySnapshot }
    | { status: 'partial-error' | 'unavailable' };

/** `undefined` means GraphQL could not answer; the caller reads through REST. */
export type GraphQLObjectResult = GraphQLGitObject | null | undefined;

export type RepositoryGraphQLBatcherOptions = {
    /** Repositories per snapshot query; keeps release nodes under GitHub's 500,000 limit. */
    maxRepositoriesPerQuery?: number;
    maxObjectsPerQuery?: number;
    /** How long a partial batch waits for concurrent repositories to join it. */
    flushDelayMs?: number;
};

type RepositoryKey = { owner: string; name: string; id: number };
type ObjectRequest = RepositoryKey & { commitOid: string; path: string };

const DEFAULT_MAX_REPOSITORIES_PER_QUERY = 25;
const DEFAULT_MAX_OBJECTS_PER_QUERY = 50;
// Repositories finish their ETag checks tens of milliseconds apart. Live
// oss-slu runs batched 1.06 repositories per snapshot at 10 ms and 1.44 at
// 100 ms with no measurable slowdown, since contributors load in parallel.
const DEFAULT_FLUSH_DELAY_MS = 100;
// Root `README.md` is the read nearly every repository needs, so prefetching
// it usually spares a second query; other files are read on demand.
const PREFETCHED_OBJECTS = [
    { alias: 'root', path: '' },
    { alias: 'github', path: '.github' },
    { alias: 'docs', path: 'docs' },
    { alias: 'readme', path: 'README.md' },
] as const;

const BLOB_FIELDS = 'text isBinary isTruncated byteSize';
const SNAPSHOT_OBJECT_FIELDS = `__typename
    ... on Tree { entries { name type mode } }
    ... on Blob { ${BLOB_FIELDS} }`;
// Directories read after the snapshot are template directories whose files
// are all read, so their blob text is inlined to save a round trip.
const OBJECT_FIELDS = `__typename
    ... on Tree { entries { name type mode object { __typename ... on Blob { ${BLOB_FIELDS} } } } }
    ... on Blob { ${BLOB_FIELDS} }`;

/**
 * Coalesces concurrent repository enrichments into GraphQL queries so README,
 * community-file, and release reads use the `graphql` quota instead of REST
 * core requests. Share one instance per scraping run with its request client.
 */
export class RepositoryGraphQLBatcher {
    private readonly snapshots: BatchQueue<
        RepositoryKey,
        GraphQLSnapshotResult
    >;
    private readonly objects: BatchQueue<ObjectRequest, GraphQLObjectResult>;

    constructor(
        private readonly client: GitHubRequestClient,
        options: RepositoryGraphQLBatcherOptions = {},
    ) {
        const flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
        this.snapshots = new BatchQueue(
            options.maxRepositoriesPerQuery ??
                DEFAULT_MAX_REPOSITORIES_PER_QUERY,
            flushDelayMs,
            (requests) =>
                runWithSplit(requests, (batch) => this.querySnapshots(batch), {
                    status: 'unavailable',
                }),
        );
        this.objects = new BatchQueue(
            options.maxObjectsPerQuery ?? DEFAULT_MAX_OBJECTS_PER_QUERY,
            flushDelayMs,
            (requests) =>
                runWithSplit(
                    requests,
                    (batch) => this.queryObjects(batch),
                    undefined,
                ),
        );
    }

    snapshot(repository: RepositoryKey): Promise<GraphQLSnapshotResult> {
        return this.snapshots.load(repository);
    }

    object(request: ObjectRequest): Promise<GraphQLObjectResult> {
        return this.objects.load(request);
    }

    private async querySnapshots(
        requests: readonly RepositoryKey[],
    ): Promise<GraphQLSnapshotResult[]> {
        const variables: Record<string, string> = {};
        const declarations: string[] = [];
        const fields: string[] = [];
        requests.forEach((request, index) => {
            variables[`o${index}`] = request.owner;
            variables[`n${index}`] = request.name;
            declarations.push(`$o${index}: String!, $n${index}: String!`);
            fields.push(
                `r${index}: repository(owner: $o${index}, name: $n${index}) { ...EnrichmentSnapshot }`,
            );
        });
        const prefetchedFields = PREFETCHED_OBJECTS.map(
            ({ alias, path }) =>
                `${alias}: object(expression: "HEAD:${path}") { ...GitObjectContent }`,
        ).join('\n    ');
        const query = `query RepositoryEnrichmentSnapshot(${declarations.join(', ')}) {
  ${fields.join('\n  ')}
}
fragment EnrichmentSnapshot on Repository {
    databaseId
    defaultBranchRef { target { oid } }
    ${prefetchedFields}
    releases(first: 100) {
        pageInfo { hasNextPage }
        nodes {
            releaseAssets(first: 100) {
                pageInfo { hasNextPage }
                nodes { downloadCount }
            }
        }
    }
}
fragment GitObjectContent on GitObject {
    ${SNAPSHOT_OBJECT_FIELDS}
}`;
        const response = await this.client.graphql<Record<string, unknown>>(
            query,
            variables,
        );
        return requests.map((request, index) => {
            const alias = `r${index}`;
            if (hasErrorAt(response.errors, [alias])) {
                return { status: 'partial-error' };
            }
            const node = response.data[alias];
            if (node === null || node === undefined) {
                return { status: 'partial-error' };
            }
            return parseSnapshot(node, request);
        });
    }

    private async queryObjects(
        requests: readonly ObjectRequest[],
    ): Promise<GraphQLObjectResult[]> {
        const groups = new Map<string, number[]>();
        requests.forEach((request, index) => {
            const key = `${request.owner}/${request.name}`;
            const group = groups.get(key) ?? [];
            group.push(index);
            groups.set(key, group);
        });
        const variables: Record<string, string> = {};
        const declarations: string[] = [];
        const fields: string[] = [];
        const locations: { alias: string; field: string }[] = [];
        [...groups.values()].forEach((indexes, groupIndex) => {
            const first = requests[indexes[0]];
            variables[`o${groupIndex}`] = first.owner;
            variables[`n${groupIndex}`] = first.name;
            declarations.push(
                `$o${groupIndex}: String!, $n${groupIndex}: String!`,
            );
            const objectFields = indexes.map((requestIndex, objectIndex) => {
                const request = requests[requestIndex];
                const variable = `e${groupIndex}_${objectIndex}`;
                variables[variable] = `${request.commitOid}:${request.path}`;
                declarations.push(`$${variable}: String!`);
                locations[requestIndex] = {
                    alias: `r${groupIndex}`,
                    field: `f${objectIndex}`,
                };
                return `f${objectIndex}: object(expression: $${variable}) { ...GitObjectContent }`;
            });
            fields.push(
                `r${groupIndex}: repository(owner: $o${groupIndex}, name: $n${groupIndex}) { databaseId ${objectFields.join(' ')} }`,
            );
        });
        const query = `query RepositoryEnrichmentObjects(${declarations.join(', ')}) {
  ${fields.join('\n  ')}
}
fragment GitObjectContent on GitObject {
    ${OBJECT_FIELDS}
}`;
        const response = await this.client.graphql<Record<string, unknown>>(
            query,
            variables,
        );
        return requests.map((request, index) => {
            const { alias, field } = locations[index];
            if (
                hasErrorAt(response.errors, [alias], true) ||
                hasErrorAt(response.errors, [alias, field])
            ) {
                return undefined;
            }
            const repository = response.data[alias];
            if (repository === null || repository === undefined) {
                return undefined;
            }
            const record = requireRecord(repository, 'GraphQL repository');
            if (record.databaseId !== request.id) return undefined;
            return parseGitObject(record[field], request.path);
        });
    }
}

/** Collects loads until the batch is full or the flush delay passes. */
class BatchQueue<Request, Result> {
    private pending: {
        request: Request;
        resolve: (value: Result) => void;
        reject: (reason: unknown) => void;
    }[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly maxSize: number,
        private readonly delayMs: number,
        private readonly run: (requests: Request[]) => Promise<Result[]>,
    ) {
        if (!Number.isInteger(maxSize) || maxSize < 1) {
            throw new RangeError(
                'GraphQL batch size must be a positive integer',
            );
        }
    }

    load(request: Request): Promise<Result> {
        return new Promise<Result>((resolve, reject) => {
            this.pending.push({ request, resolve, reject });
            if (this.pending.length >= this.maxSize) {
                this.flush();
            } else {
                this.timer ??= setTimeout(() => this.flush(), this.delayMs);
            }
        });
    }

    private flush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        const batch = this.pending.splice(0, this.maxSize);
        if (this.pending.length > 0) {
            this.timer = setTimeout(() => this.flush(), this.delayMs);
        }
        if (batch.length === 0) return;
        this.run(batch.map((item) => item.request)).then(
            (results) =>
                batch.forEach((item, index) => item.resolve(results[index])),
            (error: unknown) => batch.forEach((item) => item.reject(error)),
        );
    }
}

/**
 * Halves a batch whose query failed for a service reason, such as a GraphQL
 * timeout, so one heavy repository cannot fail its neighbours. A single
 * request that still fails resolves to `unavailable`, which reads it through
 * REST. Authentication, permission, quota exhaustion, cancellation, query
 * rejection, and malformed data remain fatal.
 */
async function runWithSplit<Request, Result>(
    requests: Request[],
    query: (requests: Request[]) => Promise<Result[]>,
    unavailable: Result,
): Promise<Result[]> {
    try {
        return await query(requests);
    } catch (error) {
        if (!isRecoverableGraphQLFailure(error)) throw error;
        if (requests.length === 1) return [unavailable];
        const middle = Math.ceil(requests.length / 2);
        const [first, second] = await Promise.all([
            runWithSplit(requests.slice(0, middle), query, unavailable),
            runWithSplit(requests.slice(middle), query, unavailable),
        ]);
        return [...first, ...second];
    }
}

const RECOVERABLE_STATUSES = new Set([408, 500, 502, 503, 504]);

function isRecoverableGraphQLFailure(error: unknown): boolean {
    if (error instanceof GitHubGraphQLError) return !error.validation;
    if (error instanceof GitHubRequestError) {
        return (
            error.rateLimit === undefined &&
            RECOVERABLE_STATUSES.has(error.status)
        );
    }
    if (error instanceof GitHubNetworkError) {
        return error.retryStopReason !== 'terminal network error';
    }
    return error instanceof GitHubResponseParseError;
}

/** True for an error at `prefix` or any field beneath it (or exactly at it when `exact`). */
function hasErrorAt(
    errors: readonly GitHubGraphQLErrorEntry[],
    prefix: readonly string[],
    exact = false,
): boolean {
    return errors.some(
        (error) =>
            (exact
                ? error.path.length === prefix.length
                : error.path.length >= prefix.length) &&
            prefix.every((part, index) => error.path[index] === part),
    );
}

function parseSnapshot(
    value: unknown,
    request: RepositoryKey,
): GraphQLSnapshotResult {
    const node = requireRecord(value, 'GraphQL repository');
    if (node.databaseId !== request.id) {
        // A same-name replacement is not the discovered repository.
        return { status: 'partial-error' };
    }
    let commitOid: string | null = null;
    if (node.defaultBranchRef !== null && node.defaultBranchRef !== undefined) {
        const target = requireRecord(
            requireRecord(node.defaultBranchRef, 'GraphQL default branch')
                .target,
            'GraphQL default branch target',
        );
        if (
            typeof target.oid !== 'string' ||
            !/^[0-9a-f]{40,64}$/.test(target.oid)
        ) {
            throw new TypeError('GitHub GraphQL default branch oid is invalid');
        }
        commitOid = target.oid;
    }
    const objects = new Map<string, GraphQLGitObject | null>();
    for (const { alias, path } of PREFETCHED_OBJECTS) {
        objects.set(path, commitOid ? parseGitObject(node[alias], path) : null);
    }
    const releases = requireRecord(node.releases, 'GraphQL releases');
    const releaseNodes = requireArray(releases.nodes, 'GraphQL release nodes');
    let hasMore = hasNextPage(releases.pageInfo, 'GraphQL releases');
    const assetDownloadCounts = releaseNodes.map((release, index) => {
        const assets = requireRecord(
            requireRecord(release, `GraphQL release ${index}`).releaseAssets,
            `GraphQL release ${index} assets`,
        );
        if (hasNextPage(assets.pageInfo, `GraphQL release ${index} assets`)) {
            hasMore = true;
        }
        return requireArray(
            assets.nodes,
            `GraphQL release ${index} assets`,
        ).map(
            (asset, assetIndex) =>
                requireRecord(asset, `GraphQL release asset ${assetIndex}`)
                    .downloadCount,
        );
    });
    return {
        status: 'ok',
        snapshot: {
            commitOid,
            objects,
            releases: { hasMore, assetDownloadCounts },
        },
    };
}

function parseGitObject(value: unknown, path: string): GraphQLGitObject | null {
    if (value === null || value === undefined) return null;
    const record = requireRecord(value, `GraphQL object ${path}`);
    if (record.__typename === 'Tree') {
        const entries = requireArray(
            record.entries,
            `GraphQL tree ${path} entries`,
        ).map((entry, index) => parseTreeEntry(entry, path, index));
        return { kind: 'tree', entries };
    }
    if (record.__typename === 'Blob') return parseBlob(record, path);
    return { kind: 'other' };
}

function parseBlob(record: Record<string, unknown>, path: string): GraphQLBlob {
    if (
        (record.text !== null && typeof record.text !== 'string') ||
        (record.isBinary !== null && typeof record.isBinary !== 'boolean') ||
        typeof record.isTruncated !== 'boolean' ||
        !Number.isSafeInteger(record.byteSize) ||
        (record.byteSize as number) < 0
    ) {
        throw new TypeError(`GitHub GraphQL blob ${path} is malformed`);
    }
    return {
        kind: 'blob',
        text: record.text as string | null,
        isBinary: record.isBinary as boolean | null,
        isTruncated: record.isTruncated,
        byteSize: record.byteSize as number,
    };
}

function parseTreeEntry(
    value: unknown,
    path: string,
    index: number,
): GraphQLTreeEntry {
    const entry = requireRecord(value, `GraphQL tree ${path} entry ${index}`);
    if (
        typeof entry.name !== 'string' ||
        entry.name === '' ||
        entry.name.includes('/') ||
        entry.name.includes('\u0000') ||
        (entry.type !== 'blob' &&
            entry.type !== 'tree' &&
            entry.type !== 'commit') ||
        typeof entry.mode !== 'number' ||
        !Number.isSafeInteger(entry.mode)
    ) {
        throw new TypeError(
            `GitHub GraphQL tree ${path} entry ${index} is malformed`,
        );
    }
    const object =
        entry.object !== null && typeof entry.object === 'object'
            ? (entry.object as Record<string, unknown>)
            : undefined;
    return {
        name: entry.name,
        type: entry.type,
        mode: entry.mode,
        ...(object?.__typename === 'Blob'
            ? { blob: parseBlob(object, `${path}/${entry.name}`) }
            : {}),
    };
}

function hasNextPage(value: unknown, label: string): boolean {
    const pageInfo = requireRecord(value, `${label} page info`);
    if (typeof pageInfo.hasNextPage !== 'boolean') {
        throw new TypeError(`GitHub ${label} page info is malformed`);
    }
    return pageInfo.hasNextPage;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`GitHub ${label} was not an object`);
    }
    return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`GitHub ${label} was not an array`);
    }
    return value;
}
