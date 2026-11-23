import type {
    ClassificationCandidate,
    ClassificationConfiguration,
    ClassificationPrediction,
    UniversityConfiguration,
} from '../types/scraping';
import {
    FakeClassificationClient,
    RandomSimulationClient,
} from '../classification/client';
import { runClassification } from '../classification/runner';
import type {
    ClassificationPredictionKey,
    ClassificationStorePort,
} from '../classification/store';
import { validateClassificationConfiguration } from '../config';

const university: UniversityConfiguration = {
    key: 'Saint Louis University',
    fullName: 'Saint Louis University',
    acronym: 'SLU',
};
// Most runner tests exercise other behaviour with quotes that do not name
// the institution, so they turn the evidence gate off; the gate tests below
// use the default (on).
const baseConfiguration = validateClassificationConfiguration({
    concurrency: 1,
    threshold: 0.4,
    affiliationEvidenceGate: 'off',
});
const gatedConfiguration = validateClassificationConfiguration({
    concurrency: 1,
    threshold: 0.4,
});

describe('classification runner', () => {
    test('enforces eligibility and threshold before project type calls', async () => {
        const store = new MemoryStore([
            candidate(1, university.key),
            candidate(2, university.key),
            candidate(3, university.key, { fork: 1 }),
        ]);
        const client = new FakeClassificationClient([
            affiliation('supported', 0.9),
            affiliation('supported', 0.2),
            projectType('DEV'),
        ]);
        const report = await runClassification(dependencies(store, client));

        expect(client.requests.map((request) => request.task)).toEqual([
            'affiliation',
            'affiliation',
            'project_type',
        ]);
        expect(report.universities[0]).toMatchObject({
            candidates: 3,
            eligible: 2,
            ineligible: 1,
            affiliationPredicted: 1,
            belowThreshold: 1,
            projectTypesPredicted: 1,
        });
        expect(
            store
                .predictionsFor('affiliation')
                .map((prediction) => prediction.status),
        ).toEqual(['predicted', 'below_threshold', 'ineligible']);
        expect(
            store
                .predictionsFor('project_type')
                .map((prediction) => prediction.status),
        ).toEqual(['predicted', 'skipped_threshold', 'skipped_eligibility']);
    });

    test('resumes matching predictions but invalidates them when evidence changes', async () => {
        const store = new MemoryStore([candidate(7, university.key)]);
        const firstClient = new FakeClassificationClient();
        await runClassification(dependencies(store, firstClient));
        expect(store.predictions).toHaveLength(2);

        const resumedClient = new FakeClassificationClient();
        const resumed = await runClassification(
            dependencies(store, resumedClient),
        );
        expect(resumedClient.requests).toHaveLength(0);
        expect(resumed.universities[0]?.reused).toBe(2);

        store.candidates[0] = candidate(7, university.key, {
            readme: 'A different README',
        });
        const changedClient = new FakeClassificationClient();
        await runClassification(dependencies(store, changedClient));
        expect(changedClient.requests.map((request) => request.task)).toEqual([
            'affiliation',
        ]);
        expect(store.predictions).toHaveLength(4);
    });

    test('invalidates resume state when model, prompt version, or threshold changes', async () => {
        const store = new MemoryStore([candidate(8, university.key)]);
        await runClassification(
            dependencies(store, new FakeClassificationClient()),
        );

        const changedModel = new FakeClassificationClient(
            [],
            'mock',
            'deterministic-fake-v2',
        );
        await runClassification(dependencies(store, changedModel));
        expect(changedModel.requests.map((request) => request.task)).toEqual([
            'affiliation',
        ]);

        const changedPrompt = new FakeClassificationClient();
        await runClassification(
            dependencies(store, changedPrompt, {
                ...baseConfiguration,
                promptVersion: 'changed-prompt-version',
            }),
        );
        expect(changedPrompt.requests.map((request) => request.task)).toEqual([
            'affiliation',
        ]);

        const changedThreshold = new FakeClassificationClient();
        await runClassification(
            dependencies(store, changedThreshold, {
                ...baseConfiguration,
                threshold: 0.5,
            }),
        );
        expect(
            changedThreshold.requests.map((request) => request.task),
        ).toEqual(['affiliation']);
    });

    test('invalidates cached results for each response generation setting', async () => {
        const store = new MemoryStore([candidate(80, university.key)]);
        await runClassification(
            dependencies(store, new FakeClassificationClient()),
        );
        const settings = [
            { ...baseConfiguration.generation, responseFormat: 'json_object' as const },
            { ...baseConfiguration.generation, temperature: 0.5 },
            { ...baseConfiguration.generation, maxOutputTokens: 513 },
            { ...baseConfiguration.generation, maxOutputTokensField: 'max_tokens' as const },
            { ...baseConfiguration.generation, seed: 42 },
            { ...baseConfiguration.generation, reasoningEffort: 'low' as const },
        ];
        for (const generation of settings) {
            const client = new FakeClassificationClient();
            await runClassification(
                dependencies(store, client, {
                    ...baseConfiguration,
                    generation,
                }),
            );
            expect(client.requests.map((request) => request.task)).toEqual([
                'affiliation',
            ]);
        }
        expect(store.predictions).toHaveLength(14);
    });

    test('persists uncertainty and rejection distinctly without provider failures', async () => {
        const store = new MemoryStore([
            candidate(81, university.key),
            candidate(82, university.key),
        ]);
        const client = new FakeClassificationClient([
            affiliation('not_supported', 0),
            affiliation('uncertain', null),
        ]);
        const report = await runClassification(dependencies(store, client));
        expect(report.universities[0]).toMatchObject({
            affiliationNotSupported: 1,
            affiliationUncertain: 1,
            failed: 0,
        });
        expect(
            store
                .predictionsFor('affiliation')
                .map((prediction) => [prediction.status, prediction.score]),
        ).toEqual([
            ['not_supported', 0],
            ['uncertain', null],
        ]);
        expect(
            store
                .predictionsFor('project_type')
                .map((prediction) => prediction.status),
        ).toEqual([
            'skipped_affiliation_rejected',
            'skipped_affiliation_uncertain',
        ]);
        expect(report.failures).toHaveLength(0);
    });

    test('reports coursework/type mismatches for review without rewriting or blocking predictions', async () => {
        const store = new MemoryStore([candidate(83, university.key)]);
        const client = new FakeClassificationClient([
            JSON.stringify({
                decision: 'supported',
                relationship: 'coursework',
                score: 0.8,
                evidence: [{ field: 'readme', quote: 'Readme content' }],
                explanation: 'The README identifies this as a course assignment.',
            }),
            projectType('DEV'),
        ]);
        const report = await runClassification(dependencies(store, client));

        expect(report.semanticReviewFindings).toEqual([
            {
                university: university.key,
                repositoryId: 83,
                repository: 'slu/repo-83',
                reasons: [
                    'coursework_project_type_mismatch',
                    'supported_affiliation_without_explicit_relationship_evidence',
                ],
            },
        ]);
        expect(report.failures).toEqual([]);
        expect(store.predictionsFor('project_type')[0]).toMatchObject({
            category: 'DEV',
            status: 'predicted',
        });
    });

    test('flags support without target relationship evidence but preserves the prediction', async () => {
        const store = new MemoryStore([
            candidate(84, university.key, { readme: 'A general-purpose utility.' }),
        ]);
        const client = new FakeClassificationClient([
            JSON.stringify({
                decision: 'supported',
                relationship: 'institutional_project',
                score: 0.9,
                evidence: [
                    { field: 'readme', quote: 'A general-purpose utility.' },
                ],
                explanation: 'The repository is a useful utility.',
            }),
            JSON.stringify({
                category: 'DEV',
                evidence: [
                    { field: 'readme', quote: 'A general-purpose utility.' },
                ],
                explanation: 'The README describes a reusable utility.',
            }),
        ]);
        const report = await runClassification(dependencies(store, client));

        expect(report.semanticReviewFindings).toEqual([
            {
                university: university.key,
                repositoryId: 84,
                repository: 'slu/repo-84',
                reasons: [
                    'supported_affiliation_without_explicit_relationship_evidence',
                ],
            },
        ]);
        expect(report.failures).toEqual([]);
        expect(store.predictionsFor('affiliation')[0]).toMatchObject({
            status: 'predicted',
            affiliationDecision: 'supported',
        });
    });

    test('flags explicit coursework evidence labeled with a generic relationship', async () => {
        const courseEvidence =
            'This project was completed for CS101 course at Saint Louis University.';
        const store = new MemoryStore([
            candidate(85, university.key, { readme: courseEvidence }),
        ]);
        const client = new FakeClassificationClient([
            JSON.stringify({
                decision: 'supported',
                relationship: 'institutional_project',
                score: 0.9,
                evidence: [{ field: 'readme', quote: courseEvidence }],
                explanation: 'The README describes coursework.',
            }),
            JSON.stringify({
                category: 'EDU',
                evidence: [{ field: 'readme', quote: courseEvidence }],
                explanation: 'The README describes coursework.',
            }),
        ]);
        const report = await runClassification(dependencies(store, client));

        expect(report.semanticReviewFindings[0]?.reasons).toContain(
            'coursework_relationship_mismatch',
        );
        expect(report.semanticReviewFindings[0]?.reasons).not.toContain(
            'supported_affiliation_without_explicit_relationship_evidence',
        );
    });

    test('keeps the same repository ID isolated by university', async () => {
        const secondUniversity: UniversityConfiguration = {
            key: 'Another University',
            fullName: 'Another University',
            acronym: 'AU',
        };
        const store = new MemoryStore([
            candidate(9, university.key),
            candidate(9, secondUniversity.key),
        ]);
        await runClassification({
            ...dependencies(store, new FakeClassificationClient()),
            universities: [university, secondUniversity],
        });
        expect(
            store.predictions.filter(
                (prediction) => prediction.task === 'affiliation',
            ),
        ).toHaveLength(2);
        expect(
            new Set(
                store.predictions.map((prediction) => prediction.university),
            ).size,
        ).toBe(2);
    });

    test('records a failed affiliation and skips type classification after an invalid response', async () => {
        const store = new MemoryStore([candidate(11, university.key)]);
        const client = new FakeClassificationClient([
            '{"decision":"supported","relationship":"coursework","score":1.1,"evidence":[{"field":"readme","quote":"Readme content"}],"explanation":"invalid"}',
        ]);
        const report = await runClassification(dependencies(store, client));
        expect(report.failures).toHaveLength(1);
        expect(report.failures[0]?.task).toBe('affiliation');
        expect(client.requests.map((request) => request.task)).toEqual([
            'affiliation',
        ]);
        expect(store.predictionsFor('affiliation')[0]?.status).toBe('failed');
        expect(store.predictionsFor('project_type')[0]?.status).toBe(
            'skipped_affiliation_failed',
        );
    });

    test('continues after one candidate fails and persists later candidates incrementally', async () => {
        const store = new MemoryStore([
            candidate(12, university.key),
            candidate(13, university.key),
        ]);
        const client = new FakeClassificationClient([
            '{"decision":"supported","relationship":"coursework","score":1.5,"evidence":[{"field":"readme","quote":"Readme content"}],"explanation":"invalid"}',
            affiliation('supported', 0.8),
            projectType('EDU'),
        ]);
        const report = await runClassification(dependencies(store, client));
        expect(report.failures).toHaveLength(1);
        expect(report.universities[0]).toMatchObject({
            failed: 1,
            affiliationPredicted: 1,
            projectTypesPredicted: 1,
        });
        expect(
            store
                .predictionsFor('affiliation')
                .map((prediction) => prediction.status),
        ).toEqual(['failed', 'predicted']);
        expect(
            store
                .predictionsFor('project_type')
                .map((prediction) => prediction.status),
        ).toEqual(['skipped_affiliation_failed', 'predicted']);
    });

    test('repairs mislabelled citations, counts them, and stores the corrected field', async () => {
        const store = new MemoryStore([candidate(90, university.key)]);
        const client = new FakeClassificationClient([
            JSON.stringify({
                decision: 'supported',
                relationship: 'coursework',
                score: 0.8,
                evidence: [
                    { field: 'description', quote: 'Readme content' },
                    { field: 'homepage', quote: 'https://slu.edu' },
                ],
                explanation: 'The README describes coursework.',
            }),
            JSON.stringify({
                category: 'EDU',
                evidence: [{ field: 'fullName', quote: 'Readme content' }],
                explanation: 'The README describes coursework.',
            }),
        ]);
        const report = await runClassification(dependencies(store, client));
        expect(report.universities[0]).toMatchObject({
            affiliationPredicted: 1,
            projectTypesPredicted: 1,
            repairedResults: 2,
            citationRepairs: 3,
            failed: 0,
        });
        expect(store.predictionsFor('affiliation')[0]?.affiliationEvidence).toEqual([
            { field: 'readme', quote: 'Readme content' },
        ]);
        expect(
            report.citationRepairs.map((record) => [
                record.task,
                record.repairs.map((repair) => repair.action),
            ]),
        ).toEqual([
            ['affiliation', ['relabeled', 'dropped']],
            ['project_type', ['relabeled']],
        ]);
    });

    test('retries a missing score once and records the retry', async () => {
        const store = new MemoryStore([candidate(91, university.key)]);
        const client = new FakeClassificationClient([
            affiliation('supported', null),
            affiliation('supported', 0.55),
            projectType('DEV'),
        ]);
        const report = await runClassification(dependencies(store, client));
        expect(client.requests.map((request) => request.task)).toEqual([
            'affiliation',
            'affiliation',
            'project_type',
        ]);
        expect(report.universities[0]).toMatchObject({
            scoreRetries: 1,
            scoreRetriesRecovered: 1,
            affiliationPredicted: 1,
            failed: 0,
        });
        expect(report.scoreRetries).toEqual([
            expect.objectContaining({
                repositoryId: 91,
                task: 'affiliation',
                recovered: true,
            }),
        ]);
        expect(store.predictionsFor('affiliation')[0]?.score).toBe(0.55);
    });

    test('counts a missing-score follow-up that still fails', async () => {
        const store = new MemoryStore([candidate(94, university.key)]);
        const client = new FakeClassificationClient([
            affiliation('supported', null),
        ]);
        const report = await runClassification(dependencies(store, client));
        expect(report.universities[0]).toMatchObject({
            scoreRetries: 1,
            scoreRetriesRecovered: 0,
            failed: 1,
        });
        expect(report.scoreRetries).toEqual([
            expect.objectContaining({ repositoryId: 94, recovered: false }),
        ]);
        expect(report.failures[0]?.message).toMatch(
            /^After one missing-score follow-up/,
        );
    });

    test('emits progress per task with completed, total, and failures so far', async () => {
        const store = new MemoryStore([
            candidate(92, university.key),
            candidate(93, university.key),
        ]);
        const events: Array<[string, number, number, number]> = [];
        await runClassification({
            ...dependencies(
                store,
                new FakeClassificationClient(['not json', affiliation('uncertain', null)]),
            ),
            onProgress: (event) =>
                events.push([event.task, event.completed, event.total, event.failed]),
        });
        expect(events).toEqual([
            ['affiliation', 0, 2, 0],
            ['affiliation', 1, 2, 1],
            ['affiliation', 2, 2, 1],
            ['project_type', 0, 2, 1],
            ['project_type', 1, 2, 1],
            ['project_type', 2, 2, 1],
        ]);
    });

    test('seeded simulation runs the project-type task offline with the gate on', async () => {
        const store = new MemoryStore(
            Array.from({ length: 12 }, (_, index) =>
                candidate(100 + index, university.key, {
                    readme:
                        index % 2 === 0
                            ? 'Built for a course at Saint Louis University.'
                            : 'Readme content',
                }),
            ),
        );
        const report = await runClassification({
            store,
            client: new RandomSimulationClient(42),
            configuration: gatedConfiguration,
            universities: [university],
            now: () => new Date('2026-10-26T12:00:00.000Z'),
        });
        expect(report.failures).toEqual([]);
        expect(report.universities[0]!.projectTypesPredicted).toBeGreaterThan(0);
        expect(report.universities[0]!.citationRepairs).toBe(0);
        expect(report.universities[0]!.downgraded).toBe(0);
        expect(
            store.predictions.every((prediction) => prediction.simulated),
        ).toBe(true);
    });

    describe('affiliation evidence gate', () => {
        const named = 'Built for CS 101 at Saint Louis University.';
        const supportedWith = (evidence: unknown[]) =>
            JSON.stringify({
                decision: 'supported',
                relationship: 'coursework',
                score: 0.9,
                evidence,
                explanation: 'The model explanation.',
            });

        test('keeps a supported result whose quote names the institution', async () => {
            const store = new MemoryStore([
                candidate(120, university.key, { readme: named }),
            ]);
            const client = new FakeClassificationClient([
                supportedWith([{ field: 'readme', quote: named }]),
                JSON.stringify({
                    category: 'EDU',
                    evidence: [{ field: 'readme', quote: 'CS 101' }],
                    explanation: 'The README describes coursework.',
                }),
            ]);
            const report = await runClassification(
                dependencies(store, client, gatedConfiguration),
            );
            expect(report.universities[0]).toMatchObject({
                affiliationPredicted: 1,
                downgraded: 0,
                projectTypesPredicted: 1,
            });
            expect(report.affiliationDowngrades).toEqual([]);
        });

        test('stores an unnamed supported result as uncertain, keeps the original in the report, and skips project type', async () => {
            const store = new MemoryStore([
                candidate(121, university.key, { owner: 'oss-slu', fullName: 'oss-slu/tool' }),
            ]);
            const original = supportedWith([
                { field: 'readme', quote: 'Readme content' },
                { field: 'owner', quote: 'oss-slu' },
            ]);
            const client = new FakeClassificationClient([original]);
            const report = await runClassification(
                dependencies(store, client, gatedConfiguration),
            );
            expect(client.requests.map((request) => request.task)).toEqual([
                'affiliation',
            ]);
            expect(report.universities[0]).toMatchObject({
                affiliationPredicted: 0,
                affiliationUncertain: 1,
                downgraded: 1,
                projectTypesPredicted: 0,
            });
            const stored = store.predictionsFor('affiliation')[0]!;
            expect(stored).toMatchObject({
                status: 'uncertain',
                affiliationDecision: 'uncertain',
                affiliationRelationship: 'insufficient_evidence',
                score: null,
                affiliationEvidence: [
                    { field: 'readme', quote: 'Readme content' },
                    { field: 'owner', quote: 'oss-slu' },
                ],
            });
            expect(stored.explanation).toMatch(/^Downgraded to uncertain/);
            expect(stored.explanation).toContain('supported (coursework, score 0.9)');
            expect(stored.explanation).toContain('The model explanation.');
            expect(store.predictionsFor('project_type')[0]?.status).toBe(
                'skipped_affiliation_uncertain',
            );
            expect(report.affiliationEvidenceGate).toBe('names_institution');
            expect(report.affiliationDowngrades).toEqual([
                {
                    university: university.key,
                    repositoryId: 121,
                    repository: 'oss-slu/tool',
                    original: JSON.parse(original),
                },
            ]);
        });

        test('keeps the model decision when the gate is off', async () => {
            const store = new MemoryStore([candidate(122, university.key)]);
            const client = new FakeClassificationClient([
                supportedWith([{ field: 'readme', quote: 'Readme content' }]),
                projectType('DEV'),
            ]);
            const report = await runClassification(dependencies(store, client));
            expect(report.universities[0]).toMatchObject({
                affiliationPredicted: 1,
                downgraded: 0,
            });
            expect(report.affiliationEvidenceGate).toBe('off');
        });

        test('accepts a citation that repair relabelled to the field naming the institution', async () => {
            const store = new MemoryStore([
                candidate(123, university.key, { readme: named }),
            ]);
            const client = new FakeClassificationClient([
                supportedWith([
                    { field: 'description', quote: 'Saint Louis University' },
                ]),
                JSON.stringify({
                    category: 'EDU',
                    evidence: [{ field: 'readme', quote: 'CS 101' }],
                    explanation: 'The README describes coursework.',
                }),
            ]);
            const report = await runClassification(
                dependencies(store, client, gatedConfiguration),
            );
            expect(report.universities[0]).toMatchObject({
                affiliationPredicted: 1,
                downgraded: 0,
                citationRepairs: 1,
            });
            expect(store.predictionsFor('affiliation')[0]?.affiliationEvidence).toEqual([
                { field: 'readme', quote: 'Saint Louis University' },
            ]);
        });

        test('keys gated and ungated results separately', async () => {
            const store = new MemoryStore([candidate(124, university.key)]);
            await runClassification(
                dependencies(store, new FakeClassificationClient(), gatedConfiguration),
            );
            const ungated = new FakeClassificationClient();
            await runClassification(dependencies(store, ungated));
            expect(ungated.requests.map((request) => request.task)).toEqual([
                'affiliation',
            ]);
            const regated = new FakeClassificationClient();
            await runClassification(
                dependencies(store, regated, gatedConfiguration),
            );
            expect(regated.requests).toEqual([]);
            expect(
                new Set(
                    store
                        .predictionsFor('affiliation')
                        .map((prediction) => prediction.inputHash),
                ).size,
            ).toBe(2);
        });
    });
});

