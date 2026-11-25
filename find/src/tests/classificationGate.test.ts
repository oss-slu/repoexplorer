import {
    AFFILIATION_GATE_VERSION,
    applyAffiliationEvidenceGate,
} from '../classification/gate';
import type { AffiliationResponse } from '../classification/contracts';
import {
    citationNamesInstitution,
    quoteNamesInstitution,
} from '../classification/review';
import type { UniversityConfiguration } from '../types/scraping';

const slu: UniversityConfiguration = {
    key: 'Saint Louis University',
    fullName: 'Saint Louis University',
    acronym: 'SLU',
    emailDomains: ['slu.edu'],
    excludedNames: ['Saint Louis University Baguio'],
};
const ucsc: UniversityConfiguration = {
    key: 'UC Santa Cruz',
    fullName: 'University of California, Santa Cruz',
    acronym: 'UCSC',
    emailDomains: ['ucsc.edu'],
    alternateNames: ['UC Santa Cruz'],
    excludedNames: ['University of Colombo School of Computing'],
};
const someone = { ownerLogin: 'someone' };
const sluOwner = { ownerLogin: 'oss-slu' };

describe('institution name matching', () => {
    // Each row is a case the live evaluation runs found or a known collision.
    test.each([
        [
            'full name, any case and punctuation',
            'built at SAINT-LOUIS university',
            someone,
            true,
        ],
        ['unrelated text', 'A general-purpose utility.', someone, false],
        [
            'email at the domain or a subdomain',
            'Contact maintainers@cs.slu.edu.',
            someone,
            true,
        ],
        [
            'email at a different domain',
            'Student email 2221816@slu.edu.ph',
            someone,
            false,
        ],
        [
            'domain inside a link',
            'Docs at https://cs.slu.edu/projects',
            someone,
            false,
        ],
        [
            'bare acronym, no other evidence',
            'The chemistry department at SLU',
            someone,
            false,
        ],
        [
            'acronym with the full name in the repository text',
            'The chemistry department at SLU',
            {
                ownerLogin: 'someone',
                repositoryText: 'Built at Saint Louis University.',
            },
            true,
        ],
        [
            'acronym vouched for by the owner login',
            'The chemistry department at SLU',
            sluOwner,
            true,
        ],
        [
            'acronym inside a longer login',
            'The chemistry department at SLU',
            { ownerLogin: 'asluser' },
            false,
        ],
        [
            'acronym collision: spoken language understanding',
            'Spoken Language Understanding (SLU) in PyTorch',
            someone,
            false,
        ],
        [
            'acronym collision: Saint Leo University',
            'Saint Leo University (SLU)',
            someone,
            false,
        ],
        [
            'acronym is case-sensitive and whole-word',
            'the slu helpers and SLUG parser',
            sluOwner,
            false,
        ],
        [
            'owner login occurrences are ignored',
            'git clone https://github.com/oss-slu/Mouser.git',
            sluOwner,
            false,
        ],
        [
            'an owner login that is part of the name does not hide it',
            'Built at Saint Louis University.',
            { ownerLogin: 'louis' },
            true,
        ],
        [
            'an owner login that is part of the domain does not hide an email',
            'Contact jdoe@slu.edu',
            { ownerLogin: 'edu' },
            true,
        ],
        [
            'an owner login that spells the name is ignored',
            'https://github.com/saint-louis-university/tools',
            { ownerLogin: 'saint-louis-university' },
            false,
        ],
        [
            'excluded name in the quote',
            'Saint Louis University Baguio | Team 404',
            someone,
            false,
        ],
        [
            'excluded name in the repository text',
            'A project for Saint Louis University.',
            {
                ownerLogin: 'someone',
                repositoryText:
                    'Our team at Saint Louis University, Baguio City.',
            },
            false,
        ],
    ])('%s', (_case, quote, context, expected) => {
        expect(quoteNamesInstitution(quote, slu, context)).toBe(expected);
    });

    test('alternate names count like the full name, and camelCase logins vouch for acronyms', () => {
        const course = {
            ownerLogin: 'someone',
            repositoryText: 'CMPM 121 at UC Santa Cruz.',
        };
        expect(
            quoteNamesInstitution('CMPM 121 at UC Santa Cruz', ucsc, course),
        ).toBe(true);
        expect(
            quoteNamesInstitution(
                'CMPM 121 at UC Santa Cruz',
                { ...ucsc, alternateNames: [] },
                course,
            ),
        ).toBe(false);
        expect(quoteNamesInstitution('The UCSC course', ucsc, course)).toBe(
            true,
        );
        expect(
            quoteNamesInstitution('The UCSC Genome Browser', ucsc, {
                ownerLogin: 'ucscGenomeBrowser',
            }),
        ).toBe(true);
        expect(
            quoteNamesInstitution('The UCSC Genome Browser', ucsc, {
                ownerLogin: 'ucscx',
            }),
        ).toBe(false);
    });

    test('owner and repository-name fields never count; the domain counts as the homepage host', () => {
        expect(
            citationNamesInstitution(
                { field: 'owner', quote: 'SLU' },
                slu,
                sluOwner,
            ),
        ).toBe(false);
        expect(
            citationNamesInstitution(
                {
                    field: 'fullName',
                    quote: 'slu/Saint-Louis-University-tools',
                },
                slu,
                sluOwner,
            ),
        ).toBe(false);
        expect(
            citationNamesInstitution(
                { field: 'homepage', quote: 'https://www.slu.edu/lab' },
                slu,
            ),
        ).toBe(true);
        expect(
            citationNamesInstitution(
                { field: 'readme', quote: 'https://www.slu.edu/lab' },
                slu,
            ),
        ).toBe(false);
        expect(
            citationNamesInstitution(
                { field: 'homepage', quote: 'https://www.slu.edu.ph' },
                slu,
            ),
        ).toBe(false);
    });
});

