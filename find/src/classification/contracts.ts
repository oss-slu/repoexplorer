export const RESPONSE_CONTRACT_VERSION = 'repository-classification-v2';
export const EVIDENCE_REFERENCE_WIRE_CONTRACT_VERSION =
    'repository-classification-evidence-reference-v1';
export const CLASSIFICATION_RUBRIC_VERSION = 'repository-classification-rubric-v1';

export const PROJECT_TYPES = [
    'DEV',
    'EDU',
    'DOCS',
    'WEB',
    'DATA',
    'OTHER',
] as const;

export const AFFILIATION_DECISIONS = [
    'supported',
    'not_supported',
    'uncertain',
] as const;

export const AFFILIATION_RELATIONSHIPS = [
    'institutional_project',
    'research_group',
    'coursework',
    'student_organization',
    'maintainer_affiliation',
    'incidental_mention',
    'insufficient_evidence',
] as const;

export const AFFILIATION_EVIDENCE_FIELDS = [
    'fullName',
    'owner',
    'description',
    'readme',
    'homepage',
] as const;

export const PROJECT_TYPE_EVIDENCE_FIELDS = [
    'fullName',
    'description',
    'readme',
    'homepage',
] as const;

export type AffiliationDecision = (typeof AFFILIATION_DECISIONS)[number];
export type AffiliationRelationship =
    (typeof AFFILIATION_RELATIONSHIPS)[number];
export type ProjectType = (typeof PROJECT_TYPES)[number];
export type AffiliationEvidenceField =
    (typeof AFFILIATION_EVIDENCE_FIELDS)[number];
export type ProjectTypeEvidenceField =
    (typeof PROJECT_TYPE_EVIDENCE_FIELDS)[number];

export type EvidenceCitation<Field extends string = string> = {
    field: Field;
    quote: string;
};

export type AffiliationResponse = {
    decision: AffiliationDecision;
    relationship: AffiliationRelationship;
    score: number | null;
    evidence: EvidenceCitation<AffiliationEvidenceField>[];
    explanation: string;
};

export type ProjectTypeResponse = {
    category: ProjectType;
    evidence: EvidenceCitation<ProjectTypeEvidenceField>[];
    explanation: string;
};

const evidenceSchema = (fields: readonly string[]) => ({
    type: 'array',
    minItems: 0,
    maxItems: 5,
    items: {
        type: 'object',
        properties: {
            field: { type: 'string', enum: [...fields] },
            quote: { type: 'string', minLength: 1, maxLength: 400 },
        },
        required: ['field', 'quote'],
        additionalProperties: false,
    },
});

const evidenceReferenceIdsSchema = {
    type: 'array',
    minItems: 0,
    maxItems: 5,
    uniqueItems: true,
    items: { type: 'string', pattern: '^E[0-9]{4}$' },
} as const;

export const AFFILIATION_RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        decision: { type: 'string', enum: [...AFFILIATION_DECISIONS] },
        relationship: {
            type: 'string',
            enum: [...AFFILIATION_RELATIONSHIPS],
        },
        score: {
            anyOf: [
                { type: 'number', minimum: 0, maximum: 1 },
                { type: 'null' },
            ],
        },
        evidence: evidenceSchema(AFFILIATION_EVIDENCE_FIELDS),
        explanation: { type: 'string', minLength: 1, maxLength: 1200 },
    },
    required: ['decision', 'relationship', 'score', 'evidence', 'explanation'],
    additionalProperties: false,
} as const;

export const PROJECT_TYPE_RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        category: { type: 'string', enum: [...PROJECT_TYPES] },
        evidence: evidenceSchema(PROJECT_TYPE_EVIDENCE_FIELDS),
        explanation: { type: 'string', minLength: 1, maxLength: 1200 },
    },
    required: ['category', 'evidence', 'explanation'],
    additionalProperties: false,
} as const;

export const AFFILIATION_EVIDENCE_REFERENCE_SCHEMA = {
    type: 'object',
    properties: {
        decision: { type: 'string', enum: [...AFFILIATION_DECISIONS] },
        relationship: { type: 'string', enum: [...AFFILIATION_RELATIONSHIPS] },
        score: AFFILIATION_RESPONSE_SCHEMA.properties.score,
        evidenceIds: evidenceReferenceIdsSchema,
        explanation: AFFILIATION_RESPONSE_SCHEMA.properties.explanation,
    },
    required: ['decision', 'relationship', 'score', 'evidenceIds', 'explanation'],
    additionalProperties: false,
} as const;

export const PROJECT_TYPE_EVIDENCE_REFERENCE_SCHEMA = {
    type: 'object',
    properties: {
        category: { type: 'string', enum: [...PROJECT_TYPES] },
        evidenceIds: evidenceReferenceIdsSchema,
        explanation: PROJECT_TYPE_RESPONSE_SCHEMA.properties.explanation,
    },
    required: ['category', 'evidenceIds', 'explanation'],
    additionalProperties: false,
} as const;

export function schemaForTask(
    task: 'affiliation' | 'project_type',
    citationMode: 'exact_quote' | 'evidence_id' = 'exact_quote',
) {
    if (citationMode === 'evidence_id') {
        return task === 'affiliation'
            ? AFFILIATION_EVIDENCE_REFERENCE_SCHEMA
            : PROJECT_TYPE_EVIDENCE_REFERENCE_SCHEMA;
    }
    return task === 'affiliation'
        ? AFFILIATION_RESPONSE_SCHEMA
        : PROJECT_TYPE_RESPONSE_SCHEMA;
}

export function wireContractVersionForCitationMode(
    citationMode: 'exact_quote' | 'evidence_id',
): string {
    return citationMode === 'evidence_id'
        ? EVIDENCE_REFERENCE_WIRE_CONTRACT_VERSION
        : RESPONSE_CONTRACT_VERSION;
}
