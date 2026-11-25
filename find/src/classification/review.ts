import type {
    AffiliationResponse,
    ProjectType,
} from './contracts';
import type { UniversityConfiguration } from '../types/scraping';

export type SemanticReviewReason =
    | 'coursework_project_type_mismatch'
    | 'coursework_relationship_mismatch'
    | 'supported_affiliation_without_explicit_relationship_evidence';

export type SemanticReviewResult = {
    required: boolean;
    reasons: SemanticReviewReason[];
    blocksPersistence: false;
};

export function reviewClassificationSemantics(
    affiliation:
        | (Pick<AffiliationResponse, 'decision' | 'relationship'> &
              Partial<Pick<AffiliationResponse, 'evidence'>>)
        | null,
    projectType: ProjectType | null,
    institution?: InstitutionNames,
    context?: InstitutionMatchContext,
): SemanticReviewResult {
    const reasons: SemanticReviewReason[] = [];
    if (
        affiliation?.decision === 'supported' &&
        affiliation.relationship === 'coursework' &&
        projectType !== null &&
        projectType !== 'EDU'
    ) {
        reasons.push('coursework_project_type_mismatch');
    }
    if (affiliation?.decision === 'supported') {
        const evidence = affiliation.evidence ?? [];
        if (
            affiliation.relationship !== 'coursework' &&
            evidence.some((citation) => COURSEWORK_EVIDENCE.test(citation.quote))
        ) {
            reasons.push('coursework_relationship_mismatch');
        }
        if (
            institution &&
            !evidence.some(
                (citation) =>
                    citationNamesInstitution(citation, institution, context) &&
                    INSTITUTIONAL_RELATIONSHIP.test(citation.quote),
            )
        ) {
            reasons.push(
                'supported_affiliation_without_explicit_relationship_evidence',
            );
        }
    }
    return {
        required: reasons.length > 0,
        reasons,
        blocksPersistence: false,
    };
}

const COURSEWORK_EVIDENCE =
    /\b(?:coursework|course\s+(?:assignment|project|at|for)|class\s+(?:assignment|project)|for\s+[a-z]{2,}\d{2,}\s+course)\b/i;

const INSTITUTIONAL_RELATIONSHIP =
    /\b(?:coursework|course\s+(?:assignment|project|at|for)|class\s+(?:assignment|project)|student\s+(?:organization|team|club)|research\s+(?:group|lab)|laboratory|department|official|affiliated|affiliation|member|employee|employed|staff|maintainer|belongs?\s+to|owned\s+by|project\s+(?:of|at|for|by|from))\b/i;

export type InstitutionNames = Pick<
    UniversityConfiguration,
    'fullName' | 'acronym' | 'emailDomains' | 'alternateNames' | 'excludedNames'
>;

/**
 * Where a citation comes from. The owner login is removed from quotes and may
 * vouch for an acronym; the repository's own text (description, README,
 * homepage) may vouch for an acronym and can trigger an excluded name.
 */
export type InstitutionMatchContext = {
    ownerLogin?: string;
    repositoryText?: string;
};

/** Fields that identify the account or repository rather than describe it. */
const IDENTIFIER_FIELDS = new Set(['owner', 'fullName']);

/** Acronyms up to this length match case-sensitively, so "SLU" never matches "slu". */
const SHORT_ACRONYM_MAX_LENGTH = 4;

export function matchContextFor(candidate: {
    owner: string;
    description: string | null;
    readme: string | null;
    homepage: string | null;
}): InstitutionMatchContext {
    return {
        ownerLogin: candidate.owner,
        repositoryText: [candidate.description, candidate.readme, candidate.homepage]
            .filter((value): value is string => Boolean(value))
            .join('\n'),
    };
}

/**
 * True when a citation names the target institution (rule
 * names-institution-v4):
 * - its full name or one of its alternate names, ignoring case and
 *   punctuation;
 * - an email address at one of its domains, or the domain as the host of
 *   the repository's declared homepage (a domain in other URLs is usually a
 *   reference to someone else's software, not affiliation);
 * - its acronym as a whole word (case-sensitive when short), but only when
 *   the repository's own text also contains the full name (or an alternate
 *   name) or the owner login contains the acronym as a token (logins are
 *   split on punctuation and camelCase, so `ucscGenomeBrowser` has `ucsc`). Acronyms collide with other
 *   institutions and terms, such as "spoken language understanding".
 * Nothing counts when the quote or the repository text contains one of the
 * institution's excluded names (a different institution with a similar
 * name). Citations from the owner or fullName fields never count, and the
 * owner login, as a whole token, never supplies the acronym or a name it
 * spells itself: an organization login is shared by every repository it
 * owns, so it is not evidence about this one.
 */
