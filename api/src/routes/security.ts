import { Router } from 'express';
import { BASE_SECURITY, FILTERABLE_SECR_FIELDS } from '../consts';
import type { RespSecurity } from '../types/routes';
import type { secrData } from '../types/appData';
import sampleData from '../../data/sample/sampleSecrData.json';
import { makeAvgScorePerMetricArray } from '../utils/math';
import { filterData } from '../utils/filter';

const data = sampleData as secrData[];
const router = Router();

const SUB_ENDPOINTS = {
    securityScorecardByRepo: (data: secrData[]) => data,
    avgScorePerMetric: (data: secrData[]) => makeAvgScorePerMetricArray(data),
} satisfies Partial<Record<keyof RespSecurity, (data: secrData[]) => RespSecurity[keyof RespSecurity]>>;

router.get(BASE_SECURITY, (req, res) => {
    const filtered = filterData(data, req.query, FILTERABLE_SECR_FIELDS);

    res.json(
        Object.fromEntries(
            Object.entries(SUB_ENDPOINTS).map(([endpoint, fn]) => [
                endpoint,
                fn(filtered) as RespSecurity[keyof RespSecurity],
            ]),
        ),
    );
});

for (const [endpoint, fn] of Object.entries(SUB_ENDPOINTS)) {
    router.get(`${BASE_SECURITY}/${endpoint}`, (req, res) => {
        const filtered = filterData(data, req.query, FILTERABLE_SECR_FIELDS);

        res.json({
            [endpoint]: fn(filtered) as RespSecurity[keyof RespSecurity],
        });
    });
}

export default router;
