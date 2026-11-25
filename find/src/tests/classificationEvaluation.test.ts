import { FakeClassificationClient } from '../classification/client';
import type {
    ClassificationClient,
    ClassificationCompletion,
} from '../classification/client';
import {
    parseEvaluationCases,
    runClassificationEvaluation,
} from '../classification/evaluation';
import { validateClassificationConfiguration } from '../config';

const configuration = validateClassificationConfiguration({
    concurrency: 1,
    generation: {
        responseFormat: 'json_schema',
        temperature: 0,
        maxOutputTokens: 128,
    },
});

describe('non-persisting classification evaluation', () => {
    test('reports abstentions, unresolved human labels, held-out metrics, and human claim review separately', async () => {
        const cases = parseEvaluationCases([
            fixture('development-positive', {
                split: 'development',
                labels: { affiliation: 'supported', projectType: 'EDU' },
                humanReview: {
                    unsupportedClaimsReviewed: true,
                    unsupportedClaims: 2,
                },
            }),
            fixture('heldout-uncertain', {
                split: 'held_out',
                labels: { affiliation: 'uncertain', projectType: 'OTHER' },
            }),
        ]);
        const responses = [
            supportedResponse(),
            projectResponse('EDU'),
            uncertainResponse(),
            projectResponse('OTHER'),
        ];
        const report = await runClassificationEvaluation({
            cases,
            client: new FakeClassificationClient(responses),
            configuration,
            concurrency: 1,
        });

        expect(report.providerResults.uncertainty).toEqual({
            count: 1,
            denominator: 2,
            rate: 0.5,
        });
        expect(report.affiliationMetrics.all).toMatchObject({
            labeledCount: 2,
            resolvedHumanLabelCount: 1,
            unresolvedHumanLabelCount: 1,
            modelAbstentions: 0,
            coverage: 1,
            metricsExcludingAbstentions: {
                correct: 1,
                denominator: 1,
            },
        });
        // The quote never names the institution: raw metrics keep the model's
        // supported decision, while the gate's outcome is reported separately.
        expect(report.affiliationEvidenceGate).toMatchObject({
            mode: 'names_institution',
            rawSupported: 1,
            gatedSupported: 0,
            downgraded: 1,
        });
        expect(report.affiliationEvidenceGate.metrics.all).toMatchObject({
            modelAbstentions: 1,
            coverage: 0,
            metricsExcludingAbstentions: { correct: 0, denominator: 0 },
        });
        expect(
            report.cases.find(
                (result) => result.caseId === 'development-positive',
            )?.gatedAffiliation,
        ).toEqual({
            mode: 'names_institution',
            decision: 'uncertain',
            downgraded: true,
        });
        expect(
            (
                report.cases.find(
                    (result) => result.caseId === 'development-positive',
                )?.affiliation.response as { decision: string }
            ).decision,
        ).toBe('supported');
        expect(
            report.affiliationMetrics.held_out.unresolvedHumanCaseIds,
        ).toEqual(['heldout-uncertain']);
        expect(report.projectTypeMetrics.development.confusion.EDU.EDU).toBe(1);
        expect(report.humanReviewedUnsupportedClaims).toEqual({
            reviewedCases: 1,
            explicitUnsupportedClaimCount: 2,
            automaticDetection: false,
        });
    });

    test('separates logical requests from retries and reports wrong-field diagnostics', async () => {
        const client: ClassificationClient = {
            provider: 'test-provider',
            model: 'test-model',
            simulated: false,
            cacheIdentity: 'http://localhost:11434/v1',
            async classify() {
                throw new Error('classifyDetailed should be used');
            },
            async classifyDetailed(task): Promise<ClassificationCompletion> {
                const text =
                    task === 'affiliation'
                        ? JSON.stringify({
                              decision: 'supported',
                              relationship: 'coursework',
                              score: 0.8,
                              evidence: [
                                  {
                                      field: 'description',
                                      quote: 'A course assignment',
                                  },
                              ],
                              explanation:
                                  'The course evidence supports affiliation.',
                          })
                        : projectResponse('EDU');
                const attemptDiagnostics =
                    task === 'affiliation'
                        ? [
                              {
                                  attempt: 1,
                                  outcome: 'rate_limit_retry' as const,
                                  elapsedMs: 2,
                                  httpStatus: 429,
                              },
                              {
                                  attempt: 2,
                                  outcome: 'reply_received' as const,
                                  elapsedMs: 5,
                                  httpStatus: 200,
                              },
                          ]
                        : [
                              {
                                  attempt: 1,
                                  outcome: 'reply_received' as const,
                                  elapsedMs: 4,
                                  httpStatus: 200,
                              },
                          ];
                return {
                    text,
                    finishReason: 'stop',
                    completionStatus: 'complete',
                    attemptDiagnostics,
                };
            },
        };
        const report = await runClassificationEvaluation({
            cases: parseEvaluationCases([fixture('case-1')]),
            client,
            configuration,
            concurrency: 1,
        });

        expect(report.providerResults).toMatchObject({
            logicalRequests: 2,
            success: 2,
            transportAttempts: {
                count: 3,
                measuredRequests: 2,
                retriedRequests: 1,
                retryAttempts: 1,
                firstAttemptOutcomes: {
                    rate_limit_retry: 1,
                    reply_received: 1,
                },
            },
            citationsValid: { valid: 1, denominator: 2 },
            citationFailureReasons: { quote_matches_other_field: 1 },
        });
        expect(report.cases[0]?.affiliation.citationDiagnostics).toEqual([
            {
                citationIndex: 1,
                declaredField: 'description',
                reason: 'quote_matches_other_field',
                matchingFields: ['readme'],
            },
        ]);
        expect(report.cases[0]?.affiliation.rawResponse).toContain(
            'A course assignment',
        );
    });

    describe('production pipeline outcome', () => {
        const readme = 'A course assignment at Saint Louis University';
        const cases = () =>
            parseEvaluationCases([
                fixture('pipeline-case', {
                    labelProvenance: 'independent_human',
                    labels: { affiliation: 'supported', projectType: 'EDU' },
                    candidate: {
                        ...(fixture('x').candidate as object),
                        readme,
                    },
                }),
            ]);
        const affiliationReply = (
            score: number | null,
            field = 'description',
        ) =>
            JSON.stringify({
                decision: 'supported',
                relationship: 'coursework',
                score,
                evidence: [{ field, quote: 'Saint Louis University' }],
                explanation: 'The README names an SLU course assignment.',
            });
        const projectReply = JSON.stringify({
            category: 'EDU',
            evidence: [{ field: 'description', quote: 'A course assignment' }],
            explanation: 'Coursework.',
        });

        test('repairs the first reply without another request and keeps first-pass metrics strict', async () => {
            const client = new FakeClassificationClient([
                (task) =>
                    task === 'affiliation'
                        ? affiliationReply(0.8)
                        : projectReply,
            ]);
            const report = await runClassificationEvaluation({
                cases: cases(),
                client,
                configuration,
                concurrency: 1,
            });
            expect(client.requests).toHaveLength(2);
            expect(report.providerResults.contractValid).toEqual({
                valid: 0,
                denominator: 2,
            });
            expect(report.affiliationMetrics.all.unscoredProviderFailures).toBe(
                1,
            );
            expect(report.productionPipeline).toMatchObject({
                followUpRequests: 0,
                accepted: {
                    affiliation: { valid: 1, denominator: 1 },
                    projectType: { valid: 1, denominator: 1 },
                },
                repairedResults: 2,
                citationRepairs: 2,
                gate: { rawSupported: 1, gatedSupported: 1, downgraded: 0 },
            });
            expect(
                report.productionPipeline.affiliationMetrics.all.confusion
                    .supported.supported,
            ).toBe(1);
            expect(
                report.productionPipeline.projectTypeMetrics.all.correct,
            ).toBe(1);
            expect(
                report.cases[0]?.pipeline.affiliation.response?.evidence,
            ).toEqual([{ field: 'readme', quote: 'Saint Louis University' }]);
        });

        test('sends one missing-score follow-up and reports it separately', async () => {
            const client = new FakeClassificationClient([
                (task, messages) =>
                    task === 'project_type'
                        ? projectReply
                        : messages.some(
                                (message) => message.role === 'assistant',
                            )
                          ? affiliationReply(0.6, 'readme')
                          : affiliationReply(null, 'readme'),
            ]);
            const report = await runClassificationEvaluation({
                cases: cases(),
                client,
                configuration,
                concurrency: 1,
            });
            expect(client.requests).toHaveLength(3);
            expect(report.providerResults.logicalRequests).toBe(2);
            expect(report.productionPipeline).toMatchObject({
                followUpRequests: 1,
                scoreRetries: { attempted: 1, recovered: 1 },
                accepted: { affiliation: { valid: 1, denominator: 1 } },
            });
            expect(
                report.cases[0]?.pipeline.affiliation.response,
            ).toMatchObject({ score: 0.6 });
        });
    });
});

