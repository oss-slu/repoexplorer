import { Router } from 'express';
import { BASE_OVERVIEW, FILTERABLE_REPO_FIELDS } from '../consts';
import type { RespOverview } from '../types/routes';
import type { repoData } from '../types/appData';
import sampleData from '../../data/sample/sampleRepoData.json';
import { query } from '../db/connect';
import {
    getAvg,
    getCountFieldNotNull,
    getPercentFieldNotNull,
    getSum,
    makeCountsArray,
    makeFieldDistributionArray,
    makeFieldDistributionByArray,
    makeFieldsNotNullArray,
} from '../utils/math';
import { filterData } from '../utils/filter';

const data = sampleData as repoData[];
const router = Router();

const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 1000;

function parseIntegerQueryValue(value: unknown): number | null {
    if (typeof value !== 'string' || value.trim() === '') {
        return null;
    }

    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

// Create endpoint map: the string is the /destination and the function call gets the appropriate data
const SUB_ENDPOINTS = {
    totalRepos: (rows: repoData[]) => rows.length,
    withLicense: (rows: repoData[]) => getCountFieldNotNull(rows, 'license'),
    percentWithLicense: (rows: repoData[]) => getPercentFieldNotNull(rows, 'license'),
    totalContributors: (rows: repoData[]) => getSum(rows, 'contributorCount'),
    avgBusFactor: (rows: repoData[]) => getAvg(rows, 'busFactor'),
    reposPerUniversity: (rows: repoData[]) => makeCountsArray(rows, 'university'),
    languageDistribution: (rows: repoData[]) => makeFieldDistributionArray(rows, 'language'),
    licenseDistribution: (rows: repoData[]) => makeFieldDistributionArray(rows, 'license'),
    typeDistribution: (rows: repoData[]) => makeFieldDistributionArray(rows, 'typePredictionGpt5Mini'),
    communityFilesPresence: (rows: repoData[]) =>
        makeFieldsNotNullArray(rows, [
            'issueTemplates',
            'securityPolicy',
            'codeOfConductFile',
            'pullRequestTemplate',
            'contributing',
            'license',
            'description',
            'readme',
        ]),
    languageDistributionByType: (rows: repoData[]) =>
        makeFieldDistributionByArray(rows, 'language', 'typePredictionGpt5Mini'),
    licenseDistributionByType: (rows: repoData[]) =>
        makeFieldDistributionByArray(rows, 'license', 'typePredictionGpt5Mini'),
} satisfies { [K in keyof RespOverview]: (rows: repoData[]) => RespOverview[K] };

const endpoints = Object.keys(SUB_ENDPOINTS) as (keyof RespOverview)[];

function makeResponse(rows: repoData[]): RespOverview {
    return Object.fromEntries(endpoints.map((endpoint) => [endpoint, SUB_ENDPOINTS[endpoint](rows)])) as RespOverview;
}

// Register primary GET response: build and return full RespOverview object
router.get(BASE_OVERVIEW, (req, res) => {
    const filtered = filterData(data, req.query, FILTERABLE_REPO_FIELDS);
    res.json(makeResponse(filtered));
});

// Register sub GET responses for each endpoint.
for (const endpoint of endpoints) {
    router.get(`${BASE_OVERVIEW}/${endpoint}`, (req, res) => {
        const filtered = filterData(data, req.query, FILTERABLE_REPO_FIELDS);
        const value = SUB_ENDPOINTS[endpoint](filtered);
        res.json({ [endpoint]: value });
    });
}

router.get(`${BASE_OVERVIEW}/repositories`, async (req, res, next) => {
    const limit = 
        req.query.limit === undefined
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
    try {
        const { rows } = await query(
            `SELECT
                university,
                id,
                full_name AS "fullName",
                owner,
                license,
                language,
                html_url AS "htmlUrl",
                description,
                fork,
                created_at AS "createdAt",
                updated_at AS "updatedAt",
                pushed_at AS "pushedAt",
                homepage,
                size,
                stargazers_count AS "stargazersCount",
                readme,
                watchers_count AS "watchersCount",
                forks_count AS "forksCount",
                open_issues_count AS "openIssuesCount",
                watchers,
                organization,
                release_downloads AS "releaseDownloads",
                contributors,
                contributor_count AS "contributorCount",
                bus_factor AS "busFactor",
                code_of_conduct_file AS "codeOfConductFile",
                contributing,
                security_policy AS "securityPolicy",
                issue_templates AS "issueTemplates",
                pull_request_template AS "pullRequestTemplate",
                subscribers_count AS "subscribersCount",
                affiliation_prediction_gpt5_mini AS "affiliationPredictionGpt5Mini",
                type_prediction_gpt5_mini AS "typePredictionGpt5Mini"

            FROM public.repositories_parquet
            ORDER BY university, id
            LIMIT $1 OFFSET $2
            `, [limit, offset],
        );
        res.json(rows);
    } catch (error) {
        next(error);
    }
});

export default router;
