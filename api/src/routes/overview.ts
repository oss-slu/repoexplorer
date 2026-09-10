import { Router } from 'express';
import { BASE_OVERVIEW, FILTERABLE_REPO_FIELDS } from '../consts';
import type { Resp, RespOverview } from '../types/routes';
import type { appData } from '../types/appData';
import sampleData from '../../data/sample/sampleRepoData.json';
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

const data = sampleData as appData[];
const router = Router();

// Create endpoint map: the string is the /destination and the function call gets the appropriate data
const SUB_ENDPOINTS = {
    totalRepos: (data: appData[]) => data.length,
    withLicense: (data: appData[]) => getCountFieldNotNull(data, 'license'),
    percentWithLicense: (data: appData[]) => getPercentFieldNotNull(data, 'license'),
    totalContributors: (data: appData[]) => getSum(data, 'contributorCount'),
    avgBusFactor: (data: appData[]) => getAvg(data, 'busFactor'),
    reposPerUniversity: (data: appData[]) => makeCountsArray(data, 'university'),
    languageDistribution: (data: appData[]) => makeFieldDistributionArray(data, 'language'),
    licenseDistribution: (data: appData[]) => makeFieldDistributionArray(data, 'license'),
    typeDistribution: (data: appData[]) => makeFieldDistributionArray(data, 'typePredictionGpt5Mini'),
    communityFilesPresence: (data: appData[]) =>
        makeFieldsNotNullArray(data, [
            'issueTemplates',
            'securityPolicy',
            'codeOfConductFile',
            'pullRequestTemplate',
            'contributing',
            'license',
            'description',
            'readme',
        ]),
    languageDistributionByType: (data: appData[]) =>
        makeFieldDistributionByArray(data, 'language', 'typePredictionGpt5Mini'),
    licenseDistributionByType: (data: appData[]) =>
        makeFieldDistributionByArray(data, 'license', 'typePredictionGpt5Mini'),
} satisfies Partial<Record<keyof RespOverview, (data: appData[]) => Resp[string]>>;

// Register primary GET response: build and return full RespOverview object
router.get(BASE_OVERVIEW, (req, res) => {
    const filtered = filterData(data, req.query, FILTERABLE_REPO_FIELDS);
    res.json(
        Object.fromEntries(
            Object.entries(SUB_ENDPOINTS).map(([endpoint, fn]) => [endpoint, fn(filtered) as RespOverview]),
        ),
    );
});

// Register sub GET responses for each field
// (e.g. /overview/totalRepos returns only the return value of getUniqueCount(data))
for (const [endpoint, fn] of Object.entries(SUB_ENDPOINTS)) {
    router.get(`${BASE_OVERVIEW}/${endpoint}`, (req, res) => {
        const filtered = filterData(data, req.query, FILTERABLE_REPO_FIELDS);
        res.json({ [endpoint]: fn(filtered) as RespOverview });
    });
}

export default router;