describe('affiliation evidence gate', () => {
    const supported = (
        evidence: AffiliationResponse['evidence'],
    ): AffiliationResponse => ({
        decision: 'supported',
        relationship: 'institutional_project',
        score: 0.95,
        evidence,
        explanation: 'Original model explanation.',
    });

    test('keeps support when any citation names the institution, and other decisions as they are', () => {
        const named = supported([
            { field: 'readme', quote: 'A tool.' },
            { field: 'readme', quote: 'Course at SLU' },
        ]);
        expect(
            applyAffiliationEvidenceGate(
                named,
                slu,
                sluOwner,
                'names_institution',
            ),
        ).toEqual({
            response: named,
            downgradedFrom: null,
        });
        const rejected: AffiliationResponse = {
            ...supported([]),
            decision: 'not_supported',
            relationship: 'incidental_mention',
            score: 0.1,
        };
        expect(
            applyAffiliationEvidenceGate(
                rejected,
                slu,
                sluOwner,
                'names_institution',
            ).response,
        ).toBe(rejected);
    });

    test('downgrades unnamed support to uncertain and records the original decision', () => {
        const response = supported([
            {
                field: 'readme',
                quote: 'git clone https://github.com/oss-slu/tool.git',
            },
            { field: 'owner', quote: 'oss-slu' },
        ]);
        const outcome = applyAffiliationEvidenceGate(
            response,
            slu,
            sluOwner,
            'names_institution',
        );
        expect(outcome.downgradedFrom).toBe(response);
        expect(outcome.response).toMatchObject({
            decision: 'uncertain',
            relationship: 'insufficient_evidence',
            score: null,
            evidence: response.evidence,
        });
        expect(outcome.response.explanation).toContain(
            AFFILIATION_GATE_VERSION,
        );
        expect(outcome.response.explanation).toContain(
            'supported (institutional_project, score 0.95)',
        );
        expect(outcome.response.explanation).toContain(
            'Original model explanation.',
        );
        expect(
            applyAffiliationEvidenceGate(response, slu, sluOwner, 'off')
                .downgradedFrom,
        ).toBeNull();
    });
});
