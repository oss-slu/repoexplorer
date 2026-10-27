import type { Pool, PoolClient } from 'pg';
import type { RepositoryScrapingRecord } from '../types/scraping';
import {
    RepositoryRecordValidationError,
    ScrapingDatabasePreflightError,
    ScrapingDatabaseWriteError,
} from '../utils/scrapingError';
import { assertNoUnnormalizedRepositoryText } from '../utils/normalizeRepositoryText';

export const REQUIRED_REPOSITORY_SCRAPING_COLUMNS = [
    'university',
    'id',
    'full_name',
    'owner',
    'license',
    'language',
    'html_url',
    'description',
    'fork',
    'created_at',
    'updated_at',
    'pushed_at',
    'homepage',
    'size',
    'stargazers_count',
    'readme',
    'watchers_count',
    'forks_count',
    'open_issues_count',
    'watchers',
    'organization',
    'release_downloads',
    'contributors',
    'contributor_count',
    'bus_factor',
    'code_of_conduct_file',
    'contributing',
    'security_policy',
    'issue_templates',
    'pull_request_template',
    'subscribers_count',
    'affiliation_prediction_gpt5_mini',
    'type_prediction_gpt5_mini',
    'scraped_at',
] as const;

const INSERT_COLUMNS = REQUIRED_REPOSITORY_SCRAPING_COLUMNS;

const UPDATE_COLUMNS = INSERT_COLUMNS.filter(
    (column) =>
        column !== 'university' &&
        column !== 'id' &&
        column !== 'bus_factor' &&
        column !== 'affiliation_prediction_gpt5_mini' &&
        column !== 'type_prediction_gpt5_mini',
);

export class RepositoryStore {
    constructor(
        private readonly pool: Pool,
        private readonly batchSize = 100,
    ) {
        if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
            throw new RangeError('batchSize must be an integer from 1 to 500');
        }
    }

    async preflight(): Promise<void> {
        let client: PoolClient | undefined;
        try {
            client = await this.pool.connect();
            await client.query('SELECT 1 AS connected');
            const tableResult = await client.query<{ exists: boolean }>(
                `SELECT to_regclass('public.repository_scraping') IS NOT NULL AS exists`,
            );
            if (tableResult.rows[0]?.exists !== true) {
                throw new ScrapingDatabasePreflightError('missing-table');
            }

            const columnResult = await client.query<{ column_name: string }>(
                `SELECT column_name
                 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'repository_scraping'`,
            );
            const existingColumns = new Set(
                columnResult.rows.map((row) => row.column_name),
            );
            if (INSERT_COLUMNS.some((column) => !existingColumns.has(column))) {
                throw new ScrapingDatabasePreflightError('missing-columns');
            }

            const privilegeResult = await client.query<{
                schema_usage: boolean;
                can_select: boolean;
                can_insert: boolean;
                can_update: boolean;
                can_delete: boolean;
            }>(
                `SELECT
                    has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
                    has_table_privilege(current_user, 'public.repository_scraping', 'SELECT') AS can_select,
                    has_table_privilege(current_user, 'public.repository_scraping', 'INSERT') AS can_insert,
                    has_table_privilege(current_user, 'public.repository_scraping', 'UPDATE') AS can_update,
                    has_table_privilege(current_user, 'public.repository_scraping', 'DELETE') AS can_delete`,
            );
            const privileges = privilegeResult.rows[0];
            if (
                !privileges?.schema_usage ||
                !privileges.can_select ||
                !privileges.can_insert ||
                !privileges.can_update ||
                !privileges.can_delete
            ) {
                throw new ScrapingDatabasePreflightError('privileges');
            }
        } catch (error) {
            if (error instanceof ScrapingDatabasePreflightError) throw error;
            throw new ScrapingDatabasePreflightError(
                'connection',
                getSqlState(error),
                { cause: error },
            );
        } finally {
            client?.release();
        }
    }

    async upsertUniversity(
        university: string,
        records: readonly RepositoryScrapingRecord[],
    ): Promise<number> {
        if (typeof university !== 'string' || university.trim() === '') {
            throw new TypeError('University key must be a non-empty string');
        }
        if (university.includes('\u0000')) {
            throw new TypeError('University key contains an actual NUL byte');
        }
        for (const record of records) {
            validateRecord(record);
            if (record.university !== university) {
                throw new RepositoryRecordValidationError(
                    record.fullName ?? `repository ${record.id}`,
                    'university',
                    `Repository ${record.fullName ?? record.id} has a different university key`,
                );
            }
        }
        const deduplicated = deduplicateRecords(records);

        const client = await this.pool.connect();
        let transactionStarted = false;
        try {
            await client.query('BEGIN');
            transactionStarted = true;
            let batchNumber = 0;
            for (let start = 0; start < deduplicated.length; start += this.batchSize) {
                batchNumber += 1;
                const batch = deduplicateRecords(
                    deduplicated.slice(start, start + this.batchSize),
                );
                try {
                    await upsertBatch(client, batch);
                } catch (error) {
                    throw new ScrapingDatabaseWriteError(
                        batchNumber,
                        batch.length,
                        getSqlState(error),
                        { cause: error },
                    );
                }
            }
            await client.query('COMMIT');
            transactionStarted = false;
            return deduplicated.length;
        } catch (error) {
            if (transactionStarted) {
                try {
                    await client.query('ROLLBACK');
                } catch {
                    // Preserve the write error; release still returns the connection.
                }
            }
            throw error;
        } finally {
            client.release();
        }
    }
}