function dependencies(
    store: MemoryStore,
    client: FakeClassificationClient,
    configuration: ClassificationConfiguration = baseConfiguration,
) {
    return {
        store,
        client,
        configuration,
        universities: [university],
        now: () => new Date('2026-10-26T12:00:00.000Z'),
    };
}

function candidate(
    id: number,
    universityKey: string,
    overrides: Partial<ClassificationCandidate> = {},
): ClassificationCandidate {
    return {
        id,
        university: universityKey,
        fullName: `slu/repo-${id}`,
        owner: 'slu',
        htmlUrl: `https://github.com/slu/repo-${id}`,
        description: 'A repository',
        readme: 'Readme content',
        homepage: null,
        language: 'TypeScript',
        license: 'mit',
        fork: 0,
        archived: false,
        isTemplate: false,
        size: 20,
        stargazersCount: 1,
        forksCount: 0,
        contributors: '["alice"]',
        ...overrides,
    };
}

function affiliation(
    decision: 'supported' | 'not_supported' | 'uncertain',
    score: number | null = 0.8,
): string {
    return JSON.stringify({
        decision,
        relationship:
            decision === 'uncertain'
                ? 'insufficient_evidence'
                : decision === 'not_supported'
                  ? 'incidental_mention'
                  : 'coursework',
        score: decision === 'uncertain' ? null : score,
        evidence:
            decision === 'supported'
                ? [{ field: 'readme', quote: 'Readme content' }]
                : [],
        explanation: `Simulated ${decision} affiliation judgment.`,
    });
}

