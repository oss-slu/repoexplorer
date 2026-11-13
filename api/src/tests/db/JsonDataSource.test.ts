
import { JsonDataSource } from '../../db/JsonDataSource';

import sampleRepoData from '../../../data/sample/sampleRepoData.json';
import sampleSecrData from '../../../data/sample/sampleSecrData.json';
import sampleOrgsData from '../../../data/sample/sampleOrgsData.json';

describe('JsonDataSource', () => {
    const dataSource = new JsonDataSource();

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
