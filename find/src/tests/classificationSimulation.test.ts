import { validateClassificationConfiguration } from '../config';
import {
    createEvidenceMockClient,
    RandomSimulationClient,
} from '../classification/client';
import type { AffiliationResponse } from '../classification/contracts';
import { applyAffiliationEvidenceGate } from '../classification/gate';
import { matchContextFor } from '../classification/review';
import { runClassificationInference } from '../classification/inference';
import { buildPrompt } from '../classification/prompts';
import { quoteFromText, readPromptEvidence } from '../classification/simulation';
import type {
    ClassificationCandidate,
    UniversityConfiguration,
} from '../types/scraping';

const institution: UniversityConfiguration = {
    key: 'Saint Louis University',
    fullName: 'Saint Louis University',
    acronym: 'SLU',
};

const modes = ['exact_quote', 'evidence_id'] as const;

describe('offline classification clients', () => {
    test.each(modes)(
        'seeded simulator passes strict validation and completes both tasks (%s)',
        async (citationMode) => {
            const configuration = validateClassificationConfiguration({
                citationMode,
                truncation: {
                    mode: 'start_end',
                    maxChars: 120,
                    startChars: 80,
                    endChars: 30,
                },
            });
            const client = new RandomSimulationClient(42);
            const decisions: string[] = [];
            let projectTypes = 0;
            for (let id = 1; id <= 40; id += 1) {
                const repository = candidate(id);
                // Strict policy: simulated citations must verify without repair.
                const affiliation = await runClassificationInference({
                    task: 'affiliation',
                    candidate: repository,
                    institution,
                    configuration,
                    client,
                });
                const response = affiliation.response as AffiliationResponse;
                decisions.push(response.decision);
                expect(affiliation.citationRepairs).toEqual([]);
                if (response.decision === 'supported') {
                    expect(response.evidence.length).toBeGreaterThan(0);
                    expect(
                        applyAffiliationEvidenceGate(
                            response,
                            institution,
                            matchContextFor(repository),
                            'names_institution',
                        ).downgradedFrom,
                    ).toBeNull();
                    expect(response.score).toEqual(expect.any(Number));
                    const projectType = await runClassificationInference({
                        task: 'project_type',
                        candidate: repository,
                        institution,
                        configuration,
                        client,
                    });
                    expect(projectType.response.evidence.length).toBeGreaterThan(0);
                    projectTypes += 1;
                }
            }
            expect(new Set(decisions)).toEqual(
                new Set(['supported', 'not_supported', 'uncertain']),
            );
            expect(projectTypes).toBeGreaterThan(0);
            expect(client.simulated).toBe(true);
        },
    );

    test('seeded simulator stays uncertain or negative when the prompt has no evidence', async () => {
        const client = new RandomSimulationClient(7);
        const messages = [{ role: 'user' as const, content: 'prompt' }];
        for (let index = 0; index < 20; index += 1) {
            const response = JSON.parse(
                await client.classify('affiliation', messages),
            ) as { decision: string; evidence: unknown[] };
            expect(response.decision).not.toBe('supported');
            expect(response.evidence).toEqual([]);
        }
    });

    test.each(modes)(
        'mock supports only a visibly named institution and cites it (%s)',
        async (citationMode) => {
            const configuration = validateClassificationConfiguration({
                citationMode,
            });
            const client = createEvidenceMockClient();
            const named = await runClassificationInference({
                task: 'affiliation',
                candidate: candidate(1, {
                    readme: 'Intro\nA project of the Open Source with Saint Louis University program.',
                }),
                institution,
                configuration,
                client,
            });
            expect(named.response).toMatchObject({
                decision: 'supported',
                relationship: 'institutional_project',
                score: 0.7,
                evidence: [
                    {
                        field: 'readme',
                        quote: expect.stringContaining('Saint Louis University'),
                    },
                ],
            });
            const unnamed = await runClassificationInference({
                task: 'affiliation',
                candidate: candidate(2, {
                    readme: 'See https://github.com/oss-slu/repo-2 and the slu helpers.',
                }),
                institution,
                configuration,
                client,
            });
            expect(unnamed.response).toMatchObject({
                decision: 'uncertain',
                score: null,
                evidence: [],
            });
            const projectType = await runClassificationInference({
                task: 'project_type',
                candidate: candidate(1),
                institution,
                configuration,
                client,
            });
            expect(projectType.response).toMatchObject({
                category: 'DEV',
                evidence: [{ field: 'description', quote: 'A repository' }],
            });
            expect(client.model).toBe('deterministic-evidence-v2');
            expect(client.simulated).toBe(true);
        },
    );

    test('reads quotes from visible lines only, never across the truncation marker', () => {
        const configuration = validateClassificationConfiguration({
            truncation: { mode: 'start_end', maxChars: 20, startChars: 10, endChars: 5 },
        });
        const evidence = readPromptEvidence(
            buildPrompt(
                'affiliation',
                candidate(1, { readme: '0123456789abcdefghijklmnopqrstuvwxyz' }),
                institution,
                configuration,
            ),
        );
        expect(
            evidence?.citations.find((citation) => citation.field === 'readme'),
        ).toMatchObject({ quote: '0123456789' });
        expect(quoteFromText('[… README omitted …]\n   \nlast')).toBe('last');
        const long = `${'a'.repeat(300)} Saint Louis University ${'b'.repeat(300)}`;
        const quote = quoteFromText(long, (value) =>
            value.includes('Saint Louis University'),
        );
        expect(quote).toContain('Saint Louis University');
        expect(quote!.length).toBeLessThanOrEqual(160);
        expect(long).toContain(quote!);
    });
});

function candidate(
    id: number,
    overrides: Partial<ClassificationCandidate> = {},
): ClassificationCandidate {
    return {
        id,
        university: institution.key,
        fullName: `oss-slu/repo-${id}`,
        owner: 'oss-slu',
        htmlUrl: `https://github.com/oss-slu/repo-${id}`,
        description: 'A repository',
        readme: `# Repo ${id}\n\nA tool for students${id % 2 === 0 ? ' in a course at SLU' : ''}. ${'Long text. '.repeat(id % 3 === 0 ? 30 : 1)}\nEnd of README.`,
        homepage: id % 2 === 0 ? 'https://example.test' : null,
        language: 'TypeScript',
        license: 'mit',
        fork: 0,
        archived: false,
        isTemplate: false,
        size: 20,
        stargazersCount: 0,
        forksCount: 0,
        contributors: '[]',
        ...overrides,
    };
}
