import { validateClassificationConfiguration, loadScrapingConfiguration } from '../config';
import {
    AFFILIATION_GATE_VERSION,
    affiliationGatePolicy,
    applyAffiliationEvidenceGate,
} from '../classification/gate';
import type { AffiliationResponse } from '../classification/contracts';
import {
    citationNamesInstitution,
    matchContextFor,
    quoteNamesInstitution,
} from '../classification/review';
import type { UniversityConfiguration } from '../types/scraping';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const institution: UniversityConfiguration = {
    key: 'Saint Louis University',
    fullName: 'Saint Louis University',
    acronym: 'SLU',
    emailDomains: ['slu.edu'],
    excludedNames: ['Saint Louis University Baguio'],
};
const unrelatedOwner = { ownerLogin: 'someone' };
const sluOwner = { ownerLogin: 'oss-slu' };

function supported(
    evidence: AffiliationResponse['evidence'],
): AffiliationResponse {
    return {
        decision: 'supported',
        relationship: 'institutional_project',
        score: 0.95,
        evidence,
        explanation: 'Original model explanation.',
    };
}

describe('institution name matching (names-institution-v3)', () => {
    test.each([
        ['Built at Saint Louis University.', true],
        ['built at SAINT-LOUIS university', true],
        ['A general-purpose utility.', false],
        ['Contact maintainers@slu.edu', true],
        ['Contact maintainers@cs.slu.edu.', true],
        ['Student email 2221816@slu.edu.ph', false],
        ['Docs at https://cs.slu.edu/projects', false],
        ['Code from http://www.eas.slu.edu/eqc/eqccps.html', false],
        ['notslu@slu.education', false],
    ])('%p names the institution: %p', (quote, expected) => {
        expect(quoteNamesInstitution(quote, institution, unrelatedOwner)).toBe(expected);
    });

    test('alternate names count like the full name and vouch for the acronym', () => {
        const ucsc = {
            fullName: 'University of California, Santa Cruz',
            acronym: 'UCSC',
            emailDomains: ['ucsc.edu'],
            alternateNames: ['UC Santa Cruz'],
            excludedNames: ['University of Colombo School of Computing'],
        };
        const owner = { ownerLogin: 'someone', repositoryText: 'Starter code for CMPM 121 at UC Santa Cruz.' };
        expect(quoteNamesInstitution('CMPM 121 at UC Santa Cruz', ucsc, owner)).toBe(true);
        expect(quoteNamesInstitution('CMPM 121 at UC Santa Cruz', { ...ucsc, alternateNames: [] }, owner)).toBe(false);
        expect(quoteNamesInstitution('The UCSC course', ucsc, owner)).toBe(true);
        expect(
            quoteNamesInstitution('Notes from UCSC', ucsc, {
                ownerLogin: 'someone',
                repositoryText: 'UC Santa Cruz, University of Colombo School of Computing',
            }),
        ).toBe(false);
    });

    test.each([
        ['ucscGenomeBrowser', true],
        ['BrooksLabUCSC', true],
        ['UCSC-notes', true],
        ['ucscx', false],
        ['Ucscx', false],
    ])('owner login %p vouches for the acronym: %p', (ownerLogin, expected) => {
        const ucsc = { fullName: 'University of California, Santa Cruz', acronym: 'UCSC' };
        expect(
            quoteNamesInstitution('The UCSC Genome Browser source', ucsc, {
                ownerLogin,
                repositoryText: 'The UCSC Genome Browser source',
            }),
        ).toBe(expected);
    });

    test('a bare acronym needs the full name in the repository text or the acronym in the owner login', () => {
        const quote = 'The chemistry department at SLU uses scantrons.';
        expect(quoteNamesInstitution(quote, institution, unrelatedOwner)).toBe(false);
        expect(
            quoteNamesInstitution(quote, institution, {
                ownerLogin: 'someone',
                repositoryText: `${quote}\nBuilt at Saint Louis University.`,
            }),
        ).toBe(true);
        expect(quoteNamesInstitution(quote, institution, sluOwner)).toBe(true);
        expect(quoteNamesInstitution(quote, institution, { ownerLogin: 'SLU-TMI' })).toBe(true);
        // The acronym must be a whole token of the login, not a substring.
        expect(quoteNamesInstitution(quote, institution, { ownerLogin: 'asluser' })).toBe(false);
    });

    test('acronym collisions do not pass on their own', () => {
        for (const quote of [
            'End-to-End Spoken Language Understanding (SLU) in PyTorch',
            'Saint Leo University (SLU)',
            'Swedish University of Agricultural Sciences (SLU)',
            "maintained by SLU's English department",
        ]) {
            expect(quoteNamesInstitution(quote, institution, unrelatedOwner)).toBe(false);
        }
    });

    test('keeps whole-word, case-sensitive acronym matching', () => {
        for (const quote of ['the slu helpers', 'SLUG parser', 'ASLU and SLU2']) {
            expect(quoteNamesInstitution(quote, institution, sluOwner)).toBe(false);
        }
        expect(quoteNamesInstitution('(SLU)', institution, sluOwner)).toBe(true);
    });

    test('ignores the owner login, which every repository in the org shares', () => {
        for (const quote of [
            '# OSS-SLU Kubernetes Cluster',
            'git clone https://github.com/oss-slu/Mouser.git',
            'Docs at https://oss-slu.github.io/Pi4Micronaut/',
        ]) {
            expect(quoteNamesInstitution(quote, institution, sluOwner)).toBe(false);
        }
        expect(
            quoteNamesInstitution(
                'Developed through Open Source with SLU (https://github.com/oss-slu)',
                institution,
                sluOwner,
            ),
        ).toBe(true);
    });

    test('never accepts the owner or repository-name fields, and accepts the domain as the homepage host', () => {
        expect(
            citationNamesInstitution(
                { field: 'fullName', quote: 'slu/Saint-Louis-University-tools' },
                institution,
                sluOwner,
            ),
        ).toBe(false);
        expect(
            citationNamesInstitution({ field: 'owner', quote: 'SLU' }, institution, sluOwner),
        ).toBe(false);
        expect(
            citationNamesInstitution({ field: 'homepage', quote: 'https://www.slu.edu/lab' }, institution),
        ).toBe(true);
        expect(
            citationNamesInstitution({ field: 'readme', quote: 'https://www.slu.edu/lab' }, institution),
        ).toBe(false);
        expect(
            citationNamesInstitution({ field: 'homepage', quote: 'https://www.slu.edu.ph' }, institution),
        ).toBe(false);
    });

    test('rejects evidence when the quote or the repository text mentions an excluded name', () => {
        expect(
            quoteNamesInstitution('Saint Louis University Baguio | Team 404', institution, unrelatedOwner),
        ).toBe(false);
        expect(
            quoteNamesInstitution('A project for Saint Louis University.', institution, {
                ownerLogin: 'someone',
                repositoryText: 'Our team at Saint Louis University, Baguio City.',
            }),
        ).toBe(false);
        expect(
            quoteNamesInstitution('A project for Saint Louis University.', {
                ...institution,
                excludedNames: undefined,
            }, unrelatedOwner),
        ).toBe(true);
    });

    test('builds a context from a candidate', () => {
        expect(
            matchContextFor({ owner: 'oss-slu', description: 'd', readme: null, homepage: 'h' }),
        ).toEqual({ ownerLogin: 'oss-slu', repositoryText: 'd\nh' });
    });
});

