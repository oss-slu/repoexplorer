import { GitHubRequestClient } from '../utils/githubRequest';

export type RequestHandler = (
    url: URL,
    init: RequestInit,
) => Response | Promise<Response>;

export function createTestClient(
    handler: RequestHandler,
    maxRetries = 0,
): GitHubRequestClient {
    return new GitHubRequestClient({
        fetch: (async (input, init) => {
            const url = input instanceof URL ? input : new URL(String(input));
            return handler(url, init ?? {});
        }) as typeof fetch,
        maxRetries,
        retryBaseDelayMs: 0,
        retryMaxDelayMs: 0,
        sleep: async () => {},
    });
}

export function jsonResponse(
    value: unknown,
    headers: Record<string, string> = {},
    status = 200,
): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}

export function textResponse(value: string, status = 200): Response {
    return new Response(value, {
        status,
        headers: { 'content-type': 'text/plain' },
    });
}

export function nextPageHeader(url: URL, page: number): string {
    const next = new URL(url);
    next.searchParams.set('page', String(page));
    return `<${next.toString()}>; rel="next"`;
}

export function searchEnvelope(
    items: unknown[],
    totalCount = items.length,
    incompleteResults = false,
): object {
    return {
        total_count: totalCount,
        incomplete_results: incompleteResults,
        items,
    };
}
