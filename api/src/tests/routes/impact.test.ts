import request from 'supertest';
import { createApp } from '../../app';

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
        expect(res.body.totalStars).toBe(146);
        expect(res.body.totalForks).toBe(289);
        expect(res.body.totalDownloads).toBe(223);
        expect(res.body.totalContributors).toBe(515);
        expect(res.body.impactIndicatorsPerUniversity).toEqual([
            {
                name: 'University of California, Santa Barbara',
                stars: 10,
                forks: 1,
                downloads: 0,
                contributors: 1,
            },
            {
                name: 'University of California, Santa Cruz',
                stars: 34,
                forks: 28,
                downloads: 0,
                contributors: 24,
            },
            {
                name: 'Saint Louis University',
                stars: 102,
                forks: 260,
                downloads: 223,
                contributors: 490,
            },
        ]);
        expect(res.body.starsDistribution).toEqual([
            { name: '0-10', value: 110 },
            { name: '11-100', value: 1 },
            { name: '101-1000', value: 0 },
            { name: '1k-10k', value: 0 },
            { name: '10k+', value: 0 },
        ]);
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
            { query: { university: 'saint louis university' }, totalStars: 102, totalContributors: 490 },
            { query: { language: 'PYTHON' }, totalStars: 55, totalContributors: 164 },
            { query: { license: 'MIT' }, totalStars: 62, totalContributors: 150 },
            { query: { typePredictionGpt5Mini: 'dev' }, totalStars: 106, totalContributors: 336 },
            {
                query: { language: ['PYTHON', 'javascript'] },
                totalStars: 84,
                totalContributors: 281,
            },
            {
                query: {
                    university: 'saint louis university',
                    language: 'python',
                    license: 'MIT',
                    typePredictionGpt5Mini: 'dev',
                },
                totalStars: 7,
                totalContributors: 31,
            },
            { query: { ignored: 'does-not-filter' }, totalStars: 146, totalContributors: 515 },
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
