import { Router } from 'express';
import { BASE_SUSTAINABILITY, FILTERABLE_REPO_FIELDS } from '../consts';
import type { repoData } from '../types/appData';
import type { respSustainability } from '../types/routes';
import type { AppDataSource } from '../types/AppDataSource';
import {
    getAvailableAvg,
    makeBusFactorDistributionArray,
    makeCommunityFilesByStarsArray,
    makeCommunityFilesByTypeArray,
    makeContributorCountDistributionArray,
    makeSustainabilityIndicatorsArray,
} from '../utils/math';
import { filterData } from '../utils/filter';

const SUB_ENDPOINTS = {
    avgContributors: (rows: repoData[]) => getAvailableAvg(rows, 'contributorCount'),
    avgBusFactor: (rows: repoData[]) => getAvailableAvg(rows, 'busFactor'),
    sustainabilityIndicatorsPerUniversity: (rows: repoData[]) => makeSustainabilityIndicatorsArray(rows),
    communityFiles: (rows: repoData[]) => makeCommunityFilesByTypeArray(rows),
    communityFilesByStars: (rows: repoData[]) => makeCommunityFilesByStarsArray(rows),
    busFactorDistribution: (rows: repoData[]) => makeBusFactorDistributionArray(rows),
    contributorCountDistribution: (rows: repoData[]) => makeContributorCountDistributionArray(rows),
} satisfies { [K in keyof respSustainability]: (rows: repoData[]) => respSustainability[K] };

const endpoints = Object.keys(SUB_ENDPOINTS) as (keyof respSustainability)[];

function makeResponse(rows: repoData[]): respSustainability {
    return Object.fromEntries(
        endpoints.map((endpoint) => [endpoint, SUB_ENDPOINTS[endpoint](rows)]),
    ) as respSustainability;
}


export function createSustainabilityRouter(dataSource: AppDataSource) {
    const router = Router();

    // Register primary GET response
    router.get(BASE_SUSTAINABILITY, async (req, res, next) => {
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
        router.get(`${BASE_SUSTAINABILITY}/${endpoint}`, async (req, res, next) => {
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