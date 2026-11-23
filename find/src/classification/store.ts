import type { Pool } from 'pg';
import type {
    ClassificationCandidate,
    ClassificationPrediction,
} from '../types/scraping';
import {
    AFFILIATION_DECISIONS,
    AFFILIATION_EVIDENCE_FIELDS,
    AFFILIATION_RELATIONSHIPS,
    type EvidenceCitation,
} from './contracts';

export type ClassificationPredictionKey = Pick<
    ClassificationPrediction,
    | 'id'
    | 'university'
    | 'task'
    | 'provider'
    | 'model'
    | 'promptVersion'
    | 'threshold'
    | 'inputHash'
>;

export interface ClassificationStorePort {
    listCandidates(university: string): Promise<ClassificationCandidate[]>;
    findPrediction(
        key: ClassificationPredictionKey,
    ): Promise<ClassificationPrediction | null>;
    savePrediction(prediction: ClassificationPrediction): Promise<void>;
}

export class ClassificationStore implements ClassificationStorePort {
    constructor(private readonly pool: Pool) {}

    async listCandidates(
        university: string,
    ): Promise<ClassificationCandidate[]> {
        const result = await this.pool.query(
            `SELECT id, university, full_name, owner, html_url, description, readme,
                    homepage, language, license, fork, archived, is_template, size,
                    stargazers_count, forks_count, contributors
             FROM public.repository_scraping
             WHERE university = $1
             ORDER BY id`,
            [university],
        );
        return result.rows.map((row) => ({
            id: safeInteger(row.id, 'id'),
            university: requireString(row.university, 'university'),
            fullName: nullableString(row.full_name),
            owner: requireString(row.owner, 'owner'),
            htmlUrl: nullableString(row.html_url),
            description: nullableString(row.description),
            readme: nullableString(row.readme),
            homepage: nullableString(row.homepage),
            language: nullableString(row.language),
            license: nullableString(row.license),
            fork: safeInteger(row.fork, 'fork'),
            archived: nullableBoolean(row.archived),
            isTemplate: nullableBoolean(row.is_template),
            size: safeInteger(row.size, 'size'),
            stargazersCount: safeInteger(
                row.stargazers_count,
                'stargazers_count',
            ),
            forksCount: safeInteger(row.forks_count, 'forks_count'),
            contributors: nullableString(row.contributors),
        }));
    }

    async findPrediction(
        key: ClassificationPredictionKey,
    ): Promise<ClassificationPrediction | null> {
        const result = await this.pool.query(
            `SELECT id, university, task, provider, model, prompt_version, threshold, input_hash,
                    score, category, affiliation_decision, affiliation_relationship,
                    affiliation_evidence, explanation, status, simulated, error_message,
                    classified_at
             FROM public.repository_classification_predictions
             WHERE id = $1 AND university = $2 AND task = $3 AND provider = $4
               AND model = $5 AND prompt_version = $6 AND threshold = $7 AND input_hash = $8`,
            [
                key.id,
                key.university,
                key.task,
                key.provider,
                key.model,
                key.promptVersion,
                key.threshold,
                key.inputHash,
            ],
        );
        return result.rows[0] ? parsePrediction(result.rows[0]) : null;
    }

    async savePrediction(prediction: ClassificationPrediction): Promise<void> {
        validatePrediction(prediction);
        await this.pool.query(
            `INSERT INTO public.repository_classification_predictions (
                id, university, task, provider, model, prompt_version, threshold, input_hash,
                score, category, affiliation_decision, affiliation_relationship,
                affiliation_evidence, explanation, status, simulated, error_message, classified_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
             ON CONFLICT (id, university, task, provider, model, prompt_version, threshold, input_hash)
             DO UPDATE SET score = EXCLUDED.score, category = EXCLUDED.category,
                affiliation_decision = EXCLUDED.affiliation_decision,
                affiliation_relationship = EXCLUDED.affiliation_relationship,
                affiliation_evidence = EXCLUDED.affiliation_evidence,
                explanation = EXCLUDED.explanation, status = EXCLUDED.status,
                simulated = EXCLUDED.simulated, error_message = EXCLUDED.error_message,
                classified_at = EXCLUDED.classified_at`,
            [
                prediction.id,
                prediction.university,
                prediction.task,
                prediction.provider,
                prediction.model,
                prediction.promptVersion,
                prediction.threshold,
                prediction.inputHash,
                prediction.score,
                prediction.category,
                prediction.affiliationDecision,
                prediction.affiliationRelationship,
                prediction.affiliationEvidence === null
                    ? null
                    : JSON.stringify(prediction.affiliationEvidence),
                prediction.explanation,
                prediction.status,
                prediction.simulated,
                prediction.errorMessage,
                prediction.classifiedAt,
            ],
        );
    }
}

