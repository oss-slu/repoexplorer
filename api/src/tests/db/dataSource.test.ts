import { jest } from '@jest/globals';
import sampleRepoData from '../../../data/sample/sampleRepoData.json';
import sampleSecrData from '../../../data/sample/sampleSecrData.json';
import sampleOrgsData from '../../../data/sample/sampleOrgsData.json';
import type { AppDataSource } from '../../types/AppDataSource';

jest.unstable_mockModule('../../db/connect', () => ({
    query: jest.fn(),
}));

describe('PostgresDataSource', () => {
    let dataSource: AppDataSource;
    let queryMock: ReturnType<typeof jest.fn>;

    beforeAll(async () => {

        jest.resetModules();

        const { PostgresDataSource } = await import('../../db/dataSource');
        const connect = await import('../../db/connect');
        
        dataSource = new PostgresDataSource();
        queryMock = connect.query as unknown as ReturnType<typeof jest.fn>;
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

describe('JsonDataSource', () => {
    let dataSource: AppDataSource;

    beforeAll(async () => {
        const { JsonDataSource } = await import('../../db/dataSource');
        dataSource = new JsonDataSource();
    });

    it('should return repository data from the sample JSON file', async () => {
        const result = await dataSource.getRepoData();
        expect(result).toEqual(sampleRepoData);
    });

    it('should return security data from the sample JSON file', async () => {
        const result = await dataSource.getSecrData();
        expect(result).toEqual(sampleSecrData);
    });

    it('should return organization data from the sample JSON file', async () => {
        const result = await dataSource.getOrgsData();
        expect(result).toEqual(sampleOrgsData);
    });
});