function projectType(category: string): string {
    return JSON.stringify({
        category,
        evidence: [{ field: 'readme', quote: 'Readme content' }],
        explanation: `The repository is primarily ${category}.`,
    });
}

class MemoryStore implements ClassificationStorePort {
    readonly predictions: ClassificationPrediction[] = [];

    constructor(public candidates: ClassificationCandidate[]) {}

    async listCandidates(
        universityKey: string,
    ): Promise<ClassificationCandidate[]> {
        return this.candidates.filter(
            (candidate) => candidate.university === universityKey,
        );
    }

    async findPrediction(
        key: ClassificationPredictionKey,
    ): Promise<ClassificationPrediction | null> {
        return (
            this.predictions.find((prediction) =>
                Object.entries(key).every(
                    ([field, value]) =>
                        prediction[field as keyof ClassificationPrediction] ===
                        value,
                ),
            ) ?? null
        );
    }

    async savePrediction(prediction: ClassificationPrediction): Promise<void> {
        const index = this.predictions.findIndex(
            (saved) =>
                saved.id === prediction.id &&
                saved.university === prediction.university &&
                saved.task === prediction.task &&
                saved.provider === prediction.provider &&
                saved.model === prediction.model &&
                saved.promptVersion === prediction.promptVersion &&
                saved.inputHash === prediction.inputHash,
        );
        if (index < 0) this.predictions.push(prediction);
        else this.predictions[index] = prediction;
    }

    predictionsFor(
        task: ClassificationPrediction['task'],
    ): ClassificationPrediction[] {
        return this.predictions
            .filter((prediction) => prediction.task === task)
            .sort((a, b) => a.id - b.id);
    }
}
