import request from 'supertest';
import { createApp } from '../../app';

describe('GET /security', () => {
    it('returns successful response', async () => {
        const app = createApp();
        const res = await request(app).get('/security');

        expect(res.status).toBe(200);
    });

    it('returns all security fields', async () => {
        const app = createApp();
        const res = await request(app).get('/security');

        expect(res.body).toHaveProperty('securityScorecardByRepo');
        expect(res.body).toHaveProperty('avgScorePerMetric');
    });

    it('returns security scorecard by repository', async () => {
        const app = createApp();
        const res = await request(app).get('/security/securityScorecardByRepo');

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.securityScorecardByRepo)).toBe(true);
    });

    it('returns average score per security metric', async () => {
        const app = createApp();
        const res = await request(app).get('/security/avgScorePerMetric');

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.avgScorePerMetric)).toBe(true);
    });

    it('excludes -1 values when calculating metric averages', async () => {
        const app = createApp();
        const res = await request(app).get('/security/avgScorePerMetric');

        const packaging = res.body.avgScorePerMetric.find(
            (metric: { name: string; value: number }) => metric.name === 'packaging',
        );

        expect(packaging.value).toBe(10);
    });
});
