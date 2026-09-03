import { Router } from 'express';
import { BASE_OVERVIEW } from '../consts';
import { getAvg, getPercentFieldNotNull, getSum, getUniqueCount, makeCountsArray, makeDistributionArray, makeFieldsNotNullArray } from '../utils/math';
import sampleData from '../../data/sample/sampleRepoData.json';
import type { parquetData } from '../types/parquetData';
import type { RespOverview } from '../types/routes';

const router = Router();

const data = sampleData as parquetData[];

const distArrays: Record<string, keyof parquetData> = {
    'langdist': 'language',
    'licndist': 'license',
    'typedist': 'typePredictionGpt5Mini',
};

router.get(BASE_OVERVIEW, (_req, res) => {
    res.json({
        totalRepos: getUniqueCount(data),
        percentWithLicense: getPercentFieldNotNull(data, 'license'),
        totalContributors: getSum(data, 'contributorCount'),
        avgBusFactor: getAvg(data, 'busFactor'),
        reposPerUniversity: makeCountsArray(data, 'university'),
        languageDistribution: makeDistributionArray(data, distArrays['langdist']),
        licenseDistribution: makeDistributionArray(data, distArrays['licndist']),
        typeDistribution: makeDistributionArray(data, distArrays['typedist']),
        communityFilesPresence: makeFieldsNotNullArray(data, [
            'issueTemplates', 'securityPolicy', 'codeOfConductFile',
            'pullRequestTemplate', 'contributing', 'license', 'description', 'readme',
        ]),
    } as RespOverview);
});

Object.entries(distArrays).forEach(([endpoint, field]) => {
    router.get(`${BASE_OVERVIEW}/${endpoint}`, (_req, res) => {
        res.json(makeDistributionArray(data, field) as RespOverview);
    });
});

export default router;