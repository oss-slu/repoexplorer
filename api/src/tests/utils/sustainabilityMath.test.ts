import type { repoData } from '../../types/appData';
import {
    getAvailableAvg,
    makeBusFactorDistributionArray,
    makeCommunityFilesByStarsArray,
    makeCommunityFilesByTypeArray,
    makeContributorCountDistributionArray,
    makeSustainabilityIndicatorsArray,
} from '../../utils/math';

function makeRow(overrides: Partial<repoData> = {}): repoData {
    return {
        university: 'A',
        id: 1,
        fullName: 'org/repo',
        owner: 'org',
        license: 'mit',
        language: 'TypeScript',
        htmlUrl: 'https://github.com/org/repo',
        description: null,
        fork: 0,
        createdAt: null,
        updatedAt: null,
        pushedAt: null,
        homepage: null,
        size: 1,
        stargazersCount: 0,
        readme: null,
        watchersCount: 0,
        forksCount: 0,
        openIssuesCount: 0,
        watchers: 0,
        organization: null,
        releaseDownloads: 0,
        contributors: null,
        contributorCount: 0,
        busFactor: 0,
        codeOfConductFile: null,
        contributing: null,
        securityPolicy: null,
        issueTemplates: null,
        pullRequestTemplate: null,
        subscribersCount: 0,
        affiliationPredictionGpt5Mini: 1,
        typePredictionGpt5Mini: 'DEV',
        ...overrides,
    };
}

