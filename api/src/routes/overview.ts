import { Router } from 'express';
import { BASE_OVERVIEW } from '../consts';
import type { Resp, RespOverview } from '../types/routes';
import type { parquetData } from '../types/parquetData';
import sampleData from '../../data/sample/sampleRepoData.json';
import {
    getAvg, getCountFieldNotNull, getPercentFieldNotNull, getSum, makeCountsArray,
    makeFieldDistributionArray, makeFieldDistributionByArray, makeFieldsNotNullArray
} from '../utils/math';

const data = sampleData as parquetData[];
const router = Router();

// Create endpoint map: the string is the /destination and the function call gets the appropriate data
const SUB_ENDPOINTS = {
    'totalRepos': () => data.length,
    'withLicense': () => getCountFieldNotNull(data, 'license'),
    'percentWithLicense': () => getPercentFieldNotNull(data, 'license') ,
    'totalContributors': () => getSum(data, 'contributorCount'),
    'avgBusFactor': () => getAvg(data, 'busFactor'),
    'reposPerUniversity': () => makeCountsArray(data, 'university'),
    'languageDistribution': () => makeFieldDistributionArray(data, 'language'),
    'licenseDistribution': () => makeFieldDistributionArray(data, 'license'),
    'typeDistribution': () => makeFieldDistributionArray(data, 'typePredictionGpt5Mini'),
    'communityFilesPresence': () => makeFieldsNotNullArray(data, [
        'issueTemplates', 'securityPolicy', 'codeOfConductFile',
        'pullRequestTemplate', 'contributing', 'license', 'description', 'readme',
    ]),
    'languageDistributionByType': () => makeFieldDistributionByArray(data, 'language', 'typePredictionGpt5Mini'),
    'licenseDistributionByType': () => makeFieldDistributionByArray(data, 'license', 'typePredictionGpt5Mini'),
} satisfies Partial<Record<keyof RespOverview, () => Resp[string]>>;

// Register primary GET response: build and return full RespOverview object
router.get(BASE_OVERVIEW, (_req, res) => {
    res.json(Object.fromEntries(
        Object.entries(SUB_ENDPOINTS).map(([endpoint, fn]) => [endpoint, fn() as RespOverview]))
    );
});

// Register sub GET responses for each field 
// (e.g. /overview/totalRepos returns only the return value of getUniqueCount(data))
for (const [endpoint, fn] of Object.entries(SUB_ENDPOINTS)) {
    router.get(`${BASE_OVERVIEW}/${endpoint}`, (_req, res) => res.json({
        [endpoint]: fn() as RespOverview
    }));
}

export default router;