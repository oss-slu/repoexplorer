import request from 'supertest';
import { createApp } from '../../app';
import sampleRepoData from '../../../data/sample/sampleRepoData.json';

const OVERVIEW_FIELDS = [
    'totalRepos',
    'withLicense',
    'percentWithLicense',
    'totalContributors',
    'avgBusFactor',
    'reposPerUniversity',
    'languageDistribution',
    'licenseDistribution',
    'typeDistribution',
    'communityFilesPresence',
    'languageDistributionByType',
    'licenseDistributionByType',
] as const;

describe('GET /overview', () => {
    it('returns exactly the documented fields and representative fixture values', async () => {
        const res = await request(createApp()).get('/overview');

        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual([...OVERVIEW_FIELDS].sort());
        expect(res.body.totalRepos).toBe(sampleRepoData.length);
        expect(res.body.withLicense).toBe(
            sampleRepoData.filter((repo) => repo.license !== null && repo.license !== '').length,
        );
        expect(res.body.percentWithLicense).toBeCloseTo((res.body.withLicense / sampleRepoData.length) * 100);
        expect(res.body.totalContributors).toBe(
            sampleRepoData.reduce<number>((total, repo) => total + (Number(repo.contributorCount) || 0), 0),
        );
        expect(res.body.avgBusFactor).toBeCloseTo(
            sampleRepoData.reduce<number>((total, repo) => total + Number(repo.busFactor ?? 0), 0) /
                sampleRepoData.length,
        );
        expect(
            res.body.reposPerUniversity.reduce(
                (total: number, university: { name: string; value: number }) => total + university.value,
                0,
            ),
        ).toBe(sampleRepoData.length);
        expect(res.body.languageDistribution).toContainEqual({
            name: 'Python',
            value: sampleRepoData.filter((repo) => repo.language === 'Python').length / sampleRepoData.length,
        });
        expect(res.body.licenseDistribution).toContainEqual({
            name: 'mit',
            value:
                sampleRepoData.filter((repo) => repo.license?.toLowerCase() === 'mit').length / sampleRepoData.length,
        });
        expect(res.body.typeDistribution).toContainEqual({
            name: 'DEV',
            value:
                sampleRepoData.filter((repo) => repo.typePredictionGpt5Mini === 'DEV').length / sampleRepoData.length,
        });
    });

    it.each(OVERVIEW_FIELDS)('returns the full-response value from /overview/%s', async (field) => {
        const app = createApp();
        const [root, sub] = await Promise.all([request(app).get('/overview'), request(app).get(`/overview/${field}`)]);

        expect(sub.status).toBe(200);
        expect(Object.keys(sub.body)).toEqual([field]);
        expect(sub.body[field]).toEqual(root.body[field]);
    });

    it('applies case-insensitive, OR, AND, and unknown-parameter filter behavior', async () => {
        const cases = [
            {
                query: { university: 'saint louis university' },
                totalRepos: sampleRepoData.filter((repo) => repo.university?.toLowerCase() === 'saint louis university')
                    .length,
                totalContributors: sampleRepoData
                    .filter((repo) => repo.university?.toLowerCase() === 'saint louis university')
                    .reduce<number>((total, repo) => total + (Number(repo.contributorCount) || 0), 0),
            },
            {
                query: { language: 'PYTHON' },
                totalRepos: sampleRepoData.filter((repo) => repo.language?.toLowerCase() === 'python').length,
                totalContributors: sampleRepoData
                    .filter((repo) => repo.language?.toLowerCase() === 'python')
                    .reduce<number>((total, repo) => total + (Number(repo.contributorCount) || 0), 0),
            },
            {
                query: { license: 'MIT' },
                totalRepos: sampleRepoData.filter((repo) => repo.license?.toLowerCase() === 'mit').length,
                totalContributors: sampleRepoData
                    .filter((repo) => repo.license?.toLowerCase() === 'mit')
                    .reduce<number>((total, repo) => total + (Number(repo.contributorCount) || 0), 0),
            },
            {
                query: { typePredictionGpt5Mini: 'dev' },
                totalRepos: sampleRepoData.filter((repo) => repo.typePredictionGpt5Mini?.toLowerCase() === 'dev')
                    .length,
                totalContributors: sampleRepoData
                    .filter((repo) => repo.typePredictionGpt5Mini?.toLowerCase() === 'dev')
                    .reduce<number>((total, repo) => total + (Number(repo.contributorCount) || 0), 0),
            },
            {
                query: { language: ['PYTHON', 'javascript'] },
                totalRepos: sampleRepoData.filter((repo) =>
                    ['python', 'javascript'].includes(repo.language?.toLowerCase() ?? ''),
                ).length,
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
                totalRepos: sampleRepoData.filter(
                    (repo) =>
                        repo.university?.toLowerCase() === 'saint louis university' &&
                        repo.language?.toLowerCase() === 'python' &&
                        repo.license?.toLowerCase() === 'mit' &&
                        repo.typePredictionGpt5Mini?.toLowerCase() === 'dev',
                ).length,
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
                totalRepos: sampleRepoData.length,
                totalContributors: sampleRepoData.reduce<number>(
                    (total, repo) => total + (Number(repo.contributorCount) || 0),
                    0,
                ),
            },
        ];

        for (const testCase of cases) {
            const [root, sub] = await Promise.all([
                request(createApp()).get('/overview').query(testCase.query),
                request(createApp()).get('/overview/totalRepos').query(testCase.query),
            ]);

            expect(root.status).toBe(200);
            expect(root.body.totalRepos).toBe(testCase.totalRepos);
            expect(root.body.totalContributors).toBe(testCase.totalContributors);
            expect(sub.body).toEqual({ totalRepos: testCase.totalRepos });
        }
    });

    it('returns the documented empty shapes when no repositories match', async () => {
        const query = { university: 'does-not-exist' };
        const root = await request(createApp()).get('/overview').query(query);
        const expected = {
            totalRepos: 0,
            withLicense: 0,
            percentWithLicense: 0,
            totalContributors: 0,
            avgBusFactor: 0,
            reposPerUniversity: [],
            languageDistribution: [],
            licenseDistribution: [],
            typeDistribution: [],
            communityFilesPresence: [
                { name: 'issueTemplates', value: 0 },
                { name: 'securityPolicy', value: 0 },
                { name: 'codeOfConductFile', value: 0 },
                { name: 'pullRequestTemplate', value: 0 },
                { name: 'contributing', value: 0 },
                { name: 'license', value: 0 },
                { name: 'description', value: 0 },
                { name: 'readme', value: 0 },
            ],
            languageDistributionByType: [],
            licenseDistributionByType: [],
        };

        expect(root.status).toBe(200);
        expect(root.body).toEqual(expected);

        for (const field of OVERVIEW_FIELDS) {
            const res = await request(createApp()).get(`/overview/${field}`).query(query);
            expect(res.body).toEqual({ [field]: expected[field] });
        }
    });

    it('returns 404 for an unknown suffix', async () => {
        const res = await request(createApp()).get('/overview/notAField');

        expect(res.status).toBe(404);
    });
});
