import { query } from './connect';
import type { AppDataSource } from '../types/AppDataSource';
import type { repoData, secrData, orgsData } from '../types/appData';
import { toCamel } from '../utils/strings';
import sampleRepoData from '../../data/sample/sampleRepoData.json';
import sampleSecrData from '../../data/sample/sampleSecrData.json';
import sampleOrgsData from '../../data/sample/sampleOrgsData.json';

function mapRowToCamelCase<T>(row: Record<string, unknown>): T {
    const newObj: Record<string, unknown> = {};
    for (const key in row) {
        const camelKey = toCamel(key);
        let value = row[key];
        
        if (typeof value === 'string' && /^-?\d+$/.test(value)) {
            const parsedNum = Number(value);

            if (Number.isSafeInteger(parsedNum)) {
                value = parsedNum;
            }
        }

        newObj[camelKey] = value;
    }
    return newObj as T;
}

const REPOS_LIMIT = 10_000;

export class PostgresDataSource implements AppDataSource {
    async getRepoData(): Promise<repoData[]> {
        const result = await query<Record<string, unknown>>(`
            SELECT * FROM repositories_parquet
            WHERE owner IN ('oss-slu', 'UC_OSPO_Network')
            UNION (
                SELECT * FROM repositories_parquet
                WHERE owner NOT IN ('oss-slu', 'UC_OSPO_Network')
                ORDER BY stargazers_count DESC LIMIT ${REPOS_LIMIT}
            )
        `);
        
        return result.rows.map((row) => mapRowToCamelCase<repoData>(row));
    }

    async getSecrData(): Promise<secrData[]> {
        const result = await query<Record<string, unknown>>('SELECT * FROM security_parquet');
        return result.rows.map((row) => mapRowToCamelCase<secrData>(row));
    }

    async getOrgsData(): Promise<orgsData[]> {
        const result = await query<Record<string, unknown>>('SELECT * FROM organizations_parquet');
        return result.rows.map((row) => mapRowToCamelCase<orgsData>(row));
    }
}

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