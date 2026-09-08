import { Router } from 'express';
import { BASE_IMPACT } from '../consts';
import type { Resp, RespImpact } from '../types/routes';
import type { appData } from '../types/appData';
import sampleData from '../../data/sample/sampleRepoData.json';
import { getSum, makeNumericDistributionArray, makeImpactIndicatorsArray } from '../utils/math';
import { filterData } from '../utils/filter';

const data = sampleData as appData[];
const router = Router();

// Create endpoint map: the string is the /destination and the function call gets the appropriate data
const SUB_ENDPOINTS = {
    totalStars: (data: appData[]) => getSum(data, 'stargazersCount'),
    totalForks: (data: appData[]) => getSum(data, 'forksCount'),
    totalDownloads: (data: appData[]) => getSum(data, 'releaseDownloads'),
    totalContributors: (data: appData[]) => getSum(data, 'contributorCount'),
    impactIndicatorsPerUniversity: (data: appData[]) => makeImpactIndicatorsArray(data),
    starsDistribution: (data: appData[]) => makeNumericDistributionArray(data, 'stargazersCount'),
    forksDistribution: (data: appData[]) => makeNumericDistributionArray(data, 'forksCount'),
    releaseDownloadsDistribution: (data: appData[]) => makeNumericDistributionArray(data, 'releaseDownloads'),
    contributorsDistribution: (data: appData[]) => makeNumericDistributionArray(data, 'contributorCount'),
} satisfies Partial<Record<keyof RespImpact, (data: appData[]) => Resp[string]>>;

// Register primary GET response: build and return full RespImpact object
router.get(BASE_IMPACT, (req, res) => {
    const filtered = filterData(data, req.query);
    const response: Partial<RespImpact> = {};

    for (const [endpoint, fn] of Object.entries(SUB_ENDPOINTS)) {
        const key = endpoint as keyof RespImpact;
        response[key] = fn(filtered) as RespImpact[keyof RespImpact];
    }
    res.json(response);
});

// Register sub GET responses for each field
// (e.g. /impact/totalStars returns only the return value of getUniqueCount(data))
for (const [endpoint, fn] of Object.entries(SUB_ENDPOINTS)) {
    router.get(`${BASE_IMPACT}/${endpoint}`, (req, res) => {
        const filtered = filterData(data, req.query);
        const value = fn(filtered) as RespImpact[keyof RespImpact];
        res.json({ [endpoint]: value } satisfies Partial<RespImpact>);
    });
}

export default router;
