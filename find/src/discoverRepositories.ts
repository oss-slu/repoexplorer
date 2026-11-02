import { mapWithConcurrency } from './utils/concurrency';
import { GitHubRequestClient, GitHubRequestError } from './utils/githubRequest';
import {
    RepositoryRecordValidationError,
    withScrapingContext,
} from './utils/scrapingError';
import { paginateGitHub } from './utils/githubPagination';
import { searchGitHub } from './utils/githubSearch';
import { sanitizeGitHubEndpoint } from './utils/scrapingDiagnostics';
import type { ScrapingProgressCallback } from './types/progress';
import type {
    OwnerListingPolicy,
    RepositoryCandidate,
    ScrapingWarning,
    SkippedOwner,
    UniversityConfiguration,
} from './types/scraping';

type OwnerKind = 'Organization' | 'User';
type DiscoveredOwner = { login: string; kind: OwnerKind };

export type RepositoryDiscovery = {
    candidates: RepositoryCandidate[];
    repositorySearchTotal: number;
    organizationSearchTotal: number;
    userSearchTotal: number;
    ownersDiscovered: number;
    skippedOwners: SkippedOwner[];
};

export type RepositoryDiscoveryOptions = {
    signal?: AbortSignal;
    onProgress?: ScrapingProgressCallback;
    onFatalError?: (error: unknown) => void;
    onOwnerSkipped?: (owner: SkippedOwner) => void;
    policy?: OwnerListingPolicy;
    university: string;
    elapsedMs?: () => number;
    searchRetrySleep?: (
        delayMs: number,
        signal?: AbortSignal,
    ) => Promise<void>;
};

export async function discoverRepositories(
    client: GitHubRequestClient,
    university: UniversityConfiguration,
    ownerConcurrency = 4,
    options: RepositoryDiscoveryOptions = {
        university: university.key,
        policy: 'best-effort',
    },
): Promise<RepositoryDiscovery> {
    const policy = options.policy ?? 'best-effort';
    const queries = getSearchQueries(university);
    const controller = new AbortController();
    const abortFromParent = () =>
        controller.abort(options.signal?.reason ?? new Error('Run cancelled'));
    if (options.signal?.aborted) {
        abortFromParent();
    } else {
        options.signal?.addEventListener('abort', abortFromParent, {
            once: true,
        });
    }

    const report = (
        phase: 'search' | 'owner listing',
        completed: number,
        total: number,
        label?: string,
    ) =>
        options.onProgress?.({
            type: 'progress',
            phase,
            university: options.university,
            completed,
            total,
            label,
            elapsedMs: options.elapsedMs?.() ?? 0,
        });

    try {
        let completedSearches = 0;
        const searchDone = (label: string) => {
            completedSearches += 1;
            report('search', completedSearches, 3, label);
        };
        const searchTasks = [
            {
                endpoint: 'repositories',
                query: queries.repositories,
                kind: 'repository',
                label: 'repositories',
                detail: 'repository search',
            },
            {
                endpoint: 'users',
                query: queries.organizations,
                kind: 'organization',
                label: 'organizations',
                detail: 'organization search',
            },
            {
                endpoint: 'users',
                query: queries.users,
                kind: 'user',
                label: 'users',
                detail: 'user search',
            },
        ] as const;
        const [repositorySearch, organizationSearch, userSearch] =
            await mapWithConcurrency(
                searchTasks,
                2,
                async ({ endpoint, query, kind, label, detail }) => {
                    try {
                        const result = await searchGitHub<unknown>(
                            client,
                            endpoint,
                            query,
                            kind,
                            {
                                signal: controller.signal,
                                onProgress: options.onProgress,
                                university: options.university,
                                elapsedMs: options.elapsedMs,
                                sleep: options.searchRetrySleep,
                            },
                        );
                        searchDone(label);
                        return result;
                    } catch (error) {
                        throw withScrapingContext(error, {
                            phase: 'search',
                            university: options.university,
                            detail,
                        });
                    }
                },
                (error) => {
                    options.onFatalError?.(error);
                    controller.abort(error);
                },
            );

        const ownersByIdentity = new Map<string, DiscoveredOwner>();
        for (const [items, kind] of [
            [organizationSearch.items, 'Organization'],
            [userSearch.items, 'User'],
        ] as const) {
            for (const item of items) {
                const owner = parseOwner(item, kind);
                const identity = `${kind}:${owner.login.toLowerCase()}`;
                if (!ownersByIdentity.has(identity)) {
                    ownersByIdentity.set(identity, owner);
                }
            }
        }
        const owners = [...ownersByIdentity.values()];
        options.onProgress?.({
            type: 'phase',
            phase: 'owner listing',
            university: options.university,
            elapsedMs: options.elapsedMs?.() ?? 0,
        });
        let completedOwners = 0;
        const skippedOwners: SkippedOwner[] = [];
        report('owner listing', completedOwners, owners.length);
        const ownerCandidates = await mapWithConcurrency(
            owners,
            ownerConcurrency,
            async (owner) => {
                try {
                    const repositories = await listOwnerRepositories(
                        client,
                        owner,
                        controller.signal,
                        options.university,
                    );
                    completedOwners += 1;
                    report(
                        'owner listing',
                        completedOwners,
                        owners.length,
                        `${owner.kind.toLowerCase()} ${owner.login}`,
                    );
                    return { candidates: repositories };
                } catch (error) {
                    const requestError = findGitHubRequestError(error);
                    if (policy === 'best-effort' && requestError?.status === 404) {
                        const skippedOwner: SkippedOwner = {
                            university: options.university,
                            login: owner.login,
                            ownerType: owner.kind,
                            endpoint: sanitizeGitHubEndpoint(requestError.url),
                            status: 404,
                            reason: 'GitHub returned HTTP 404 for this owner repository listing; the owner was skipped.',
                        };
                        skippedOwners.push(skippedOwner);
                        options.onOwnerSkipped?.(skippedOwner);
                        completedOwners += 1;
                        report(
                            'owner listing',
                            completedOwners,
                            owners.length,
                            `${owner.kind.toLowerCase()} ${owner.login} (skipped: HTTP 404)`,
                        );
                        return { candidates: [], skippedOwner };
                    }
                    throw withScrapingContext(error, {
                        phase: 'owner listing',
                        university: options.university,
                        owner: `${owner.kind} ${owner.login}`,
                        ...(requestError?.status === 404
                            ? {
                                  detail: 'Owner repository listing returned 404; strict discovery policy stopped before persistence. No alternate owner endpoint was used.',
                              }
                            : {}),
                    });
                }
            },
            (error) => {
                options.onFatalError?.(error);
                controller.abort(error);
            },
        );

        const byId = new Map<number, RepositoryCandidate>();
        for (const item of repositorySearch.items) {
            const candidate = parseRepositoryCandidate(item, options.university);
            byId.set(candidate.id, candidate);
        }
        for (const candidate of ownerCandidates.flatMap(
            (listing) => listing.candidates,
        )) {
            byId.set(candidate.id, candidate);
        }

        return {
            candidates: [...byId.values()],
            repositorySearchTotal: repositorySearch.totalCount,
            organizationSearchTotal: organizationSearch.totalCount,
            userSearchTotal: userSearch.totalCount,
            ownersDiscovered: owners.length,
            skippedOwners,
        };
    } finally {
        options.signal?.removeEventListener('abort', abortFromParent);
    }
}

