import { createHash } from 'node:crypto';
import type {
    ClassificationCandidate,
    ClassificationConfiguration,
} from '../types/scraping';
import type { AffiliationEvidenceField, ProjectTypeEvidenceField } from './contracts';

export const EVIDENCE_CATALOG_VERSION = 'visible-exact-spans-v1';
export const EVIDENCE_SPAN_MAX_CHARS = 320;

export type EvidenceReference = {
    id: string;
    field: AffiliationEvidenceField;
    segmentIndex: number;
    startOffset: number;
    endOffset: number;
    text: string;
};

export type PreparedTextEvidence = {
    value: string;
    truncated: boolean;
    citationSegments: string[];
    shown?: string;
};

export type PreparedRepositoryEvidence = {
    affiliation: {
        fullName: string;
        owner: string;
        description: PreparedTextEvidence;
        readme: PreparedTextEvidence;
        homepage: string;
    };
    projectType: {
        fullName: string;
        description: PreparedTextEvidence;
        readme: PreparedTextEvidence;
        homepage: string;
    };
    citationSegments: Record<AffiliationEvidenceField | ProjectTypeEvidenceField, string[]>;
    evidenceCatalog: EvidenceReference[];
    evidenceCatalogHash: string;
    sourceHash: string;
};

export function prepareRepositoryEvidence(
    candidate: ClassificationCandidate,
    configuration: ClassificationConfiguration,
): PreparedRepositoryEvidence {
    const fullName = normalizeLineEndings(candidate.fullName ?? '');
    const owner = normalizeLineEndings(candidate.owner);
    const description = prepareText(candidate.description, 'description', configuration);
    const readme = prepareText(candidate.readme, 'README', configuration);
    const homepage = normalizeLineEndings(candidate.homepage ?? '');
    const citationSegments = {
        fullName: nonemptySegments([fullName]),
        owner: nonemptySegments([owner]),
        description: description.citationSegments,
        readme: readme.citationSegments,
        homepage: nonemptySegments([homepage]),
    };
    const evidence = {
        affiliation: { fullName, owner, description, readme, homepage },
        projectType: { fullName, description, readme, homepage },
        citationSegments,
    };
    const evidenceCatalog = buildEvidenceCatalog(citationSegments);
    const evidenceCatalogHash = createHash('sha256')
        .update(JSON.stringify({ version: EVIDENCE_CATALOG_VERSION, evidenceCatalog }))
        .digest('hex');
    const sourceHash = createHash('sha256')
        .update(JSON.stringify(evidence))
        .digest('hex');
    return { ...evidence, evidenceCatalog, evidenceCatalogHash, sourceHash };
}

export function buildEvidenceCatalog(
    citationSegments: PreparedRepositoryEvidence['citationSegments'],
): EvidenceReference[] {
    const catalog: EvidenceReference[] = [];
    const fields: AffiliationEvidenceField[] = [
        'fullName',
        'owner',
        'description',
        'readme',
        'homepage',
    ];
    for (const field of fields) {
        for (const [segmentIndex, segment] of citationSegments[field].entries()) {
            let startOffset = 0;
            while (startOffset < segment.length) {
                const endOffset = chooseSpanEnd(
                    segment,
                    startOffset,
                    EVIDENCE_SPAN_MAX_CHARS,
                );
                catalog.push({
                    id: `E${String(catalog.length + 1).padStart(4, '0')}`,
                    field,
                    segmentIndex,
                    startOffset,
                    endOffset,
                    text: segment.slice(startOffset, endOffset),
                });
                startOffset = endOffset;
            }
        }
    }
    return catalog;
}

export function formatTruncatedText(
    value: string | null,
    field: string,
    configuration: ClassificationConfiguration,
): { value: string; truncated: boolean; shown?: string } {
    const prepared = prepareText(value, field, configuration);
    return {
        value: prepared.value,
        truncated: prepared.truncated,
        ...(prepared.shown ? { shown: prepared.shown } : {}),
    };
}

function prepareText(
    value: string | null,
    field: string,
    configuration: ClassificationConfiguration,
): PreparedTextEvidence {
    const text = normalizeLineEndings(value ?? '');
    const truncation = configuration.truncation;
    if (text.length <= truncation.maxChars) {
        return {
            value: text,
            truncated: false,
            citationSegments: nonemptySegments([text]),
        };
    }
    if (truncation.mode === 'start') {
        const first = text.slice(0, safeSliceEnd(text, truncation.maxChars));
        return {
            value: first,
            truncated: true,
            citationSegments: nonemptySegments([first]),
            shown: `first ${truncation.maxChars} characters`,
        };
    }
    // Limits count UTF-16 code units; a boundary inside a surrogate pair moves
    // inward so the visible text never holds half a character, which
    // PostgreSQL rejects in JSONB evidence.
    const first = text.slice(0, safeSliceEnd(text, truncation.startChars));
    const last =
        truncation.endChars === 0
            ? ''
            : text.slice(safeSliceStart(text, text.length - truncation.endChars));
    const marker = `[… ${field} omitted …]`;
    const valueWithMarker = `${first}\n${marker}\n${last}`;
    return {
        value: valueWithMarker,
        truncated: true,
        citationSegments: nonemptySegments([first, last]),
        shown: `first ${truncation.startChars} and last ${truncation.endChars} characters`,
    };
}

function normalizeLineEndings(value: string): string {
    return value.replace(/\r\n/g, '\n');
}

function nonemptySegments(values: string[]): string[] {
    return values.filter((value) => value.length > 0);
}

function chooseSpanEnd(value: string, start: number, maxChars: number): number {
    const rawLimit = Math.min(start + maxChars, value.length);
    if (rawLimit === value.length) return rawLimit;
    const safeLimit = safeSliceEnd(value, rawLimit);
    // A one-unit budget that lands inside a pair keeps the whole character.
    const limit = safeLimit > start ? safeLimit : Math.min(start + 2, value.length);
    if (limit === value.length) return limit;
    const preferredMinimum = Math.min(start + Math.floor(maxChars * 0.45), limit);
    const newline = value.lastIndexOf('\n', limit - 1);
    if (newline >= preferredMinimum) return newline + 1;
    for (let index = limit - 1; index >= preferredMinimum; index -= 1) {
        if ('.!?;'.includes(value[index] ?? '') && /\s/.test(value[index + 1] ?? '')) {
            return index + 1;
        }
    }
    return limit;
}

/** Moves an exclusive end offset back so it does not split a surrogate pair. */
export function safeSliceEnd(value: string, end: number): number {
    return end > 0 && end < value.length && splitsSurrogatePair(value, end)
        ? end - 1
        : end;
}

/** Moves a start offset forward so it does not split a surrogate pair. */
export function safeSliceStart(value: string, start: number): number {
    return start > 0 && start < value.length && splitsSurrogatePair(value, start)
        ? start + 1
        : start;
}

function splitsSurrogatePair(value: string, offset: number): boolean {
    const before = value.charCodeAt(offset - 1);
    const after = value.charCodeAt(offset);
    return (
        before >= 0xd800 &&
        before <= 0xdbff &&
        after >= 0xdc00 &&
        after <= 0xdfff
    );
}
