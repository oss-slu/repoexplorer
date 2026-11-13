
import type { AppDataSource } from '../types/AppDataSource';
import type { repoData, secrData, orgsData } from '../types/appData';

import sampleRepoData from '../../data/sample/sampleRepoData.json';
import sampleSecrData from '../../data/sample/sampleSecrData.json';
import sampleOrgsData from '../../data/sample/sampleOrgsData.json';

export class JsonDataSource implements AppDataSource {
    async getRepoData(): Promise<repoData[]> {
        return sampleRepoData as repoData[];
    }

    async getSecrData(): Promise<secrData[]> {
        return sampleSecrData as secrData[];
    }

    async getOrgsData(): Promise<orgsData[]> {
        return sampleOrgsData as orgsData[];
    }
}