export function getSearchQueries(
    university: UniversityConfiguration,
): Required<NonNullable<UniversityConfiguration['queries']>> {
    return {
        repositories:
            university.queries?.repositories ??
            `"${escapeSearchPhrase(university.fullName)}" in:name,description archived:false size:>0 is:public`,
        organizations:
            university.queries?.organizations ??
            `"${escapeSearchPhrase(university.acronym)}" in:name,login type:org`,
        users:
            university.queries?.users ??
            `"${escapeSearchPhrase(university.acronym)}" in:name,login type:user`,
    };
}

async function listOwnerRepositories(
    client: GitHubRequestClient,
    owner: DiscoveredOwner,
    signal: AbortSignal,
    university: string,
): Promise<RepositoryCandidate[]> {
    const endpoint =
        owner.kind === 'Organization'
            ? `/orgs/${encodeURIComponent(owner.login)}/repos`
            : `/users/${encodeURIComponent(owner.login)}/repos`;
    const response = await paginateGitHub<unknown>(client, endpoint, {
        query:
            owner.kind === 'Organization'
                ? { type: 'public', per_page: 100 }
                : { type: 'owner', per_page: 100 },
        signal,
    });
    try {
        return response.data.map((value) =>
            parseRepositoryCandidate(value, university),
        );
    } catch (error) {
        throw withScrapingContext(error, {
            phase: 'owner listing',
            university,
            owner: `${owner.kind} ${owner.login}`,
        });
    }
}

