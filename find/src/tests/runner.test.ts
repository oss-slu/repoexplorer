import { runScraping } from '../runner';
import type {
    RepositoryScrapingRecord,
    ScrapingConfiguration,
} from '../types/scraping';
import {
    createTestClient,
    jsonResponse,
    searchEnvelope,
} from './githubFixtures';

const configuration: ScrapingConfiguration = {
    universities: [
        { key: 'University One', fullName: 'University One', acronym: 'U1' },
        { key: 'University Two', fullName: 'University Two', acronym: 'U2' },
    ],
    repositoryConcurrency: 2,
    databaseBatchSize: 2,
};

function sharedRepositoryClient(incompleteSecondUniversity = false) {
    return createTestClient((url) => {
        if (url.pathname === '/search/repositories') {
            const query = url.searchParams.get('q') ?? '';
            return jsonResponse(
                searchEnvelope(
                    [{ id: 88, full_name: 'shared/repository' }],
                    1,
                    incompleteSecondUniversity &&
                        query.includes('University Two'),
                ),
            );
        }
        if (url.pathname === '/search/users') {
            return jsonResponse(searchEnvelope([]));
        }
        if (url.pathname === '/repos/shared/repository') {
            return jsonResponse({
                id: 88,
                full_name: 'shared/repository',
                owner: { login: 'shared', type: 'User' },
                private: false,
                license: null,
                language: null,
                html_url: 'https://github.com/shared/repository',
                description: null,
                fork: false,
                created_at: '2020-01-01T00:00:00Z',
                updated_at: '2020-01-02T00:00:00Z',
                pushed_at: null,
                homepage: null,
                size: 0,
                stargazers_count: 0,
                watchers_count: 0,
                forks_count: 0,
                open_issues_count: 0,
                subscribers_count: 0,
            });
        }
        if (url.pathname === '/repos/shared/repository/readme') {
            return jsonResponse({ message: 'Not Found' }, {}, 404);
        }
        if (
            url.pathname === '/repos/shared/repository/releases' ||
            url.pathname === '/repos/shared/repository/contributors'
        ) {
            return jsonResponse([]);
        }
        if (url.pathname === '/repos/shared/repository/community/profile') {
            return jsonResponse({ message: 'Not Found' }, {}, 404);
        }
        if (url.pathname.startsWith('/repos/shared/repository/contents/')) {
            return jsonResponse({ message: 'Not Found' }, {}, 404);
        }
        throw new Error(`Unexpected request: ${url}`);
    });
}

describe('runScraping', () => {
    test('keeps one repository identity associated with both configured universities', async () => {
        const persisted: Array<{
            university: string;
            records: readonly RepositoryScrapingRecord[];
        }> = [];
        const result = await runScraping(configuration, {
            client: sharedRepositoryClient(),
            store: {
                async upsertUniversity(university, records) {
                    persisted.push({ university, records });
                    return records.length;
                },
            },
            now: () => new Date('2026-10-20T12:00:00Z'),
        });

        expect(result).toMatchObject({
            universitiesProcessed: 2,
            committed: 2,
            failed: 0,
        });
        expect(persisted).toHaveLength(2);
        expect(
            persisted.map(({ university, records }) => [
                university,
                records[0].id,
            ]),
        ).toEqual([
            ['University One', 88],
            ['University Two', 88],
        ]);
        expect(persisted[0].records[0].university).toBe('University One');
        expect(persisted[1].records[0].university).toBe('University Two');
    });

    test('does not write a university when search completeness fails, while retaining earlier commits', async () => {
        const persisted: string[] = [];
        const result = await runScraping(configuration, {
            client: sharedRepositoryClient(true),
            store: {
                async upsertUniversity(university, records) {
                    persisted.push(university);
                    return records.length;
                },
            },
        });

        expect(persisted).toEqual(['University One']);
        expect(result.committed).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.failures[0].university).toBe('University Two');
        expect(result.failures[0].error.message).toMatch(
            /marked results incomplete/,
        );
    });
});
