import type { Pool, PoolClient } from 'pg';
import type { RepositoryScrapingRecord } from '../types/scraping';

const INSERT_COLUMNS = [
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

    async upsertUniversity(
        university: string,
        records: readonly RepositoryScrapingRecord[],
    ): Promise<number> {
        const deduplicated = deduplicateRecords(records);
        for (const record of deduplicated) {
            if (record.university !== university) {
                throw new TypeError(
                    `Record university ${record.university} does not match ${university}`,
                );
            }
            validateRecord(record);
        }

        const client = await this.pool.connect();
        let transactionStarted = false;
        try {
            await client.query('BEGIN');
            transactionStarted = true;
            for (
                let start = 0;
                start < deduplicated.length;
                start += this.batchSize
            ) {
                const batch = deduplicateRecords(
                    deduplicated.slice(start, start + this.batchSize),
                );
                await upsertBatch(client, batch);
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
    if (record.university.trim() === '' || record.owner.trim() === '') {
        throw new TypeError(
            'Repository university and owner must be non-empty strings',
        );
    }
    if (!Number.isSafeInteger(record.id) || record.id <= 0) {
        throw new TypeError('Repository ID must be a positive safe integer');
    }
    if (record.fork !== 0 && record.fork !== 1) {
        throw new TypeError(
            'Repository fork must be represented as integer 0 or 1',
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
            throw new TypeError(`${name} must be a non-negative safe integer`);
        }
    }
    if (!Number.isFinite(Date.parse(record.scrapedAt))) {
        throw new TypeError('scrapedAt must be a valid timestamp');
    }
    validateNullableTimestamp(record.createdAt, 'createdAt');
    validateNullableTimestamp(record.updatedAt, 'updatedAt');
    validateNullableTimestamp(record.pushedAt, 'pushedAt');
    let contributors: unknown;
    try {
        contributors = JSON.parse(record.contributors);
    } catch (error) {
        throw new TypeError(
            'contributors must contain a JSON array of logins',
            {
                cause: error,
            },
        );
    }
    if (
        !Array.isArray(contributors) ||
        contributors.some((login) => typeof login !== 'string') ||
        contributors.length !== record.contributorCount
    ) {
        throw new TypeError(
            'contributors must match contributorCount as a JSON login array',
        );
    }
    for (const [name, value] of [
        ['busFactor', record.busFactor],
        ['affiliationPredictionGpt5Mini', record.affiliationPredictionGpt5Mini],
    ] as const) {
        if (value !== null && !Number.isFinite(value)) {
            throw new TypeError(`${name} must be a finite number or null`);
        }
    }
}

function validateNullableTimestamp(value: string | null, name: string): void {
    if (value !== null && !Number.isFinite(Date.parse(value))) {
        throw new TypeError(`${name} must be a valid timestamp or null`);
    }
}
