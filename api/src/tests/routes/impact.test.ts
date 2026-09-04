import request from 'supertest';
import { createApp } from '../../app';

describe('GET /impact', () => {

    it('returns successful response', async () => {
        const app = createApp();
        const res = await request(app).get('/impact');

        expect(res.status).toBe(200);
    });


    it('returns all impact fields', async () => {
        const app = createApp();
        const res = await request(app).get('/impact');

        expect(res.body).toHaveProperty('impactIndicatorsPerUniversity');
        expect(res.body).toHaveProperty('totalStars');
        expect(res.body).toHaveProperty('totalForks');
        expect(res.body).toHaveProperty('totalDownloads');
        expect(res.body).toHaveProperty('totalContributors');
        expect(res.body).toHaveProperty('starsDistribution');
        expect(res.body).toHaveProperty('forksDistribution');
        expect(res.body).toHaveProperty('releaseDownloadsDistribution');
        expect(res.body).toHaveProperty('contributorsDistribution');
    });

    it('returns university impact indicators', async () => {
        const app = createApp();
        const res = await request(app).get('/impact/impactIndicatorsPerUniversity');

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.impactIndicatorsPerUniversity)).toBe(true);
    });

    it('returns total stars from specific endpt', async () => {
        const app = createApp();
        const res = await request(app).get('/impact/totalStars');

        expect(res.status).toBe(200);
        expect(typeof res.body.totalStars).toBe('number');
    });

    it('returns total forks from specific endpt', async () => {
        const app = createApp();
        const res = await request(app).get('/impact/totalForks');

        expect(res.status).toBe(200);
        expect(typeof res.body.totalForks).toBe('number');
    });

    it('returns total downloads from specific endpt', async () => {
        const app = createApp();
        const res = await request(app).get('/impact/totalDownloads');

        expect(res.status).toBe(200);
        expect(typeof res.body.totalDownloads).toBe('number');
    });

    it('returns total contributors from specific endpt', async () => {
        const app = createApp();
        const res = await request(app).get('/impact/totalContributors');

        expect(res.status).toBe(200);
        expect(typeof res.body.totalContributors).toBe('number');
    });

    it('returns stars distribution', async () => {
        const app = createApp();
        const res = await request(app).get('/impact/starsDistribution');

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.starsDistribution)).toBe(true);
    });

    it('returns forks distribution', async () => {
        const app = createApp();
        const res = await request(app).get('/impact/forksDistribution');

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.forksDistribution)).toBe(true);
    });

    it('returns release downloads distribution', async () => {
        const app = createApp();
        const res = await request(app).get('/impact/releaseDownloadsDistribution');

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.releaseDownloadsDistribution)).toBe(true);
    });

    it('returns contributors distribution', async () => {
        const app = createApp();
        const res = await request(app).get('/impact/contributorsDistribution');

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.contributorsDistribution)).toBe(true);
    });

});