export function citationNamesInstitution(
    citation: { field: string; quote: string },
    institution: InstitutionNames,
    context: InstitutionMatchContext = {},
): boolean {
    if (IDENTIFIER_FIELDS.has(citation.field)) return false;
    return quoteNamesInstitution(citation.quote, institution, context, {
        homepage: citation.field === 'homepage',
    });
}

export function quoteNamesInstitution(
    quote: string,
    institution: InstitutionNames,
    context: InstitutionMatchContext = {},
    options: { homepage?: boolean } = {},
): boolean {
    const ownerLogin = context.ownerLogin?.trim() ?? '';
    // An organization login appears in every repository's URLs and badges.
    // Remove it as a whole token (never inside a longer word), and only where
    // it could produce the match: before acronym matching, and before name
    // matching when the login itself spells that name.
    const stripOwner = (value: string) =>
        ownerLogin === ''
            ? value
            : value.replace(
                  new RegExp(
                      `(?<![\\p{L}\\p{N}])${escapeRegExp(ownerLogin)}(?![\\p{L}\\p{N}])`,
                      'giu',
                  ),
                  ' ',
              );
    const ownerNormalized = ` ${normalizeForMatching(ownerLogin)} `;
    const namesIn = (value: string) =>
        [institution.fullName, ...(institution.alternateNames ?? [])].some(
            (name) =>
                containsFullName(
                    ownerNormalized.includes(` ${normalizeForMatching(name)} `)
                        ? stripOwner(value)
                        : value,
                    name,
                ),
        );
    const repositoryText = context.repositoryText ?? '';
    if (
        mentionsExcludedName(quote, institution) ||
        mentionsExcludedName(repositoryText, institution)
    ) {
        return false;
    }
    if (namesIn(quote)) return true;
    // Logins cannot contain a dot, so they never form an email domain.
    if (namesEmailDomain(quote, institution, options.homepage === true)) {
        return true;
    }
    const acronym = institution.acronym.trim();
    if (acronym.length < 2) return false;
    const pattern = new RegExp(
        `(?<![\\p{L}\\p{N}_])${escapeRegExp(acronym)}(?![\\p{L}\\p{N}_])`,
        acronym.length <= SHORT_ACRONYM_MAX_LENGTH ? 'u' : 'iu',
    );
    if (!pattern.test(stripOwner(quote))) return false;
    return (
        namesIn(repositoryText) ||
        loginTokens(ownerLogin).includes(acronym.toLowerCase())
    );
}

/** Splits a login on punctuation and camelCase: `BrooksLabUCSC` -> brooks, lab, ucsc. */
function loginTokens(login: string): string[] {
    return login
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token !== '');
}

function containsFullName(text: string, fullName: string): boolean {
    const name = normalizeForMatching(fullName);
    return name.length >= 3 && ` ${normalizeForMatching(text)} `.includes(` ${name} `);
}

function mentionsExcludedName(text: string, institution: InstitutionNames): boolean {
    if (text === '') return false;
    const normalized = ` ${normalizeForMatching(text)} `;
    return (institution.excludedNames ?? []).some((name) => {
        const excluded = normalizeForMatching(name);
        return excluded.length >= 3 && normalized.includes(` ${excluded} `);
    });
}

function namesEmailDomain(
    text: string,
    institution: InstitutionNames,
    allowUrlHost: boolean,
): boolean {
    return (institution.emailDomains ?? []).some((domain) => {
        const trimmed = escapeRegExp(domain.trim().replace(/^@/, ''));
        if (trimmed === '') return false;
        // The domain must end the host name: `slu.edu.ph` is a different
        // institution's domain, while a sentence-ending period is fine.
        const end = '(?![a-z0-9-]|\\.[a-z0-9])';
        if (new RegExp(`@(?:[a-z0-9-]+\\.)*${trimmed}${end}`, 'i').test(text)) {
            return true;
        }
        return (
            allowUrlHost &&
            new RegExp(
                `^(?:https?://)?(?:[a-z0-9-]+\\.)*${trimmed}${end}`,
                'i',
            ).test(text.trim())
        );
    });
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeForMatching(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('en-US')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}
