import type { ClassificationTask } from '../types/scraping';
import { safeSliceEnd, safeSliceStart } from './evidence';
import type { PromptMessage } from './prompts';
import { quoteNamesInstitution, type InstitutionNames } from './review';

/** Longest quote an offline client copies from a prompt field. */
const SIMULATED_QUOTE_MAX_CHARS = 160;

export type PromptEvidenceCitation =
    | { mode: 'exact_quote'; field: string; quote: string }
    | { mode: 'evidence_id'; id: string; field: string; quote: string };

export type PromptEvidence = {
    citationMode: 'exact_quote' | 'evidence_id';
    institution: { name: string | null; acronym: string | null };
    /** One verifiable citation per field that has usable visible text. */
    citations: PromptEvidenceCitation[];
    /**
     * Finds a verifiable citation, outside the owner and fullName fields,
     * that names the institution by the same rule as the evidence gate.
     */
    findInstitutionCitation(): PromptEvidenceCitation | null;
};

const IDENTIFIER_FIELDS = new Set(['owner', 'fullName']);

/**
 * Reads the repository evidence block the prompt builders embed, so offline
 * clients cite only text the prompt actually showed. Returns null when the
 * messages do not contain a recognisable evidence block.
 */
export function readPromptEvidence(
    messages: readonly PromptMessage[],
): PromptEvidence | null {
    const user = messages.find((message) => message.role === 'user');
    if (!user) return null;
    // JSON.stringify escapes newlines inside values, so blank lines only
    // separate prompt sections.
    const sections = user.content.split('\n\n');
    const evidence = parseSection(sections, 'Repository evidence');
    if (!isRecord(evidence)) return null;
    const institution = parseSection(sections, 'Target institution context');
    const institutionRecord = isRecord(institution) ? institution : {};
    const institutionInfo = {
        name: stringOrNull(institutionRecord.name),
        acronym: stringOrNull(institutionRecord.acronym),
    };
    const names: InstitutionNames | null = institutionInfo.name
        ? {
              fullName: institutionInfo.name,
              acronym: institutionInfo.acronym ?? '',
              emailDomains: Array.isArray(institutionRecord.emailDomains)
                  ? institutionRecord.emailDomains.filter(
                        (domain): domain is string => typeof domain === 'string',
                    )
                  : [],
          }
        : null;
    const fieldRecord = isRecord(evidence.fields) ? evidence.fields : evidence;
    const owner = typeof fieldRecord.owner === 'string' ? fieldRecord.owner : '';
    const fieldText = (value: unknown) =>
        typeof value === 'string'
            ? value
            : isRecord(value) && typeof value.value === 'string'
              ? value.value
              : '';
    const context = {
        ownerLogin: owner,
        repositoryText: ['description', 'readme', 'homepage']
            .map((field) => fieldText(fieldRecord[field]))
            .filter((value) => value !== '')
            .join('\n'),
    };
    const namesInstitution = (quote: string, field?: string) =>
        names !== null &&
        quoteNamesInstitution(quote, names, context, {
            homepage: field === 'homepage',
        });

    if (Array.isArray(evidence.evidenceCatalog)) {
        const catalog = evidence.evidenceCatalog.filter(
            (entry): entry is { id: string; field: string; text: string } =>
                isRecord(entry) &&
                typeof entry.id === 'string' &&
                typeof entry.field === 'string' &&
                typeof entry.text === 'string' &&
                entry.text.trim() !== '',
        );
        const toCitation = (entry: (typeof catalog)[number]) => ({
            mode: 'evidence_id' as const,
            id: entry.id,
            field: entry.field,
            quote: entry.text,
        });
        const firstPerField = new Map<string, PromptEvidenceCitation>();
        for (const entry of catalog) {
            if (!firstPerField.has(entry.field)) {
                firstPerField.set(entry.field, toCitation(entry));
            }
        }
        return {
            citationMode: 'evidence_id',
            institution: institutionInfo,
            citations: [...firstPerField.values()],
            findInstitutionCitation() {
                const entry = catalog.find(
                    (candidate) =>
                        !IDENTIFIER_FIELDS.has(candidate.field) &&
                        namesInstitution(candidate.text, candidate.field),
                );
                return entry ? toCitation(entry) : null;
            },
        };
    }

    const fields = new Map<string, string>();
    for (const [field, value] of Object.entries(evidence)) {
        const text =
            typeof value === 'string'
                ? value
                : isRecord(value) && typeof value.value === 'string'
                  ? value.value
                  : null;
        if (text !== null && text.trim() !== '') fields.set(field, text);
    }
    const citationFor = (
        field: string,
        text: string,
    ): PromptEvidenceCitation | null => {
        const quote = quoteFromText(text);
        return quote === null ? null : { mode: 'exact_quote', field, quote };
    };
    const citations = [...fields.entries()]
        .map(([field, text]) => citationFor(field, text))
        .filter((citation): citation is PromptEvidenceCitation => citation !== null);
    return {
        citationMode: 'exact_quote',
        institution: institutionInfo,
        citations,
        findInstitutionCitation() {
            for (const [field, text] of fields) {
                if (IDENTIFIER_FIELDS.has(field)) continue;
                const quote = quoteFromText(text, (value) =>
                    namesInstitution(value, field),
                );
                if (quote !== null) return { mode: 'exact_quote', field, quote };
            }
            return null;
        },
    };
}