describe('affiliation evidence gate', () => {
    test('keeps support when one citation names the institution', () => {
        const response = supported([
            { field: 'readme', quote: 'A tool.' },
            { field: 'readme', quote: 'Course at SLU' },
        ]);
        expect(
            applyAffiliationEvidenceGate(response, institution, sluOwner, 'names_institution'),
        ).toEqual({ response, downgradedFrom: null });
    });

    test('downgrades support whose citations never name the institution', () => {
        const response = supported([
            { field: 'readme', quote: 'git clone https://github.com/oss-slu/tool.git' },
            { field: 'owner', quote: 'oss-slu' },
        ]);
        const outcome = applyAffiliationEvidenceGate(
            response,
            institution,
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
        expect(outcome.response.explanation).toContain(AFFILIATION_GATE_VERSION);
        expect(outcome.response.explanation).toContain(
            'supported (institutional_project, score 0.95)',
        );
        expect(outcome.response.explanation).toContain('Original model explanation.');
    });

    test('accepts a matching email address', () => {
        const response = supported([{ field: 'readme', quote: 'Email help@slu.edu' }]);
        expect(
            applyAffiliationEvidenceGate(response, institution, unrelatedOwner, 'names_institution')
                .downgradedFrom,
        ).toBeNull();
    });

    test('leaves other decisions and the disabled gate unchanged', () => {
        const unnamed = supported([{ field: 'readme', quote: 'A tool.' }]);
        expect(
            applyAffiliationEvidenceGate(unnamed, institution, sluOwner, 'off'),
        ).toEqual({ response: unnamed, downgradedFrom: null });
        const rejected: AffiliationResponse = {
            ...unnamed,
            decision: 'not_supported',
            relationship: 'incidental_mention',
            score: 0.1,
        };
        expect(
            applyAffiliationEvidenceGate(rejected, institution, sluOwner, 'names_institution')
                .response,
        ).toBe(rejected);
    });

    test('is on by default, validated, and part of the fingerprint only when on', () => {
        expect(validateClassificationConfiguration({}).affiliationEvidenceGate).toBe(
            'names_institution',
        );
        expect(
            validateClassificationConfiguration({ affiliationEvidenceGate: 'off' })
                .affiliationEvidenceGate,
        ).toBe('off');
        expect(() =>
            validateClassificationConfiguration({ affiliationEvidenceGate: true }),
        ).toThrow(/affiliationEvidenceGate must be names_institution or off/);
        expect(affiliationGatePolicy('off')).toEqual({});
        expect(affiliationGatePolicy('names_institution')).toEqual({
            affiliationEvidenceGate: 'names-institution-v3',
        });
    });

    test('reads and validates excludedNames from the universities configuration', async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'gate-config-'));
        try {
            const write = async (excludedNames: unknown) => {
                const file = path.join(directory, `config-${Math.random()}.json`);
                await writeFile(
                    file,
                    JSON.stringify({
                        universities: [
                            {
                                key: 'Saint Louis University',
                                fullName: 'Saint Louis University',
                                acronym: 'SLU',
                                excludedNames,
                                queries: { repositories: 'q' },
                            },
                        ],
                    }),
                );
                return file;
            };
            const loaded = await loadScrapingConfiguration(
                await write(['Saint Louis University Baguio']),
            );
            expect(loaded.universities[0]?.excludedNames).toEqual([
                'Saint Louis University Baguio',
            ]);
            await expect(loadScrapingConfiguration(await write([1]))).rejects.toThrow(
                /excludedNames/,
            );
            const withAlternates = path.join(directory, 'alternates.json');
            const university = {
                key: 'UC Santa Cruz',
                fullName: 'University of California, Santa Cruz',
                acronym: 'UCSC',
                queries: { repositories: 'q' },
            };
            await writeFile(
                withAlternates,
                JSON.stringify({ universities: [{ ...university, alternateNames: ['UC Santa Cruz'] }] }),
            );
            expect(
                (await loadScrapingConfiguration(withAlternates)).universities[0]?.alternateNames,
            ).toEqual(['UC Santa Cruz']);
            await writeFile(
                withAlternates,
                JSON.stringify({ universities: [{ ...university, alternateNames: 'UC Santa Cruz' }] }),
            );
            await expect(loadScrapingConfiguration(withAlternates)).rejects.toThrow(/alternateNames/);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
