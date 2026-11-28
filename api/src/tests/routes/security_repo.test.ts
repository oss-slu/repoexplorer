import { jest } from '@jest/globals';
import request from 'supertest';

type QueryResult = {
    rows: Record<string, unknown>[];
};

const queryMock = jest.fn<
    (text: string, params?: unknown[]) => Promise<QueryResult>
>();

jest.unstable_mockModule('../../db/connect', () => ({
    query: queryMock,
}));

const { createApp } = await import('../../app');
const { PostgresDataSource } = await import('../../db/dataSource');

const createPostgresApp = () =>
    createApp(undefined, new PostgresDataSource());

describe ('GET /security/securityScorecardByRepo pagination', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    it('returns the total repository count for repo filters', async () => {
        queryMock.mockResolvedValue({ rows: [{ totalCount: '42'}] });

        const response = await request(createApp(undefined, new PostgresDataSource()))
            .get('/security/securityScorecardByRepo/count')
            .query({ repoLicense: 'MIT' });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ totalCount: 42 });
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringMatching(
                /SELECT COUNT\(\*\) AS "totalCount"[\s\S]*FROM public\.security_parquet s[\s\S]*EXISTS[\s\S]*FROM public\.repositories_parquet r/,
            ),
            ['mit'],
        );
    });

    it('defaults to 500 rows starting at offset zero', async () => {
        queryMock.mockResolvedValue({ rows: [] });

        const response = await request(createPostgresApp()).get('/security/securityScorecardByRepo');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ securityScorecardByRepo: [] });
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringMatching(
                /FROM public\.security_parquet s[\s\S]*LIMIT \$1[\s\S]*OFFSET \$2/,
            ),
            [500,0],
        );
    });

    it('uses the requested limit and offset with the repo filter', async () => {
        queryMock.mockResolvedValue({ 
            rows: [
                {
                    html_url: 'https://github.com/example/repo',
                    total_score: 8,
                },
            ] ,
        });

        const response = await request(createPostgresApp())
            .get('/security/securityScorecardByRepo')
            .query({ repoLicense: 'MIT', limit: 25, offset: 50 });

        expect(response.status).toBe(200);
        expect(response.body.securityScorecardByRepo).toMatchObject([
            { 
                htmlUrl: 'https://github.com/example/repo',
                totalScore: 8,
             },
        ]);
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringMatching(
                /FROM public\.security_parquet s[\s\S]*EXISTS[\s\S]*ORDER BY s\.html_url[\s\S]*LIMIT \$2[\s\S]*OFFSET \$3/,
            ),
            ['mit', 25, 50],
        );
    });

    it.each([
        { limit: '0' },
        { limit: '1001' },
        { limit: '1.5' },
        { offset: '-1' },
    ])('rejects invalid pagination parameters: %o', async (params) => {
        const response = await request(createPostgresApp())
            .get('/security/securityScorecardByRepo')
            .query(params);

        expect(response.status).toBe(400);
        expect(queryMock).not.toHaveBeenCalled();
    });
});