async function upsertBatch(
    client: PoolClient,
    records: readonly RepositoryScrapingRecord[],
): Promise<void> {
    if (records.length === 0) {
        return;
    }
    const values: unknown[] = [];
    const rows = records.map((record, rowIndex) => {
        const recordValues = toDatabaseValues(record);
        values.push(...recordValues);
        const start = rowIndex * INSERT_COLUMNS.length;
        return `(${INSERT_COLUMNS.map((_, columnIndex) => `$${start + columnIndex + 1}`).join(', ')})`;
    });
    const updates = UPDATE_COLUMNS.map(
        (column) => `${column} = EXCLUDED.${column}`,
    ).join(', ');
    const sql = `INSERT INTO public.repository_scraping (${INSERT_COLUMNS.join(', ')}) VALUES ${rows.join(', ')} ON CONFLICT (id, university) DO UPDATE SET ${updates}`;
    await client.query(sql, values);
}

function toDatabaseValues(record: RepositoryScrapingRecord): unknown[] {
    return [
        record.university,
        record.id,
        record.fullName,
        record.owner,
        record.license,
        record.language,
        record.htmlUrl,
        record.description,
        record.fork,
        record.createdAt,
        record.updatedAt,
        record.pushedAt,
        record.homepage,
        record.size,
        record.stargazersCount,
        record.readme,
        record.watchersCount,
        record.forksCount,
        record.openIssuesCount,
        record.watchers,
        record.organization,
        record.releaseDownloads,
        record.contributors,
        record.contributorCount,
        record.busFactor,
        record.codeOfConductFile,
        record.contributing,
        record.securityPolicy,
        record.issueTemplates,
        record.pullRequestTemplate,
        record.subscribersCount,
        record.affiliationPredictionGpt5Mini,
        record.typePredictionGpt5Mini,
        record.scrapedAt,
    ];
}

function deduplicateRecords(
    records: readonly RepositoryScrapingRecord[],
): RepositoryScrapingRecord[] {
    const unique = new Map<string, RepositoryScrapingRecord>();
    for (const record of records) {
        unique.set(`${record.university}\u0000${record.id}`, record);
    }
    return [...unique.values()];
}