function parsePrediction(row: Record<string, unknown>): ClassificationPrediction {
    const task = requireOneOf(row.task, ['affiliation', 'project_type'], 'task');
    const prediction: ClassificationPrediction = {
        id: safeInteger(row.id, 'id'),
        university: requireString(row.university, 'university'),
        task,
        provider: requireString(row.provider, 'provider'),
        model: requireString(row.model, 'model'),
        promptVersion: requireString(row.prompt_version, 'prompt_version'),
        threshold: finiteNumber(row.threshold, 'threshold'),
        inputHash: requireString(row.input_hash, 'input_hash').trim(),
        score: row.score === null ? null : finiteNumber(row.score, 'score'),
        category: nullableString(row.category),
        affiliationDecision: nullableOneOf(
            row.affiliation_decision,
            AFFILIATION_DECISIONS,
            'affiliation_decision',
        ),
        affiliationRelationship: nullableOneOf(
            row.affiliation_relationship,
            AFFILIATION_RELATIONSHIPS,
            'affiliation_relationship',
        ),
        affiliationEvidence: parseAffiliationEvidence(
            row.affiliation_evidence,
        ),
        explanation: nullableString(row.explanation),
        status: requireOneOf(
            row.status,
            [
                'predicted',
                'below_threshold',
                'not_supported',
                'uncertain',
                'ineligible',
                'skipped_threshold',
                'skipped_eligibility',
                'skipped_affiliation_failed',
                'skipped_affiliation_uncertain',
                'skipped_affiliation_rejected',
                'failed',
            ],
            'status',
        ),
        simulated: requireBoolean(row.simulated, 'simulated'),
        errorMessage: nullableString(row.error_message),
        classifiedAt: new Date(String(row.classified_at)).toISOString(),
    };
    validateTaskStatus(prediction);
    return prediction;
}

function validatePrediction(value: ClassificationPrediction): void {
    if (!Number.isSafeInteger(value.id) || value.id <= 0) {
        throw new TypeError(
            'Classification repository ID must be a positive safe integer',
        );
    }
    if (!/^[0-9a-f]{64}$/.test(value.inputHash)) {
        throw new TypeError(
            'Classification inputHash must be a lowercase SHA-256 digest',
        );
    }
    if (
        !Number.isFinite(value.threshold) ||
        value.threshold < 0 ||
        value.threshold > 1
    ) {
        throw new TypeError(
            'Classification threshold must be a finite number from 0 to 1',
        );
    }
    validateTaskStatus(value);
    if (value.task === 'affiliation') {
        if (value.category !== null)
            throw new TypeError('Affiliation predictions cannot have a category');
        if (
            value.score !== null &&
            (!Number.isFinite(value.score) || value.score < 0 || value.score > 1)
        ) {
            throw new TypeError('Affiliation score must be from 0 to 1 or null');
        }
        validateAffiliationConsistency(value);
    } else {
        if (value.score !== null)
            throw new TypeError('Project type predictions cannot have a score');
        if (
            value.affiliationDecision !== null ||
            value.affiliationRelationship !== null ||
            value.affiliationEvidence !== null
        ) {
            throw new TypeError(
                'Project type predictions cannot have affiliation response fields',
            );
        }
        if (
            value.category !== null &&
            !['DEV', 'EDU', 'DOCS', 'WEB', 'DATA', 'OTHER'].includes(
                value.category,
            )
        ) {
            throw new TypeError('Project type category is not supported');
        }
        if (
            (value.status === 'predicted' && value.category === null) ||
            (value.status !== 'predicted' && value.category !== null)
        ) {
            throw new TypeError('Project type category and status are inconsistent');
        }
    }
    if (!Number.isFinite(Date.parse(value.classifiedAt))) {
        throw new TypeError('classifiedAt must be a valid timestamp');
    }
}

function validateTaskStatus(value: ClassificationPrediction): void {
    const affiliationStatuses = [
        'predicted',
        'below_threshold',
        'not_supported',
        'uncertain',
        'ineligible',
        'failed',
    ];
    const projectStatuses = [
        'predicted',
        'skipped_threshold',
        'skipped_eligibility',
        'skipped_affiliation_failed',
        'skipped_affiliation_uncertain',
        'skipped_affiliation_rejected',
        'failed',
    ];
    const allowed =
        value.task === 'affiliation' ? affiliationStatuses : projectStatuses;
    if (!allowed.includes(value.status)) {
        throw new TypeError(
            `Classification status ${value.status} is not valid for ${value.task}`,
        );
    }
}

