import {
    getSum,
    getAvg,
    getCountFieldNotNull,
    getPercentFieldNotNull,
    makeFieldsNotNullArray,
    makeFieldDistributionArray,
    makeFieldDistributionByArray,
    makeCountsArray,
    makeNumericDistributionArray,
    makeImpactIndicatorsArray,
    makeAvgScorePerMetricArray,
    makeDateDistributionArray,
    makeProfileCompleteDistributionArray,
} from '../../utils/math';

import type { orgsData, repoData, secrData } from '../../types/appData';

const makeRepo = (overrides: Partial<repoData> = {}): repoData => ({
    university: 'SLU',
    id: 1,
    fullName: 'repo-one',
    owner: 'owner',
    license: 'MIT',
    language: 'TypeScript',
    htmlUrl: 'https://example.com',
    description: 'Test repository',
    fork: 0,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-02',
    pushedAt: '2026-01-03',
    homepage: null,
    size: 10,
    stargazersCount: 10,
    readme: '# README',
    watchersCount: 5,
    forksCount: 2,
    openIssuesCount: 1,
    watchers: 5,
    organization: 'org',
    releaseDownloads: 100,
    contributors: 'alice,bob',
    contributorCount: 2,
    busFactor: 1,
    codeOfConductFile: 'CODE_OF_CONDUCT.md',
    contributing: null,
    securityPolicy: null,
    issueTemplates: null,
    pullRequestTemplate: null,
    subscribersCount: 4,
    affiliationPredictionGpt5Mini: 1,
    typePredictionGpt5Mini: 'student',
    ...overrides,
});

const makeSecurity = (overrides: Partial<secrData> = {}): secrData => ({
    htmlUrl: 'https://example.com/repo',
    binaryArtifacts: 1,
    branchProtection: 0,
    ciTests: 1,
    ciiBestPractices: 1,
    codeReview: 0,
    contributors: 1,
    dangerousWorkflow: 0,
    dependencyUpdateTool: 1,
    fuzzing: -1,
    license: 1,
    maintained: 1,
    packaging: 0,
    pinnedDependencies: 1,
    sast: -1,
    securityPolicy: 1,
    signedReleases: 0,
    tokenPermissions: 1,
    vulnerabilities: 1,
    totalScore: 11,
    ...overrides,
});

const makeOrganization = (overrides: Partial<orgsData> = {}): orgsData => ({
    login: 'organization',
    name: 'Organization',
    description: 'Organization description',
    location: 'St. Louis',
    company: 'Example University',
    email: 'contact@example.edu',
    url: 'https://example.edu',
    createdAt: '2020-06-15T12:00:00',
    updatedAt: '2026-06-15T12:00:00',
    university: 'SLU',
    affiliationPredictionOrgs: null,
    ...overrides,
});

