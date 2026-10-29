import type { Pool, PoolClient } from 'pg';
import type {
    CollectionMode,
    RepositoryCandidate,
    RepositoryCollectionCheckpoint,
    RepositoryScrapingRecord,
    ScrapingWarning,
    SkippedOwner,
    SkippedRepository,
    UniversityCollectionCheckpoint,
} from '../types/scraping';
import type { RepositoryCollectionStorePort } from '../collectionRunner';
import {
    cancellationForSignal,
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

export class RepositoryStore implements RepositoryCollectionStorePort {
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

            const checkpointTables = await client.query<{ exists: boolean }>(
                `SELECT
                    to_regclass('public.repository_scraping_cache') IS NOT NULL
                    AND to_regclass('public.repository_scraping_runs') IS NOT NULL
                    AND to_regclass('public.repository_scraping_run_repositories') IS NOT NULL
                    AS exists`,
            );
            if (checkpointTables.rows[0]?.exists !== true) {
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
                cache_select: boolean;
                cache_insert: boolean;
                cache_update: boolean;
                cache_delete: boolean;
                runs_select: boolean;
                runs_insert: boolean;
                runs_update: boolean;
                checkpoints_select: boolean;
                checkpoints_insert: boolean;
                checkpoints_update: boolean;
                checkpoints_delete: boolean;
            }>(
                `SELECT
                    has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
                    has_table_privilege(current_user, 'public.repository_scraping', 'SELECT') AS can_select,
                    has_table_privilege(current_user, 'public.repository_scraping', 'INSERT') AS can_insert,
                    has_table_privilege(current_user, 'public.repository_scraping', 'UPDATE') AS can_update,
                    has_table_privilege(current_user, 'public.repository_scraping', 'DELETE') AS can_delete,
                    has_table_privilege(current_user, 'public.repository_scraping_cache', 'SELECT') AS cache_select,
                    has_table_privilege(current_user, 'public.repository_scraping_cache', 'INSERT') AS cache_insert,
                    has_table_privilege(current_user, 'public.repository_scraping_cache', 'UPDATE') AS cache_update,
                    has_table_privilege(current_user, 'public.repository_scraping_cache', 'DELETE') AS cache_delete,
                    has_table_privilege(current_user, 'public.repository_scraping_runs', 'SELECT') AS runs_select,
                    has_table_privilege(current_user, 'public.repository_scraping_runs', 'INSERT') AS runs_insert,
                    has_table_privilege(current_user, 'public.repository_scraping_runs', 'UPDATE') AS runs_update,
                    has_table_privilege(current_user, 'public.repository_scraping_run_repositories', 'SELECT') AS checkpoints_select,
                    has_table_privilege(current_user, 'public.repository_scraping_run_repositories', 'INSERT') AS checkpoints_insert,
                    has_table_privilege(current_user, 'public.repository_scraping_run_repositories', 'UPDATE') AS checkpoints_update,
                    has_table_privilege(current_user, 'public.repository_scraping_run_repositories', 'DELETE') AS checkpoints_delete`,
            );
            const privileges = privilegeResult.rows[0];
            if (
                !privileges?.schema_usage ||
                !privileges.can_select ||
                !privileges.can_insert ||
                !privileges.can_update ||
                !privileges.can_delete ||
                !privileges.cache_select ||
                !privileges.cache_insert ||
                !privileges.cache_update ||
                !privileges.cache_delete ||
                !privileges.runs_select ||
                !privileges.runs_insert ||
                !privileges.runs_update ||
                !privileges.checkpoints_select ||
                !privileges.checkpoints_insert ||
                !privileges.checkpoints_update ||
                !privileges.checkpoints_delete
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

    async startOrLoadUniversityCollection(
        runId: string,
        university: string,
        mode: CollectionMode,
    ): Promise<UniversityCollectionCheckpoint> {
        validateCollectionIdentity(runId, university);
        const client = await this.pool.connect();
        try {
            await client.query(
                `INSERT INTO public.repository_scraping_runs (run_id, university, mode, status)
                 VALUES ($1, $2, $3, 'discovering')
                 ON CONFLICT (run_id, university) DO NOTHING`,
                [runId, university, mode],
            );
            const runResult = await client.query<{
                mode: CollectionMode;
                status: UniversityCollectionCheckpoint['status'];
                candidate_count: number;
                committed_count: number;
                skipped_owners: unknown;
                skipped_repositories: unknown;
                warnings: unknown;
            }>(
                `SELECT mode, status, candidate_count, committed_count,
                        skipped_owners, skipped_repositories, warnings
                 FROM public.repository_scraping_runs
                 WHERE run_id = $1 AND university = $2`,
                [runId, university],
            );
            const run = runResult.rows[0];
            if (!run) throw new Error('Collection checkpoint was not created');
            if (run.mode !== mode) {
                throw new Error(
                    `Collection run ${runId} for ${university} was started in ${run.mode} mode and cannot resume in ${mode} mode`,
                );
            }
            const candidateResult = await client.query<{
                candidate: unknown;
                status: RepositoryCollectionCheckpoint['status'];
                record: unknown;
                etag: string | null;
                skipped_repository: unknown;
                warnings: unknown;
            }>(
                `SELECT candidate, status, record, etag, skipped_repository, warnings
                 FROM public.repository_scraping_run_repositories
                 WHERE run_id = $1 AND university = $2
                 ORDER BY repository_id`,
                [runId, university],
            );
            const candidates = candidateResult.rows.map((row) => ({
                candidate: parseStoredCandidate(row.candidate),
                status: row.status,
                ...(row.record ? { record: row.record as RepositoryScrapingRecord } : {}),
                ...(row.etag ? { etag: row.etag } : {}),
                ...(row.skipped_repository
                    ? { skippedRepository: row.skipped_repository as SkippedRepository }
                    : {}),
                warnings: readJsonArray<ScrapingWarning>(row.warnings),
            }));
            const skippedRepositories = [
                ...readJsonArray<SkippedRepository>(run.skipped_repositories),
                ...candidates.flatMap((item) =>
                    item.skippedRepository ? [item.skippedRepository] : [],
                ),
            ];
            const warnings = [
                ...readJsonArray<ScrapingWarning>(run.warnings),
                ...candidates.flatMap((item) => item.warnings ?? []),
            ];
            return {
                mode: run.mode,
                status: run.status,
                discovered: run.candidate_count,
                committed: run.committed_count,
                candidates,
                skippedOwners: readJsonArray<SkippedOwner>(run.skipped_owners),
                skippedRepositories: deduplicateByRepository(skippedRepositories),
                warnings: deduplicateWarnings(warnings),
            };
        } finally {
            client.release();
        }
    }

    async listKnownRepositories(university: string): Promise<RepositoryCandidate[]> {
        if (typeof university !== 'string' || university.trim() === '') {
            throw new TypeError('University key must be a non-empty string');
        }
        const result = await this.pool.query<{
            id: string;
            full_name: string | null;
            html_url: string | null;
            etag: string | null;
        }>(
            `SELECT repository.id::text, repository.full_name, repository.html_url, cache.etag
             FROM public.repository_scraping AS repository
             LEFT JOIN public.repository_scraping_cache AS cache
               ON cache.university = repository.university
              AND cache.repository_id = repository.id
             WHERE repository.university = $1
             ORDER BY repository.id`,
            [university],
        );
        return result.rows.map((row) => {
            const id = Number(row.id);
            if (!Number.isSafeInteger(id) || id <= 0) {
                throw new TypeError('Stored repository ID is not a safe integer');
            }
            const fullName = row.full_name ?? repositoryNameFromUrl(row.html_url);
            if (!fullName) {
                throw new Error(
                    `Known repository ${id} has no full_name or usable GitHub URL`,
                );
            }
            return {
                id,
                fullName,
                ...(row.etag ? { etag: row.etag } : {}),
            };
        });
    }

    async saveDiscoveryCheckpoint(
        runId: string,
        university: string,
        candidates: readonly RepositoryCandidate[],
        skippedOwners: readonly SkippedOwner[],
    ): Promise<void> {
        validateCollectionIdentity(runId, university);
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                `INSERT INTO public.repository_scraping_run_repositories
                    (run_id, university, repository_id, candidate, status)
                 SELECT $1, $2, (value->>'id')::BIGINT, value, 'pending'
                 FROM jsonb_array_elements($3::JSONB) AS candidate(value)
                 WHERE true
                 ON CONFLICT (run_id, university, repository_id) DO NOTHING`,
                [runId, university, JSON.stringify(candidates)],
            );
            await client.query(
                `UPDATE public.repository_scraping_runs
                 SET status = 'ready', candidate_count = (
                         SELECT count(*)::INTEGER
                         FROM public.repository_scraping_run_repositories
                         WHERE run_id = $1 AND university = $2
                     ),
                     skipped_owners = $3::JSONB,
                     updated_at = now()
                 WHERE run_id = $1 AND university = $2 AND status = 'discovering'`,
                [runId, university, JSON.stringify(skippedOwners)],
            );
            await client.query('COMMIT');
        } catch (error) {
            await rollbackQuietly(client);
            throw error;
        } finally {
            client.release();
        }
    }

    async saveRepositoryCheckpoint(
        runId: string,
        university: string,
        checkpoint: RepositoryCollectionCheckpoint,
    ): Promise<void> {
        validateCollectionIdentity(runId, university);
        if (checkpoint.status === 'pending') {
            throw new TypeError('A repository checkpoint must be completed');
        }
        const result = await this.pool.query(
            `UPDATE public.repository_scraping_run_repositories
             SET status = $4,
                 record = $5::JSONB,
                 etag = $6,
                 skipped_repository = $7::JSONB,
                 warnings = $8::JSONB,
                 updated_at = now()
             WHERE run_id = $1 AND university = $2 AND repository_id = $3`,
            [
                runId,
                university,
                checkpoint.candidate.id,
                checkpoint.status,
                checkpoint.record ? JSON.stringify(checkpoint.record) : null,
                checkpoint.etag ?? null,
                checkpoint.skippedRepository
                    ? JSON.stringify(checkpoint.skippedRepository)
                    : null,
                JSON.stringify(checkpoint.warnings ?? []),
            ],
        );
        if (result.rowCount !== 1) {
            throw new Error(
                `No collection checkpoint exists for repository ${checkpoint.candidate.id}`,
            );
        }
    }

    async publishUniversityCollection(
        runId: string,
        university: string,
        signal?: AbortSignal,
    ): Promise<number> {
        validateCollectionIdentity(runId, university);
        throwIfCancelled(signal);
        const client = await this.pool.connect();
        let transactionStarted = false;
        try {
            throwIfCancelled(signal);
            await client.query('BEGIN');
            transactionStarted = true;
            throwIfCancelled(signal);
            const runResult = await client.query<{
                mode: CollectionMode;
                status: UniversityCollectionCheckpoint['status'];
                candidate_count: number;
                skipped_owners: unknown;
            }>(
                `SELECT mode, status, candidate_count, skipped_owners
                 FROM public.repository_scraping_runs
                 WHERE run_id = $1 AND university = $2 FOR UPDATE`,
                [runId, university],
            );
            throwIfCancelled(signal);
            const run = runResult.rows[0];
            if (!run) throw new Error(`Unknown collection run ${runId}`);
            if (run.status === 'complete') {
                await client.query('COMMIT');
                transactionStarted = false;
                return 0;
            }
            if (run.status !== 'ready') {
                throw new Error(`Collection run ${runId} has no completed discovery checkpoint`);
            }
            const checkpointResult = await client.query<{
                repository_id: string;
                status: RepositoryCollectionCheckpoint['status'];
                record: unknown;
                etag: string | null;
                skipped_repository: unknown;
                warnings: unknown;
            }>(
                `SELECT repository_id::TEXT, status, record, etag, skipped_repository, warnings
                 FROM public.repository_scraping_run_repositories
                 WHERE run_id = $1 AND university = $2
                 ORDER BY repository_id FOR UPDATE`,
                [runId, university],
            );
            throwIfCancelled(signal);
            if (
                checkpointResult.rows.length !== run.candidate_count ||
                checkpointResult.rows.some((item) => item.status === 'pending')
            ) {
                throw new Error('Collection run still has unfinished repositories');
            }
            const records = checkpointResult.rows.flatMap((item) =>
                item.status === 'complete' && item.record
                    ? [item.record as RepositoryScrapingRecord]
                    : [],
            );
            for (const record of records) {
                validateRecord(record);
                if (record.university !== university) {
                    throw new RepositoryRecordValidationError(
                        record.fullName ?? `repository ${record.id}`,
                        'university',
                        'Checkpoint record has a different university key',
                    );
                }
            }
            const uniqueRecords = deduplicateRecords(records);
            for (let start = 0; start < uniqueRecords.length; start += this.batchSize) {
                const batch = uniqueRecords.slice(start, start + this.batchSize);
                try {
                    throwIfCancelled(signal);
                    await upsertBatch(client, batch);
                    throwIfCancelled(signal);
                } catch (error) {
                    if (cancellationForSignal(signal)) throw error;
                    throw new ScrapingDatabaseWriteError(
                        Math.floor(start / this.batchSize) + 1,
                        batch.length,
                        getSqlState(error),
                        { cause: error },
                    );
                }
            }
            for (const item of checkpointResult.rows) {
                if (item.status === 'complete' && item.etag) {
                    throwIfCancelled(signal);
                    await client.query(
                        `INSERT INTO public.repository_scraping_cache
                            (university, repository_id, etag, updated_at)
                         VALUES ($1, $2, $3, now())
                         ON CONFLICT (university, repository_id)
                         DO UPDATE SET etag = EXCLUDED.etag, updated_at = now()`,
                        [university, item.repository_id, item.etag],
                    );
                    throwIfCancelled(signal);
                }
            }
            const completeFullSnapshot =
                run.mode === 'full' &&
                readJsonArray<SkippedOwner>(run.skipped_owners).length === 0 &&
                checkpointResult.rows.every((item) => item.status === 'complete');
            if (completeFullSnapshot) {
                await client.query(
                    `DELETE FROM public.repository_scraping AS repository
                     WHERE repository.university = $1
                       AND NOT EXISTS (
                           SELECT 1
                           FROM public.repository_scraping_run_repositories AS checkpoint
                           WHERE checkpoint.run_id = $2
                             AND checkpoint.university = $1
                             AND checkpoint.repository_id = repository.id
                             AND checkpoint.status = 'complete'
                       )`,
                    [university, runId],
                );
                throwIfCancelled(signal);
                await client.query(
                    `DELETE FROM public.repository_scraping_cache AS cache
                     WHERE cache.university = $1
                       AND NOT EXISTS (
                           SELECT 1
                           FROM public.repository_scraping_run_repositories AS checkpoint
                           WHERE checkpoint.run_id = $2
                             AND checkpoint.university = $1
                             AND checkpoint.repository_id = cache.repository_id
                             AND checkpoint.status = 'complete'
                       )`,
                    [university, runId],
                );
                throwIfCancelled(signal);
            }
            const skippedRepositories = checkpointResult.rows.flatMap((item) =>
                item.skipped_repository
                    ? [item.skipped_repository as SkippedRepository]
                    : [],
            );
            const warnings = checkpointResult.rows.flatMap((item) =>
                readJsonArray<ScrapingWarning>(item.warnings),
            );
            await client.query(
                `UPDATE public.repository_scraping_runs
                 SET status = 'complete', committed_count = $3,
                     skipped_repositories = $4::JSONB,
                     warnings = $5::JSONB,
                     completed_at = now(), updated_at = now()
                 WHERE run_id = $1 AND university = $2`,
                [
                    runId,
                    university,
                    uniqueRecords.length,
                    JSON.stringify(deduplicateByRepository(skippedRepositories)),
                    JSON.stringify(deduplicateWarnings(warnings)),
                ],
            );
            throwIfCancelled(signal);
            await client.query(
                `DELETE FROM public.repository_scraping_run_repositories
                 WHERE run_id = $1 AND university = $2`,
                [runId, university],
            );
            throwIfCancelled(signal);
            // Once COMMIT is sent, its response decides whether publication won the race.
            await client.query('COMMIT');
            transactionStarted = false;
            return uniqueRecords.length;
        } catch (error) {
            if (transactionStarted) await rollbackQuietly(client);
            throw error;
        } finally {
            client.release();
        }
    }

    async acquireCollectionLock(): Promise<() => Promise<void>> {
        const client = await this.pool.connect();
        try {
            const result = await client.query<{ acquired: boolean }>(
                'SELECT pg_try_advisory_lock(731947, 83) AS acquired',
            );
            if (!result.rows[0]?.acquired) {
                throw new Error(
                    'Another repository collection is already running against this database',
                );
            }
        } catch (error) {
            client.release();
            throw error;
        }
        let released = false;
        return async () => {
            if (released) return;
            released = true;
            try {
                await client.query('SELECT pg_advisory_unlock(731947, 83)');
            } finally {
                client.release();
            }
        };
    }

    async upsertUniversity(
        university: string,
        records: readonly RepositoryScrapingRecord[],
        signal?: AbortSignal,
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
            throwIfCancelled(signal);
            await client.query('BEGIN');
            transactionStarted = true;
            throwIfCancelled(signal);
            let batchNumber = 0;
            for (let start = 0; start < deduplicated.length; start += this.batchSize) {
                batchNumber += 1;
                const batch = deduplicateRecords(
                    deduplicated.slice(start, start + this.batchSize),
                );
                try {
                    throwIfCancelled(signal);
                    await upsertBatch(client, batch);
                    throwIfCancelled(signal);
                } catch (error) {
                    if (cancellationForSignal(signal)) throw error;
                    throw new ScrapingDatabaseWriteError(
                        batchNumber,
                        batch.length,
                        getSqlState(error),
                        { cause: error },
                    );
                }
            }
            throwIfCancelled(signal);
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

function validateCollectionIdentity(runId: string, university: string): void {
    if (
        typeof runId !== 'string' ||
        runId.trim() === '' ||
        runId.length > 256 ||
        runId.includes('\u0000')
    ) {
        throw new TypeError('Collection run ID must be a non-empty string');
    }
    if (
        typeof university !== 'string' ||
        university.trim() === '' ||
        university.includes('\u0000')
    ) {
        throw new TypeError('University key must be a non-empty string');
    }
}

function parseStoredCandidate(value: unknown): RepositoryCandidate {
    const candidate = readJsonObject(value, 'repository candidate');
    const id = candidate.id;
    const fullName = candidate.fullName;
    if (
        typeof id !== 'number' ||
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        typeof fullName !== 'string' ||
        !/^[^/]+\/[^/]+$/.test(fullName)
    ) {
        throw new Error('Stored repository candidate is malformed');
    }
    return {
        id,
        fullName,
        ...(Object.hasOwn(candidate, 'metadata')
            ? { metadata: candidate.metadata }
            : {}),
        ...(Object.hasOwn(candidate, 'metadataWarnings')
            ? {
                  metadataWarnings: readJsonArray<ScrapingWarning>(
                      candidate.metadataWarnings,
                  ),
              }
            : {}),
        ...(typeof candidate.etag === 'string' ? { etag: candidate.etag } : {}),
    };
}

function readJsonObject(value: unknown, name: string): Record<string, unknown> {
    let parsed = value;
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed) as unknown;
        } catch {
            throw new Error(`Stored ${name} is invalid JSON`);
        }
    }
    if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
    ) {
        throw new Error(`Stored ${name} is not an object`);
    }
    return parsed as Record<string, unknown>;
}

