import { Router } from 'express';
import { BASE_ORGANIZATION, FILTERABLE_ORGS_FIELDS } from '../consts';
import type { RespOrganization } from '../types/routes';
import type { orgsData } from '../types/appData';
import type { AppDataSource } from '../types/AppDataSource';
import {
    getPercentFieldNotNull,
    makeCountsArray,
    makeDateDistributionArray,
    makeProfileCompleteDistributionArray,
} from '../utils/math';
import { filterData } from '../utils/filter';

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


export function createOrganizationRouter(dataSource: AppDataSource) {
    const router = Router();

    // Register primary GET response
    router.get(BASE_ORGANIZATION, async (req, res, next) => {
        try {
            const data = await dataSource.getOrgsData();
            const filtered = filterData(data, req.query, FILTERABLE_ORGS_FIELDS);
            res.json(makeResponse(filtered));
        } catch (error) {
            next(error);
        }
    });

    // Register sub GET responses
    for (const endpoint of endpoints) {
        router.get(`${BASE_ORGANIZATION}/${endpoint}`, async (req, res, next) => {
            try {
                const data = await dataSource.getOrgsData();
                const filtered = filterData(data, req.query, FILTERABLE_ORGS_FIELDS);
                const value = SUB_ENDPOINTS[endpoint](filtered);
                res.json({ [endpoint]: value });
            } catch (error) {
                next(error);
            }
        });
    }

    // Register organizations table endpoint
    router.get(`${BASE_ORGANIZATION}/organizations`, async (req, res, next) => {
        try {
            const data = await dataSource.getOrgsData();
            const filtered = filterData(data, req.query, FILTERABLE_ORGS_FIELDS);
            res.json(filtered);
        } catch (error) {
            next(error);
        }
    });

    return router;
}