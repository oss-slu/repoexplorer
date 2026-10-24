import { allOrThrow, mapWithConcurrency } from './utils/concurrency';
import { GitHubRequestClient, GitHubRequestError } from './utils/githubRequest';
import { withScrapingContext } from './utils/scrapingError';
import { paginateGitHub } from './utils/githubPagination';
import { searchGitHub } from './utils/githubSearch';
import { sanitizeGitHubEndpoint } from './utils/formatScrapingError';
import type { ScrapingProgressCallback } from './types/progress';
import type {
    OwnerListingPolicy,
    RepositoryCandidate,
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
        const [repositorySearch, organizationSearch, userSearch] =
            await allOrThrow(
                [
                    searchGitHub<unknown>(
                        client,
                        'repositories',
                        queries.repositories,
                        'repository',
                        { signal: controller.signal },
                    )
                        .then((value) => {
                            searchDone('repositories');
                            return value;
                        })
                        .catch((error: unknown) => {
                            throw withScrapingContext(error, {
                                phase: 'search',
                                university: options.university,
                                detail: 'repository search',
                            });
                        }),
                    searchGitHub<unknown>(
                        client,
                        'users',
                        queries.organizations,
                        'organization',
                        { signal: controller.signal },
                    )
                        .then((value) => {
                            searchDone('organizations');
                            return value;
                        })
                        .catch((error: unknown) => {
                            throw withScrapingContext(error, {
                                phase: 'search',
                                university: options.university,
                                detail: 'organization search',
                            });
                        }),
                    searchGitHub<unknown>(
                        client,
                        'users',
                        queries.users,
                        'user',
                        { signal: controller.signal },
                    )
                        .then((value) => {
                            searchDone('users');
                            return value;
                        })
                        .catch((error: unknown) => {
                            throw withScrapingContext(error, {
                                phase: 'search',
                                university: options.university,
                                detail: 'user search',
                            });
                        }),
                ] as const,
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
            const candidate = parseRepositoryCandidate(item);
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
        return response.data.map(parseRepositoryCandidate);
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
        value.login.trim() === ''
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

function parseRepositoryCandidate(value: unknown): RepositoryCandidate {
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
        throw new TypeError(
            'GitHub repository result has an invalid or unsafe ID',
        );
    }
    if (
        typeof value.full_name !== 'string' ||
        !/^[^/]+\/[^/]+$/.test(value.full_name)
    ) {
        throw new TypeError(
            `GitHub repository ${value.id} has an invalid full_name`,
        );
    }
    return { id: value.id, fullName: value.full_name };
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
