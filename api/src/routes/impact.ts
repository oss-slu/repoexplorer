import { Router } from 'express';
import { BASE_IMPACT, FILTERABLE_REPO_FIELDS } from '../consts';
import type { RespImpact } from '../types/routes';
import type { repoData } from '../types/appData';
import type { AppDataSource } from '../types/AppDataSource';
import { getSum, makeNumericDistributionArray, makeImpactIndicatorsArray } from '../utils/math';
import { filterData } from '../utils/filter';

// Create endpoint map: the string is the /destination and the function call gets the appropriate data
const SUB_ENDPOINTS = {
    totalStars: (rows: repoData[]) => getSum(rows, 'stargazersCount'),
    totalForks: (rows: repoData[]) => getSum(rows, 'forksCount'),
    totalDownloads: (rows: repoData[]) => getSum(rows, 'releaseDownloads'),
    totalContributors: (rows: repoData[]) => getSum(rows, 'contributorCount'),
    impactIndicatorsPerUniversity: (rows: repoData[]) => makeImpactIndicatorsArray(rows),
    starsDistribution: (rows: repoData[]) => makeNumericDistributionArray(rows, 'stargazersCount'),
    forksDistribution: (rows: repoData[]) => makeNumericDistributionArray(rows, 'forksCount'),
    releaseDownloadsDistribution: (rows: repoData[]) => makeNumericDistributionArray(rows, 'releaseDownloads'),
    contributorsDistribution: (rows: repoData[]) => makeNumericDistributionArray(rows, 'contributorCount'),
} satisfies { [K in keyof RespImpact]: (rows: repoData[]) => RespImpact[K] };

const endpoints = Object.keys(SUB_ENDPOINTS) as (keyof RespImpact)[];

function makeResponse(rows: repoData[]): RespImpact {
    return Object.fromEntries(
        endpoints.map((endpoint) => [endpoint, SUB_ENDPOINTS[endpoint](rows)]),
    ) as unknown as RespImpact;
}


export function createImpactRouter(dataSource: AppDataSource) {
    const router = Router();

    // Register primary GET response
    router.get(BASE_IMPACT, async (req, res, next) => {
        try {
            const data = await dataSource.getRepoData();
            const filtered = filterData(data, req.query, FILTERABLE_REPO_FIELDS);
            res.json(makeResponse(filtered));
        } catch (error) {
            next(error);
        }
    });

    // Register sub GET responses
    for (const endpoint of endpoints) {
        router.get(`${BASE_IMPACT}/${endpoint}`, async (req, res, next) => {
            try {
                const data = await dataSource.getRepoData();
                const filtered = filterData(data, req.query, FILTERABLE_REPO_FIELDS);
                const value = SUB_ENDPOINTS[endpoint](filtered);
                res.json({ [endpoint]: value });
            } catch (error) {
                next(error);
            }
        });
    }

    return router;
}
