import { validateClassificationConfiguration } from '../config';
import {
    EVIDENCE_SPAN_MAX_CHARS,
    prepareRepositoryEvidence,
} from '../classification/evidence';
import type { ClassificationCandidate } from '../types/scraping';

describe('classification evidence catalog', () => {
    test('deterministically covers each visible exact segment without bridging truncation', () => {
        const configuration = validateClassificationConfiguration({
            truncation: {
                mode: 'start_end',
                maxChars: 100,
                startChars: 40,
                endChars: 40,
            },
        });
        const candidate = makeCandidate({
            description: Array.from(
                { length: 80 },
                (_, index) => `clause-${index}; `,
            ).join(''),
            readme: `VISIBLE_HEAD\r\n${'x'.repeat(150)}\r\nOMITTED_ONLY_SECRET\r\n${'y'.repeat(150)}\r\nVISIBLE_TAIL`,
        });
        const first = prepareRepositoryEvidence(candidate, configuration);
        const second = prepareRepositoryEvidence(candidate, configuration);

        expect(first.evidenceCatalogHash).toBe(second.evidenceCatalogHash);
        expect(first.evidenceCatalog).toEqual(second.evidenceCatalog);
        expect(new Set(first.evidenceCatalog.map((item) => item.id)).size).toBe(
            first.evidenceCatalog.length,
        );
        expect(first.evidenceCatalog[0]?.id).toBe('E0001');
        expect(first.evidenceCatalog.at(-1)?.id).toBe(
            `E${String(first.evidenceCatalog.length).padStart(4, '0')}`,
        );
        expect(
            first.evidenceCatalog.every(
                (item) => item.text.length <= EVIDENCE_SPAN_MAX_CHARS,
            ),
        ).toBe(true);
        expect(
            first.evidenceCatalog.some((item) =>
                item.text.includes('OMITTED_ONLY_SECRET'),
            ),
        ).toBe(false);
        expect(
            first.evidenceCatalog.some((item) => item.text.includes('omitted')),
        ).toBe(false);

        for (const [field, segments] of Object.entries(
            first.citationSegments,
        )) {
            segments.forEach((segment, segmentIndex) => {
                const references = first.evidenceCatalog.filter(
                    (item) =>
                        item.field === field &&
                        item.segmentIndex === segmentIndex,
                );
                expect(references.map((item) => item.text).join('')).toBe(
                    segment,
                );
                expect(references[0]?.startOffset).toBe(0);
                expect(references.at(-1)?.endOffset).toBe(segment.length);
                for (const [index, reference] of references.entries()) {
                    expect(reference.text).toBe(
                        segment.slice(
                            reference.startOffset,
                            reference.endOffset,
                        ),
                    );
                    if (index > 0) {
                        expect(reference.startOffset).toBe(
                            references[index - 1]?.endOffset,
                        );
                    }
                }
            });
        }
    });

    test('never splits a surrogate pair at truncation or span boundaries', () => {
        const emoji = '\u{1F600}';
        const readme = `${'a'.repeat(39)}${emoji}${'b'.repeat(100)}${emoji}${'c'.repeat(39)}`;
        const startEnd = prepareRepositoryEvidence(
            makeCandidate({ readme }),
            validateClassificationConfiguration({
                truncation: {
                    mode: 'start_end',
                    maxChars: 100,
                    startChars: 40,
                    endChars: 40,
                },
            }),
        );
        expect(startEnd.citationSegments.readme).toEqual([
            'a'.repeat(39),
            'c'.repeat(39),
        ]);
        expect(isWellFormed(startEnd.affiliation.readme.value)).toBe(true);

        const startOnly = prepareRepositoryEvidence(
            makeCandidate({ readme }),
            validateClassificationConfiguration({
                truncation: {
                    mode: 'start',
                    maxChars: 40,
                    startChars: 40,
                    endChars: 0,
                },
            }),
        );
        expect(startOnly.citationSegments.readme).toEqual(['a'.repeat(39)]);

        const intact = prepareRepositoryEvidence(
            makeCandidate({
                readme: `${'a'.repeat(38)}${emoji}${'z'.repeat(200)}`,
            }),
            validateClassificationConfiguration({
                truncation: {
                    mode: 'start_end',
                    maxChars: 100,
                    startChars: 40,
                    endChars: 40,
                },
            }),
        );
        expect(intact.citationSegments.readme[0]).toBe(
            `${'a'.repeat(38)}${emoji}`,
        );

        // Catalog spans also end on character boundaries, so JSONB accepts them.
        const offset = EVIDENCE_SPAN_MAX_CHARS - 1;
        const longReadme = `${'x'.repeat(offset)}${emoji}${'y'.repeat(100)}`;
        const prepared = prepareRepositoryEvidence(
            makeCandidate({ readme: longReadme }),
            validateClassificationConfiguration({}),
        );
        const spans = prepared.evidenceCatalog.filter(
            (reference) => reference.field === 'readme',
        );
        expect(spans.map((span) => span.text).join('')).toBe(longReadme);
        expect(spans[0]?.endOffset).toBe(offset);
        expect(spans[1]?.text.startsWith(emoji)).toBe(true);
        for (const span of spans) {
            expect(isWellFormed(span.text)).toBe(true);
            expect(JSON.stringify(span.text)).not.toMatch(/\\ud[89a-f]/i);
        }
    });
});

function makeCandidate(
    overrides: Partial<ClassificationCandidate> = {},
): ClassificationCandidate {
    return {
        id: 42,
        university: 'Example Institute',
        fullName: 'example/project',
        owner: 'example',
        htmlUrl: 'https://example.test/example/project',
        description: 'A small project',
        readme: 'A short README',
        homepage: null,
        language: 'TypeScript',
        license: 'mit',
        fork: 0,
        archived: false,
        isTemplate: false,
        size: 12,
        stargazersCount: 0,
        forksCount: 0,
        contributors: '[]',
        ...overrides,
    };
}

function isWellFormed(value: string): boolean {
    return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        value,
    );
}
