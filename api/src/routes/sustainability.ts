import { Router } from 'express';
import { BASE_SUSTAINABILITY, FILTERABLE_REPO_FIELDS } from '../consts';
import type { repoData } from '../types/appData';
import type { respSustainability } from '../types/routes';
import sampleData from '../../data/sample/sampleRepoData.json';
import {
    getAvailableAvg,
    makeBusFactorDistributionArray,
    makeCommunityFilesByStarsArray,
    makeCommunityFilesByTypeArray,
    makeContributorCountDistributionArray,
    makeSustainabilityIndicatorsArray,
} from '../utils/math';
import { filterData } from '../utils/filter';

const data = sampleData as repoData[];
const router = Router();

const SUB_ENDPOINTS = {
    sustainabilityIndicatorsPerUniversity: (rows: repoData[]) => makeSustainabilityIndicatorsArray(rows),
    avgContributors: (rows: repoData[]) => getAvailableAvg(rows, 'contributorCount'),
    avgBusFactor: (rows: repoData[]) => getAvailableAvg(rows, 'busFactor'),
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

router.get(BASE_SUSTAINABILITY, (req, res) => {
    const filtered = filterData(data, req.query, FILTERABLE_REPO_FIELDS);
    res.json(makeResponse(filtered));
});

for (const endpoint of endpoints) {
    router.get(`${BASE_SUSTAINABILITY}/${endpoint}`, (req, res) => {
        const filtered = filterData(data, req.query, FILTERABLE_REPO_FIELDS);
        const value = SUB_ENDPOINTS[endpoint](filtered);
        res.json({ [endpoint]: value });
    });
}

export default router;
