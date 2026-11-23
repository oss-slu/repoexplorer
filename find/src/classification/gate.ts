import type { AffiliationEvidenceGate } from '../types/scraping';
import type { AffiliationResponse } from './contracts';
import {
    citationNamesInstitution,
    type InstitutionMatchContext,
    type InstitutionNames,
} from './review';

/** Recorded in the input fingerprint; change it when the gate's rule changes. */
export const AFFILIATION_GATE_VERSION = 'names-institution-v3';

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

/** Fingerprint policy; `off` keeps the pre-gate key so older ungated rows stay reusable. */
export function affiliationGatePolicy(
    mode: AffiliationEvidenceGate,
): Record<string, unknown> {
    return mode === 'off'
        ? {}
        : { affiliationEvidenceGate: AFFILIATION_GATE_VERSION };
}
