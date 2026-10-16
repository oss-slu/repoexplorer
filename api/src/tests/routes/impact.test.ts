import request from 'supertest';
import { createApp } from '../../app';
import sampleRepoData from '../../../data/sample/sampleRepoData.json';

const IMPACT_FIELDS = [
    'totalStars',
    'totalForks',
    'totalDownloads',
    'totalContributors',
    'impactIndicatorsPerUniversity',
    'starsDistribution',
    'forksDistribution',
    'releaseDownloadsDistribution',
    'contributorsDistribution',
] as const;

const EMPTY_NUMERIC_DISTRIBUTION = [
    { name: '0-10', value: 0 },
    { name: '11-100', value: 0 },
    { name: '101-1000', value: 0 },
    { name: '1k-10k', value: 0 },
    { name: '10k+', value: 0 },
];

describe('GET /impact', () => {
    it('returns exactly the documented fields and representative fixture values', async () => {
        const res = await request(createApp()).get('/impact');

        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual([...IMPACT_FIELDS].sort());
        expect(res.body.totalStars).toBe(
            sampleRepoData.reduce<number>((total, repo) => total + (Number(repo.stargazersCount) || 0), 0),
        );
        expect(res.body.totalForks).toBe(
            sampleRepoData.reduce<number>((total, repo) => total + (Number(repo.forksCount) || 0), 0),
        );
        expect(res.body.totalDownloads).toBe(
            sampleRepoData.reduce<number>((total, repo) => total + (Number(repo.releaseDownloads) || 0), 0),
        );
        expect(res.body.totalContributors).toBe(
            sampleRepoData.reduce<number>((total, repo) => total + (Number(repo.contributorCount) || 0), 0),
        );
        expect(
            res.body.impactIndicatorsPerUniversity.reduce(
                (
                    totals: { stars: number; forks: number; downloads: number; contributors: number },
                    university: { stars: number; forks: number; downloads: number; contributors: number },
                ) => ({
                    stars: totals.stars + university.stars,
                    forks: totals.forks + university.forks,
                    downloads: totals.downloads + university.downloads,
                    contributors: totals.contributors + university.contributors,
                }),
                { stars: 0, forks: 0, downloads: 0, contributors: 0 },
            ),
        ).toEqual({
            stars: res.body.totalStars,
            forks: res.body.totalForks,
            downloads: res.body.totalDownloads,
            contributors: res.body.totalContributors,
        });
        expect(res.body.starsDistribution).toHaveLength(5);
        expect(res.body.starsDistribution.map((group: { name: string }) => group.name)).toEqual([
            '0-10',
            '11-100',
            '101-1000',
            '1k-10k',
            '10k+',
        ]);
        expect(
            res.body.starsDistribution.reduce((total: number, group: { value: number }) => total + group.value, 0),
        ).toBe(sampleRepoData.length);
    });

    it.each(IMPACT_FIELDS)('returns the full-response value from /impact/%s', async (field) => {
        const app = createApp();
        const [root, sub] = await Promise.all([request(app).get('/impact'), request(app).get(`/impact/${field}`)]);

        expect(sub.status).toBe(200);
        expect(Object.keys(sub.body)).toEqual([field]);
        expect(sub.body[field]).toEqual(root.body[field]);
    });

    it('applies case-insensitive, OR, AND, and unknown-parameter filter behavior', async () => {
        const cases = [
            {
                query: { university: 'saint louis university' },
                totalStars: sampleRepoData
                    .filter((repo) => repo.university?.toLowerCase() === 'saint louis university')
                    .reduce<number>((total, repo) => total + (Number(repo.stargazersCount) || 0), 0),
                totalContributors: sampleRepoData
                    .filter((repo) => repo.university?.toLowerCase() === 'saint louis university')
                    .reduce<number>((total, repo) => total + (Number(repo.contributorCount) || 0), 0),
            },
            {
                query: { language: 'PYTHON' },
                totalStars: sampleRepoData
                    .filter((repo) => repo.language?.toLowerCase() === 'python')
                    .reduce<number>((total, repo) => total + (Number(repo.stargazersCount) || 0), 0),
                totalContributors: sampleRepoData
                    .filter((repo) => repo.language?.toLowerCase() === 'python')
                    .reduce<number>((total, repo) => total + (Number(repo.contributorCount) || 0), 0),
            },
            {
                query: { license: 'MIT' },
                totalStars: sampleRepoData
                    .filter((repo) => repo.license?.toLowerCase() === 'mit')
                    .reduce<number>((total, repo) => total + (Number(repo.stargazersCount) || 0), 0),
                totalContributors: sampleRepoData
                    .filter((repo) => repo.license?.toLowerCase() === 'mit')
                    .reduce<number>((total, repo) => total + (Number(repo.contributorCount) || 0), 0),
            },
            {
                query: { typePredictionGpt5Mini: 'dev' },
                totalStars: sampleRepoData
                    .filter((repo) => repo.typePredictionGpt5Mini?.toLowerCase() === 'dev')
                    .reduce<number>((total, repo) => total + (Number(repo.stargazersCount) || 0), 0),
                totalContributors: sampleRepoData
                    .filter((repo) => repo.typePredictionGpt5Mini?.toLowerCase() === 'dev')
                    .reduce<number>((total, repo) => total + (Number(repo.contributorCount) || 0), 0),
            },
            {
                query: { language: ['PYTHON', 'javascript'] },
                totalStars: sampleRepoData
                    .filter((repo) => ['python', 'javascript'].includes(repo.language?.toLowerCase() ?? ''))
                    .reduce<number>((total, repo) => total + (Number(repo.stargazersCount) || 0), 0),
                totalContributors: sampleRepoData
                    .filter((repo) => ['python', 'javascript'].includes(repo.language?.toLowerCase() ?? ''))
                    .reduce<number>((total, repo) => total + (Number(repo.contributorCount) || 0), 0),
            },
            {
                query: {
                    university: 'saint louis university',
                    language: 'python',
                    license: 'MIT',
                    typePredictionGpt5Mini: 'dev',
                },
                totalStars: sampleRepoData
                    .filter(
                        (repo) =>
                            repo.university?.toLowerCase() === 'saint louis university' &&
                            repo.language?.toLowerCase() === 'python' &&
                            repo.license?.toLowerCase() === 'mit' &&
                            repo.typePredictionGpt5Mini?.toLowerCase() === 'dev',
                    )
                    .reduce<number>((total, repo) => total + (Number(repo.stargazersCount) || 0), 0),
                totalContributors: sampleRepoData
                    .filter(
                        (repo) =>
                            repo.university?.toLowerCase() === 'saint louis university' &&
                            repo.language?.toLowerCase() === 'python' &&
                            repo.license?.toLowerCase() === 'mit' &&
                            repo.typePredictionGpt5Mini?.toLowerCase() === 'dev',
                    )
                    .reduce<number>((total, repo) => total + (Number(repo.contributorCount) || 0), 0),
            },
            {
                query: { ignored: 'does-not-filter' },
                totalStars: sampleRepoData.reduce<number>(
                    (total, repo) => total + (Number(repo.stargazersCount) || 0),
                    0,
                ),
                totalContributors: sampleRepoData.reduce<number>(
                    (total, repo) => total + (Number(repo.contributorCount) || 0),
                    0,
                ),
            },
        ];

        for (const testCase of cases) {
            const [root, sub] = await Promise.all([
                request(createApp()).get('/impact').query(testCase.query),
                request(createApp()).get('/impact/totalStars').query(testCase.query),
            ]);

            expect(root.status).toBe(200);
            expect(root.body.totalStars).toBe(testCase.totalStars);
            expect(root.body.totalContributors).toBe(testCase.totalContributors);
            expect(sub.body).toEqual({ totalStars: testCase.totalStars });
        }
    });

    it('returns zero scalars and zero-filled distributions when no repositories match', async () => {
        const query = { university: 'does-not-exist' };
        const root = await request(createApp()).get('/impact').query(query);
        const expected = {
            totalStars: 0,
            totalForks: 0,
            totalDownloads: 0,
            totalContributors: 0,
            impactIndicatorsPerUniversity: [],
            starsDistribution: EMPTY_NUMERIC_DISTRIBUTION,
            forksDistribution: EMPTY_NUMERIC_DISTRIBUTION,
            releaseDownloadsDistribution: EMPTY_NUMERIC_DISTRIBUTION,
            contributorsDistribution: EMPTY_NUMERIC_DISTRIBUTION,
        };

        expect(root.status).toBe(200);
        expect(root.body).toEqual(expected);

        for (const field of IMPACT_FIELDS) {
            const res = await request(createApp()).get(`/impact/${field}`).query(query);
            expect(res.body).toEqual({ [field]: expected[field] });
        }
    });

    it('returns 404 for an unknown suffix', async () => {
        const res = await request(createApp()).get('/impact/notAField');

        expect(res.status).toBe(404);
    });

    it('returns SLU data only', async () => {
        const app = createApp();
        const res = await request(app).get('/impact?university=saint+louis+university');

        expect(res.status).toBe(200);
        expect(res.body.impactIndicatorsPerUniversity).toHaveLength(1);
        expect(res.body.impactIndicatorsPerUniversity[0]).toMatchObject({
            name: 'Saint Louis University',
        });

        expect(typeof res.body.totalStars).toBe('number');
        expect(typeof res.body.totalForks).toBe('number');
        expect(typeof res.body.totalDownloads).toBe('number');
        expect(typeof res.body.totalContributors).toBe('number');
        expect(Array.isArray(res.body.starsDistribution)).toBe(true);
        expect(Array.isArray(res.body.forksDistribution)).toBe(true);
        expect(Array.isArray(res.body.releaseDownloadsDistribution)).toBe(true);
        expect(Array.isArray(res.body.contributorsDistribution)).toBe(true);
    });
});
