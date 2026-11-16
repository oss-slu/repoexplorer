import type { RepositoryScrapingRecord } from '../types/scraping';
import {
    assertNoUnnormalizedRepositoryText,
    normalizeRepositoryText,
} from '../utils/normalizeRepositoryText';

test('replaces actual NUL in descriptive fields and leaves ordinary Unicode and line endings intact', () => {
    const source = record({
        description: 'emoji 😀, combining e\u0301, tabs\t, and CRLF\r\n with \u0000',
        readme: 'first\r\nsecond',
        contributing: String.raw`the literal \u0000 sequence`,
    });

    const normalized = normalizeRepositoryText([source]);

    expect(normalized.records[0].description).toBe(
        'emoji 😀, combining e\u0301, tabs\t, and CRLF\r\n with �',
    );
    expect(normalized.records[0].readme).toBe('first\r\nsecond');
    expect(normalized.records[0].contributing).toBe(
        String.raw`the literal \u0000 sequence`,
    );
    expect(normalized.warnings).toEqual([
        {
            university: 'University',
            repositoryId: 123,
            repositoryName: 'owner/repository',
            field: 'description',
            replacementCount: 1,
            code: 'nul_replaced',
        },
    ]);
    expect(normalizeRepositoryText(normalized.records).warnings).toEqual([]);
});

test('normalizes NUL in nested issue-template content and preserves valid JSON', () => {
    const inner = JSON.stringify([
        { path: 'nested.md', content: 'inside\u0000text' },
    ]);
    const source = record({
        issueTemplates: JSON.stringify([
            { path: '.github/ISSUE_TEMPLATE', content: inner },
        ]),
    });

    const normalized = normalizeRepositoryText([source]);
    const outer = JSON.parse(normalized.records[0].issueTemplates ?? 'null') as {
        path: string;
        content: string;
    }[];
    const nested = JSON.parse(outer[0].content) as {
        path: string;
        content: string;
    }[];

    expect(nested[0].content).toBe('inside�text');
    expect(normalized.warnings).toMatchObject([
        { field: 'issueTemplates', replacementCount: 1 },
    ]);
    expect(() => assertNoUnnormalizedRepositoryText(normalized.records[0])).not.toThrow();
});

test('leaves empty strings and null content values unchanged', () => {
    const source = record({ description: '', readme: null, securityPolicy: '' });
    const normalized = normalizeRepositoryText([source]);
    expect(normalized.records[0]).toMatchObject({
        description: '',
        readme: null,
        securityPolicy: '',
    });
    expect(normalized.warnings).toEqual([]);
});

test('rejects malformed supported issue-template structures with repository and field context', () => {
    const source = record({
        issueTemplates: JSON.stringify([{ path: 17, content: 'invalid' }]),
    });
    expect(() => normalizeRepositoryText([source])).toThrow(
        /owner\/repository field issueTemplates/,
    );
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
