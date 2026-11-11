import { query } from './connect';
import type { AppDataSource } from '../types/AppDataSource';
import type { repoData, secrData, orgsData } from '../types/appData';

function toCamelCase(str: string): string {
    return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function mapRowToCamelCase<T>(row: any): T {
    const newObj: any = {};
    for (const key in row) {
        newObj[toCamelCase(key)] = row[key];
    }
    return newObj as T;
}

export class PostgresDataSource implements AppDataSource {
    
    async getRepoData(): Promise<repoData[]> {
        const result = await query<any>('SELECT * FROM repositories_parquet');
        return result.rows.map((row) => mapRowToCamelCase<repoData>(row));
    }

    async getSecrData(): Promise<secrData[]> {
        const result = await query<any>('SELECT * FROM security_parquet');
        return result.rows.map((row) => mapRowToCamelCase<secrData>(row));
    }

    async getOrgsData(): Promise<orgsData[]> {
        const result = await query<any>('SELECT * FROM organizations_parquet');
        return result.rows.map((row) => mapRowToCamelCase<orgsData>(row));
    }
}