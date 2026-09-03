import { Router } from 'express';
import { BASE_OVERVIEW } from '../consts';
import type { RespOverview } from '../types/routes';
import type { parquetData } from '../types/parquetData';
import sampleData from '../../data/sample/sampleRepoData.json';
import {
    getAvg, getPercentFieldNotNull, getSum, getUniqueCount, makeCountsArray, makeDistributionArray,
    makeDistributionByArray, makeFieldsNotNullArray
} from '../utils/math';

const data = sampleData as parquetData[];

// initialize express router
const router = Router();

// add a function call to get the data for each field in the response type
const FETCHERS: Record<keyof RespOverview, Function> = {
    'totalRepos': () => getUniqueCount(data),
    'percentWithLicense': () => getPercentFieldNotNull(data, 'license'),
    'totalContributors': () => getSum(data, 'contributorCount'),
    'avgBusFactor': () => getAvg(data, 'busFactor'),
    'reposPerUniversity': () => makeCountsArray(data, 'university'),
    'languageDistribution': () => makeDistributionArray(data, 'language'),
    'licenseDistribution': () => makeDistributionArray(data, 'license'),
    'typeDistribution': () => makeDistributionArray(data, 'typePredictionGpt5Mini'),
    'communityFilesPresence': () => makeFieldsNotNullArray(data, [
        'issueTemplates', 'securityPolicy', 'codeOfConductFile',
        'pullRequestTemplate', 'contributing', 'license', 'description', 'readme',
    ]),
    'languageDistributionByType': () => makeDistributionByArray(data, 'language', 'typePredictionGpt5Mini'),
    'licenseDistributionByType': () => makeDistributionByArray(data, 'license', 'typePredictionGpt5Mini'),
};

// Register primary GET response: build and return full RespOverview object
router.get(BASE_OVERVIEW, (_req, res) => {
    res.json(Object.fromEntries(Object.entries(FETCHERS).map(([endpoint, fn]) => [endpoint, fn() as RespOverview])));
});

// Register sub GET responses for each field 
// (e.g. /overview/totalRepos returns only the return value of getUniqueCount(data))
for (const [endpoint, fn] of Object.entries(FETCHERS)) {
    router.get(`${BASE_OVERVIEW}/${endpoint}`, (_req, res) => res.json({
        [endpoint]: fn() as RespOverview
    }));
}

export default router;