import type { Pool } from 'pg';
import { jest } from '@jest/globals';
import { RepositoryStore } from '../db/repositoryStore';
import type { RepositoryScrapingRecord } from '../types/scraping';

describe('RepositoryStore input validation', () => {
    test('rejects unsafe counts and contributor text before opening a connection', async () => {
        const connect = jest.fn();
        const store = new RepositoryStore({ connect } as unknown as Pool);

        await expect(
            store.upsertUniversity('University', [
                record({ stargazersCount: Number.MAX_SAFE_INTEGER + 1 }),
            ]),
        ).rejects.toThrow(/safe integer/);
        await expect(
            store.upsertUniversity('University', [
                record({ contributors: "['alice']", contributorCount: 1 }),
            ]),
        ).rejects.toThrow(/JSON array/);
        expect(connect).not.toHaveBeenCalled();
    });
});

function record(
    overrides: Partial<RepositoryScrapingRecord> = {},
): RepositoryScrapingRecord {
    return {
        university: 'University',
        id: 123,
        fullName: 'owner/repository',
        owner: 'owner',
        license: null,
        language: null,
        htmlUrl: null,
        description: null,
        fork: 0,
        createdAt: null,
        updatedAt: null,
        pushedAt: null,
        homepage: null,
        size: 0,
        stargazersCount: 0,
        readme: null,
        watchersCount: 0,
        forksCount: 0,
        openIssuesCount: 0,
        watchers: 0,
        organization: null,
        releaseDownloads: 0,
        contributors: '[]',
        contributorCount: 0,
        busFactor: null,
        codeOfConductFile: null,
        contributing: null,
        securityPolicy: null,
        issueTemplates: null,
        pullRequestTemplate: null,
        subscribersCount: 0,
        affiliationPredictionGpt5Mini: null,
        typePredictionGpt5Mini: null,
        scrapedAt: '2026-10-20T12:00:00.000Z',
        ...overrides,
    };
}
