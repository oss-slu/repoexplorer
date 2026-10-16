import request from 'supertest';
import { createApp } from '../../app';
import sampleSecrData from '../../../data/sample/sampleSecrData.json';

const SECURITY_FIELDS = ['securityScorecardByRepo', 'avgScorePerMetric'] as const;

describe('GET /security', () => {
    it('returns exactly the documented fields and representative fixture values', async () => {
        const res = await request(createApp()).get('/security');

        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual([...SECURITY_FIELDS].sort());
        expect(res.body.securityScorecardByRepo).toHaveLength(sampleSecrData.length);
        expect(res.body.securityScorecardByRepo[0]).toEqual(sampleSecrData[0]);
        expect(res.body.avgScorePerMetric).toContainEqual({ name: 'packaging', value: 10 });
    });

    it.each(SECURITY_FIELDS)('returns the full-response value from /security/%s', async (field) => {
        const app = createApp();
        const [root, sub] = await Promise.all([request(app).get('/security'), request(app).get(`/security/${field}`)]);

        expect(sub.status).toBe(200);
        expect(Object.keys(sub.body)).toEqual([field]);
        expect(sub.body[field]).toEqual(root.body[field]);
    });

    it('preserves license filtering and ignores unknown parameters', async () => {
        const cases = [
            {
                query: { license: '9' },
                scorecardRows: sampleSecrData.filter((repo) => repo.license === 9).length,
            },
            {
                query: { license: ['0', '9'] },
                scorecardRows: sampleSecrData.filter((repo) => repo.license === 0 || repo.license === 9).length,
            },
            {
                query: { license: '10', ignored: 'does-not-filter' },
                scorecardRows: sampleSecrData.filter((repo) => repo.license === 10).length,
            },
        ];

        for (const testCase of cases) {
            const [root, sub] = await Promise.all([
                request(createApp()).get('/security').query(testCase.query),
                request(createApp()).get('/security/securityScorecardByRepo').query(testCase.query),
            ]);

            expect(root.status).toBe(200);
            expect(root.body.securityScorecardByRepo).toHaveLength(testCase.scorecardRows);
            expect(sub.body.securityScorecardByRepo).toEqual(root.body.securityScorecardByRepo);
        }
    });

    it('excludes -1 values when calculating metric averages', async () => {
        const res = await request(createApp()).get('/security/avgScorePerMetric');

        const packaging = res.body.avgScorePerMetric.find(
            (metric: { name: string; value: number }) => metric.name === 'packaging',
        );

        expect(packaging.value).toBe(10);
    });

    it('returns empty arrays when no security rows match', async () => {
        const query = { license: 'does-not-exist' };
        const root = await request(createApp()).get('/security').query(query);

        expect(root.status).toBe(200);
        expect(root.body).toEqual({ securityScorecardByRepo: [], avgScorePerMetric: [] });

        for (const field of SECURITY_FIELDS) {
            const res = await request(createApp()).get(`/security/${field}`).query(query);
            expect(res.body).toEqual({ [field]: [] });
        }
    });

    it('returns 404 for an unknown suffix', async () => {
        const res = await request(createApp()).get('/security/notAField');

        expect(res.status).toBe(404);
    });
});
