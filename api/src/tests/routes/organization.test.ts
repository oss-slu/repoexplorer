import request from 'supertest';
import { createApp } from '../../app';

const ORGANIZATION_FIELDS = [
    'totalOrganizations',
    'percentOrganizationsURL',
    'percentOrganizationsDescription',
    'percentOrganizationsEmail',
    'orgsPerUniversity',
    'orgsCreatedPerYear',
    'profileCompleteness',
] as const;
/*
{"totalOrganizations":100,"percentOrganizationsURL":55.00000000000001,"percentOrganizationsDescription":76,"percentOrganizationsEmail":35,"orgsPerUniversity":[{"name":"GWU","value":100}],"orgsCreatedPerYear":[{"name":"2008","value":0},{"name":"2009","value":0},{"name":"2010","value":0},{"name":"2011","value":3},{"name":"2012","value":2},{"name":"2013","value":5},{"name":"2014","value":6},{"name":"2015","value":13},{"name":"2016","value":12},{"name":"2017","value":4},{"name":"2018","value":8},{"name":"2019","value":9},{"name":"2020","value":11},{"name":"2021","value":5},{"name":"2022","value":7},{"name":"2023","value":5},{"name":"2024","value":4},{"name":"2025","value":5},{"name":"2026","value":1}],
*/
describe('GET /organization', () => {
    it('returns exactly the seven documented fields and expected row shapes', async () => {
        const res = await request(createApp()).get('/organization');

        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual([...ORGANIZATION_FIELDS].sort());
        expect(res.body.totalOrganizations).toBeCloseTo(100);
        expect(res.body.percentOrganizationsURL).toBeCloseTo(55.00000000000001);
        expect(res.body.percentOrganizationsDescription).toBeCloseTo(76);
        expect(res.body.percentOrganizationsEmail).toBeCloseTo(35);
        expect(res.body.orgsPerUniversity[0]).toEqual(
            expect.objectContaining({
                name: expect.any(String),
                value: expect.any(Number),
            }),
        );
        expect(res.body.orgsCreatedPerYear[0]).toEqual(
            expect.objectContaining({
                name: expect.any(String),
                value: expect.any(Number),
            }),
        );
        expect(res.body.profileCompleteness[0]).toEqual(
            expect.objectContaining({
                name: expect.any(String),
                value: expect.any(Number),
            }),
        );
    });

    it.each(ORGANIZATION_FIELDS)('returns the full-response value from /organization/%s', async (field) => {
        const app = createApp();
        const [root, sub] = await Promise.all([
            request(app).get('/organization'),
            request(app).get(`/organization/${field}`),
        ]);

        expect(sub.status).toBe(200);
        expect(Object.keys(sub.body)).toEqual([field]);
        expect(sub.body[field]).toEqual(root.body[field]);
    });

    it('applies each filter case-insensitively and combines filters with AND/OR semantics', async () => {
        const app = createApp();
        const cases = [
            { query: { university: 'gwu' }, expected: 100 },
            { query: { university: 'GWU' }, expected: 100 },
            { query: { university: 'does-not-exist' }, expected: 0 },
        ];

        for (const testCase of cases) {
            const [root, sub] = await Promise.all([
                request(app).get('/organization').query(testCase.query),
                request(app).get('/organization/totalOrganizations').query(testCase.query),
            ]);

            expect(root.status).toBe(200);
            expect(root.body.totalOrganizations).toBeCloseTo(testCase.expected);
            expect(sub.body).toEqual({ totalOrganizations: root.body.totalOrganizations });
        }
    });

    it('returns zero scalars and empty arrays when no repositories match', async () => {
        const app = createApp();
        const root = await request(app).get('/organization').query({ university: 'does-not-exist' });
        const expected = {
            totalOrganizations: 0,
            percentOrganizationsURL: 0,
            percentOrganizationsDescription: 0,
            percentOrganizationsEmail: 0,
            orgsPerUniversity: [],
            orgsCreatedPerYear: [
                { name: '2008', value: 0 },
                { name: '2009', value: 0 },
                { name: '2010', value: 0 },
                { name: '2011', value: 0 },
                { name: '2012', value: 0 },
                { name: '2013', value: 0 },
                { name: '2014', value: 0 },
                { name: '2015', value: 0 },
                { name: '2016', value: 0 },
                { name: '2017', value: 0 },
                { name: '2018', value: 0 },
                { name: '2019', value: 0 },
                { name: '2020', value: 0 },
                { name: '2021', value: 0 },
                { name: '2022', value: 0 },
                { name: '2023', value: 0 },
                { name: '2024', value: 0 },
                { name: '2025', value: 0 },
                { name: '2026', value: 0 },
            ],
            profileCompleteness: [
                { name: 'url', value: 0 },
                { name: 'location', value: 0 },
                { name: 'description', value: 0 },
                { name: 'email', value: 0 },
                { name: 'company', value: 0 },
            ],
        };

        expect(root.status).toBe(200);
        expect(root.body).toEqual(expected);

        for (const field of ORGANIZATION_FIELDS) {
            const res = await request(app).get(`/organization/${field}`).query({ university: 'does-not-exist' });
            expect(res.body).toEqual({ [field]: expected[field] });
        }
    });

    it('returns 404 for an unknown suffix', async () => {
        const res = await request(createApp()).get('/organization/notAField');

        expect(res.status).toBe(404);
    });
});
