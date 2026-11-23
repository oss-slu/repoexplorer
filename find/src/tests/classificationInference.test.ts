import { validateClassificationConfiguration } from '../config';
import type {
    ClassificationClient,
    ClassificationCompletion,
} from '../classification/client';
import {
    classificationInputHash,
    prepareClassificationInference,
    runClassificationInference,
} from '../classification/inference';
import type {
    ClassificationCandidate,
    ClassificationTask,
    UniversityConfiguration,
} from '../types/scraping';

const institution: UniversityConfiguration = {
    key: 'Example Institute',
    fullName: 'Example Institute',
    acronym: 'EI',
};
const configuration = validateClassificationConfiguration({
    citationMode: 'evidence_id',
    promptVersion: 'evidence-reference-test-v1',
    generation: { responseFormat: 'json_schema' },
});

describe('classification inference', () => {
    test('changes effective input identity when the citation wire contract changes', () => {
        const repository = candidate('cache-case', 'Exact evidence text');
        const exactConfiguration = validateClassificationConfiguration({
            citationMode: 'exact_quote',
            promptVersion: 'same-prompt-version',
        });
        const referenceConfiguration = validateClassificationConfiguration({
            citationMode: 'evidence_id',
            promptVersion: 'same-prompt-version',
        });
        const exact = prepareClassificationInference({
            task: 'affiliation',
            candidate: repository,
            institution,
            configuration: exactConfiguration,
        });
        const reference = prepareClassificationInference({
            task: 'affiliation',
            candidate: repository,
            institution,
            configuration: referenceConfiguration,
        });
        const client: ClassificationClient = {
            provider: 'test',
            model: 'cache-identity',
            simulated: true,
            cacheIdentity: 'test:cache-identity',
            async classify() {
                return '';
            },
        };
        expect(
            classificationInputHash({
                task: 'affiliation',
                client,
                configuration: exactConfiguration,
                messages: exact.messages,
                evidence: exact.evidence,
            }),
        ).not.toBe(
            classificationInputHash({
                task: 'affiliation',
                client,
                configuration: referenceConfiguration,
                messages: reference.messages,
                evidence: reference.evidence,
            }),
        );
    });

    test('resolves IDs in request-local catalogs during concurrent cases', async () => {
        const firstCandidate = candidate('case-one', 'First case README evidence');
        const secondCandidate = candidate('case-two', 'Second case README evidence');
        const firstPrepared = prepareClassificationInference({
            task: 'affiliation',
            candidate: firstCandidate,
            institution,
            configuration,
        });
        const secondPrepared = prepareClassificationInference({
            task: 'affiliation',
            candidate: secondCandidate,
            institution,
            configuration,
        });
        const firstId = firstPrepared.evidence.evidenceCatalog.find(
            (reference) => reference.field === 'readme',
        )!.id;
        const secondId = secondPrepared.evidence.evidenceCatalog.find(
            (reference) => reference.field === 'readme',
        )!.id;
        const observedModes: string[] = [];
        const client: ClassificationClient = {
            provider: 'test',
            model: 'request-scoped-fake',
            simulated: true,
            cacheIdentity: 'test:request-scoped-fake',
            async classify() {
                throw new Error('classifyDetailed should be used');
            },
            async classifyDetailed(
                task,
                messages,
                _signal,
                requestOptions,
            ): Promise<ClassificationCompletion> {
                observedModes.push(requestOptions?.citationMode ?? 'missing');
                const id = messages[1]?.content.includes('case-one')
                    ? firstId
                    : secondId;
                const text =
                    task === 'affiliation'
                        ? JSON.stringify({
                              decision: 'supported',
                              relationship: 'coursework',
                              score: 0.8,
                              evidenceIds: [id],
                              explanation: 'The request evidence supports course work.',
                          })
                        : JSON.stringify({
                              category: 'EDU',
                              evidenceIds: [id],
                              explanation: 'The request evidence describes course work.',
                          });
                return {
                    text,
                    finishReason: 'stop',
                    completionStatus: 'complete',
                    attemptDiagnostics: [
                        { attempt: 1, outcome: 'reply_received', elapsedMs: 1 },
                    ],
                };
            },
        };

        const inputs = [
                [firstCandidate, firstPrepared, 'affiliation'],
                [secondCandidate, secondPrepared, 'affiliation'],
                [firstCandidate, prepareClassificationInference({
                    task: 'project_type',
                    candidate: firstCandidate,
                    institution,
                    configuration,
                }), 'project_type'],
                [secondCandidate, prepareClassificationInference({
                    task: 'project_type',
                    candidate: secondCandidate,
                    institution,
                    configuration,
                }), 'project_type'],
            ] as const;
        const results = await Promise.all(inputs.map(async ([candidateValue, prepared, task]) =>
            runClassificationInference({
                task: task as ClassificationTask,
                candidate: candidateValue,
                institution,
                configuration,
                client,
                prepared,
            }),
        ));

        expect(results.map((result) => result.response.evidence[0]?.quote)).toEqual([
            'First case README evidence',
            'Second case README evidence',
            'First case README evidence',
            'Second case README evidence',
        ]);
        expect(observedModes).toEqual(['evidence_id', 'evidence_id', 'evidence_id', 'evidence_id']);
        expect(firstPrepared.promptHash).not.toBe(secondPrepared.promptHash);
        expect(
            results.every(
                (result) =>
                    result.evidenceCatalog !== null &&
                    result.evidenceCatalog.entryCount > 0,
            ),
        ).toBe(true);
    });

    test('captures but rejects a provider response marked truncated', async () => {
        const repository = candidate('truncated', 'A sufficiently exact quote');
        const prepared = prepareClassificationInference({
            task: 'project_type',
            candidate: repository,
            institution,
            configuration,
        });
        let captured: string | null = null;
        const client: ClassificationClient = {
            provider: 'test',
            model: 'truncated-fake',
            simulated: true,
            async classify() {
                throw new Error('classifyDetailed should be used');
            },
            async classifyDetailed(): Promise<ClassificationCompletion> {
                return {
                    text: '{"category":"DEV"',
                    finishReason: 'length',
                    completionStatus: 'truncated',
                    attemptDiagnostics: [
                        { attempt: 1, outcome: 'reply_received', elapsedMs: 1 },
                    ],
                };
            },
        };
        await expect(
            runClassificationInference({
                task: 'project_type',
                candidate: repository,
                institution,
                configuration,
                client,
                prepared,
                onRawResponse: (text) => {
                    captured = text;
                },
            }),
        ).rejects.toMatchObject({ code: 'provider_truncated_completion' });
        expect(captured).toBe('{"category":"DEV"');
    });

    describe('citation repair and missing-score retry', () => {
        const exactConfiguration = validateClassificationConfiguration({
            citationMode: 'exact_quote',
        });
        const repository = {
            ...candidate('repair', 'Built for CS 101 at Example Institute.'),
            homepage: null,
        };
        const supported = (evidence: unknown[], score: number | null = 0.8) =>
            JSON.stringify({
                decision: 'supported',
                relationship: 'coursework',
                score,
                evidence,
                explanation: 'The README names a course at the institution.',
            });
        const replying = (...texts: string[]) => {
            const seen: Array<readonly { role: string; content: string }[]> = [];
            let index = 0;
            const client: ClassificationClient = {
                provider: 'test',
                model: 'scripted',
                simulated: true,
                async classify() {
                    throw new Error('classifyDetailed should be used');
                },
                async classifyDetailed(_task, messages) {
                    seen.push(messages);
                    const text = texts[Math.min(index, texts.length - 1)]!;
                    index += 1;
                    return {
                        text,
                        completionStatus: 'complete',
                        usage: { input: 10, output: 5, total: 15 },
                        attemptDiagnostics: [
                            { attempt: 1, outcome: 'reply_received', elapsedMs: 1 },
                        ],
                    };
                },
            };
            return { client, seen };
        };
        const run = (
            client: ClassificationClient,
            extra: {
                citationPolicy?: 'strict' | 'repair';
                retryMissingScore?: boolean;
            } = {},
        ) =>
            runClassificationInference({
                task: 'affiliation',
                candidate: repository,
                institution,
                configuration: exactConfiguration,
                client,
                ...extra,
            });

        test('strict policy rejects a mislabelled quote that repair relabels', async () => {
            const text = supported([
                { field: 'description', quote: 'CS 101 at Example Institute' },
                { field: 'homepage', quote: 'https://example.test' },
            ]);
            await expect(run(replying(text).client)).rejects.toMatchObject({
                code: 'invalid_citation',
            });
            const repaired = await run(replying(text).client, {
                citationPolicy: 'repair',
            });
            expect(repaired.response.evidence).toEqual([
                { field: 'readme', quote: 'CS 101 at Example Institute' },
            ]);
            expect(repaired.citationRepairs.map((repair) => repair.action)).toEqual([
                'relabeled',
                'dropped',
            ]);
            expect(repaired.responseText).toBe(text);
        });

        test('repair still fails when no verified citation remains', async () => {
            await expect(
                run(
                    replying(
                        supported([{ field: 'homepage', quote: 'https://example.test' }]),
                    ).client,
                    { citationPolicy: 'repair' },
                ),
            ).rejects.toMatchObject({ code: 'invalid_citation' });
        });

        test('asks once for a missing score and never fills one in locally', async () => {
            const evidence = [{ field: 'readme', quote: 'CS 101' }];
            await expect(
                run(replying(supported(evidence, null)).client),
            ).rejects.toMatchObject({ detail: 'missing_score' });

            const { client, seen } = replying(
                supported(evidence, null),
                supported(evidence, 0.65),
            );
            const result = await run(client, { retryMissingScore: true });
            expect(result.response).toMatchObject({ score: 0.65 });
            expect(result.scoreRetried).toBe(true);
            expect(result.requestAttempts).toBe(2);
            expect(result.tokenUsage).toEqual({ input: 20, output: 10, total: 30 });
            expect(seen).toHaveLength(2);
            expect(seen[1]!.slice(0, seen[0]!.length)).toEqual(seen[0]);
            expect(seen[1]!.slice(-2).map((message) => message.role)).toEqual([
                'assistant',
                'user',
            ]);
            expect(seen[1]!.at(-2)?.content).toBe(supported(evidence, null));
        });

        test('reports a second missing score as a failure after one follow-up', async () => {
            const evidence = [{ field: 'readme', quote: 'CS 101' }];
            const { client, seen } = replying(supported(evidence, null));
            await expect(
                run(client, { retryMissingScore: true }),
            ).rejects.toMatchObject({
                code: 'invalid_schema',
                detail: 'missing_score',
                message: expect.stringMatching(/^After one missing-score follow-up/),
            });
            expect(seen).toHaveLength(2);
        });
    });
});

function candidate(name: string, readme: string): ClassificationCandidate {
    return {
        id: name === 'case-one' ? 1 : name === 'case-two' ? 2 : 3,
        university: institution.key,
        fullName: `example/${name}`,
        owner: 'example',
        htmlUrl: `https://example.test/example/${name}`,
        description: 'Coursework repository',
        readme,
        homepage: null,
        language: 'TypeScript',
        license: 'mit',
        fork: 0,
        archived: false,
        isTemplate: false,
        size: 20,
        stargazersCount: 0,
        forksCount: 0,
        contributors: '[]',
    };
}
