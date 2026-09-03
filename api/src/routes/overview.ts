import { Router } from 'express';
import type { parquetData } from '../types/parquetData';
import { makeDistributionArray } from '../utils/math';
import sampleData from '../../data/sample/sampleRepoData.json';
import { BASE_OVERVIEW } from '../consts';

const router = Router();

const data = sampleData as parquetData[];

const distArrays: Record<string, keyof parquetData> = {
    'langdist': 'language',
    'licndist': 'license',
    'typedist': 'typePredictionGpt5Mini',
};

router.get(BASE_OVERVIEW, (_req, res) => {
    res.json({
        languageDistribution: makeDistributionArray(data, distArrays['langdist']),
        licenseDistribution: makeDistributionArray(data, distArrays['licndist']),
        typeDistribution: makeDistributionArray(data, distArrays['typedist']),
    });
});

Object.entries(distArrays).forEach(([endpoint, field]) => {
    router.get(`${BASE_OVERVIEW}/${endpoint}`, (_req, res) => {
        res.json(makeDistributionArray(data, field));
    });
});

export default router;