function fixture(
    caseId: string,
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        caseId,
        snapshotAt: '2026-10-26T20:00:00.000Z',
        institution: {
            key: 'Saint Louis University',
            fullName: 'Saint Louis University',
            acronym: 'SLU',
        },
        candidate: {
            id: 42,
            fullName: 'slu/course-project',
            owner: 'slu',
            description: 'Course exercise',
            readme: 'A course assignment',
            homepage: null,
            language: 'TypeScript',
            license: 'mit',
            fork: 0,
            size: 12,
            stargazersCount: 0,
            forksCount: 0,
            archived: null,
            isTemplate: null,
        },
        labelProvenance: 'independent_human',
        labels: {},
        labelRationale: '',
        split: 'development',
        ...overrides,
    };
}

function supportedResponse(): string {
    return JSON.stringify({
        decision: 'supported',
        relationship: 'coursework',
        score: 0.8,
        evidence: [{ field: 'readme', quote: 'A course assignment' }],
        explanation: 'The README documents an SLU course assignment.',
    });
}

function uncertainResponse(): string {
    return JSON.stringify({
        decision: 'uncertain',
        relationship: 'insufficient_evidence',
        score: null,
        evidence: [],
        explanation: 'Evidence does not establish a defensible conclusion.',
    });
}

function projectResponse(category: string): string {
    return JSON.stringify({
        category,
        evidence: [{ field: 'readme', quote: 'A course assignment' }],
        explanation: 'The README describes the repository purpose.',
    });
}
