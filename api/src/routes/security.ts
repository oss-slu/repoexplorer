import { Router } from 'express';
import { BASE_SECURITY } from '../consts';
import type { RespSecurity } from '../types/routes';
import type { secrData } from '../types/appData';
import sampleData from '../../data/sample/sampleSecrData.json';
import { makeAvgScorePerMetricArray } from '../utils/math';

const data = sampleData as secrData[];
const router = Router();

const SUB_ENDPOINTS = {
    securityScorecardByRepo: (data: secrData[]) => data,
    avgScorePerMetric: (data: secrData[]) => makeAvgScorePerMetricArray(data),
} satisfies Partial<Record<keyof RespSecurity, (data: secrData[]) => RespSecurity[keyof RespSecurity]>>;

router.get(BASE_SECURITY, (_req, res) => {
    const response: RespSecurity = {
        securityScorecardByRepo: SUB_ENDPOINTS.securityScorecardByRepo(data),
        avgScorePerMetric: SUB_ENDPOINTS.avgScorePerMetric(data),
    };

    res.json(response);
});

for (const [endpoint, fn] of Object.entries(SUB_ENDPOINTS)) {
    router.get(`${BASE_SECURITY}/${endpoint}`, (_req, res) => {
        const value = fn(data) as RespSecurity[keyof RespSecurity];
        res.json({ [endpoint]: value } satisfies Partial<RespSecurity>);
    });
}

export default router;
