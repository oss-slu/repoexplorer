import {
    parseAffiliationResponse,
    parseProjectTypeResponse,
    repairCitations,
    resolveEvidenceReferences,
    validateCitations,
} from '../classification/response';
import type { EvidenceReference } from '../classification/evidence';

const affiliation = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
        decision: 'supported',
        relationship: 'coursework',
        score: 0.4,
        evidence: [{ field: 'readme', quote: 'Course 101 at SLU' }],
        explanation:
            'The README identifies a course assignment at the institution.',
        ...overrides,
    });

describe('response contract', () => {
    test('accepts valid replies, including fenced JSON', () => {
        expect(parseAffiliationResponse(affiliation()).decision).toBe(
            'supported',
        );
        expect(
            parseProjectTypeResponse(
                '```json\n{"category":"DATA","evidence":[{"field":"readme","quote":"dataset"}],"explanation":"A dataset."}\n```',
            ).category,
        ).toBe('DATA');
    });

    test.each([
        ['malformed JSON', '{"decision":"supported"', 'invalid_json'],
        ['an unknown field', affiliation({ extra: true }), 'invalid_schema'],
        [
            'an unknown relationship',
            affiliation({ relationship: 'other' }),
            'invalid_schema',
        ],
        ['a score above 1', affiliation({ score: 1.01 }), 'invalid_schema'],
        ['a string score', affiliation({ score: '0.4' }), 'invalid_schema'],
        [
            'uncertain with a score',
            affiliation({
                decision: 'uncertain',
                relationship: 'insufficient_evidence',
                score: 0,
            }),
            'contradictory_response',
        ],
        [
            'supported with insufficient evidence',
            affiliation({ relationship: 'insufficient_evidence' }),
            'contradictory_response',
        ],
        [
            'supported without a citation',
            affiliation({ evidence: [] }),
            'contradictory_response',
        ],
    ])('rejects %s', (_case, text, code) => {
        expect(() => parseAffiliationResponse(text)).toThrow(
            expect.objectContaining({ code }),
        );
    });

    test('marks only a null score on a positive decision as a missing score', () => {
        expect(() =>
            parseAffiliationResponse(affiliation({ score: null })),
        ).toThrow(
            expect.objectContaining({
                code: 'invalid_schema',
                detail: 'missing_score',
            }),
        );
        expect(() =>
            parseAffiliationResponse(affiliation({ score: 1.5 })),
        ).toThrow(
            expect.objectContaining({ code: 'invalid_schema', detail: null }),
        );
    });
});

describe('citations', () => {
    test('require an exact quote from the named visible field and explain each failure', () => {
        const exact = '## Café — `npm run build`';
        expect(() =>
            validateCitations([{ field: 'readme', quote: exact }], {
                readme: [`before\n${exact}\nafter`],
            }),
        ).not.toThrow();
        expect(() =>
            validateCitations(
                [{ field: 'readme', quote: '## Cafe — `npm run build`' }],
                { readme: [exact] },
            ),
        ).toThrow(expect.objectContaining({ code: 'invalid_citation' }));

        expect(() =>
            validateCitations(
                [
                    { field: 'missing', quote: 'anything' },
                    { field: 'description', quote: 'anything' },
                    { field: 'readme', quote: 'not in the visible excerpt' },
                    { field: 'homepage', quote: 'Exact README quote' },
                ],
                {
                    description: [],
                    readme: ['Exact README quote'],
                    homepage: ['https://example.test'],
                },
            ),
        ).toThrow(
            expect.objectContaining({
                code: 'invalid_citation',
                citationDiagnostics: [
                    expect.objectContaining({
                        citationIndex: 1,
                        reason: 'source_field_missing',
                    }),
                    expect.objectContaining({
                        citationIndex: 2,
                        reason: 'empty_source',
                    }),
                    expect.objectContaining({
                        citationIndex: 3,
                        reason: 'quote_absent_from_visible_segments',
                    }),
                    expect.objectContaining({
                        citationIndex: 4,
                        reason: 'quote_matches_other_field',
                        matchingFields: ['readme'],
                    }),
                ],
            }),
        );
    });

    test('resolve evidence IDs to exact quotes and reject unknown, duplicate, or ineligible IDs', () => {
        const catalog: EvidenceReference[] = [
            {
                id: 'E0001',
                field: 'readme',
                segmentIndex: 0,
                startOffset: 0,
                endOffset: 17,
                text: 'Course 101 at SLU',
            },
        ];
        const wire = (evidenceIds: string[]) =>
            JSON.stringify({
                decision: 'supported',
                relationship: 'coursework',
                score: 0.8,
                evidenceIds,
                explanation: 'The source identifies course work.',
            });
        expect(
            parseAffiliationResponse(
                resolveEvidenceReferences(
                    wire(['E0001']),
                    catalog,
                    'affiliation',
                ),
            ).evidence,
        ).toEqual([{ field: 'readme', quote: 'Course 101 at SLU' }]);
        for (const ids of [['E9999'], ['E0001', 'E0001']]) {
            expect(() =>
                resolveEvidenceReferences(wire(ids), catalog, 'affiliation'),
            ).toThrow(
                expect.objectContaining({ code: 'invalid_evidence_reference' }),
            );
        }
        expect(() =>
            resolveEvidenceReferences(
                JSON.stringify({
                    category: 'DEV',
                    evidenceIds: ['E0001'],
                    explanation: 'A tool.',
                }),
                [{ ...catalog[0]!, field: 'owner' }],
                'project_type',
            ),
        ).toThrow(
            expect.objectContaining({ code: 'invalid_evidence_reference' }),
        );
    });

    describe('repair', () => {
        const segments = {
            fullName: ['slu/course-tool'],
            owner: ['slu'],
            description: ['A course tool'],
            readme: ['Built for CS 101 at Saint Louis University.'],
            homepage: [],
        };
        const fields = [
            'fullName',
            'owner',
            'description',
            'readme',
            'homepage',
        ] as const;

        test('relabels a quote found in exactly one other field and drops unverifiable ones', () => {
            const result = repairCitations(
                [
                    { field: 'description', quote: 'Saint Louis University' },
                    { field: 'homepage', quote: 'https://slu.edu' },
                    { field: 'readme', quote: 'not in the text' },
                    { field: 'description', quote: 'slu' },
                ],
                { ...segments, description: ['A tool'] },
                fields,
            );
            expect(result.citations).toEqual([
                { field: 'readme', quote: 'Saint Louis University' },
            ]);
            expect(
                result.repairs.map((repair) => [
                    repair.citationIndex,
                    repair.action,
                    repair.reason,
                ]),
            ).toEqual([
                [1, 'relabeled', 'quote_matches_other_field'],
                [2, 'dropped', 'empty_source'],
                [3, 'dropped', 'quote_absent_from_visible_segments'],
                // Found in two other fields (fullName and owner): dropped, not guessed.
                [4, 'dropped', 'quote_matches_other_field'],
            ]);
        });

        test('fails as strict validation would when no verified citation remains', () => {
            expect(() =>
                repairCitations(
                    [
                        { field: 'homepage', quote: 'https://slu.edu' },
                        { field: 'readme', quote: 'not in the text' },
                    ],
                    segments,
                    fields,
                ),
            ).toThrow(expect.objectContaining({ code: 'invalid_citation' }));
        });
    });
});
