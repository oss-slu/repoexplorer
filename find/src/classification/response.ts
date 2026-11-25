import {
    AFFILIATION_DECISIONS,
    AFFILIATION_EVIDENCE_FIELDS,
    AFFILIATION_RELATIONSHIPS,
    PROJECT_TYPES,
    PROJECT_TYPE_EVIDENCE_FIELDS,
    type AffiliationResponse,
    type EvidenceCitation,
    type ProjectTypeResponse,
} from './contracts';
import type { ClassificationTask } from '../types/scraping';
import type { EvidenceReference } from './evidence';

export type ClassificationValidationCode =
    | 'invalid_json'
    | 'invalid_schema'
    | 'invalid_citation'
    | 'invalid_evidence_reference'
    | 'contradictory_response';

export type CitationFailureReason =
    | 'source_field_missing'
    | 'empty_source'
    | 'quote_absent_from_visible_segments'
    | 'quote_matches_other_field';

export type CitationDiagnostic = {
    citationIndex: number;
    declaredField: string;
    reason: CitationFailureReason;
    matchingFields: string[];
};

/**
 * A change made to a model citation before it was accepted. `relabeled`
 * keeps the exact quote but moves it to the only other allowed field that
 * contains it; `dropped` removes a citation that cannot be verified while
 * other verified citations remain.
 */
export type CitationRepair = {
    citationIndex: number;
    action: 'relabeled' | 'dropped';
    reason: CitationFailureReason;
    declaredField: string;
    repairedField: string | null;
};

export type ClassificationValidationDetail = 'missing_score';

export class ClassificationValidationError extends TypeError {
    constructor(
        readonly code: ClassificationValidationCode,
        message: string,
        options?: ErrorOptions,
        readonly citationDiagnostics: CitationDiagnostic[] = [],
        readonly detail: ClassificationValidationDetail | null = null,
        /** True when this error came from the reply to a missing-score follow-up. */
        readonly afterScoreRetry = false,
    ) {
        super(message, options);
        this.name = 'ClassificationValidationError';
    }
}

export function parseAffiliationResponse(value: string): AffiliationResponse {
    const response = parseObject(value);
    requireExactKeys(response, [
        'decision',
        'relationship',
        'score',
        'evidence',
        'explanation',
    ]);
    if (!isOneOf(response.decision, AFFILIATION_DECISIONS)) {
        throw schemaError('Affiliation response decision is unsupported');
    }
    if (!isOneOf(response.relationship, AFFILIATION_RELATIONSHIPS)) {
        throw schemaError('Affiliation response relationship is unsupported');
    }
    const evidence = parseEvidence(
        response.evidence,
        AFFILIATION_EVIDENCE_FIELDS,
        'affiliation',
    );
    const explanation = requireExplanation(response.explanation);
    const decision = response.decision;
    const relationship = response.relationship;
    const score = response.score;

    if (decision === 'uncertain') {
        if (score !== null) {
            throw contradictionError(
                'Uncertain affiliation decisions require a null score',
            );
        }
    } else if (score === null) {
        throw new ClassificationValidationError(
            'invalid_schema',
            'Supported and not_supported affiliation decisions require a finite score from 0 to 1; the score was null',
            undefined,
            [],
            'missing_score',
        );
    } else if (
        typeof score !== 'number' ||
        !Number.isFinite(score) ||
        score < 0 ||
        score > 1
    ) {
        throw schemaError(
            'Supported and not_supported affiliation decisions require a finite score from 0 to 1',
        );
    }
    if (relationship === 'insufficient_evidence' && decision !== 'uncertain') {
        throw contradictionError(
            'insufficient_evidence requires an uncertain affiliation decision',
        );
    }
    if (decision === 'supported') {
        if (evidence.length === 0) {
            throw contradictionError(
                'Supported affiliation decisions require at least one evidence citation',
            );
        }
        if (
            relationship === 'incidental_mention' ||
            relationship === 'insufficient_evidence'
        ) {
            throw contradictionError(
                'A supported decision requires a positive relationship type',
            );
        }
    }
    return { decision, relationship, score, evidence, explanation };
}

