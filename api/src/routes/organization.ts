import { Router } from 'express';
import { BASE_ORGANIZATION, FILTERABLE_ORGS_FIELDS } from '../consts';
import type { RespOrganization } from '../types/routes';
import type { orgsData } from '../types/appData';
import sampleOrgsData from '../../data/sample/sampleOrgsData.json';
import {
    getPercentFieldNotNull,
    makeCountsArray,
    makeDateDistributionArray,
    makeProfileCompleteDistributionArray,
} from '../utils/math';
import { filterData } from '../utils/filter';

const data = sampleOrgsData as orgsData[];
const router = Router();

// Create endpoint map: the string is the /destination and the function call gets the appropriate data
const SUB_ENDPOINTS = {
    totalOrganizations: (rows: orgsData[]) => rows.length,
    percentOrganizationsURL: (rows: orgsData[]) => getPercentFieldNotNull(rows, 'url'),
    percentOrganizationsDescription: (rows: orgsData[]) => getPercentFieldNotNull(rows, 'description'),
    percentOrganizationsEmail: (rows: orgsData[]) => getPercentFieldNotNull(rows, 'email'),
    orgsPerUniversity: (rows: orgsData[]) => makeCountsArray(rows, 'university'),
    orgsCreatedPerYear: (rows: orgsData[]) => makeDateDistributionArray(rows, 'createdAt'),
    profileCompleteness: (rows: orgsData[]) => makeProfileCompleteDistributionArray(rows),
} satisfies { [K in keyof RespOrganization]: (rows: orgsData[]) => RespOrganization[K] };

const endpoints = Object.keys(SUB_ENDPOINTS) as (keyof RespOrganization)[];

function makeResponse(rows: orgsData[]): RespOrganization {
    return Object.fromEntries(
        endpoints.map((endpoint) => [endpoint, SUB_ENDPOINTS[endpoint](rows)]),
    ) as RespOrganization;
}

// Register primary GET response: build and return full RespOrganization object
router.get(BASE_ORGANIZATION, (req, res) => {
    const filtered = filterData(data, req.query, FILTERABLE_ORGS_FIELDS);
    res.json(makeResponse(filtered));
});

// Register sub GET responses for each field
// (e.g. /ORGANIZATION/totalOrganizations returns only the return value of getUniqueCount(data))
for (const endpoint of endpoints) {
    router.get(`${BASE_ORGANIZATION}/${endpoint}`, (req, res) => {
        const filtered = filterData(data, req.query, FILTERABLE_ORGS_FIELDS);
        const value = SUB_ENDPOINTS[endpoint](filtered);
        res.json({ [endpoint]: value });
    });
}

export default router;
