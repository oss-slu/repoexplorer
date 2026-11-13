import { jest } from '@jest/globals';

jest.unstable_mockModule('../../db/connect', () => ({
    query: jest.fn(),
}));

describe('PostgresDataSource', () => {
    let dataSource: any;
    let queryMock: any;

    beforeAll(async () => {
        const { PostgresDataSource } = await import('../../db/PostgresDataSource');
        const connect = await import('../../db/connect');
        
        dataSource = new PostgresDataSource();
        queryMock = connect.query;
    });

    beforeEach(() => {
        queryMock.mockClear();
    });

    it('should fetch and map repository data to camelCase', async () => {
        const mockDbRows = [{ id: 1, full_name: 'test/repo', stargazers_count: 50 }];
        queryMock.mockResolvedValue({ rows: mockDbRows });

        await dataSource.getRepoData();

        expect(queryMock).toHaveBeenCalledTimes(1);
        const sql = queryMock.mock.calls[0][0] as string;
        expect(sql).toMatch(/FROM repositories_parquet/);
    });

    it('should fetch and map security data to camelCase', async () => {
        const mockDbRows = [{ html_url: 'test/url', binary_artifacts: 1 }];
        queryMock.mockResolvedValue({ rows: mockDbRows });

        const result = await dataSource.getSecrData();

        expect(queryMock).toHaveBeenCalledWith('SELECT * FROM security_parquet');
        expect(result).toEqual([{ htmlUrl: 'test/url', binaryArtifacts: 1 }]);
    });

    it('should fetch and map organization data to camelCase', async () => {
        const mockDbRows = [{ login: 'test-org', created_at: '2026-01-01' }];
        queryMock.mockResolvedValue({ rows: mockDbRows });

        const result = await dataSource.getOrgsData();

        expect(queryMock).toHaveBeenCalledWith('SELECT * FROM organizations_parquet');
        expect(result).toEqual([{ login: 'test-org', createdAt: '2026-01-01' }]);
    });
});