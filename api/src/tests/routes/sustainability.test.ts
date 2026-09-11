import request from 'supertest';
import { createApp } from '../../app';

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
        expect(res.body.avgContributors).toBeCloseTo(10.738095238095237);
        expect(res.body.avgBusFactor).toBeCloseTo(2.8333333333333335);
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
            { query: { university: 'saint louis university' }, expected: 11.225 },
            { query: { language: 'python' }, expected: 10.333333333333334 },
            { query: { license: 'MIT' }, expected: 11.272727272727273 },
            { query: { typePredictionGpt5Mini: 'dev' }, expected: 10.193548387096774 },
            {
                query: { language: ['python', 'javascript'] },
                expected: 11.904761904761905,
            },
            {
                query: {
                    university: 'saint louis university',
                    language: 'python',
                    license: 'MIT',
                    typePredictionGpt5Mini: 'dev',
                },
                expected: 27,
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