function validateAffiliationConsistency(value: ClassificationPrediction): void {
    const fields = [
        value.affiliationDecision,
        value.affiliationRelationship,
        value.affiliationEvidence,
    ];
    const structured = fields.every((field) => field !== null);
    if (!structured) {
        if (fields.some((field) => field !== null)) {
            throw new TypeError(
                'Affiliation response fields must be all present or all null',
            );
        }
        // Existing rows are readable. Their old input hash prevents new-contract reuse.
        return;
    }
    const decision = value.affiliationDecision!;
    const relationship = value.affiliationRelationship!;
    const evidence = value.affiliationEvidence!;
    if (decision === 'uncertain') {
        if (value.score !== null || value.status !== 'uncertain') {
            throw new TypeError(
                'Uncertain affiliation predictions require a null score and uncertain status',
            );
        }
    } else if (value.score === null) {
        throw new TypeError(
            'Supported or not_supported affiliation predictions require a score',
        );
    }
    if (
        relationship === 'insufficient_evidence' &&
        decision !== 'uncertain'
    ) {
        throw new TypeError(
            'insufficient_evidence requires an uncertain decision',
        );
    }
    if (decision === 'supported') {
        if (
            evidence.length === 0 ||
            relationship === 'incidental_mention' ||
            relationship === 'insufficient_evidence' ||
            !['predicted', 'below_threshold'].includes(value.status)
        ) {
            throw new TypeError('Supported affiliation prediction is contradictory');
        }
        if (
            (value.status === 'predicted' && value.score! < value.threshold) ||
            (value.status === 'below_threshold' && value.score! >= value.threshold)
        ) {
            throw new TypeError(
                'Affiliation prediction status does not match its threshold',
            );
        }
    } else if (value.status !== decision) {
        throw new TypeError(
            'Affiliation decision and prediction status do not match',
        );
    }
}

function parseAffiliationEvidence(value: unknown): EvidenceCitation[] | null {
    if (value === null || value === undefined) return null;
    let parsed: unknown = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch (error) {
            throw new TypeError('Database affiliation_evidence is not valid JSON', {
                cause: error,
            });
        }
    }
    if (!Array.isArray(parsed) || parsed.length > 5) {
        throw new TypeError(
            'Database affiliation_evidence is not a valid citation array',
        );
    }
    return parsed.map((citation, index) => {
        if (
            citation === null ||
            typeof citation !== 'object' ||
            Array.isArray(citation)
        ) {
            throw new TypeError(`Database affiliation citation ${index + 1} is invalid`);
        }
        const record = citation as Record<string, unknown>;
        if (
            Object.keys(record).length !== 2 ||
            typeof record.field !== 'string' ||
            !AFFILIATION_EVIDENCE_FIELDS.includes(
                record.field as (typeof AFFILIATION_EVIDENCE_FIELDS)[number],
            ) ||
            typeof record.quote !== 'string' ||
            record.quote.trim() === '' ||
            record.quote.length > 400
        ) {
            throw new TypeError(`Database affiliation citation ${index + 1} is invalid`);
        }
        return { field: record.field, quote: record.quote };
    });
}

function safeInteger(value: unknown, name: string): number {
    const result = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(result))
        throw new TypeError(`Database ${name} is not a safe integer`);
    return result;
}

function finiteNumber(value: unknown, name: string): number {
    const result = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(result))
        throw new TypeError(`Database ${name} is not finite`);
    return result;
}

function requireString(value: unknown, name: string): string {
    if (typeof value !== 'string')
        throw new TypeError(`Database ${name} is not text`);
    return value;
}

function nullableString(value: unknown): string | null {
    return value === null || value === undefined
        ? null
        : requireString(value, 'nullable text');
}

function nullableBoolean(value: unknown): boolean | null {
    if (value === null || value === undefined) return null;
    return requireBoolean(value, 'eligibility flag');
}

function requireBoolean(value: unknown, name: string): boolean {
    if (typeof value !== 'boolean')
        throw new TypeError(`Database ${name} is not a boolean`);
    return value;
}

function nullableOneOf<const T extends readonly string[]>(
    value: unknown,
    allowed: T,
    name: string,
): T[number] | null {
    if (value === null || value === undefined) return null;
    return requireOneOf(value, allowed, name);
}

function requireOneOf<const T extends readonly string[]>(
    value: unknown,
    allowed: T,
    name: string,
): T[number] {
    if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new TypeError(`Database ${name} is unsupported`);
    }
    return value as T[number];
}