describe('Sustainability math helpers', () => {
    it('computes weighted headline averages and sorted university indicators', () => {
        const rows = [
            makeRow({ university: 'A', contributorCount: 2, busFactor: 1 }),
            makeRow({ id: 2, university: 'A', contributorCount: 4, busFactor: 3 }),
            makeRow({ id: 3, university: 'B', contributorCount: 12, busFactor: 5 }),
        ];

        expect(getAvailableAvg(rows, 'contributorCount')).toBe(6);
        expect(getAvailableAvg(rows, 'busFactor')).toBe(3);
        expect(makeSustainabilityIndicatorsArray(rows)).toEqual([
            { name: 'B', avgContributors: 12, avgBusFactor: 5 },
            { name: 'A', avgContributors: 3, avgBusFactor: 2 },
        ]);
    });

    it('uses independent available observations and Unknown for nullish universities', () => {
        const rows = [
            makeRow({ university: 'A', contributorCount: 2, busFactor: 1 }),
            makeRow({
                id: 2,
                university: 'A',
                contributorCount: 4,
                busFactor: null as unknown as number,
            }),
            makeRow({
                id: 3,
                university: null as unknown as string,
                contributorCount: null as unknown as number,
                busFactor: 5,
            }),
        ];

        expect(getAvailableAvg(rows, 'contributorCount')).toBe(3);
        expect(getAvailableAvg(rows, 'busFactor')).toBe(3);
        expect(getAvailableAvg([makeRow({ contributorCount: NaN })], 'contributorCount')).toBe(0);
        expect(makeSustainabilityIndicatorsArray(rows)).toEqual([
            { name: 'A', avgContributors: 3, avgBusFactor: 1 },
            { name: 'Unknown', avgContributors: 0, avgBusFactor: 5 },
        ]);
    });

    it('counts community presence by project type, including empty strings and null types', () => {
        const rows = [
            makeRow({
                description: '',
                readme: 'README',
                license: 'mit',
                securityPolicy: '',
                typePredictionGpt5Mini: 'DEV',
            }),
            makeRow({
                id: 2,
                description: null,
                readme: null,
                license: null,
                codeOfConductFile: 'CODE',
                contributing: 'GUIDE',
                issueTemplates: 'ISSUES',
                typePredictionGpt5Mini: 'EDU',
            }),
            makeRow({
                id: 3,
                typePredictionGpt5Mini: null,
            }),
        ];

        const result = makeCommunityFilesByTypeArray(rows);

        expect(result.map((row) => row.name)).toEqual([
            'pullRequestTemplate',
            'description',
            'readme',
            'license',
            'codeOfConductFile',
            'contributing',
            'securityPolicy',
            'issueTemplates',
        ]);
        expect(result.find((row) => row.name === 'description')).toEqual({
            name: 'description',
            total: 1,
            percentage: 33.3,
            DEV: 1,
            EDU: 0,
        });
        expect(result.find((row) => row.name === 'pullRequestTemplate')).toEqual({
            name: 'pullRequestTemplate',
            total: 0,
            percentage: 0,
            DEV: 0,
            EDU: 0,
        });
        expect(result.find((row) => row.name === 'securityPolicy')).toEqual({
            name: 'securityPolicy',
            total: 1,
            percentage: 33.3,
            DEV: 1,
            EDU: 0,
        });
    });

    it('orders canonical and custom project types consistently', () => {
        const rows = ['ZZ', 'error', 'WEB', 'DEV', 'DATA', 'OTHER'].map((type, index) =>
            makeRow({ id: index + 1, typePredictionGpt5Mini: type }),
        );

        expect(Object.keys(makeCommunityFilesByTypeArray(rows)[0])).toEqual([
            'name',
            'total',
            'percentage',
            'DATA',
            'DEV',
            'OTHER',
            'WEB',
            'error',
            'ZZ',
        ]);
    });

    it('places star values at every boundary and includes all project types', () => {
        const rows = [0, 10, 11, 50, 51, 100, 101, 200, 201].map((stars, index) =>
            makeRow({
                id: index + 1,
                stargazersCount: stars,
                description: 'present',
                typePredictionGpt5Mini: index % 2 === 0 ? 'DEV' : 'EDU',
            }),
        );

        const result = makeCommunityFilesByStarsArray(rows);

        expect(result.map((row) => row.name)).toEqual([
            'description',
            'readme',
            'license',
            'codeOfConductFile',
            'contributing',
            'securityPolicy',
            'issueTemplates',
            'pullRequestTemplate',
            'average',
        ]);
        for (const row of result) {
            expect(Object.keys(row)).toEqual(['name', '0-10', '11-50', '51-100', '101-200', '>200']);
        }
        expect(result[0]).toEqual({
            name: 'description',
            '0-10': 100,
            '11-50': 100,
            '51-100': 100,
            '101-200': 100,
            '>200': 100,
        });
    });

    it('uses bucket denominators, includes non-DEV rows, and averages rounded percentages', () => {
        const oneOfTwo = makeCommunityFilesByStarsArray([
            makeRow({ stargazersCount: 0, description: 'present', typePredictionGpt5Mini: 'EDU' }),
            makeRow({ id: 2, stargazersCount: 10, typePredictionGpt5Mini: 'DEV' }),
        ]);
        expect(oneOfTwo.find((row) => row.name === 'description')).toMatchObject({ '0-10': 50 });
        expect(oneOfTwo.find((row) => row.name === 'securityPolicy')).toMatchObject({ '0-10': 0 });
        expect(oneOfTwo.find((row) => row.name === 'description')).toBeDefined();

        const average = makeCommunityFilesByStarsArray([
            makeRow({
                stargazersCount: 0,
                description: 'present',
                readme: 'present',
                license: null,
                typePredictionGpt5Mini: 'EDU',
            }),
            makeRow({
                id: 2,
                stargazersCount: 10,
                description: 'present',
                readme: 'present',
                license: null,
                typePredictionGpt5Mini: 'DEV',
            }),
        ]).find((row) => row.name === 'average');

        expect(average).toEqual({
            name: 'average',
            '0-10': 25,
            '11-50': 0,
            '51-100': 0,
            '101-200': 0,
            '>200': 0,
        });
    });

    it('uses the specified bus-factor buckets and excludes invalid observations', () => {
        const rows = [0, 1, 2, 3, 4, 5, 6, 10, 11, -1, NaN, null].map((busFactor, index) =>
            makeRow({ id: index + 1, busFactor: busFactor as number }),
        );

        expect(makeBusFactorDistributionArray(rows)).toEqual([
            { name: '0-1', value: 2, percentage: 16.7 },
            { name: '1-2', value: 1, percentage: 8.3 },
            { name: '2-3', value: 1, percentage: 8.3 },
            { name: '3-4', value: 1, percentage: 8.3 },
            { name: '4-5', value: 1, percentage: 8.3 },
            { name: '5-10', value: 2, percentage: 16.7 },
            { name: '10+', value: 1, percentage: 8.3 },
        ]);
        expect(makeBusFactorDistributionArray(rows).every((row) => Number.isFinite(row.percentage))).toBe(true);
    });

    it('uses the specified contributor buckets and excludes invalid observations', () => {
        const rows = [0, 2, 3, 10, 11, 50, 51, 100, 101, -1, NaN, null].map((contributorCount, index) =>
            makeRow({ id: index + 1, contributorCount: contributorCount as number }),
        );

        expect(makeContributorCountDistributionArray(rows)).toEqual([
            { name: '0-2', value: 2, percentage: 16.7 },
            { name: '3-10', value: 2, percentage: 16.7 },
            { name: '10-50', value: 2, percentage: 16.7 },
            { name: '50-100', value: 2, percentage: 16.7 },
            { name: '100+', value: 1, percentage: 8.3 },
        ]);
        expect(makeContributorCountDistributionArray([makeRow({ contributorCount: 0 })])).toEqual([
            { name: '0-2', value: 1, percentage: 100 },
            { name: '3-10', value: 0, percentage: 0 },
            { name: '10-50', value: 0, percentage: 0 },
            { name: '50-100', value: 0, percentage: 0 },
            { name: '100+', value: 0, percentage: 0 },
        ]);
    });
});
