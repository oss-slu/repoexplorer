import { GitHubPaginationError, paginateGitHub } from './githubPagination';
import { GitHubRequestClient } from './githubRequest';

type SearchResult<T> = { items: T[]; totalCount: number };
type CreationRange = { start: number; end: number };

const SEARCH_LIMIT = 1_000;
const MAX_PARTITIONS = 4_095;

/** Collect complete searches, subdividing capped queries by creation time. */
export async function searchGitHub<T>(
    client: GitHubRequestClient,
    endpoint: 'repositories' | 'users',
    query: string,
    label: string,
): Promise<SearchResult<T>> {
    // Seconds match GitHub's search precision. Epoch predates GitHub accounts
    // and repositories; freeze the upper bound for this search's partitions.
    const bounds = { start: 0, end: Math.floor(Date.now() / 1_000) };
    let partitions = 0;

    async function collect(range?: CreationRange): Promise<SearchResult<T>> {
        if (++partitions > MAX_PARTITIONS) {
            throw new GitHubPaginationError(
                `GitHub ${label} search exceeded ${MAX_PARTITIONS} partitions; narrow or configure the query: ${query}`,
            );
        }
        const partitionQuery = range
            ? `${query} created:${timestamp(range.start)}..${timestamp(range.end)}`
            : query;
        // Probe before paginating so capped searches never request inaccessible
        // pages or spend ten requests downloading results we will subdivide.
        const probe = await client.request<unknown>(`/search/${endpoint}`, {
            query: { q: partitionQuery, per_page: 1 },
        });
        const totalCount = searchCount(probe.data, label);
        if (totalCount > SEARCH_LIMIT) {
            // Repeated created qualifiers can change a custom query's meaning.
            // Refuse to rewrite them rather than silently broaden its scope.
            if (/(?:^|\s)-?created:/i.test(query)) {
                throw new GitHubPaginationError(
                    `GitHub ${label} search exceeds the 1,000-result search limit and already contains a created: qualifier; remove it to enable automatic partitioning or narrow the query: ${query}`,
                );
            }
            const { start, end } = range ?? bounds;
            if (start >= end) {
                throw new GitHubPaginationError(
                    `GitHub ${label} search exceeds the 1,000-result search limit within one second; narrow or configure the query: ${partitionQuery}`,
                );
            }
            const midpoint = Math.floor((start + end) / 2);
            const left = await collect({ start, end: midpoint });
            const right = await collect({ start: midpoint + 1, end });
            if (left.totalCount + right.totalCount !== totalCount) {
                throw new GitHubPaginationError(
                    `GitHub ${label} search total_count changed across partitions; rerun the query: ${query}`,
                );
            }
            return {
                items: [...left.items, ...right.items],
                totalCount,
            };
        }
        if (totalCount === 0) return { items: [], totalCount };

        const response = await paginateGitHub<T>(
            client,
            `/search/${endpoint}`,
            {
                query: { q: partitionQuery, per_page: 100 },
            },
        );
        if (response.incompleteResults !== false) {
            throw new GitHubPaginationError(
                `GitHub ${label} search marked results incomplete; narrow or configure the query: ${partitionQuery}`,
            );
        }
        if (
            response.searchTotalCount !== totalCount ||
            response.data.length !== totalCount
        ) {
            throw new GitHubPaginationError(
                `GitHub ${label} search returned ${response.data.length} of ${totalCount} results or total_count changed; rerun or narrow the query: ${partitionQuery}`,
            );
        }
        return { items: response.data, totalCount };
    }

    return collect();
}

function timestamp(seconds: number): string {
    return new Date(seconds * 1_000).toISOString().replace('.000Z', 'Z');
}

function searchCount(value: unknown, label: string): number {
    if (
        value === null ||
        typeof value !== 'object' ||
        !('items' in value) ||
        !Array.isArray(value.items) ||
        !('total_count' in value) ||
        typeof value.total_count !== 'number' ||
        !Number.isSafeInteger(value.total_count) ||
        value.total_count < 0
    ) {
        throw new GitHubPaginationError(
            `GitHub ${label} search did not include valid items and total_count; completeness cannot be confirmed`,
        );
    }
    if (
        !('incomplete_results' in value) ||
        value.incomplete_results !== false
    ) {
        throw new GitHubPaginationError(
            `GitHub ${label} search marked results incomplete; narrow or configure the query`,
        );
    }
    return value.total_count;
}