/**
 * Returns a short substring of one visible line. Single lines never span the
 * truncation marker, so the quote is inside one prepared citation segment.
 * With `accept`, returns the first window that satisfies it.
 */
export function quoteFromText(
    text: string,
    accept: (quote: string) => boolean = () => true,
): string | null {
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (line === '' || /^\[… .+ omitted …\]$/.test(line)) continue;
        if (line.length <= SIMULATED_QUOTE_MAX_CHARS) {
            if (accept(line)) return line;
            continue;
        }
        const step = SIMULATED_QUOTE_MAX_CHARS / 2;
        for (let offset = 0; offset < line.length; offset += step) {
            const start = safeSliceStart(
                line,
                Math.min(offset, line.length - SIMULATED_QUOTE_MAX_CHARS),
            );
            const end = safeSliceEnd(
                line,
                Math.min(line.length, start + SIMULATED_QUOTE_MAX_CHARS),
            );
            const quote = line.slice(start, end).trim();
            if (quote !== '' && accept(quote)) return quote;
        }
    }
    return null;
}

/** Shapes citations for the wire format the prompt asked for. */
export function wireEvidence(
    citations: readonly PromptEvidenceCitation[],
): { evidence: Array<{ field: string; quote: string }> } | { evidenceIds: string[] } {
    if (citations.some((citation) => citation.mode === 'evidence_id')) {
        return {
            evidenceIds: citations.flatMap((citation) =>
                citation.mode === 'evidence_id' ? [citation.id] : [],
            ),
        };
    }
    return {
        evidence: citations.map(({ field, quote }) => ({ field, quote })),
    };
}

export function emptyWireEvidence(
    evidence: PromptEvidence | null,
): { evidence: [] } | { evidenceIds: [] } {
    return evidence?.citationMode === 'evidence_id'
        ? { evidenceIds: [] }
        : { evidence: [] };
}

/**
 * Deterministic offline response used by `npm run classify -- --mock`. It
 * supports affiliation only when a visible field (other than the owner and
 * repository name) names the institution by the evidence gate's rule, cites
 * that passage, and then classifies the project as DEV with
 * a real citation. It is a pipeline check, not an evaluated judgment.
 */
export function deterministicEvidenceResponse(
    task: ClassificationTask,
    messages: readonly PromptMessage[],
): string {
    const evidence = readPromptEvidence(messages);
    if (task === 'affiliation') {
        const citation = evidence?.findInstitutionCitation() ?? null;
        if (citation) {
            return JSON.stringify({
                decision: 'supported',
                relationship: 'institutional_project',
                score: 0.7,
                ...wireEvidence([citation]),
                explanation:
                    'Deterministic simulated response: a visible field names the institution. This is not an evaluated affiliation judgment.',
            });
        }
        return JSON.stringify({
            decision: 'uncertain',
            relationship: 'insufficient_evidence',
            score: null,
            ...emptyWireEvidence(evidence),
            explanation:
                'Deterministic simulated response; no visible field names the institution, so no conclusion was evaluated.',
        });
    }
    const citation = preferredProjectCitation(evidence);
    return JSON.stringify({
        category: citation ? 'DEV' : 'OTHER',
        ...(citation ? wireEvidence([citation]) : emptyWireEvidence(evidence)),
        explanation: citation
            ? 'Deterministic simulated project type response citing visible repository text.'
            : 'Deterministic simulated project type response; the supplied evidence is insufficient.',
    });
}

export function preferredProjectCitation(
    evidence: PromptEvidence | null,
): PromptEvidenceCitation | null {
    if (!evidence) return null;
    for (const field of ['description', 'readme', 'fullName', 'homepage']) {
        const citation = evidence.citations.find(
            (candidate) => candidate.field === field,
        );
        if (citation) return citation;
    }
    return null;
}

function parseSection(sections: readonly string[], heading: string): unknown {
    const section = sections.find((value) => value.startsWith(heading));
    const start = section?.indexOf('{') ?? -1;
    if (!section || start < 0) return null;
    try {
        return JSON.parse(section.slice(start));
    } catch {
        return null;
    }
}

function stringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
