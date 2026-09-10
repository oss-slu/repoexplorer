import { Router } from 'express';
import { BASE_IMPACT, FILTERABLE_REPO_FIELDS } from '../consts';
import type { Resp, RespImpact } from '../types/routes';
import type { repoData } from '../types/appData';
import sampleData from '../../data/sample/sampleRepoData.json';
import { getSum, makeNumericDistributionArray, makeImpactIndicatorsArray } from '../utils/math';
import { filterData } from '../utils/filter';

const data = sampleData as repoData[];
const router = Router();

// Create endpoint map: the string is the /destination and the function call gets the appropriate data
const SUB_ENDPOINTS = {
    totalStars: (data: repoData[]) => getSum(data, 'stargazersCount'),
    totalForks: (data: repoData[]) => getSum(data, 'forksCount'),
    totalDownloads: (data: repoData[]) => getSum(data, 'releaseDownloads'),
    totalContributors: (data: repoData[]) => getSum(data, 'contributorCount'),
    impactIndicatorsPerUniversity: (data: repoData[]) => makeImpactIndicatorsArray(data),
    starsDistribution: (data: repoData[]) => makeNumericDistributionArray(data, 'stargazersCount'),
    forksDistribution: (data: repoData[]) => makeNumericDistributionArray(data, 'forksCount'),
    releaseDownloadsDistribution: (data: repoData[]) => makeNumericDistributionArray(data, 'releaseDownloads'),
    contributorsDistribution: (data: repoData[]) => makeNumericDistributionArray(data, 'contributorCount'),
} satisfies Partial<Record<keyof RespImpact, (data: repoData[]) => Resp[string]>>;

// Register primary GET response: build and return full RespImpact object
router.get(BASE_IMPACT, (req, res) => {
    const filtered = filterData(data, req.query, FILTERABLE_REPO_FIELDS);
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
        const filtered = filterData(data, req.query, FILTERABLE_REPO_FIELDS);
        const value = fn(filtered) as RespImpact[keyof RespImpact];
        res.json({ [endpoint]: value } satisfies Partial<RespImpact>);
    });
}

export default router;