function validateRecord(record: RepositoryScrapingRecord): void {
    if (!record || typeof record !== 'object') {
        throw new TypeError('Repository record must be an object');
    }
    const repositoryName =
        typeof record.fullName === 'string' && record.fullName.length > 0
            ? record.fullName
            : `repository ${String(record.id)}`;
    const stringFields = [
        ['university', record.university, false],
        ['fullName', record.fullName, true],
        ['owner', record.owner, false],
        ['license', record.license, true],
        ['language', record.language, true],
        ['htmlUrl', record.htmlUrl, true],
        ['description', record.description, true],
        ['createdAt', record.createdAt, true],
        ['updatedAt', record.updatedAt, true],
        ['pushedAt', record.pushedAt, true],
        ['homepage', record.homepage, true],
        ['readme', record.readme, true],
        ['organization', record.organization, true],
        ['contributors', record.contributors, false],
        ['codeOfConductFile', record.codeOfConductFile, true],
        ['contributing', record.contributing, true],
        ['securityPolicy', record.securityPolicy, true],
        ['issueTemplates', record.issueTemplates, true],
        ['pullRequestTemplate', record.pullRequestTemplate, true],
        ['typePredictionGpt5Mini', record.typePredictionGpt5Mini, true],
        ['scrapedAt', record.scrapedAt, false],
    ] as const;
    for (const [field, value, nullable] of stringFields) {
        if (value === null && nullable) continue;
        if (typeof value !== 'string') {
            throw validationError(
                repositoryName,
                field,
                `${field} must be ${nullable ? 'a string or null' : 'a non-empty string'}`,
            );
        }
        if (value.includes('\u0000')) {
            throw validationError(
                repositoryName,
                field,
                `${field} contains an actual NUL byte`,
            );
        }
    }
    if (record.university.trim() === '' || record.owner.trim() === '') {
        throw validationError(
            repositoryName,
            record.university.trim() === '' ? 'university' : 'owner',
            'university and owner must be non-empty strings',
        );
    }
    if (
        record.fullName !== null &&
        (!/^[^/]+\/[^/]+$/.test(record.fullName) ||
            record.fullName.split('/').some((part) => part.trim() === ''))
    ) {
        throw validationError(
            repositoryName,
            'fullName',
            'fullName must contain one owner/repository separator',
        );
    }
    assertNoUnnormalizedRepositoryText(record);
    if (!Number.isSafeInteger(record.id) || record.id <= 0) {
        throw validationError(
            repositoryName,
            'id',
            'Repository ID must be a positive safe integer',
        );
    }
    if (record.fork !== 0 && record.fork !== 1) {
        throw validationError(
            repositoryName,
            'fork',
            'fork must be represented as integer 0 or 1',
        );
    }
    for (const [name, value] of [
        ['size', record.size],
        ['stargazersCount', record.stargazersCount],
        ['watchersCount', record.watchersCount],
        ['forksCount', record.forksCount],
        ['openIssuesCount', record.openIssuesCount],
        ['watchers', record.watchers],
        ['releaseDownloads', record.releaseDownloads],
        ['contributorCount', record.contributorCount],
        ['subscribersCount', record.subscribersCount],
    ] as const) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw validationError(
                repositoryName,
                name,
                `${name} must be a non-negative safe integer`,
            );
        }
    }
    if (!Number.isFinite(Date.parse(record.scrapedAt))) {
        throw validationError(
            repositoryName,
            'scrapedAt',
            'scrapedAt must be a valid timestamp',
        );
    }
    validateNullableTimestamp(record, 'createdAt', record.createdAt);
    validateNullableTimestamp(record, 'updatedAt', record.updatedAt);
    validateNullableTimestamp(record, 'pushedAt', record.pushedAt);
    let contributors: unknown;
    try {
        contributors = JSON.parse(record.contributors);
    } catch (error) {
        throw validationError(
            repositoryName,
            'contributors',
            'contributors must contain a JSON array of logins',
            { cause: error },
        );
    }
    if (
        !Array.isArray(contributors) ||
        contributors.some(
            (login) =>
                typeof login !== 'string' ||
                login.trim() === '' ||
                login.includes('\u0000'),
        ) ||
        contributors.length !== record.contributorCount
    ) {
        throw validationError(
            repositoryName,
            'contributors',
            'contributors must match contributorCount as a JSON login array',
        );
    }
    for (const [name, value] of [
        ['busFactor', record.busFactor],
        ['affiliationPredictionGpt5Mini', record.affiliationPredictionGpt5Mini],
    ] as const) {
        if (value !== null && !Number.isFinite(value)) {
            throw validationError(
                repositoryName,
                name,
                `${name} must be a finite number or null`,
            );
        }
    }
}

function validateNullableTimestamp(
    record: RepositoryScrapingRecord,
    name: string,
    value: string | null,
): void {
    if (value !== null && !Number.isFinite(Date.parse(value))) {
        throw validationError(
            record.fullName ?? `repository ${record.id}`,
            name,
            `${name} must be a valid timestamp or null`,
        );
    }
}

function validationError(
    repository: string,
    field: string,
    message: string,
    options?: ErrorOptions,
): RepositoryRecordValidationError {
    return new RepositoryRecordValidationError(
        repository,
        field,
        `Repository ${repository} field ${field}: ${message}`,
        options,
    );
}

function getSqlState(error: unknown): string | undefined {
    if (!(error instanceof Error)) return undefined;
    const code = (error as Error & { code?: unknown }).code;
    return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
        ? code
        : undefined;
}
