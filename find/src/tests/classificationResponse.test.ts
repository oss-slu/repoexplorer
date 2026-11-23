import {
    parseAffiliationResponse,
    parseProjectTypeResponse,
    repairCitations,
    resolveEvidenceReferences,
    validateCitations,
} from '../classification/response';
import type { EvidenceReference } from '../classification/evidence';

describe('classifier response validation', () => {
    test('accepts supported affiliation and project type responses', () => {
        expect(parseAffiliationResponse(affiliation()).decision).toBe(
            'supported',
        );
        expect(
            parseProjectTypeResponse(
                JSON.stringify({
                    category: 'DATA',
                    evidence: [{ field: 'readme', quote: 'analysis dataset' }],
                    explanation: 'The repository primarily distributes an analysis dataset.',
                }),
            ).category,
        ).toBe('DATA');
    });

    test('preserves fenced JSON compatibility but does not repair malformed quotes', () => {
        expect(
            parseProjectTypeResponse(
                `\`\`\`json\n${projectType()}\n\`\`\``,
            ).category,
        ).toBe('DEV');
        expect(() => parseAffiliationResponse('{"decision":"supported"')).toThrow(
            /JSON/,
        );
    });

    test('rejects unknown fields, invalid enums, and malformed response fields', () => {
        expect(() =>
            parseAffiliationResponse(
                JSON.stringify({ ...JSON.parse(affiliation()), extra: true }),
            ),
        ).toThrow(/unknown fields/);
        expect(() =>
            parseAffiliationResponse(
                JSON.stringify({
                    ...JSON.parse(affiliation()),
                    relationship: 'other',
                }),
            ),
        ).toThrow(/relationship/);
        expect(() =>
            parseProjectTypeResponse(
                JSON.stringify({
                    category: 'MISC',
                    evidence: [],
                    explanation: 'Reason',
                }),
            ),
        ).toThrow(/category/);
        expect(() => parseAffiliationResponse('not json')).toThrow(
            expect.objectContaining({ code: 'invalid_json' }),
        );
    });

    test.each([NaN, Infinity, -0.01, 1.01, '0.4'])('rejects invalid score %p', (score) => {
        const response = JSON.parse(affiliation()) as Record<string, unknown>;
        response.score = score;
        expect(() => parseAffiliationResponse(JSON.stringify(response))).toThrow();
    });

    test('requires uncertainty to have a null score and positive decisions to have consistent relationships', () => {
        const uncertain = JSON.parse(affiliation()) as Record<string, unknown>;
        uncertain.decision = 'uncertain';
        uncertain.relationship = 'insufficient_evidence';
        uncertain.score = 0;
        expect(() => parseAffiliationResponse(JSON.stringify(uncertain))).toThrow(
            expect.objectContaining({ code: 'contradictory_response' }),
        );

        const unsupported = JSON.parse(affiliation()) as Record<string, unknown>;
        unsupported.relationship = 'insufficient_evidence';
        expect(() => parseAffiliationResponse(JSON.stringify(unsupported))).toThrow(
            expect.objectContaining({ code: 'contradictory_response' }),
        );

        const noCitation = JSON.parse(affiliation()) as Record<string, unknown>;
        noCitation.evidence = [];
        expect(() => parseAffiliationResponse(JSON.stringify(noCitation))).toThrow(
            expect.objectContaining({ code: 'contradictory_response' }),
        );
    });

    test('validates exact citation text and rejects wrong-field or fabricated quotes', () => {
        const citations = [{ field: 'readme', quote: 'Course 101 at SLU' }];
        expect(() =>
            validateCitations(citations, {
                readme: ['Course 101 at SLU'],
                description: ['Course 101'],
            }),
        ).not.toThrow();
        expect(() =>
            validateCitations(
                [{ field: 'description', quote: 'Course 101 at SLU' }],
                { description: ['Course 101'] },
            ),
        ).toThrow(expect.objectContaining({ code: 'invalid_citation' }));
        expect(() =>
            validateCitations(
                [{ field: 'readme', quote: 'Course 101 is official' }],
                { readme: ['Course 101 at SLU'] },
            ),
        ).toThrow(expect.objectContaining({ code: 'invalid_citation' }));
    });

    test('explains citation failures without accepting a cross-field match', () => {
        const wrongField = [{ field: 'description', quote: 'Exact README quote' }];
        try {
            validateCitations(wrongField, {
                description: ['A shorter description'],
                readme: ['Exact README quote'],
            });
            throw new Error('Expected the wrong-field quote to be rejected');
        } catch (error) {
            expect(error).toMatchObject({
                code: 'invalid_citation',
                citationDiagnostics: [{
                    citationIndex: 1,
                    declaredField: 'description',
                    reason: 'quote_matches_other_field',
                    matchingFields: ['readme'],
                }],
            });
        }
    });

    test('distinguishes missing, empty, and absent-visible-source failures', () => {
        const citations = [
            { field: 'missing', quote: 'anything' },
            { field: 'description', quote: 'anything' },
            { field: 'readme', quote: 'not in visible excerpt' },
        ];
        try {
            validateCitations(citations, {
                description: [],
                readme: ['Only the first and last excerpt are visible'],
            });
            throw new Error('Expected unavailable evidence to be rejected');
        } catch (error) {
            expect(error).toMatchObject({
                code: 'invalid_citation',
                citationDiagnostics: [
                    { citationIndex: 1, reason: 'source_field_missing' },
                    { citationIndex: 2, reason: 'empty_source' },
                    { citationIndex: 3, reason: 'quote_absent_from_visible_segments' },
                ],
            });
        }
    });

    test('accepts exact Unicode, Markdown, and code punctuation without fuzzy matching', () => {
        const exact = '## Café — `npm run build`';
        expect(() =>
            validateCitations(
                [{ field: 'readme', quote: exact }],
                { readme: [`before\n${exact}\nafter`] },
            ),
        ).not.toThrow();
        expect(() =>
            validateCitations(
                [{ field: 'readme', quote: '## Cafe — `npm run build`' }],
                { readme: [`before\n${exact}\nafter`] },
            ),
        ).toThrow(expect.objectContaining({ code: 'invalid_citation' }));
    });

    test('resolves evidence IDs to canonical exact quotes and rejects unknown or duplicate IDs', () => {
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
        const wireResponse = JSON.stringify({
            decision: 'supported',
            relationship: 'coursework',
            score: 0.8,
            evidenceIds: ['E0001'],
            explanation: 'The source identifies course work.',
        });
        const canonical = resolveEvidenceReferences(
            wireResponse,
            catalog,
            'affiliation',
        );
        expect(parseAffiliationResponse(canonical).evidence).toEqual([
            { field: 'readme', quote: 'Course 101 at SLU' },
        ]);
        expect(() =>
            resolveEvidenceReferences(
                JSON.stringify({
                    ...JSON.parse(wireResponse),
                    evidenceIds: ['E9999'],
                }),
                catalog,
                'affiliation',
            ),
        ).toThrow(expect.objectContaining({ code: 'invalid_evidence_reference' }));
        expect(() =>
            resolveEvidenceReferences(
                JSON.stringify({
                    ...JSON.parse(wireResponse),
                    evidenceIds: ['E0001', 'E0001'],
                }),
                catalog,
                'affiliation',
            ),
        ).toThrow(expect.objectContaining({ code: 'invalid_evidence_reference' }));
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
        ).toThrow(expect.objectContaining({ code: 'invalid_evidence_reference' }));
    });

    describe('citation repair', () => {
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

        test('leaves valid citations unchanged', () => {
            const citations = [{ field: 'readme' as const, quote: 'CS 101' }];
            expect(repairCitations(citations, segments, fields)).toEqual({
                citations,
                repairs: [],
            });
        });

        test('relabels a quote found in exactly one other allowed field', () => {
            expect(
                repairCitations(
                    [{ field: 'description', quote: 'Saint Louis University' }],
                    segments,
                    fields,
                ),
            ).toEqual({
                citations: [{ field: 'readme', quote: 'Saint Louis University' }],
                repairs: [
                    {
                        citationIndex: 1,
                        action: 'relabeled',
                        reason: 'quote_matches_other_field',
                        declaredField: 'description',
                        repairedField: 'readme',
                    },
                ],
            });
        });

        test('drops empty-source and absent quotes while a verified citation remains', () => {
            const result = repairCitations(
                [
                    { field: 'homepage', quote: 'https://slu.edu' },
                    { field: 'readme', quote: 'CS 101' },
                    { field: 'readme', quote: 'not in the text' },
                ],
                segments,
                fields,
            );
            expect(result.citations).toEqual([
                { field: 'readme', quote: 'CS 101' },
            ]);
            expect(
                result.repairs.map((repair) => [
                    repair.citationIndex,
                    repair.action,
                    repair.reason,
                ]),
            ).toEqual([
                [1, 'dropped', 'empty_source'],
                [3, 'dropped', 'quote_absent_from_visible_segments'],
            ]);
        });

        test('drops a quote that matches more than one other field instead of guessing', () => {
            const result = repairCitations(
                [
                    { field: 'homepage', quote: 'slu' },
                    { field: 'readme', quote: 'CS 101' },
                ],
                segments,
                fields,
            );
            expect(result.citations).toEqual([
                { field: 'readme', quote: 'CS 101' },
            ]);
            expect(result.repairs[0]).toMatchObject({
                action: 'dropped',
                reason: 'empty_source',
            });
            const ambiguous = repairCitations(
                [
                    { field: 'description', quote: 'slu' },
                    { field: 'readme', quote: 'CS 101' },
                ],
                { ...segments, description: ['A tool'] },
                fields,
            );
            expect(ambiguous.repairs[0]).toMatchObject({
                action: 'dropped',
                reason: 'quote_matches_other_field',
                repairedField: null,
            });
        });

        test('keeps strict failure when no verified citation remains', () => {
            expect(() =>
                repairCitations(
                    [
                        { field: 'homepage', quote: 'https://slu.edu' },
                        { field: 'readme', quote: 'not in the text' },
                    ],
                    segments,
                    fields,
                ),
            ).toThrow(
                expect.objectContaining({
                    code: 'invalid_citation',
                    citationDiagnostics: [
                        expect.objectContaining({ reason: 'empty_source' }),
                        expect.objectContaining({
                            reason: 'quote_absent_from_visible_segments',
                        }),
                    ],
                }),
            );
        });
    });

    test('marks a positive decision with a null score as a missing score', () => {
        const response = JSON.parse(affiliation()) as Record<string, unknown>;
        response.score = null;
        expect(() => parseAffiliationResponse(JSON.stringify(response))).toThrow(
            expect.objectContaining({
                code: 'invalid_schema',
                detail: 'missing_score',
            }),
        );
        response.score = 1.5;
        expect(() => parseAffiliationResponse(JSON.stringify(response))).toThrow(
            expect.objectContaining({ code: 'invalid_schema', detail: null }),
        );
    });
});

function affiliation(): string {
    return JSON.stringify({
        decision: 'supported',
        relationship: 'coursework',
        score: 0.4,
        evidence: [{ field: 'readme', quote: 'Course 101 at SLU' }],
        explanation: 'The README identifies a course assignment at the institution.',
    });
}

function projectType(): string {
    return JSON.stringify({
        category: 'DEV',
        evidence: [{ field: 'readme', quote: 'Course 101 at SLU' }],
        explanation: 'The README describes a software tool.',
    });
}