function readJsonArray<T>(value: unknown): T[] {
    let parsed = value;
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed) as unknown;
        } catch {
            throw new Error('Stored collection JSON array is invalid');
        }
    }
    if (parsed === null || parsed === undefined) return [];
    if (!Array.isArray(parsed)) {
        throw new Error('Stored collection value is not an array');
    }
    return parsed as T[];
}

function deduplicateByRepository(
    skipped: readonly SkippedRepository[],
): SkippedRepository[] {
    return [
        ...new Map(skipped.map((item) => [item.repositoryId, item])).values(),
    ];
}

function deduplicateWarnings(
    warnings: readonly ScrapingWarning[],
): ScrapingWarning[] {
    return [
        ...new Map(
            warnings.map((warning) => [
                `${warning.repositoryId}:${warning.field}:${warning.code}`,
                warning,
            ]),
        ).values(),
    ];
}

function repositoryNameFromUrl(value: string | null): string | undefined {
    if (!value) return undefined;
    try {
        const url = new URL(value);
        if (url.hostname.toLowerCase() !== 'github.com') return undefined;
        const [owner, repository] = url.pathname.split('/').filter(Boolean);
        if (!owner || !repository) return undefined;
        return `${owner}/${repository.replace(/\.git$/i, '')}`;
    } catch {
        return undefined;
    }
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
    try {
        await client.query('ROLLBACK');
    } catch {
        // Preserve the operation error; releasing returns the connection.
    }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
    const cancellation = cancellationForSignal(signal);
    if (cancellation) throw cancellation;
}
