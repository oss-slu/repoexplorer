import { Router } from 'express';
import { BASE_OVERVIEW } from '../consts';
import type { Resp, RespOverview } from '../types/routes';
import type { parquetData } from '../types/parquetData';
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

const data = sampleData as parquetData[];
const router = Router();

// Create endpoint map: the string is the /destination and the function call gets the appropriate data
const SUB_ENDPOINTS = {
    totalRepos: (data: parquetData[]) => data.length,
    withLicense: (data: parquetData[]) => getCountFieldNotNull(data, 'license'),
    percentWithLicense: (data: parquetData[]) => getPercentFieldNotNull(data, 'license'),
    totalContributors: (data: parquetData[]) => getSum(data, 'contributorCount'),
    avgBusFactor: (data: parquetData[]) => getAvg(data, 'busFactor'),
    reposPerUniversity: (data: parquetData[]) => makeCountsArray(data, 'university'),
    languageDistribution: (data: parquetData[]) => makeFieldDistributionArray(data, 'language'),
    licenseDistribution: (data: parquetData[]) => makeFieldDistributionArray(data, 'license'),
    typeDistribution: (data: parquetData[]) => makeFieldDistributionArray(data, 'typePredictionGpt5Mini'),
    communityFilesPresence: (data: parquetData[]) =>
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
    languageDistributionByType: (data: parquetData[]) =>
        makeFieldDistributionByArray(data, 'language', 'typePredictionGpt5Mini'),
    licenseDistributionByType: (data: parquetData[]) =>
        makeFieldDistributionByArray(data, 'license', 'typePredictionGpt5Mini'),
} satisfies Partial<Record<keyof RespOverview, (data: parquetData[]) => Resp[string]>>;

// Register primary GET response: build and return full RespOverview object
router.get(BASE_OVERVIEW, (req, res) => {
    const filtered = filterData(data, req.query)
    res.json(
        Object.fromEntries(Object.entries(SUB_ENDPOINTS).map(
            ([endpoint, fn]) => [endpoint, fn(filtered) as RespOverview]
        )),
    );
});

// Register sub GET responses for each field
// (e.g. /overview/totalRepos returns only the return value of getUniqueCount(data))
for (const [endpoint, fn] of Object.entries(SUB_ENDPOINTS)) {
    router.get(`${BASE_OVERVIEW}/${endpoint}`, (req, res) => {
        const filtered = filterData(data, req.query);
        res.json({ [endpoint]: fn(filtered) as RespOverview });
    });
}

export default router;
