import type { repoData, secrData, orgsData } from './appData';

export interface AppDataSource {
    getRepoData(): Promise<repoData[]>;
    getSecrData(): Promise<secrData[]>;
    getOrgsData(): Promise<orgsData[]>;
}