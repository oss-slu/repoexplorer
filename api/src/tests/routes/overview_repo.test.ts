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

const{  createApp } = await import('../../app');

describe ('GET /overview/repositories', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    it('defaults to 500 rows and queries the parquet repository table', async () => {
        queryMock.mockResolvedValue({ rows: [] });

        const response = await request(createApp()).get('/overview/repositories');

        expect(response.status).toBe(200);
        expect(response.body).toEqual([]);
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringMatching(
                /FROM public\.repositories_parquet[\s\S]*LIMIT \$1 OFFSET \$2/,
            ),
            [500,0],
        );
    });

    it('uses the requested limit and offset', async () => {
        queryMock.mockResolvedValue({ rows: [{ id: 123 }] });

        const response = await request(createApp())
            .get('/overview/repositories')
            .query({ limit: 25, offset: 50 });

        expect(response.status).toBe(200);
        expect(response.body).toEqual([{ id: 123 }]);
        expect(queryMock).toHaveBeenCalledWith(
            expect.any(String),
            [25, 50],
        );
    });

    it.each([
        { limit: '0' },
        { limit: '1001' },
        { limit: '1.5' },
        { offset: '-1' },
    ])('rejects invalid pagination parameters: %o', async (params) => {
        const response = await request(createApp())
            .get('/overview/repositories')
            .query(params);

        expect(response.status).toBe(400);
        expect(queryMock).not.toHaveBeenCalled();
    });
});