import { runDemo } from '../demoRunner';
import { createDemoReport } from '../utils/demoReport';
import { ScrapingCancellationError } from '../utils/scrapingError';
import type { UniversityConfiguration } from '../types/scraping';
import {
    createTestClient,
    jsonResponse,
    searchEnvelope,
} from './githubFixtures';

const university: UniversityConfiguration = {
    key: 'Demo University',
    fullName: 'Demo University',
    acronym: 'DU',
    queries: { repositories: 'demo query' },
};

function repository(id: number, fullName = `demo/repo-${id}`) {
    const [owner, name] = fullName.split('/');
    return {
        id,
        name,
        full_name: fullName,
        owner: { login: owner, type: 'Organization' },
        private: false,
        license: null,
        language: 'TypeScript',
        html_url: `https://github.com/${fullName}`,
        description: 'safe sample description',
        fork: false,
        created_at: '2020-01-02T03:04:05Z',
        updated_at: '2024-05-06T07:08:09Z',
        pushed_at: null,
        homepage: null,
        size: 1,
        stargazers_count: 2,
        watchers_count: 2,
        forks_count: 0,
        open_issues_count: 0,
        subscribers_count: 1,
    };
}

function createEnrichmentClient(options: {
    searchItems: unknown[];
    onReadme?: () => Promise<Response>;
    failRoot?: boolean;
}): ReturnType<typeof createTestClient> {
    return createTestClient((url) => {
        if (url.pathname === '/search/repositories') {
            return jsonResponse(searchEnvelope(options.searchItems));
        }
        if (url.pathname === '/repos/demo/removed') {
            return options.failRoot
                ? jsonResponse({ message: 'private raw API body' }, {}, 500)
                : jsonResponse({ message: 'Not Found' }, {}, 404);
        }
        if (url.pathname.endsWith('/readme')) {
            return options.onReadme?.() ?? jsonResponse({ message: 'Not Found' }, {}, 404);
        }
        if (url.pathname.endsWith('/releases')) return jsonResponse([]);
        if (url.pathname.endsWith('/contributors')) return jsonResponse([]);
        if (url.pathname.endsWith('/community/profile')) {
            return jsonResponse({ files: {} });
        }
        if (/\/contents(\/|$)/.test(url.pathname)) {
            return jsonResponse({ message: 'Not Found' }, {}, 404);
        }
        throw new Error(`Unexpected demo request: ${url.pathname}`);
    }, 0, 8);
}

test('enriches the selected sample, normalizes text, and reports only a safe projection', async () => {
    const rawText = 'must never appear in the report\u0000';
    const candidate = repository(7);
    candidate.description = rawText;
    const client = createEnrichmentClient({ searchItems: [candidate] });
    const result = await runDemo(client, university, 10, 2);
    const report = createDemoReport({
        startedAt: new Date('2026-10-31T12:00:00Z'),
        finishedAt: new Date('2026-10-31T12:00:01Z'),
        result,
    });
    const serialized = JSON.stringify(report);

    expect(result).toMatchObject({
        status: 'sampled',
        searchTotal: 1,
        sampled: 1,
        repositories: [
            {
                repositoryId: 7,
                repositoryName: 'demo/repo-7',
                status: 'success',
                warningCount: 1,
                diagnostic: { category: 'success' },
            },
        ],
    });
    expect(report).toMatchObject({
        mode: 'demo',
        coverage: 'sampled',
        publication: 'not published',
        summary: { searchTotal: 1, sampled: 1, succeeded: 1, warningCount: 1 },
    });
    expect(serialized).not.toContain('must never appear');
    expect(serialized).not.toContain('safe sample description');
    expect(serialized).not.toContain('private raw API body');
});

test('reports documented repository 404s as skips in a successful demo', async () => {
    const result = await runDemo(
        createEnrichmentClient({
            searchItems: [{ id: 9, full_name: 'demo/removed' }],
        }),
        university,
        10,
        1,
    );

    expect(result.status).toBe('sampled');
    expect(result.repositories).toMatchObject([
        {
            status: 'skipped',
            diagnostic: {
                category: 'repository_unavailable_404',
                status: 404,
            },
        },
    ]);
});

test('reports a fatal enrichment error without exposing its API body', async () => {
    const result = await runDemo(
        createEnrichmentClient({
            searchItems: [{ id: 10, full_name: 'demo/removed' }],
            failRoot: true,
        }),
        university,
        10,
        1,
    );
    const report = createDemoReport({
        startedAt: new Date('2026-10-31T12:00:00Z'),
        finishedAt: new Date('2026-10-31T12:00:01Z'),
        result,
    });

    expect(result).toMatchObject({
        status: 'failed',
        diagnostic: { category: 'server-error', status: 500 },
        repositories: [
            { status: 'failed', diagnostic: { category: 'server-error' } },
        ],
    });
    expect(JSON.stringify(report)).not.toContain('private raw API body');
});

test('uses the requested worker bound while enriching candidates', async () => {
    let activeReadmes = 0;
    let maximumActiveReadmes = 0;
    const result = await runDemo(
        createEnrichmentClient({
            searchItems: [repository(1), repository(2)],
            onReadme: async () => {
                activeReadmes += 1;
                maximumActiveReadmes = Math.max(
                    maximumActiveReadmes,
                    activeReadmes,
                );
                await new Promise((resolve) => setTimeout(resolve, 5));
                activeReadmes -= 1;
                return jsonResponse({ message: 'Not Found' }, {}, 404);
            },
        }),
        university,
        10,
        1,
    );

    expect(result.status).toBe('sampled');
    expect(maximumActiveReadmes).toBe(1);
});

test('preserves cancellation during enrichment as an interrupted demo', async () => {
    let resolveReadmeStarted!: () => void;
    const readmeStarted = new Promise<void>((resolve) => {
        resolveReadmeStarted = resolve;
    });
    const controller = new AbortController();
    const client = createTestClient((url, init) => {
        if (url.pathname === '/search/repositories') {
            return jsonResponse(searchEnvelope([repository(22)]));
        }
        if (url.pathname.endsWith('/readme')) {
            resolveReadmeStarted();
            return new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener(
                    'abort',
                    () => reject(init.signal?.reason),
                    { once: true },
                );
            });
        }
        if (url.pathname.endsWith('/releases')) return jsonResponse([]);
        if (url.pathname.endsWith('/contributors')) return jsonResponse([]);
        if (url.pathname.endsWith('/community/profile')) {
            return jsonResponse({ files: {} });
        }
        if (/\/contents(\/|$)/.test(url.pathname)) {
            return jsonResponse({ message: 'Not Found' }, {}, 404);
        }
        throw new Error(`Unexpected demo request: ${url.pathname}`);
    }, 0, 8);
    const resultPromise = runDemo(client, university, 10, 1, {
        signal: controller.signal,
    });

    await readmeStarted;
    controller.abort(new ScrapingCancellationError('SIGTERM'));
    const result = await resultPromise;

    expect(result).toMatchObject({
        status: 'interrupted',
        diagnostic: {
            category: 'interrupted',
            cancellationSource: 'SIGTERM',
        },
    });
});
