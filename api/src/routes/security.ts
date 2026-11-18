import { Router } from 'express';
import { BASE_SECURITY, FILTERABLE_REPO_FIELDS } from '../consts';
import type { RespSecurity } from '../types/routes';
import type { secrData, repoData } from '../types/appData';
import type { AppDataSource } from '../types/AppDataSource';
import { makeAvgScorePerMetricArray } from '../utils/math';
import { filterData } from '../utils/filter';

function filterSecurityData(
    query: Parameters<typeof filterData>[1],
    data: secrData[],
    repoRows: repoData[],
): secrData[] {
    if (query.license !== undefined) {
        return filterData(data, query, { license: 'exact' });
    }

    const repoFilters = { ...query };

    if (query.repoLicense !== undefined) {
        repoFilters.license = query.repoLicense;
        delete repoFilters.repoLicense;
    }

    const activeFilters = Object.keys(repoFilters).filter(
        (key) => key in FILTERABLE_REPO_FIELDS && !['', 'All', '0'].includes(String(repoFilters[key])),
    );

    if (activeFilters.length === 0) {
        return data;
    }

    const filteredRepos = filterData(repoRows, repoFilters, FILTERABLE_REPO_FIELDS);
    const matchingUrls = new Set(filteredRepos.map((repo) => repo.htmlUrl));

    return data.filter((securityRepo) => matchingUrls.has(securityRepo.htmlUrl));
}

const SUB_ENDPOINTS = {
    securityScorecardByRepo: (rows: secrData[]) => rows,
    avgScorePerMetric: (rows: secrData[]) => makeAvgScorePerMetricArray(rows),
} satisfies { [K in keyof RespSecurity]: (rows: secrData[]) => RespSecurity[K] };

const endpoints = Object.keys(SUB_ENDPOINTS) as (keyof RespSecurity)[];

function makeResponse(rows: secrData[]): RespSecurity {
    return Object.fromEntries(endpoints.map((endpoint) => [endpoint, SUB_ENDPOINTS[endpoint](rows)])) as RespSecurity;
}

export function createSecurityRouter(dataSource: AppDataSource) {
    const router = Router();

    async function getFilteredSecurityData(
        query: Parameters<typeof filterData>[1],
    ): Promise<secrData[]> {
        const [data, repoRows] = await Promise.all([
            dataSource.getSecrData(),
            dataSource.getRepoData(),
        ]);

        return filterSecurityData(query, data, repoRows);
    }

    router.get(BASE_SECURITY, async (req, res, next) => {
        try {
            const filtered = await getFilteredSecurityData(req.query);
            res.json(makeResponse(filtered));
        } catch (error) {
            next(error);
        }
    });

    for (const endpoint of endpoints) {
        router.get(`${BASE_SECURITY}/${endpoint}`, async (req, res, next) => {
            try {
                const filtered = await getFilteredSecurityData(req.query);
                const value = SUB_ENDPOINTS[endpoint](filtered);
                res.json({ [endpoint]: value });
            } catch (error) {
                next(error);
            }
        });
    }

    return router;
}