function parseOwner(value: unknown, expectedKind: OwnerKind): DiscoveredOwner {
    if (
        !isRecord(value) ||
        typeof value.login !== 'string' ||
        value.login.trim() === '' ||
        value.login.includes('\u0000')
    ) {
        throw new TypeError(
            `GitHub ${expectedKind.toLowerCase()} search returned an invalid owner`,
        );
    }
    if (value.type !== expectedKind) {
        throw new TypeError(
            `GitHub ${expectedKind.toLowerCase()} search returned an owner with type ${String(value.type)}`,
        );
    }
    return { login: value.login, kind: expectedKind };
}

function parseRepositoryCandidate(
    value: unknown,
    university: string,
): RepositoryCandidate {
    if (!isRecord(value)) {
        throw new TypeError(
            'GitHub repository search returned a non-object result',
        );
    }
    if (
        typeof value.id !== 'number' ||
        !Number.isSafeInteger(value.id) ||
        value.id <= 0
    ) {
        throw new RepositoryRecordValidationError(
            `repository ${String(value.id)}`,
            'id',
            'GitHub repository result has an invalid or unsafe ID',
        );
    }
    if (
        typeof value.full_name !== 'string' ||
        value.full_name.includes('\u0000') ||
        !/^[^/]+\/[^/]+$/.test(value.full_name) ||
        value.full_name.split('/').some((part) => part.trim() === '')
    ) {
        throw new RepositoryRecordValidationError(
            `repository ${value.id}`,
            'full_name',
            `GitHub repository ${value.id} has an invalid full_name`,
        );
    }
    const metadataWarnings: ScrapingWarning[] = [];
    const repositoryMetadata =
        Object.hasOwn(value, 'owner') && Object.hasOwn(value, 'private')
            ? projectRepositoryMetadata(
                  value,
                  value.id,
                  value.full_name,
                  university,
                  metadataWarnings,
              )
            : undefined;
    return {
        id: value.id,
        fullName: value.full_name,
        ...(repositoryMetadata ? { metadata: repositoryMetadata } : {}),
        ...(metadataWarnings.length > 0 ? { metadataWarnings } : {}),
    };
}

function projectRepositoryMetadata(
    source: Record<string, unknown>,
    repositoryId: number,
    fullName: string,
    university: string,
    warnings: ScrapingWarning[],
): Record<string, unknown> | undefined {
    const ownerValue = source.owner;
    const licenseValue = source.license;
    const fields = [
        'id',
        'full_name',
        'private',
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
    ];
    if (
        fields.some(
            (field) =>
                field !== 'description' &&
                typeof source[field] === 'string' &&
                (source[field] as string).includes('\u0000'),
        ) ||
        (typeof ownerValue === 'string' &&
            ownerValue.includes('\u0000')) ||
        (isRecord(ownerValue) &&
            ['login', 'type'].some(
                (field) =>
                    typeof ownerValue[field] === 'string' &&
                    (ownerValue[field] as string).includes('\u0000'),
            )) ||
        (isRecord(licenseValue) &&
            ['spdx_id', 'key'].some(
                (field) =>
                    typeof licenseValue[field] === 'string' &&
                    (licenseValue[field] as string).includes('\u0000'),
            )) ||
        (typeof licenseValue === 'string' &&
            licenseValue.includes('\u0000'))
    ) {
        return undefined;
    }
    const metadata: Record<string, unknown> = {};
    for (const field of fields) {
        if (!Object.hasOwn(source, field)) continue;
        const value = source[field];
        if (field === 'description' && typeof value === 'string') {
            const replacementCount = value.split('\u0000').length - 1;
            metadata.description = value.replaceAll('\u0000', '\uFFFD');
            if (replacementCount > 0) {
                warnings.push({
                    university,
                    repositoryId,
                    repositoryName: fullName,
                    field: 'description',
                    replacementCount,
                    code: 'nul_replaced',
                });
            }
        } else {
            metadata[field] = value;
        }
    }
    if (isRecord(ownerValue)) {
        metadata.owner = {
            login: ownerValue.login,
            type: ownerValue.type,
        };
    } else if (Object.hasOwn(source, 'owner')) {
        metadata.owner = ownerValue;
    }
    if (licenseValue === null) {
        metadata.license = null;
    } else if (isRecord(licenseValue)) {
        metadata.license = {
            ...(Object.hasOwn(licenseValue, 'spdx_id')
                ? { spdx_id: licenseValue.spdx_id }
                : {}),
            ...(Object.hasOwn(licenseValue, 'key')
                ? { key: licenseValue.key }
                : {}),
        };
    } else if (Object.hasOwn(source, 'license')) {
        metadata.license = licenseValue;
    }
    return metadata;
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

function escapeSearchPhrase(value: string): string {
    return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