export function parseProjectTypeResponse(value: string): ProjectTypeResponse {
    const response = parseObject(value);
    requireExactKeys(response, ['category', 'evidence', 'explanation']);
    if (!isOneOf(response.category, PROJECT_TYPES)) {
        throw schemaError(
            `Project type response category must be one of ${PROJECT_TYPES.join(', ')}`,
        );
    }
    const evidence = parseEvidence(
        response.evidence,
        PROJECT_TYPE_EVIDENCE_FIELDS,
        'project type',
    );
    return {
        category: response.category,
        evidence,
        explanation: requireExplanation(response.explanation),
    };
}

export function resolveEvidenceReferences(
    value: string,
    catalog: readonly EvidenceReference[],
    task: ClassificationTask,
): string {
    const response = parseObject(value);
    const keys =
        task === 'affiliation'
            ? ['decision', 'relationship', 'score', 'evidenceIds', 'explanation']
            : ['category', 'evidenceIds', 'explanation'];
    requireExactKeys(response, keys);
    if (
        !Array.isArray(response.evidenceIds) ||
        response.evidenceIds.length > 5 ||
        !response.evidenceIds.every(
            (id) => typeof id === 'string' && /^E\d{4}$/.test(id),
        )
    ) {
        throw schemaError(
            'Evidence references must be an array of at most five catalog IDs',
        );
    }
    const ids = response.evidenceIds as string[];
    if (new Set(ids).size !== ids.length) {
        throw evidenceReferenceError('Duplicate evidence reference IDs are not allowed');
    }
    const allowedFields =
        task === 'affiliation'
            ? new Set<string>(AFFILIATION_EVIDENCE_FIELDS)
            : new Set<string>(PROJECT_TYPE_EVIDENCE_FIELDS);
    const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
    const citations = ids.map((id) => {
        const reference = catalogById.get(id);
        if (!reference) {
            throw evidenceReferenceError('Evidence reference ID is unknown for this request');
        }
        if (!allowedFields.has(reference.field)) {
            throw evidenceReferenceError(
                'Evidence reference field is unavailable for this task',
            );
        }
        return { field: reference.field, quote: reference.text };
    });
    const canonical = { ...response };
    delete canonical.evidenceIds;
    return JSON.stringify({ ...canonical, evidence: citations });
}

export function validateCitations(
    citations: readonly EvidenceCitation[],
    preparedSegments: Readonly<Record<string, readonly string[]>>,
    allowedFields: readonly string[] = Object.keys(preparedSegments),
): void {
    const diagnostics = diagnoseCitations(
        citations,
        preparedSegments,
        allowedFields,
    );
    if (diagnostics.length > 0) throw citationError(diagnostics);
}

/**
 * Accepts citations that can be verified without changing their quotes.
 * A quote found verbatim in exactly one other allowed field is relabeled to
 * that field. Other unverifiable citations are dropped only while at least
 * one verified citation remains; otherwise the strict citation error is
 * thrown with the original diagnostics.
 */
export function repairCitations<Field extends string>(
    citations: readonly EvidenceCitation<Field>[],
    preparedSegments: Readonly<Record<string, readonly string[]>>,
    allowedFields: readonly Field[],
): { citations: EvidenceCitation<Field>[]; repairs: CitationRepair[] } {
    const diagnostics = diagnoseCitations(
        citations,
        preparedSegments,
        allowedFields,
    );
    if (diagnostics.length === 0) {
        return { citations: [...citations], repairs: [] };
    }
    const byIndex = new Map(
        diagnostics.map((diagnostic) => [diagnostic.citationIndex, diagnostic]),
    );
    const repaired: EvidenceCitation<Field>[] = [];
    const repairs: CitationRepair[] = [];
    for (const [offset, citation] of citations.entries()) {
        const diagnostic = byIndex.get(offset + 1);
        if (!diagnostic) {
            repaired.push(citation);
            continue;
        }
        const target =
            diagnostic.reason === 'quote_matches_other_field' &&
            diagnostic.matchingFields.length === 1
                ? (diagnostic.matchingFields[0] as Field)
                : null;
        if (target !== null) {
            repaired.push({ field: target, quote: citation.quote });
        }
        repairs.push({
            citationIndex: diagnostic.citationIndex,
            action: target === null ? 'dropped' : 'relabeled',
            reason: diagnostic.reason,
            declaredField: diagnostic.declaredField,
            repairedField: target,
        });
    }
    if (repaired.length === 0) throw citationError(diagnostics);
    return { citations: repaired, repairs };
}

