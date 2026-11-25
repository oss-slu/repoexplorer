import type { AffiliationEvidenceGate } from '../types/scraping';
import type { AffiliationResponse } from './contracts';
import {
    citationNamesInstitution,
    quoteNamesInstitution,
    type InstitutionMatchContext,
    type InstitutionNames,
} from './review';

/** Recorded in the input fingerprint; change it when the gate's rule changes. */
export const AFFILIATION_GATE_VERSION = 'names-institution-v4';

/** Recorded in the input fingerprint; change it when the pre-filter changes. */
export const AFFILIATION_PREFILTER_VERSION = 'visible-text-v1';

/** Fields a gate-accepted citation can come from (owner and fullName never count). */
const NAMING_FIELDS = ['description', 'readme', 'homepage'] as const;

/**
 * True when some text the model is shown (the description, the visible README
 * excerpt, or the homepage) names the institution under the gate's rule. When
 * it is false, no citation can pass the gate, so the classifier skips the
 * model and stores prefilteredAffiliation() instead. This replaces upstream
 * repofinder's keyword score, limited to the fields this finder collects.
 */
export function visibleTextNamesInstitution(
    segments: Partial<Record<string, readonly string[]>>,
    institution: InstitutionNames,
    context: InstitutionMatchContext,
): boolean {
    return NAMING_FIELDS.some((field) =>
        (segments[field] ?? []).some((segment) =>
            quoteNamesInstitution(segment, institution, context, {
                homepage: field === 'homepage',
            }),
        ),
    );
}

/** The stored result for a repository the pre-filter keeps from the model. */
export function prefilteredAffiliation(
    institution: InstitutionNames,
): AffiliationResponse {
    return {
        decision: 'uncertain',
        relationship: 'insufficient_evidence',
        score: null,
        evidence: [],
        explanation: `Not sent to the model (pre-filter ${AFFILIATION_PREFILTER_VERSION}): no visible description, README, or homepage text names ${institution.fullName} under the evidence gate's rule (${AFFILIATION_GATE_VERSION}), so a supported answer could not be kept.`,
    };
}

export type AffiliationGateOutcome = {
    response: AffiliationResponse;
    /** The model's own response when the gate replaced it, otherwise null. */
    downgradedFrom: AffiliationResponse | null;
};

/**
 * Keeps a supported affiliation only when at least one accepted citation
 * names the institution (see citationNamesInstitution). Otherwise the result
 * becomes uncertain with a null score; the citations stay attached and the
 * explanation records the model's original decision and explanation.
 */
export function applyAffiliationEvidenceGate(
    response: AffiliationResponse,
    institution: InstitutionNames,
    context: InstitutionMatchContext,
    mode: AffiliationEvidenceGate,
): AffiliationGateOutcome {
    if (
        mode === 'off' ||
        response.decision !== 'supported' ||
        response.evidence.some((citation) =>
            citationNamesInstitution(citation, institution, context),
        )
    ) {
        return { response, downgradedFrom: null };
    }
    return {
        response: {
            decision: 'uncertain',
            relationship: 'insufficient_evidence',
            score: null,
            evidence: response.evidence,
            explanation: `Downgraded to uncertain by the affiliation evidence gate (${AFFILIATION_GATE_VERSION}): no accepted citation names ${institution.fullName} under that rule (alternate names count like the full name; a bare acronym needs the full name in the repository text or the acronym in the owner login; a domain counts in email addresses and the homepage; the owner login and repository name never count; evidence mentioning an excluded name never counts). The model answered supported (${response.relationship}, score ${response.score}). Model explanation: ${response.explanation}`,
        },
        downgradedFrom: response,
    };
}

/**
 * Fingerprint policy: the gate and pre-filter versions and every name they
 * match on, so editing a university's names reclassifies its rows. `off` keeps the
 * pre-gate key so older ungated rows stay reusable.
 */
export function affiliationGatePolicy(
    mode: AffiliationEvidenceGate,
    institution: InstitutionNames,
): Record<string, unknown> {
    if (mode === 'off') return {};
    const sorted = (values: readonly string[] | undefined) =>
        [...(values ?? [])]
            .map((value) => value.trim())
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return {
        affiliationEvidenceGate: AFFILIATION_GATE_VERSION,
        affiliationPrefilter: AFFILIATION_PREFILTER_VERSION,
        institutionNames: {
            fullName: institution.fullName.trim(),
            acronym: institution.acronym.trim(),
            emailDomains: sorted(institution.emailDomains),
            alternateNames: sorted(institution.alternateNames),
            excludedNames: sorted(institution.excludedNames),
        },
    };
}
