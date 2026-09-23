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
    securityScorecardByRepo: (rows: secrData[]) => rows,
    avgScorePerMetric: (rows: secrData[]) => makeAvgScorePerMetricArray(rows),
} satisfies { [K in keyof RespSecurity]: (rows: secrData[]) => RespSecurity[K] };

const endpoints = Object.keys(SUB_ENDPOINTS) as (keyof RespSecurity)[];

function makeResponse(rows: secrData[]): RespSecurity {
    return Object.fromEntries(endpoints.map((endpoint) => [endpoint, SUB_ENDPOINTS[endpoint](rows)])) as RespSecurity;
}

router.get(BASE_SECURITY, (req, res) => {
    const filtered = filterData(data, req.query, FILTERABLE_SECR_FIELDS);
    res.json(makeResponse(filtered));
});

for (const endpoint of endpoints) {
    router.get(`${BASE_SECURITY}/${endpoint}`, (req, res) => {
        const filtered = filterData(data, req.query, FILTERABLE_SECR_FIELDS);
        const value = SUB_ENDPOINTS[endpoint](filtered);
        res.json({ [endpoint]: value });
    });
}

export default router;
