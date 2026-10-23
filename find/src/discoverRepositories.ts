import { paginateGitHub } from './utils/githubPagination';
import { searchGitHub } from './utils/githubSearch';
import { GitHubRequestClient } from './utils/githubRequest';
import { allOrThrow, mapWithConcurrency } from './utils/concurrency';
import type {
    RepositoryCandidate,
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
};

export async function discoverRepositories(
    client: GitHubRequestClient,
    university: UniversityConfiguration,
    ownerConcurrency = 4,
): Promise<RepositoryDiscovery> {
    const queries = getSearchQueries(university);
    const [repositorySearch, organizationSearch, userSearch] = await allOrThrow(
        [
            searchGitHub<unknown>(
                client,
                'repositories',
                queries.repositories,
                'repository',
            ),
            searchGitHub<unknown>(
                client,
                'users',
                queries.organizations,
                'organization',
            ),
            searchGitHub<unknown>(client, 'users', queries.users, 'user'),
        ],
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

    const ownerCandidates = await mapWithConcurrency(
        owners,
        ownerConcurrency,
        async (owner) => listOwnerRepositories(client, owner),
    );
    const byId = new Map<number, RepositoryCandidate>();
    for (const item of repositorySearch.items) {
        const candidate = parseRepositoryCandidate(item);
        byId.set(candidate.id, candidate);
    }
    for (const candidate of ownerCandidates.flat()) {
        byId.set(candidate.id, candidate);
    }

    return {
        candidates: [...byId.values()],
        repositorySearchTotal: repositorySearch.totalCount,
        organizationSearchTotal: organizationSearch.totalCount,
        userSearchTotal: userSearch.totalCount,
        ownersDiscovered: owners.length,
    };
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
    });
    return response.data.map(parseRepositoryCandidate);
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

function escapeSearchPhrase(value: string): string {
    return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
