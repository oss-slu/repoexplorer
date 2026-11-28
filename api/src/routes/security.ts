import { Router } from 'express';
import { BASE_SECURITY, FILTERABLE_REPO_FIELDS } from '../consts';
import type { RespSecurity } from '../types/routes';
import type { secrData, repoData } from '../types/appData';
import type { AppDataSource } from '../types/AppDataSource';
import { makeAvgScorePerMetricArray } from '../utils/math';
import { filterData } from '../utils/filter';
import { PostgresDataSource } from '../db/dataSource';
import { query } from '../db/connect';
import { toCamel } from '../utils/strings';

const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 1000;

const SECURITY_REPO_FILTER_COLUMNS: Partial < Record<keyof repoData, string> > =
    {
        university: 'university',
        language: 'language',
        license: 'license',
        typePredictionGpt5Mini: 'type_prediction_gpt5_mini',
        affiliationPredictionGpt5Mini: 'affiliation_prediction_gpt5_mini',
        stargazersCount: 'stargazers_count',
        forksCount: 'forks_count',
        releaseDownloads: 'release_downloads',
    };

function parseIntegerQueryValue(value: unknown): number | null {
    if (typeof value !== 'string' || value.trim() === '') {
        return null;
    }

    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizedFilterValues(value: unknown): string[] {
    const values = Array.isArray(value) ? value : [value];

    return values
        .filter(
            (item): item is string | number =>
                typeof item === 'string' || typeof item === 'number',
        )
        .map(String);
}

function buildSecurityFilterClauses(
    filters: Record<string, unknown>,
    values: unknown[],
): string[] {
    if (filters.license !== undefined) {
        const licenseValues = normalizedFilterValues(filters.license);

        if (licenseValues.length === 0) {
            return ['FALSE'];
        }

        const placeholders = licenseValues.map((value) => {
            values.push(value.toLowerCase());
            return `$${values.length}`;
        });
        
        return [
            `LOWER(s.license::text) IN (${placeholders.join(', ')})`,
        ];
    }

    const repoFilters = { ...filters };

    if (repoFilters.repoLicense !== undefined) {
        repoFilters.license = repoFilters.repoLicense;
        delete repoFilters.repoLicense;
    }

    const activeFilters = Object.keys(repoFilters).filter(
        (key) =>
            key in FILTERABLE_REPO_FIELDS &&
            !['', 'All', '0'].includes(String(repoFilters[key])),
    );

    if (activeFilters.length === 0) {
        return [];
    }

    const repoClause: string[] = [];

    for (const key of activeFilters) {
        const field = key as keyof repoData;
        const column = SECURITY_REPO_FILTER_COLUMNS[field];
        const mode = FILTERABLE_REPO_FIELDS[field];

        if (!column || !mode) {
            continue;
        }

        const rawValue = repoFilters[key];
        const rawValues = Array.isArray(rawValue)
            ? rawValue
            : [rawValue];

        if (mode === 'exact') {
            const filterValues = normalizedFilterValues(rawValues);

            if (filterValues.length === 0) {
                repoClause.push('FALSE');
                continue;
            }

            const placeholders = filterValues.map((value) => {
                values.push(value.toLowerCase());
                return `$${values.length}`;
            });

            repoClause.push(
                `LOWER(r.${column}::text) IN (${placeholders.join(', ')})`,
            );
            continue;
        }

        const minimum = Number(rawValues[0]);

        if (!Number.isFinite(minimum)) {
            repoClause.push('FALSE');
            continue;
        }

        values.push(minimum);
        repoClause.push(`r.${column} >= $${values.length}`);
    }

    if (repoClause.length === 0) {
        return [];
    }

    return [
        `EXISTS (
            SELECT 1
            FROM public.repositories_parquet r
            WHERE r.html_url = s.html_url
                AND ${repoClause.join(' AND ')}
        )`,
    ];
}

function buildSecurityWhereClause(
    filters: Record<string, unknown>,
    values: unknown[],
): string {
    const clauses = buildSecurityFilterClauses(filters, values);

    return clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
}

function mapRowToCamelCase<T>(row: Record<string, unknown>): T {
    const newRow: Record<string, unknown> = {};

    for (const key in row) {
        const camelKey = toCamel(key);
        let value = row[key];

        if (typeof value === 'string' && /^-?\d+$/.test(value)) {
            const parsedNumber = Number(value);

            if (Number.isSafeInteger(parsedNumber)) {
                value = parsedNumber;
            }
        }

        newRow[camelKey] = value;
    }

    return newRow as T;
}

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
    const isPostgresDataSource = dataSource instanceof PostgresDataSource;

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

    router.get(
        `${BASE_SECURITY}/securityScorecardByRepo/count`,
        async (req, res, next) => {
            try {
                const filters = req.query as Record<string, unknown>;

                if (!isPostgresDataSource) {
                    const filtered = await getFilteredSecurityData(req.query);
                    res.json({ totalCount: filtered.length });
                    return;
                }

                const values: unknown[] = [];
                const whereClause = buildSecurityWhereClause(filters, values);
                const result = await query<{
                    totalCount: number | string;
                }>(
                    `SELECT COUNT(*) AS "totalCount"
                    FROM public.security_parquet s
                    ${whereClause}`,
                    values,
                );

                res.json({
                    totalCount: Number(result.rows[0]?.totalCount ?? 0),
                });
            } catch (error) {
                next(error);
            }
        },
    );

    for (const endpoint of endpoints) {
        router.get(`${BASE_SECURITY}/${endpoint}`, async (req, res, next) => {
            try {
                if (endpoint === 'securityScorecardByRepo') {
                    const limit = req.query.limit === undefined
                        ? DEFAULT_PAGE_SIZE
                        : parseIntegerQueryValue(req.query.limit);
                    const offset =
                        req.query.offset === undefined
                            ? 0
                            : parseIntegerQueryValue(req.query.offset);

                    if (
                        limit === null ||
                        limit < 1 ||
                        limit > MAX_PAGE_SIZE ||
                        offset === null ||
                        offset < 0
                    ) {
                        res.status(400).json({
                            error: `limit must be between 1 and ${MAX_PAGE_SIZE}; offset must be a non-negative integer`,
                        });
                        return;
                    }

                    if (!isPostgresDataSource) {
                        const filtered = await getFilteredSecurityData(
                            req.query,
                        );
                        res.json({
                            [endpoint]: filtered.slice(
                                offset,
                                offset + limit,
                            ),
                        });

                        return;
                    }

                    const filters = req.query as Record<string, unknown>;
                    const values: unknown[] = [];
                    const whereClause = buildSecurityWhereClause(
                        filters,
                        values,
                    );
                    const limitPlaceholder = values.push(limit);
                    const offsetPlaceholder = values.push(offset);

                    const result = await query<Record<string, unknown>>(
                        `SELECT s.*
                        FROM public.security_parquet s
                        ${whereClause}
                        ORDER BY s.html_url
                        LIMIT $${limitPlaceholder}
                        OFFSET $${offsetPlaceholder}`,
                        values,
                    );

                    res.json({
                        [endpoint]: result.rows.map((row) =>
                            mapRowToCamelCase<secrData>(row),
                        ),
                    });
                    return;
                }

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
