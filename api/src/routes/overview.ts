import { Router } from 'express';
import { BASE_OVERVIEW, FILTERABLE_REPO_FIELDS } from '../consts';
import type { RespOverview } from '../types/routes';
import type { repoData } from '../types/appData';
import type { AppDataSource } from '../types/AppDataSource';
import {
    getAvg,
    getCountFieldNotNull,
    getPercentFieldNotNull,
    getSum,
    makeCountsArray,
    makeFieldDistributionArray,
    makeFieldDistributionByArray,
    makeFieldsNotNullArray,
} from '../utils/math';
import { filterData } from '../utils/filter';

// Create endpoint map: the string is the /destination and the function call gets the appropriate data
const SUB_ENDPOINTS = {
    totalRepos: (rows: repoData[]) => rows.length,
    withLicense: (rows: repoData[]) => getCountFieldNotNull(rows, 'license'),
    percentWithLicense: (rows: repoData[]) => getPercentFieldNotNull(rows, 'license'),
    totalContributors: (rows: repoData[]) => getSum(rows, 'contributorCount'),
    avgBusFactor: (rows: repoData[]) => getAvg(rows, 'busFactor'),
    reposPerUniversity: (rows: repoData[]) => makeCountsArray(rows, 'university'),
    languageDistribution: (rows: repoData[]) => makeFieldDistributionArray(rows, 'language'),
    licenseDistribution: (rows: repoData[]) => makeFieldDistributionArray(rows, 'license'),
    typeDistribution: (rows: repoData[]) => makeFieldDistributionArray(rows, 'typePredictionGpt5Mini'),
    communityFilesPresence: (rows: repoData[]) =>
        makeFieldsNotNullArray(rows, [
            'issueTemplates',
            'securityPolicy',
            'codeOfConductFile',
            'pullRequestTemplate',
            'contributing',
            'license',
            'description',
            'readme',
        ]),
    languageDistributionByType: (rows: repoData[]) =>
        makeFieldDistributionByArray(rows, 'language', 'typePredictionGpt5Mini'),
    licenseDistributionByType: (rows: repoData[]) =>
        makeFieldDistributionByArray(rows, 'license', 'typePredictionGpt5Mini'),
} satisfies { [K in keyof RespOverview]: (rows: repoData[]) => RespOverview[K] };

const endpoints = Object.keys(SUB_ENDPOINTS) as (keyof RespOverview)[];

function makeResponse(rows: repoData[]): RespOverview {
    return Object.fromEntries(endpoints.map((endpoint) => [endpoint, SUB_ENDPOINTS[endpoint](rows)])) as RespOverview;
}


export function createOverviewRouter(dataSource: AppDataSource) {
    const router = Router();

    router.get(BASE_OVERVIEW, async (req, res, next) => {
        try {
            const data = await dataSource.getRepoData();
            const filtered = filterData(data, req.query, FILTERABLE_REPO_FIELDS);
            res.json(makeResponse(filtered));
        } catch (error) {
            next(error);
        }
    });

    for (const endpoint of endpoints) {
        router.get(`${BASE_OVERVIEW}/${endpoint}`, async (req, res, next) => {
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

    router.get(`${BASE_OVERVIEW}/repositories`, async (req, res, next) => {
        try {
            const data = await dataSource.getRepoData();
            const filtered = filterData(data, req.query, FILTERABLE_REPO_FIELDS);
            res.json(filtered);
        } catch (error) {
            next(error);
        }
    });

    return router;
}