function citationError(
    diagnostics: CitationDiagnostic[],
): ClassificationValidationError {
    const first = diagnostics[0]!;
    const reason =
        first.reason === 'quote_matches_other_field'
            ? `; exact quote also appears in ${first.matchingFields.join(', ')}`
            : '';
    return new ClassificationValidationError(
        'invalid_citation',
        `Evidence citation ${first.citationIndex} does not match supplied ${first.declaredField} text (${first.reason})${reason}`,
        undefined,
        diagnostics,
    );
}

export function diagnoseCitations(
    citations: readonly EvidenceCitation[],
    preparedSegments: Readonly<Record<string, readonly string[]>>,
    allowedFields: readonly string[] = Object.keys(preparedSegments),
): CitationDiagnostic[] {
    const diagnostics: CitationDiagnostic[] = [];
    for (const [index, citation] of citations.entries()) {
        const segments = preparedSegments[citation.field];
        if (segments?.some((segment) => segment.includes(citation.quote))) {
            continue;
        }
        const matchingFields = allowedFields.filter(
            (field) =>
                field !== citation.field &&
                preparedSegments[field]?.some((segment) =>
                    segment.includes(citation.quote),
                ),
        );
        const reason: CitationFailureReason =
            segments === undefined
                ? 'source_field_missing'
                : segments.length === 0
                  ? 'empty_source'
                  : matchingFields.length > 0
                    ? 'quote_matches_other_field'
                    : 'quote_absent_from_visible_segments';
        diagnostics.push({
            citationIndex: index + 1,
            declaredField: citation.field,
            reason,
            matchingFields,
        });
    }
    return diagnostics;
}

function parseEvidence<Field extends string>(
    value: unknown,
    fields: readonly Field[],
    label: string,
): EvidenceCitation<Field>[] {
    if (!Array.isArray(value) || value.length > 5) {
        throw schemaError(`${label} response evidence must be an array of at most 5 citations`);
    }
    return value.map((citation, index) => {
        if (!isRecord(citation)) {
            throw schemaError(`${label} evidence citation ${index + 1} must be an object`);
        }
        requireExactKeys(citation, ['field', 'quote']);
        if (!isOneOf(citation.field, fields)) {
            throw schemaError(`${label} evidence citation ${index + 1} has an unsupported field`);
        }
        if (
            typeof citation.quote !== 'string' ||
            citation.quote.trim() === '' ||
            citation.quote.length > 400
        ) {
            throw schemaError(`${label} evidence citation ${index + 1} must have a non-empty quote of at most 400 characters`);
        }
        return { field: citation.field, quote: citation.quote };
    });
}

function parseObject(value: string): Record<string, unknown> {
    let stripped = value.trim().replace(/^```(?:json)?\s*/i, '');
    if (stripped.endsWith('```')) stripped = stripped.slice(0, -3).trimEnd();
    let parsed: unknown;
    try {
        parsed = JSON.parse(stripped);
    } catch (error) {
        throw new ClassificationValidationError(
            'invalid_json',
            'Classifier response is not valid JSON',
            { cause: error },
        );
    }
    if (!isRecord(parsed)) {
        throw schemaError('Classifier response must be a JSON object');
    }
    return parsed;
}

function requireExactKeys(
    value: Record<string, unknown>,
    keys: readonly string[],
): void {
    const actual = Object.keys(value);
    if (
        actual.length !== keys.length ||
        keys.some((key) => !Object.hasOwn(value, key))
    ) {
        throw schemaError('Classifier response contains missing or unknown fields');
    }
}

function requireExplanation(value: unknown): string {
    if (
        typeof value !== 'string' ||
        value.trim() === '' ||
        value.length > 1200
    ) {
        throw schemaError('Classifier response explanation must be non-empty and at most 1200 characters');
    }
    return value;
}

function isOneOf<const T extends readonly string[]>(
    value: unknown,
    allowed: T,
): value is T[number] {
    return typeof value === 'string' && allowed.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function schemaError(message: string): ClassificationValidationError {
    return new ClassificationValidationError('invalid_schema', message);
}

function contradictionError(message: string): ClassificationValidationError {
    return new ClassificationValidationError('contradictory_response', message);
}

function evidenceReferenceError(message: string): ClassificationValidationError {
    return new ClassificationValidationError('invalid_evidence_reference', message);
}
