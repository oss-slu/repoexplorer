import type {
    RepositoryScrapingRecord,
    ScrapingWarning,
} from '../types/scraping';
import { RepositoryRecordValidationError } from './scrapingError';

const DESCRIPTIVE_TEXT_FIELDS = [
    'description',
    'readme',
    'codeOfConductFile',
    'contributing',
    'securityPolicy',
    'pullRequestTemplate',
] as const satisfies readonly (keyof RepositoryScrapingRecord)[];

type NormalizedText = { value: string; replacements: number };

export function normalizeRepositoryText(
    records: readonly RepositoryScrapingRecord[],
): { records: RepositoryScrapingRecord[]; warnings: ScrapingWarning[] } {
    const warnings: ScrapingWarning[] = [];
    const normalizedRecords = records.map((record) => {
        const next = { ...record };
        const repositoryName = record.fullName ?? `repository ${record.id}`;

        for (const field of DESCRIPTIVE_TEXT_FIELDS) {
            const value = record[field];
            if (value === null) continue;
            const normalized = replaceNul(value);
            next[field] = normalized.value;
            if (normalized.replacements > 0) {
                warnings.push({
                    university: record.university,
                    repositoryId: record.id,
                    repositoryName,
                    field,
                    replacementCount: normalized.replacements,
                    code: 'nul_replaced',
                });
            }
        }

        if (record.issueTemplates !== null) {
            const normalized = normalizeIssueTemplates(
                record.issueTemplates,
                repositoryName,
            );
            next.issueTemplates = normalized.value;
            if (normalized.replacements > 0) {
                warnings.push({
                    university: record.university,
                    repositoryId: record.id,
                    repositoryName,
                    field: 'issueTemplates',
                    replacementCount: normalized.replacements,
                    code: 'nul_replaced',
                });
            }
        }
        return next;
    });

    return { records: normalizedRecords, warnings };
}

/** Reject direct store callers that bypass the runner's normalization step. */
export function assertNoUnnormalizedRepositoryText(
    record: RepositoryScrapingRecord,
): void {
    const repositoryName = record.fullName ?? `repository ${record.id}`;
    for (const field of DESCRIPTIVE_TEXT_FIELDS) {
        const value = record[field];
        if (typeof value === 'string' && value.includes('\u0000')) {
            throw new RepositoryRecordValidationError(
                repositoryName,
                field,
                `Repository ${repositoryName} field ${field} contains unnormalized NUL text`,
            );
        }
    }
    if (typeof record.issueTemplates === 'string') {
        const normalized = normalizeIssueTemplates(
            record.issueTemplates,
            repositoryName,
        );
        if (normalized.replacements > 0) {
            throw new RepositoryRecordValidationError(
                repositoryName,
                'issueTemplates',
                `Repository ${repositoryName} field issueTemplates contains unnormalized NUL text`,
            );
        }
    }
}

function normalizeIssueTemplates(
    value: string,
    repositoryName: string,
): NormalizedText {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value) as unknown;
    } catch {
        return replaceNul(value);
    }
    if (!isTemplateEntryList(parsed)) {
        return replaceNul(value);
    }

    let replacements = 0;
    const entries = parsed.map((entry) => {
        if (
            !isRecord(entry) ||
            typeof entry.path !== 'string' ||
            entry.path.trim() === '' ||
            entry.path.includes('\u0000') ||
            (typeof entry.content !== 'string' && entry.content !== null)
        ) {
            throw new RepositoryRecordValidationError(
                repositoryName,
                'issueTemplates',
                `Repository ${repositoryName} field issueTemplates must contain path and text content entries`,
            );
        }
        if (entry.content === null) {
            return { path: entry.path, content: null };
        }
        const nested = normalizeNestedIssueTemplateContent(
            entry.content,
            repositoryName,
        );
        replacements += nested.replacements;
        return { path: entry.path, content: nested.value };
    });
    return { value: JSON.stringify(entries), replacements };
}

function normalizeNestedIssueTemplateContent(
    value: string,
    repositoryName: string,
): NormalizedText {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value) as unknown;
    } catch {
        return replaceNul(value);
    }
    if (!isTemplateEntryList(parsed)) {
        return replaceNul(value);
    }
    const nested = normalizeIssueTemplates(value, repositoryName);
    return nested;
}

function isTemplateEntryList(value: unknown): value is unknown[] {
    if (!Array.isArray(value)) return false;
    if (value.length === 0) return true;
    const entryLike = value.some(
        (item) =>
            isRecord(item) && ('path' in item || 'content' in item),
    );
    return entryLike;
}

function replaceNul(value: string): NormalizedText {
    const replacements = value.split('\u0000').length - 1;
    return {
        value: value.replaceAll('\u0000', '\uFFFD'),
        replacements,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
