import request from 'supertest';
import { createApp } from '../../app';
import sampleRepoData from '../../../data/sample/sampleRepoData.json';

const SUSTAINABILITY_FIELDS = [
    'sustainabilityIndicatorsPerUniversity',
    'avgContributors',
    'avgBusFactor',
    'communityFiles',
    'communityFilesByStars',
    'busFactorDistribution',
    'contributorCountDistribution',
] as const;

describe('GET /sustainability', () => {
    it('returns exactly the seven documented fields and expected row shapes', async () => {
        const res = await request(createApp()).get('/sustainability');

        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual([...SUSTAINABILITY_FIELDS].sort());
        const reposWithContributors = sampleRepoData.filter(
            (repo) => typeof repo.contributorCount === 'number' && Number.isFinite(repo.contributorCount),
        );

        expect(res.body.avgContributors).toBeCloseTo(
            reposWithContributors.reduce<number>((total, repo) => total + Number(repo.contributorCount), 0) /
                reposWithContributors.length,
        );
        expect(res.body.avgBusFactor).toBeCloseTo(
            sampleRepoData
                .filter((repo) => repo.busFactor !== null && repo.busFactor !== undefined)
                .reduce<number>((total, repo) => total + Number(repo.busFactor), 0) /
                sampleRepoData.filter((repo) => repo.busFactor !== null && repo.busFactor !== undefined).length,
        );
        expect(res.body.sustainabilityIndicatorsPerUniversity[0]).toEqual(
            expect.objectContaining({
                name: expect.any(String),
                avgContributors: expect.any(Number),
                avgBusFactor: expect.any(Number),
            }),
        );
        expect(res.body.communityFiles[0]).toEqual(
            expect.objectContaining({
                name: expect.any(String),
                total: expect.any(Number),
                percentage: expect.any(Number),
            }),
        );
        expect(res.body.communityFilesByStars[0]).toEqual(
            expect.objectContaining({
                name: expect.any(String),
                '0-10': expect.any(Number),
                '11-50': expect.any(Number),
                '51-100': expect.any(Number),
                '101-200': expect.any(Number),
                '>200': expect.any(Number),
            }),
        );
        expect(res.body.busFactorDistribution[0]).toEqual(
            expect.objectContaining({
                name: expect.any(String),
                value: expect.any(Number),
                percentage: expect.any(Number),
            }),
        );
        expect(res.body.contributorCountDistribution[0]).toEqual(
            expect.objectContaining({
                name: expect.any(String),
                value: expect.any(Number),
                percentage: expect.any(Number),
            }),
        );
    });

    it.each(SUSTAINABILITY_FIELDS)('returns the full-response value from /sustainability/%s', async (field) => {
        const app = createApp();
        const [root, sub] = await Promise.all([
            request(app).get('/sustainability'),
            request(app).get(`/sustainability/${field}`),
        ]);

        expect(sub.status).toBe(200);
        expect(Object.keys(sub.body)).toEqual([field]);
        expect(sub.body[field]).toEqual(root.body[field]);
    });

    it('applies each filter case-insensitively and combines filters with AND/OR semantics', async () => {
        const app = createApp();
        const cases = [
            {
                query: { university: 'saint louis university' },
                expected: (() => {
                    const matchingRepos = sampleRepoData.filter(
                        (repo) =>
                            repo.university?.toLowerCase() === 'saint louis university' &&
                            typeof repo.contributorCount === 'number' &&
                            Number.isFinite(repo.contributorCount),
                    );
                    return (
                        matchingRepos.reduce<number>((total, repo) => total + Number(repo.contributorCount), 0) /
                        matchingRepos.length
                    );
                })(),
            },
            {
                query: { language: 'python' },
                expected: (() => {
                    const matchingRepos = sampleRepoData.filter(
                        (repo) =>
                            repo.language?.toLowerCase() === 'python' &&
                            typeof repo.contributorCount === 'number' &&
                            Number.isFinite(repo.contributorCount),
                    );
                    return (
                        matchingRepos.reduce<number>((total, repo) => total + Number(repo.contributorCount), 0) /
                        matchingRepos.length
                    );
                })(),
            },
            {
                query: { license: 'MIT' },
                expected: (() => {
                    const matchingRepos = sampleRepoData.filter(
                        (repo) =>
                            repo.license?.toLowerCase() === 'mit' &&
                            typeof repo.contributorCount === 'number' &&
                            Number.isFinite(repo.contributorCount),
                    );
                    return (
                        matchingRepos.reduce<number>((total, repo) => total + Number(repo.contributorCount), 0) /
                        matchingRepos.length
                    );
                })(),
            },
            {
                query: { typePredictionGpt5Mini: 'dev' },
                expected: (() => {
                    const matchingRepos = sampleRepoData.filter(
                        (repo) =>
                            repo.typePredictionGpt5Mini?.toLowerCase() === 'dev' &&
                            typeof repo.contributorCount === 'number' &&
                            Number.isFinite(repo.contributorCount),
                    );
                    return (
                        matchingRepos.reduce<number>((total, repo) => total + Number(repo.contributorCount), 0) /
                        matchingRepos.length
                    );
                })(),
            },
            {
                query: { language: ['python', 'javascript'] },
                expected: (() => {
                    const matchingRepos = sampleRepoData.filter(
                        (repo) =>
                            ['python', 'javascript'].includes(repo.language?.toLowerCase() ?? '') &&
                            typeof repo.contributorCount === 'number' &&
                            Number.isFinite(repo.contributorCount),
                    );
                    return (
                        matchingRepos.reduce<number>((total, repo) => total + Number(repo.contributorCount), 0) /
                        matchingRepos.length
                    );
                })(),
            },
            {
                query: {
                    university: 'saint louis university',
                    language: 'python',
                    license: 'MIT',
                    typePredictionGpt5Mini: 'dev',
                },
                expected: (() => {
                    const matchingRepos = sampleRepoData.filter(
                        (repo) =>
                            repo.university?.toLowerCase() === 'saint louis university' &&
                            repo.language?.toLowerCase() === 'python' &&
                            repo.license?.toLowerCase() === 'mit' &&
                            repo.typePredictionGpt5Mini?.toLowerCase() === 'dev' &&
                            typeof repo.contributorCount === 'number' &&
                            Number.isFinite(repo.contributorCount),
                    );
                    return matchingRepos.length === 0
                        ? 0
                        : matchingRepos.reduce<number>((total, repo) => total + Number(repo.contributorCount), 0) /
                              matchingRepos.length;
                })(),
            },
        ];

        for (const testCase of cases) {
            const [root, sub] = await Promise.all([
                request(app).get('/sustainability').query(testCase.query),
                request(app).get('/sustainability/avgContributors').query(testCase.query),
            ]);

            expect(root.status).toBe(200);
            expect(root.body.avgContributors).toBeCloseTo(testCase.expected);
            expect(sub.body).toEqual({ avgContributors: root.body.avgContributors });
        }
    });

    it('returns zero scalars and empty arrays when no repositories match', async () => {
        const app = createApp();
        const root = await request(app).get('/sustainability').query({ university: 'does-not-exist' });
        const expected = {
            sustainabilityIndicatorsPerUniversity: [],
            avgContributors: 0,
            avgBusFactor: 0,
            communityFiles: [],
            communityFilesByStars: [],
            busFactorDistribution: [],
            contributorCountDistribution: [],
        };

        expect(root.status).toBe(200);
        expect(root.body).toEqual(expected);

        for (const field of SUSTAINABILITY_FIELDS) {
            const res = await request(app).get(`/sustainability/${field}`).query({ university: 'does-not-exist' });
            expect(res.body).toEqual({ [field]: expected[field] });
        }
    });

    it('returns 404 for an unknown suffix', async () => {
        const res = await request(createApp()).get('/sustainability/notAField');

        expect(res.status).toBe(404);
    });
});