describe('math utilities', () => {
    describe('getSum', () => {
        it('sums numeric values', () => {
            const rows = [makeRepo({ size: 10 }), makeRepo({ size: 20 }), makeRepo({ size: 5 })];

            expect(getSum(rows, 'size')).toBe(35);
        });

        it('ignores non-numeric values', () => {
            const rows = [makeRepo({ description: 'hello' }), makeRepo({ description: null })];

            expect(getSum(rows, 'description')).toBe(0);
        });
    });

    describe('getAvg', () => {
        it('calculates the average', () => {
            const rows = [makeRepo({ size: 10 }), makeRepo({ size: 20 }), makeRepo({ size: 30 })];

            expect(getAvg(rows, 'size')).toBe(20);
        });

        it('returns 0 for empty rows', () => {
            expect(getAvg([], 'size')).toBe(0);
        });
    });

    describe('getCountFieldNotNull', () => {
        it('counts non-null values', () => {
            const rows = [
                makeRepo({ description: 'one' }),
                makeRepo({ description: null }),
                makeRepo({ description: 'three' }),
            ];

            expect(getCountFieldNotNull(rows, 'description')).toBe(2);
        });

        it('returns 0 for empty rows', () => {
            expect(getCountFieldNotNull([], 'description')).toBe(0);
        });
    });

    describe('getPercentFieldNotNull', () => {
        it('calculates the percentage of non-null values', () => {
            const rows = [
                makeRepo({ description: 'one' }),
                makeRepo({ description: null }),
                makeRepo({ description: 'three' }),
                makeRepo({ description: null }),
            ];

            expect(getPercentFieldNotNull(rows, 'description')).toBe(50);
        });

        it('returns 0 for empty rows', () => {
            expect(getPercentFieldNotNull([], 'description')).toBe(0);
        });
    });

    describe('makeFieldsNotNullArray', () => {
        it('creates percentage entries for fields', () => {
            const rows = [
                makeRepo({ description: 'one', homepage: null }),
                makeRepo({
                    description: null,
                    homepage: 'https://example.com',
                }),
            ];

            expect(makeFieldsNotNullArray(rows, ['description', 'homepage'])).toEqual([
                { name: 'description', value: 50 },
                { name: 'homepage', value: 50 },
            ]);
        });

        it('returns an empty array when no fields are provided', () => {
            expect(makeFieldsNotNullArray([makeRepo()], [])).toEqual([]);
        });
    });

    describe('makeFieldDistributionArray', () => {
        it('calculates the distribution of values', () => {
            const rows = [
                makeRepo({ language: 'TypeScript' }),
                makeRepo({ language: 'TypeScript' }),
                makeRepo({ language: 'Java' }),
            ];

            expect(makeFieldDistributionArray(rows, 'language')).toEqual([
                { name: 'TypeScript', value: 2 / 3 },
                { name: 'Java', value: 1 / 3 },
            ]);
        });

        it('returns an empty array for empty rows', () => {
            expect(makeFieldDistributionArray([], 'language')).toEqual([]);
        });
    });

    describe('makeFieldDistributionByArray', () => {
        it('groups distributions by another field', () => {
            const rows = [
                makeRepo({
                    university: 'SLU',
                    language: 'TypeScript',
                }),
                makeRepo({
                    university: 'SLU',
                    language: 'Java',
                }),
                makeRepo({
                    university: 'Mizzou',
                    language: 'Java',
                }),
            ];

            expect(makeFieldDistributionByArray(rows, 'university', 'language')).toEqual([
                {
                    name: 'SLU',
                    TypeScript: 0.5,
                    Java: 0.5,
                },
                {
                    name: 'Mizzou',
                    Java: 1,
                },
            ]);
        });

        it('returns an empty array for empty rows', () => {
            expect(makeFieldDistributionByArray([], 'university', 'language')).toEqual([]);
        });
    });

    describe('makeCountsArray', () => {
        it('counts values by field', () => {
            const rows = [
                makeRepo({ language: 'TypeScript' }),
                makeRepo({ language: 'TypeScript' }),
                makeRepo({ language: 'Java' }),
            ];

            expect(makeCountsArray(rows, 'language')).toEqual([
                { name: 'TypeScript', value: 2 },
                { name: 'Java', value: 1 },
            ]);
        });

        it('returns total when no field is provided', () => {
            expect(makeCountsArray([makeRepo(), makeRepo()])).toEqual([{ name: 'total', value: 2 }]);
        });
    });

    describe('makeNumericDistributionArray', () => {
        it('puts numbers into the correct buckets', () => {
            const rows = [
                makeRepo({ size: 5 }),
                makeRepo({ size: 50 }),
                makeRepo({ size: 500 }),
                makeRepo({ size: 5000 }),
                makeRepo({ size: 50000 }),
            ];

            expect(makeNumericDistributionArray(rows, 'size')).toEqual([
                { name: '0-10', value: 1 },
                { name: '11-100', value: 1 },
                { name: '101-1000', value: 1 },
                { name: '1k-10k', value: 1 },
                { name: '10k+', value: 1 },
            ]);
        });

        it('ignores non-numeric values', () => {
            const rows = [
                makeRepo({
                    size: null as unknown as number,
                }),
            ];

            expect(makeNumericDistributionArray(rows, 'size')).toEqual([
                { name: '0-10', value: 0 },
                { name: '11-100', value: 0 },
                { name: '101-1000', value: 0 },
                { name: '1k-10k', value: 0 },
                { name: '10k+', value: 0 },
            ]);
        });
    });

    describe('makeImpactIndicatorsArray', () => {
        it('aggregates metrics by university', () => {
            const rows = [
                makeRepo({
                    university: 'SLU',
                    stargazersCount: 10,
                    forksCount: 2,
                    releaseDownloads: 100,
                    contributorCount: 4,
                }),
                makeRepo({
                    university: 'SLU',
                    stargazersCount: 5,
                    forksCount: 3,
                    releaseDownloads: 50,
                    contributorCount: 2,
                }),
            ];

            expect(makeImpactIndicatorsArray(rows)).toEqual([
                {
                    name: 'SLU',
                    stars: 15,
                    forks: 5,
                    downloads: 150,
                    contributors: 6,
                },
            ]);
        });

        it('treats missing values as 0', () => {
            const rows = [
                makeRepo({
                    university: 'SLU',
                    stargazersCount: 10,
                    forksCount: 2,
                    releaseDownloads: null as any,
                    contributorCount: undefined,
                }),
            ];

            expect(makeImpactIndicatorsArray(rows)).toEqual([
                {
                    name: 'SLU',
                    stars: 10,
                    forks: 2,
                    downloads: 0,
                    contributors: 0,
                },
            ]);
        });

        it('returns an empty array for empty rows', () => {
            expect(makeImpactIndicatorsArray([])).toEqual([]);
        });
    });

    describe('makeAvgScorePerMetricArray', () => {
        it('calculates averages and ignores -1 values', () => {
            const rows: secrData[] = [
                makeSecurity({
                    binaryArtifacts: 1,
                    branchProtection: -1,
                }),
                makeSecurity({
                    binaryArtifacts: 3,
                    branchProtection: 1,
                }),
            ];

            const result = makeAvgScorePerMetricArray(rows);

            expect(result.find((item) => item.name === 'binaryArtifacts')).toEqual({
                name: 'binaryArtifacts',
                value: 2,
            });

            expect(result.find((item) => item.name === 'branchProtection')).toEqual({
                name: 'branchProtection',
                value: 1,
            });

            expect(result.some((item) => item.name === 'htmlUrl')).toBe(false);
        });

        it('returns an empty array for empty rows', () => {
            expect(makeAvgScorePerMetricArray([])).toEqual([]);
        });
    });

    describe('organization calculations', () => {
        it('counts valid organization creation dates by year', () => {
            const rows = [
                makeOrganization({ createdAt: '2020-06-15T12:00:00' }),
                makeOrganization({ login: 'second', createdAt: '2020-09-01T12:00:00' }),
                makeOrganization({ login: 'third', createdAt: '2023-03-10T12:00:00' }),
                makeOrganization({ login: 'missing', createdAt: null as unknown as string }),
                makeOrganization({ login: 'invalid', createdAt: 'not-a-date' }),
            ];

            const result = makeDateDistributionArray(rows, 'createdAt');

            expect(result.find((row) => row.name === '2020')).toEqual({ name: '2020', value: 2 });
            expect(result.find((row) => row.name === '2022')).toEqual({ name: '2022', value: 0 });
            expect(result.find((row) => row.name === '2023')).toEqual({ name: '2023', value: 1 });
            expect(result.reduce((sum, row) => sum + row.value, 0)).toBe(3);
        });

        it('calculates profile completeness for each organization field', () => {
            const rows = [
                makeOrganization({
                    url: 'https://one.example.edu',
                    location: 'St. Louis',
                    description: 'First organization',
                    email: null,
                    company: 'First University',
                }),
                makeOrganization({
                    login: 'second',
                    url: 'https://two.example.edu',
                    location: '',
                    description: 'Second organization',
                    email: '',
                    company: null,
                }),
                makeOrganization({
                    login: 'third',
                    url: '',
                    location: null,
                    description: 'Third organization',
                    email: null,
                    company: '',
                }),
            ];

            const result = makeProfileCompleteDistributionArray(rows);

            expect(result).toHaveLength(5);
            expect(result.map((row) => row.name)).toEqual(['url', 'location', 'description', 'email', 'company']);
            expect(result.find((row) => row.name === 'url')?.value).toBeCloseTo((2 / 3) * 100);
            expect(result.find((row) => row.name === 'location')?.value).toBeCloseTo((1 / 3) * 100);
            expect(result.find((row) => row.name === 'description')?.value).toBe(100);
            expect(result.find((row) => row.name === 'email')?.value).toBe(0);
            expect(result.find((row) => row.name === 'company')?.value).toBeCloseTo((1 / 3) * 100);
        });
    });
});
