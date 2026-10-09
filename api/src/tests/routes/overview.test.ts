import request from 'supertest';
import { createApp } from '../../app';

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
        expect(res.body.totalRepos).toBe(111);
        expect(res.body.withLicense).toBe(83);
        expect(res.body.percentWithLicense).toBeCloseTo((83 / 111) * 100);
        expect(res.body.totalContributors).toBe(515);
        expect(res.body.avgBusFactor).toBeCloseTo(139 / 111);
        expect(res.body.reposPerUniversity).toEqual([
            { name: 'University of California, Santa Barbara', value: 1 },
            { name: 'University of California, Santa Cruz', value: 3 },
            { name: 'Saint Louis University', value: 107 },
        ]);
        expect(res.body.languageDistribution).toContainEqual({ name: 'Python', value: 18 / 111 });
        expect(res.body.licenseDistribution).toContainEqual({ name: 'mit', value: 26 / 111 });
        expect(res.body.typeDistribution).toContainEqual({ name: 'DEV', value: 43 / 111 });
        expect(res.body.communityFilesPresence).toContainEqual({ name: 'license', value: (83 / 111) * 100 });
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
                totalRepos: 107,
                totalContributors: 490,
            },
            { query: { language: 'PYTHON' }, totalRepos: 18, totalContributors: 164 },
            { query: { license: 'MIT' }, totalRepos: 26, totalContributors: 150 },
            { query: { typePredictionGpt5Mini: 'dev' }, totalRepos: 43, totalContributors: 336 },
            {
                query: { language: ['PYTHON', 'javascript'] },
                totalRepos: 27,
                totalContributors: 281,
            },
            {
                query: {
                    university: 'saint louis university',
                    language: 'python',
                    license: 'MIT',
                    typePredictionGpt5Mini: 'dev',
                },
                totalRepos: 2,
                totalContributors: 31,
            },
            { query: { ignored: 'does-not-filter' }, totalRepos: 111, totalContributors: 515 },
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
