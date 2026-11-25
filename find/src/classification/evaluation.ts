import { createHash } from 'node:crypto';
import type {
    ClassificationCandidate,
    ClassificationConfiguration,
    ClassificationTask,
    UniversityConfiguration,
} from '../types/scraping';
import {
    ClassificationProviderError,
    type ClassificationClient,
    type ClassificationTokenUsage,
} from './client';
import type {
    AffiliationResponse,
    ProjectType,
    ProjectTypeResponse,
} from './contracts';
import {
    CLASSIFICATION_RUBRIC_VERSION,
    RESPONSE_CONTRACT_VERSION,
    wireContractVersionForCitationMode,
} from './contracts';
import {
    runClassificationInference,
    type EvidenceCatalogSummary,
} from './inference';
import {
    ClassificationValidationError,
    type CitationFailureReason,
} from './response';
import type { ClassificationAttemptDiagnostic } from './client';
import { applyAffiliationEvidenceGate } from './gate';
import {
    interpretClassificationResponse,
    isMissingScore,
    markAfterScoreRetry,
    missingScoreFollowUpMessages,
    prepareClassificationInference,
    requestClassificationCompletion,
} from './inference';
import type { CitationRepair } from './response';
import {
    matchContextFor,
    reviewClassificationSemantics,
    type SemanticReviewResult,
} from './review';

export type EvaluationCase = {
    caseId: string;
    snapshotAt: string;
    snapshotKind: 'newly_captured' | 'recovered' | 'fixture';
    inputHash: string;
    repositoryGroupId: string;
    institution: UniversityConfiguration;
    candidate: ClassificationCandidate;
    labelProvenance: LabelProvenance;
    labels: {
        affiliation?: 'supported' | 'not_supported' | 'uncertain';
        projectType?: ProjectType;
    };
    labelRationale: string;
    split: 'development' | 'held_out';
    humanReview?: {
        unsupportedClaimsReviewed: boolean;
        unsupportedClaims?: number;
    };
};

export type LabelProvenance =
    | 'independent_human'
    | 'historical_model'
    | 'agent_suggestion'
    | 'synthetic'
    | 'unreviewed';

export type EvaluationTaskResult = {
    task: ClassificationTask;
    providerSucceeded: boolean;
    jsonValid: boolean | null;
    schemaValid: boolean | null;
    citationsValid: boolean | null;
    evidenceReferencesValid: boolean | null;
    citationDiagnostics: ClassificationValidationError['citationDiagnostics'];
    completionStatus: 'complete' | 'truncated' | 'unknown' | null;
    requestAttempts: number | null;
    attemptDiagnostics: ClassificationAttemptDiagnostic[] | null;
    promptHash: string | null;
    promptCharacters: number | null;
    effectiveInputHash: string | null;
    evidenceCatalog: EvidenceCatalogSummary | null;
    response: AffiliationResponse | ProjectTypeResponse | null;
    rawResponse: string | null;
    latencyMs: number;
    tokenUsage: ClassificationTokenUsage | null;
    failure: { code: string; message: string } | null;
};

/**
 * What the classify command would accept from the same first reply: citation
 * repair, one missing-score follow-up (the only extra request), then the
 * evidence gate for affiliation.
 */
export type PipelineTaskOutcome = {
    accepted: boolean;
    response: AffiliationResponse | ProjectTypeResponse | null;
    citationRepairs: CitationRepair[];
    scoreRetried: boolean;
    followUpRequests: number;
    failure: { code: string; message: string } | null;
};

export type EvaluationCaseResult = {
    caseId: string;
    snapshotAt: string;
    snapshotKind: EvaluationCase['snapshotKind'];
    inputHash: string;
    repositoryGroupId: string;
    split: EvaluationCase['split'];
    institution: UniversityConfiguration;
    candidate: ClassificationCandidate;
    labelProvenance: LabelProvenance;
    eligibilityBypassed: true;
    eligibilityFlags: { fork: number; archived: boolean | null; isTemplate: boolean | null };
    totalLatencyMs: number;
    labels: EvaluationCase['labels'];
    labelRationale: string;
    humanReview: EvaluationCase['humanReview'] | null;
    /** The model's raw decision lives in `affiliation.response`. */
    affiliation: EvaluationTaskResult;
    /** What the production runner would store after the evidence gate. */
    gatedAffiliation: {
        mode: ClassificationConfiguration['affiliationEvidenceGate'];
        decision: AffiliationResponse['decision'] | null;
        downgraded: boolean;
    };
    projectType: EvaluationTaskResult;
    /** Production-pipeline outcomes, reported apart from first-pass results. */
    pipeline: {
        affiliation: PipelineTaskOutcome;
        projectType: PipelineTaskOutcome;
        gatedAffiliationDecision: AffiliationResponse['decision'] | null;
        downgraded: boolean;
    };
    semanticReview: SemanticReviewResult;
};

export type ClassificationEvaluationReport = {
    startedAt: string;
    generatedAt: string;
    elapsedMs: number;
    interrupted: boolean;
    provider: string;
    model: string;
    endpointIdentity: string;
    responseContractVersion: string;
    wireContractVersion: string;
    rubricVersion: typeof CLASSIFICATION_RUBRIC_VERSION;
    promptVersion: string;
    citationMode: ClassificationConfiguration['citationMode'];
    generation: ClassificationConfiguration['generation'];
    timeoutMs: number;
    maxRetries: number;
    responseFormat: ClassificationConfiguration['generation']['responseFormat'];
    temperature: number | null;
    maxOutputTokens: number;
    seed: number | null;
    concurrency: number;
    caseCount: number;
    providerResults: {
        logicalRequests: number;
        transportAttempts: {
            count: number | null;
            measuredRequests: number;
            retriedRequests: number;
            retryAttempts: number | null;
            firstAttemptOutcomes: Record<string, number>;
        };
        success: number;
        failures: number;
        jsonValid: { valid: number; denominator: number };
        schemaValid: { valid: number; denominator: number };
        contractValid: { valid: number; denominator: number };
        citationsValid: { valid: number; denominator: number };
        evidenceReferencesValid: { valid: number; denominator: number };
        citationFailureReasons: Record<CitationFailureReason, number>;
        contradictoryResponses: number;
        uncertainty: { count: number; denominator: number; rate: number | null };
        latencyMs: {
            count: number;
            mean: number | null;
            median: number | null;
            p50: number | null;
            p95: number | null;
        };
        acceptedTaskOutputsPerMinute: number | null;
        tokenUsage: {
            requestsWithMetadata: number;
            inputTokens: number | null;
            outputTokens: number | null;
            totalTokens: number | null;
        };
    };
    promptTelemetry: {
        requestsWithPromptHash: number;
        totalPromptCharacters: number;
        meanPromptCharacters: number | null;
        evidenceCatalogRequests: number;
        evidenceCatalogEntries: number;
        evidenceCatalogTextCharacters: number;
    };
    /** Computed from the model's raw decisions (first pass, ungated). */
    affiliationMetrics: Record<string, ReturnType<typeof affiliationMetrics>>;
    /** The evidence gate's effect, reported separately from raw decisions. */
    affiliationEvidenceGate: {
        mode: ClassificationConfiguration['affiliationEvidenceGate'];
        rawSupported: number;
        gatedSupported: number;
        downgraded: number;
        metrics: Record<string, ReturnType<typeof affiliationMetrics>>;
    };
    projectTypeMetrics: Record<string, ReturnType<typeof projectTypeMetrics>>;
    /**
     * The same first replies processed as the classify command stores them.
     * Separate from first-pass metrics, which stay strict.
     */
    productionPipeline: {
        description: string;
        followUpRequests: number;
        accepted: {
            affiliation: { valid: number; denominator: number };
            projectType: { valid: number; denominator: number };
        };
        repairedResults: number;
        citationRepairs: number;
        scoreRetries: { attempted: number; recovered: number };
        gate: { rawSupported: number; gatedSupported: number; downgraded: number };
        affiliationMetrics: Record<string, ReturnType<typeof affiliationMetrics>>;
        projectTypeMetrics: Record<string, ReturnType<typeof projectTypeMetrics>>;
    };
    humanReviewedUnsupportedClaims: {
        reviewedCases: number;
        explicitUnsupportedClaimCount: number;
        automaticDetection: false;
    };
    semanticReview: {
        casesRequiringReview: number;
        persistenceBlocks: 0;
        byReason: Record<string, number>;
    };
    labelProvenanceCounts: Record<LabelProvenance, number>;
    cases: EvaluationCaseResult[];
};

export function parseEvaluationCases(value: unknown): EvaluationCase[] {
    const caseValues = Array.isArray(value)
        ? value
        : isRecord(value) && Array.isArray(value.cases)
          ? value.cases
          : null;
    if (!caseValues) {
        throw new TypeError('Fixture file must contain an array or a cases array');
    }
    const defaultSnapshotKind =
        isRecord(value) && isSnapshotKind(value.snapshotKind)
            ? value.snapshotKind
            : 'fixture';
    return caseValues.map((item) =>
        parseEvaluationCase(item, defaultSnapshotKind),
    );
}

export async function runClassificationEvaluation(options: {
    cases: readonly EvaluationCase[];
    client: ClassificationClient;
    configuration: ClassificationConfiguration;
    concurrency: number;
    signal?: AbortSignal;
    now?: () => Date;
}): Promise<ClassificationEvaluationReport> {
    const now = options.now ?? (() => new Date());
    const startedAt = now();
    if (!Number.isFinite(startedAt.getTime())) {
        throw new TypeError('Evaluation clock returned an invalid start date');
    }
    const started = performance.now();
    const results: EvaluationCaseResult[] = [];
    await mapBounded(
        options.cases,
        options.concurrency,
        options.signal,
        async (testCase) => {
            const [affiliation, projectType] = await Promise.all([
                evaluateTask('affiliation', testCase, options),
                evaluateTask('project_type', testCase, options),
            ]);
            const [pipelineAffiliation, pipelineProjectType] = await Promise.all([
                productionOutcome('affiliation', testCase, options, affiliation),
                productionOutcome('project_type', testCase, options, projectType),
            ]);
            const pipelineGate = pipelineAffiliation.response
                ? applyAffiliationEvidenceGate(
                      pipelineAffiliation.response as AffiliationResponse,
                      testCase.institution,
                      matchContextFor(testCase.candidate),
                      options.configuration.affiliationEvidenceGate,
                  )
                : null;
            results.push({
                caseId: testCase.caseId,
                snapshotAt: testCase.snapshotAt,
                snapshotKind: testCase.snapshotKind,
                inputHash: testCase.inputHash,
                repositoryGroupId: testCase.repositoryGroupId,
                split: testCase.split,
                institution: testCase.institution,
                candidate: testCase.candidate,
                labelProvenance: testCase.labelProvenance,
                eligibilityBypassed: true,
                eligibilityFlags: {
                    fork: testCase.candidate.fork,
                    archived: testCase.candidate.archived,
                    isTemplate: testCase.candidate.isTemplate,
                },
                totalLatencyMs: affiliation.latencyMs + projectType.latencyMs,
                labels: testCase.labels,
                labelRationale: testCase.labelRationale,
                humanReview: testCase.humanReview ?? null,
                affiliation,
                gatedAffiliation: gateAffiliation(
                    affiliation,
                    testCase,
                    options.configuration.affiliationEvidenceGate,
                ),
                projectType,
                pipeline: {
                    affiliation: pipelineAffiliation,
                    projectType: pipelineProjectType,
                    gatedAffiliationDecision:
                        pipelineGate?.response.decision ?? null,
                    downgraded: pipelineGate?.downgradedFrom != null,
                },
                semanticReview: reviewClassificationSemantics(
                    affiliation.response && 'decision' in affiliation.response
                        ? affiliation.response
                        : null,
                    projectType.response && 'category' in projectType.response
                        ? projectType.response.category
                        : null,
                    testCase.institution,
                    matchContextFor(testCase.candidate),
                ),
            });
        },
    );
    results.sort((left, right) => left.caseId.localeCompare(right.caseId));
    const taskResults = results.flatMap((result) => [
        result.affiliation,
        result.projectType,
    ]);
    const successful = taskResults.filter((result) => result.providerSucceeded);
    const validJson = successful.filter((result) => result.jsonValid === true).length;
    const validSchema = successful.filter((result) => result.schemaValid === true).length;
    const validContract = successful.filter(
        (result) => result.response !== null,
    ).length;
    const citationChecked = successful.filter(
        (result) => result.citationsValid !== null,
    );
    const validCitations = successful.filter(
        (result) => result.citationsValid === true,
    ).length;
    const evidenceReferenceChecked = successful.filter(
        (result) => result.evidenceReferencesValid !== null,
    );
    const validEvidenceReferences = evidenceReferenceChecked.filter(
        (result) => result.evidenceReferencesValid === true,
    ).length;
    const citationFailureReasons: Record<CitationFailureReason, number> = {
        source_field_missing: 0,
        empty_source: 0,
        quote_absent_from_visible_segments: 0,
        quote_matches_other_field: 0,
    };
    const transportRequests = taskResults.filter(
        (result) => result.attemptDiagnostics !== null,
    );
    const transportAttemptsKnown = transportRequests.length === taskResults.length;
    const transportAttempts = transportRequests.flatMap(
        (result) => result.attemptDiagnostics ?? [],
    );
    const firstAttemptOutcomes: Record<string, number> = {};
    for (const result of taskResults) {
        const first = result.attemptDiagnostics?.[0];
        if (first) {
            firstAttemptOutcomes[first.outcome] =
                (firstAttemptOutcomes[first.outcome] ?? 0) + 1;
        }
    }
    for (const result of taskResults) {
        for (const diagnostic of result.citationDiagnostics) {
            citationFailureReasons[diagnostic.reason] += 1;
        }
    }
    const contradictoryResponses = taskResults.filter(
        (result) => result.failure?.code === 'contradictory_response',
    ).length;
    const affiliationResponses = results.filter(
        (result) => result.affiliation.response !== null,
    );
    const modelUncertain = results.filter(
        (result) =>
            result.affiliation.response !== null &&
            (result.affiliation.response as AffiliationResponse).decision ===
                'uncertain',
    ).length;
    const latencies = taskResults.map((result) => result.latencyMs);
    const elapsedMs = Math.max(0, performance.now() - started);
    const measuredPrompts = taskResults.filter(
        (result) => result.promptCharacters !== null,
    );
    const catalogs = taskResults.filter((result) => result.evidenceCatalog !== null);
    const semanticReviewCases = results.filter(
        (result) => result.semanticReview.required,
    );
    const semanticReviewByReason: Record<string, number> = {};
    const labelProvenanceCounts: Record<LabelProvenance, number> = {
        independent_human: 0,
        historical_model: 0,
        agent_suggestion: 0,
        synthetic: 0,
        unreviewed: 0,
    };
    for (const result of results) {
        if (
            result.labels.affiliation !== undefined ||
            result.labels.projectType !== undefined
        ) {
            labelProvenanceCounts[result.labelProvenance] += 1;
        }
        for (const reason of result.semanticReview.reasons) {
            semanticReviewByReason[reason] =
                (semanticReviewByReason[reason] ?? 0) + 1;
        }
    }
    const withUsage = taskResults.filter((result) => result.tokenUsage !== null);
    const generatedAt = now();
    if (!Number.isFinite(generatedAt.getTime())) {
        throw new TypeError('Evaluation clock returned an invalid date');
    }
    const splits = ['all', 'development', 'held_out'] as const;
    return {
        startedAt: startedAt.toISOString(),
        generatedAt: generatedAt.toISOString(),
        elapsedMs,
        interrupted: options.signal?.aborted ?? false,
        provider: options.client.provider,
        model: options.client.model,
        endpointIdentity: options.client.cacheIdentity ?? '',
        responseContractVersion: RESPONSE_CONTRACT_VERSION,
        wireContractVersion: wireContractVersionForCitationMode(
            options.configuration.citationMode,
        ),
        rubricVersion: CLASSIFICATION_RUBRIC_VERSION,
        promptVersion: options.configuration.promptVersion,
        citationMode: options.configuration.citationMode,
        generation: options.configuration.generation,
        timeoutMs: options.configuration.timeoutMs,
        maxRetries: options.configuration.maxRetries,
        responseFormat: options.configuration.generation.responseFormat,
        temperature: options.configuration.generation.temperature ?? null,
        maxOutputTokens: options.configuration.generation.maxOutputTokens,
        seed: options.configuration.generation.seed ?? null,
        concurrency: options.concurrency,
        caseCount: results.length,
        providerResults: {
            logicalRequests: taskResults.length,
            transportAttempts: {
                count: transportAttemptsKnown
                    ? transportAttempts.length
                    : null,
                measuredRequests: transportRequests.length,
                retriedRequests: taskResults.filter(
                    (result) => (result.requestAttempts ?? 0) > 1,
                ).length,
                retryAttempts: transportAttemptsKnown
                    ? taskResults.reduce(
                          (sum, result) =>
                              sum + Math.max(0, (result.requestAttempts ?? 0) - 1),
                          0,
                      )
                    : null,
                firstAttemptOutcomes,
            },
            success: successful.length,
            failures: taskResults.length - successful.length,
            jsonValid: { valid: validJson, denominator: successful.length },
            schemaValid: { valid: validSchema, denominator: successful.length },
            contractValid: {
                valid: validContract,
                denominator: successful.length,
            },
            citationsValid: {
                valid: validCitations,
                denominator: citationChecked.length,
            },
            evidenceReferencesValid: {
                valid: validEvidenceReferences,
                denominator: evidenceReferenceChecked.length,
            },
            citationFailureReasons,
            contradictoryResponses,
            uncertainty: {
                count: modelUncertain,
                denominator: affiliationResponses.length,
                rate:
                    affiliationResponses.length === 0
                        ? null
                        : modelUncertain / affiliationResponses.length,
            },
            latencyMs: {
                count: latencies.length,
                mean: mean(latencies),
                median: median(latencies),
                p50: percentile(latencies, 0.5),
                p95: percentile(latencies, 0.95),
            },
            acceptedTaskOutputsPerMinute:
                elapsedMs === 0
                    ? null
                    : validContract / (elapsedMs / 60_000),
            tokenUsage: {
                requestsWithMetadata: withUsage.length,
                inputTokens: sumUsage(withUsage, 'input'),
                outputTokens: sumUsage(withUsage, 'output'),
                totalTokens: sumUsage(withUsage, 'total'),
            },
        },
        promptTelemetry: {
            requestsWithPromptHash: measuredPrompts.filter(
                (result) => result.promptHash !== null,
            ).length,
            totalPromptCharacters: measuredPrompts.reduce(
                (sum, result) => sum + (result.promptCharacters ?? 0),
                0,
            ),
            meanPromptCharacters:
                measuredPrompts.length === 0
                    ? null
                    : mean(
                          measuredPrompts.map(
                              (result) => result.promptCharacters ?? 0,
                          ),
                      ),
            evidenceCatalogRequests: catalogs.length,
            evidenceCatalogEntries: catalogs.reduce(
                (sum, result) => sum + (result.evidenceCatalog?.entryCount ?? 0),
                0,
            ),
            evidenceCatalogTextCharacters: catalogs.reduce(
                (sum, result) =>
                    sum + (result.evidenceCatalog?.textCharacters ?? 0),
                0,
            ),
        },
        affiliationMetrics: Object.fromEntries(
            splits.map((split) => [
                split,
                affiliationMetrics(
                    results.filter((result) => split === 'all' || result.split === split),
                ),
            ]),
        ),
        affiliationEvidenceGate: {
            mode: options.configuration.affiliationEvidenceGate,
            rawSupported: results.filter(
                (result) =>
                    (result.affiliation.response as AffiliationResponse | null)
                        ?.decision === 'supported',
            ).length,
            gatedSupported: results.filter(
                (result) => result.gatedAffiliation.decision === 'supported',
            ).length,
            downgraded: results.filter(
                (result) => result.gatedAffiliation.downgraded,
            ).length,
            metrics: Object.fromEntries(
                splits.map((split) => [
                    split,
                    affiliationMetrics(
                        results.filter(
                            (result) => split === 'all' || result.split === split,
                        ),
                        (result) => result.gatedAffiliation.decision,
                    ),
                ]),
            ),
        },
        projectTypeMetrics: Object.fromEntries(
            splits.map((split) => [
                split,
                projectTypeMetrics(
                    results.filter((result) => split === 'all' || result.split === split),
                ),
            ]),
        ),
        productionPipeline: summarizePipeline(
            results,
            splits,
        ),
        humanReviewedUnsupportedClaims: {
            reviewedCases: results.filter(
                (result) => result.humanReview?.unsupportedClaimsReviewed,
            ).length,
            explicitUnsupportedClaimCount: results.reduce(
                (sum, result) =>
                    sum +
                    (result.humanReview?.unsupportedClaimsReviewed
                        ? (result.humanReview.unsupportedClaims ?? 0)
                        : 0),
                0,
            ),
            automaticDetection: false,
        },
        semanticReview: {
            casesRequiringReview: semanticReviewCases.length,
            persistenceBlocks: 0,
            byReason: semanticReviewByReason,
        },
        labelProvenanceCounts,
        cases: results,
    };
}

const VALIDATION_FAILURE_CODES = new Set([
    'invalid_json',
    'invalid_schema',
    'invalid_citation',
    'invalid_evidence_reference',
    'contradictory_response',
]);

async function productionOutcome(
    task: ClassificationTask,
    testCase: EvaluationCase,
    options: {
        client: ClassificationClient;
        configuration: ClassificationConfiguration;
        signal?: AbortSignal;
    },
    strict: EvaluationTaskResult,
): Promise<PipelineTaskOutcome> {
    const outcome = (
        value: Partial<PipelineTaskOutcome> & Pick<PipelineTaskOutcome, 'accepted'>,
    ): PipelineTaskOutcome => ({
        response: null,
        citationRepairs: [],
        scoreRetried: false,
        followUpRequests: 0,
        failure: null,
        ...value,
    });
    if (strict.response) return outcome({ accepted: true, response: strict.response });
    if (
        strict.rawResponse === null ||
        !strict.failure ||
        !VALIDATION_FAILURE_CODES.has(strict.failure.code)
    ) {
        return outcome({ accepted: false, failure: strict.failure });
    }
    const prepared = prepareClassificationInference({
        task,
        candidate: testCase.candidate,
        institution: testCase.institution,
        configuration: options.configuration,
    });
    const interpret = (text: string) =>
        interpretClassificationResponse({
            task,
            configuration: options.configuration,
            evidence: prepared.evidence,
            text,
            citationPolicy: 'repair',
        });
    try {
        const interpreted = interpret(strict.rawResponse);
        return outcome({
            accepted: true,
            response: interpreted.response,
            citationRepairs: interpreted.citationRepairs,
        });
    } catch (error) {
        if (task !== 'affiliation' || !isMissingScore(error)) {
            return outcome({ accepted: false, failure: pipelineFailure(error) });
        }
    }
    try {
        const completion = await requestClassificationCompletion({
            task,
            client: options.client,
            configuration: options.configuration,
            messages: missingScoreFollowUpMessages(
                prepared.messages,
                strict.rawResponse,
            ),
            signal: options.signal,
        });
        const interpreted = interpret(completion.text);
        return outcome({
            accepted: true,
            response: interpreted.response,
            citationRepairs: interpreted.citationRepairs,
            scoreRetried: true,
            followUpRequests: 1,
        });
    } catch (error) {
        return outcome({
            accepted: false,
            scoreRetried: true,
            followUpRequests: 1,
            failure: pipelineFailure(markAfterScoreRetry(error)),
        });
    }
}

function pipelineFailure(error: unknown): { code: string; message: string } {
    const code =
        error instanceof ClassificationValidationError ||
        error instanceof ClassificationProviderError
            ? error.code
            : 'provider_failure';
    return { code, message: sanitizeFailure(error) };
}

function summarizePipeline(
    results: readonly EvaluationCaseResult[],
    splits: readonly ('all' | 'development' | 'held_out')[],
): ClassificationEvaluationReport['productionPipeline'] {
    const outcomes = results.flatMap((result) => [
        result.pipeline.affiliation,
        result.pipeline.projectType,
    ]);
    const retried = outcomes.filter((outcome) => outcome.scoreRetried);
    const bySplit = <T>(compute: (subset: EvaluationCaseResult[]) => T) =>
        Object.fromEntries(
            splits.map((split) => [
                split,
                compute(
                    results.filter(
                        (result) => split === 'all' || result.split === split,
                    ),
                ),
            ]),
        );
    return {
        description:
            "Each case's first reply with citation repair, one missing-score follow-up, and the affiliation evidence gate, as the classify command would store it. Project types are evaluated for every case, not only supported affiliations.",
        followUpRequests: outcomes.reduce(
            (sum, outcome) => sum + outcome.followUpRequests,
            0,
        ),
        accepted: {
            affiliation: {
                valid: results.filter((result) => result.pipeline.affiliation.accepted)
                    .length,
                denominator: results.length,
            },
            projectType: {
                valid: results.filter((result) => result.pipeline.projectType.accepted)
                    .length,
                denominator: results.length,
            },
        },
        repairedResults: outcomes.filter(
            (outcome) => outcome.citationRepairs.length > 0,
        ).length,
        citationRepairs: outcomes.reduce(
            (sum, outcome) => sum + outcome.citationRepairs.length,
            0,
        ),
        scoreRetries: {
            attempted: retried.length,
            recovered: retried.filter((outcome) => outcome.accepted).length,
        },
        gate: {
            rawSupported: results.filter(
                (result) =>
                    (result.pipeline.affiliation.response as AffiliationResponse | null)
                        ?.decision === 'supported',
            ).length,
            gatedSupported: results.filter(
                (result) => result.pipeline.gatedAffiliationDecision === 'supported',
            ).length,
            downgraded: results.filter((result) => result.pipeline.downgraded).length,
        },
        affiliationMetrics: bySplit((subset) =>
            affiliationMetrics(
                subset,
                (result) => result.pipeline.gatedAffiliationDecision,
            ),
        ),
        projectTypeMetrics: bySplit((subset) =>
            projectTypeMetrics(subset, (result) =>
                result.pipeline.projectType.response
                    ? (result.pipeline.projectType.response as ProjectTypeResponse)
                          .category
                    : null,
            ),
        ),
    };
}

async function evaluateTask(
    task: ClassificationTask,
    testCase: EvaluationCase,
    options: {
        client: ClassificationClient;
        configuration: ClassificationConfiguration;
        signal?: AbortSignal;
    },
): Promise<EvaluationTaskResult> {
    const startedAt = performance.now();
    let rawResponse: string | null = null;
    let tokenUsage: ClassificationTokenUsage | null = null;
    let completionStatus: 'complete' | 'truncated' | 'unknown' | null = null;
    let requestAttempts: number | null = null;
    let attemptDiagnostics: ClassificationAttemptDiagnostic[] | null = null;
    let promptHash: string | null = null;
    let promptCharacters: number | null = null;
    let effectiveInputHash: string | null = null;
    let evidenceCatalog: EvidenceCatalogSummary | null = null;
    try {
        const inference = await runClassificationInference({
            task,
            candidate: testCase.candidate,
            institution: testCase.institution,
            configuration: options.configuration,
            client: options.client,
            signal: options.signal,
            onRawResponse: (text, usage, diagnostics, status) => {
                rawResponse = text;
                if (usage) {
                    tokenUsage = {
                        input: usage.input,
                        output: usage.output,
                        total: usage.total,
                    };
                }
                if (diagnostics !== undefined) {
                    attemptDiagnostics = diagnostics;
                    requestAttempts = diagnostics.length;
                }
                if (status !== undefined) completionStatus = status;
            },
            onRequestPrepared: (prepared) => {
                promptHash = prepared.promptHash;
                promptCharacters = prepared.promptCharacters;
                effectiveInputHash = prepared.inputHash;
                evidenceCatalog = prepared.evidenceCatalog;
            },
        });
        return {
            task,
            providerSucceeded: true,
            jsonValid: true,
            schemaValid: true,
            citationsValid: true,
            evidenceReferencesValid:
                options.configuration.citationMode === 'evidence_id' ? true : null,
            citationDiagnostics: [],
            completionStatus: inference.completionStatus,
            requestAttempts: inference.requestAttempts,
            attemptDiagnostics: inference.attemptDiagnostics,
            promptHash: inference.promptHash,
            promptCharacters: inference.promptCharacters,
            effectiveInputHash: inference.inputHash,
            evidenceCatalog: inference.evidenceCatalog,
            response: inference.response,
            rawResponse,
            latencyMs: inference.latencyMs,
            tokenUsage: inference.tokenUsage,
            failure: null,
        };
    } catch (error) {
        const observedAttempts = attemptDiagnostics as
            | ClassificationAttemptDiagnostic[]
            | null;
        const validation =
            error instanceof ClassificationValidationError ? error : null;
        const code =
            validation?.code ??
            (error instanceof ClassificationProviderError
                ? error.code
                : 'provider_failure');
        const providerSucceeded = rawResponse !== null || validation !== null;
        return {
            task,
            providerSucceeded,
            jsonValid:
                !providerSucceeded || validation === null
                    ? null
                    : validation.code !== 'invalid_json',
            schemaValid:
                !providerSucceeded || validation === null
                    ? null
                    : !['invalid_json', 'invalid_schema'].includes(
                          validation.code,
                      ),
            citationsValid:
                validation?.code === 'invalid_citation'
                    ? false
                    : null,
            evidenceReferencesValid:
                evidenceReferenceValidity(
                    options.configuration.citationMode,
                    validation,
                    rawResponse,
                ),
            citationDiagnostics: validation?.citationDiagnostics ?? [],
            response: null,
            rawResponse,
            completionStatus: validation
                ? null
                : error instanceof ClassificationProviderError &&
                    error.code === 'provider_truncated_completion'
                  ? 'truncated'
                  : completionStatus,
            requestAttempts:
                observedAttempts?.length ??
                (error instanceof ClassificationProviderError
                    ? error.attemptDiagnostics.length
                    : requestAttempts),
            attemptDiagnostics:
                observedAttempts ??
                (error instanceof ClassificationProviderError
                    ? error.attemptDiagnostics
                    : null),
            promptHash,
            promptCharacters,
            effectiveInputHash,
            evidenceCatalog,
            latencyMs: Math.max(0, performance.now() - startedAt),
            tokenUsage,
            failure: { code, message: sanitizeFailure(error) },
        };
    }
}

function gateAffiliation(
    affiliation: EvaluationTaskResult,
    testCase: EvaluationCase,
    mode: ClassificationConfiguration['affiliationEvidenceGate'],
): EvaluationCaseResult['gatedAffiliation'] {
    const response = affiliation.response as AffiliationResponse | null;
    if (!response) return { mode, decision: null, downgraded: false };
    const gated = applyAffiliationEvidenceGate(
        response,
        testCase.institution,
        matchContextFor(testCase.candidate),
        mode,
    );
    return {
        mode,
        decision: gated.response.decision,
        downgraded: gated.downgradedFrom !== null,
    };
}

function rawAffiliationDecision(
    result: EvaluationCaseResult,
): AffiliationResponse['decision'] | null {
    return result.affiliation.response
        ? (result.affiliation.response as AffiliationResponse).decision
        : null;
}

function affiliationMetrics(
    results: readonly EvaluationCaseResult[],
    decisionOf: (
        result: EvaluationCaseResult,
    ) => AffiliationResponse['decision'] | null = rawAffiliationDecision,
) {
    const labeled = results.filter(
        (result) =>
            result.labelProvenance === 'independent_human' &&
            result.labels.affiliation,
    );
    const unresolved = labeled.filter(
        (result) => result.labels.affiliation === 'uncertain',
    );
    const resolved = labeled.filter(
        (result) => result.labels.affiliation !== 'uncertain',
    );
    const confusion = {
        supported: { supported: 0, not_supported: 0 },
        not_supported: { supported: 0, not_supported: 0 },
    };
    let abstentions = 0;
    let unscored = 0;
    for (const result of resolved) {
        const expected = result.labels.affiliation as 'supported' | 'not_supported';
        const predicted = decisionOf(result);
        if (predicted === null) {
            unscored += 1;
        } else if (predicted === 'uncertain') {
            abstentions += 1;
        } else {
            confusion[expected][predicted] += 1;
        }
    }
    const truePositive = confusion.supported.supported;
    const predictedPositive =
        confusion.supported.supported + confusion.not_supported.supported;
    const actualPositive =
        confusion.supported.supported + confusion.supported.not_supported;
    const scored = Object.values(confusion).reduce(
        (sum, row) => sum + row.supported + row.not_supported,
        0,
    );
    const correct = confusion.supported.supported + confusion.not_supported.not_supported;
    return {
        labeledCount: labeled.length,
        resolvedHumanLabelCount: resolved.length,
        unresolvedHumanLabelCount: unresolved.length,
        unresolvedHumanCaseIds: unresolved.map((result) => result.caseId),
        modelAbstentions: abstentions,
        unscoredProviderFailures: unscored,
        coverage: ratio(resolved.length - abstentions - unscored, resolved.length),
        confusion,
        precision: metric(truePositive, predictedPositive),
        recall: metric(truePositive, actualPositive),
        metricsExcludingAbstentions: {
            accuracy: metric(correct, scored),
            correct,
            denominator: scored,
        },
    };
}

function strictProjectType(result: EvaluationCaseResult): ProjectType | null {
    return result.projectType.response
        ? (result.projectType.response as ProjectTypeResponse).category
        : null;
}

function projectTypeMetrics(
    results: readonly EvaluationCaseResult[],
    categoryOf: (result: EvaluationCaseResult) => ProjectType | null = strictProjectType,
) {
    const labeled = results.filter(
        (result) =>
            result.labelProvenance === 'independent_human' &&
            result.labels.projectType,
    );
    const confusion: Record<ProjectType, Record<ProjectType, number>> = {
        DEV: emptyProjectTypeRow(),
        EDU: emptyProjectTypeRow(),
        DOCS: emptyProjectTypeRow(),
        WEB: emptyProjectTypeRow(),
        DATA: emptyProjectTypeRow(),
        OTHER: emptyProjectTypeRow(),
    };
    const perClass: Record<
        ProjectType,
        { humanCount: number; predictedCount: number; correct: number; unscored: number }
    > = {
        DEV: { humanCount: 0, predictedCount: 0, correct: 0, unscored: 0 },
        EDU: { humanCount: 0, predictedCount: 0, correct: 0, unscored: 0 },
        DOCS: { humanCount: 0, predictedCount: 0, correct: 0, unscored: 0 },
        WEB: { humanCount: 0, predictedCount: 0, correct: 0, unscored: 0 },
        DATA: { humanCount: 0, predictedCount: 0, correct: 0, unscored: 0 },
        OTHER: { humanCount: 0, predictedCount: 0, correct: 0, unscored: 0 },
    };
    let correct = 0;
    let unscored = 0;
    for (const result of labeled) {
        const expected = result.labels.projectType!;
        const predicted = categoryOf(result);
        perClass[expected].humanCount += 1;
        if (predicted === null) {
            perClass[expected].unscored += 1;
            unscored += 1;
            continue;
        }
        confusion[expected][predicted] += 1;
        perClass[predicted].predictedCount += 1;
        if (expected === predicted) {
            correct += 1;
            perClass[expected].correct += 1;
        }
    }
    const scored = labeled.length - unscored;
    return {
        labeledCount: labeled.length,
        unscoredProviderFailures: unscored,
        coverage: ratio(scored, labeled.length),
        accuracy: metric(correct, scored),
        correct,
        denominator: scored,
        confusion,
        perClass,
    };
}

function parseEvaluationCase(
    value: unknown,
    defaultSnapshotKind: EvaluationCase['snapshotKind'],
): EvaluationCase {
    if (!isRecord(value)) throw new TypeError('Each evaluation case must be an object');
    const caseId = requireText(value.caseId, 'caseId');
    const snapshotAt = requireText(value.snapshotAt, `${caseId}.snapshotAt`);
    if (!Number.isFinite(Date.parse(snapshotAt))) {
        throw new TypeError(`${caseId}.snapshotAt must be a timestamp`);
    }
    const institution = parseInstitution(value.institution, caseId);
    const candidate = parseCandidate(value.candidate, institution, caseId);
    const labels = parseLabels(value.labels, caseId);
    const labelProvenance = value.labelProvenance ?? 'unreviewed';
    if (
        labelProvenance !== 'independent_human' &&
        labelProvenance !== 'historical_model' &&
        labelProvenance !== 'agent_suggestion' &&
        labelProvenance !== 'synthetic' &&
        labelProvenance !== 'unreviewed'
    ) {
        throw new TypeError(`${caseId}.labelProvenance is unsupported`);
    }
    const labelRationale = requireText(value.labelRationale, `${caseId}.labelRationale`, true);
    if (value.split !== 'development' && value.split !== 'held_out') {
        throw new TypeError(`${caseId}.split must be development or held_out`);
    }
    const inputHash =
        value.inputHash === undefined
            ? createHash('sha256')
                  .update(canonicalStringify({ institution, candidate }))
                  .digest('hex')
            : requireText(value.inputHash, `${caseId}.inputHash`);
    if (!/^[0-9a-f]{64}$/.test(inputHash)) {
        throw new TypeError(`${caseId}.inputHash must be a lowercase SHA-256 digest`);
    }
    const repositoryGroupId =
        value.repositoryGroupId === undefined
            ? `repository:${candidate.id}`
            : requireText(value.repositoryGroupId, `${caseId}.repositoryGroupId`);
    const humanReview = parseHumanReview(value.humanReview, caseId);
    return {
        caseId,
        snapshotAt,
        snapshotKind: isSnapshotKind(value.snapshotKind)
            ? value.snapshotKind
            : defaultSnapshotKind,
        inputHash,
        repositoryGroupId,
        institution,
        candidate,
        labelProvenance,
        labels,
        labelRationale,
        split: value.split,
        ...(humanReview ? { humanReview } : {}),
    };
}

function parseInstitution(value: unknown, caseId: string): UniversityConfiguration {
    if (!isRecord(value)) throw new TypeError(`${caseId}.institution must be an object`);
    const institution: UniversityConfiguration = {
        key: requireText(value.key, `${caseId}.institution.key`),
        fullName: requireText(value.fullName, `${caseId}.institution.fullName`),
        acronym: requireText(value.acronym, `${caseId}.institution.acronym`),
    };
    if (value.emailDomains !== undefined) {
        if (!Array.isArray(value.emailDomains) || !value.emailDomains.every(isNonemptyString)) {
            throw new TypeError(`${caseId}.institution.emailDomains must be strings`);
        }
        institution.emailDomains = value.emailDomains;
    }
    if (value.additionalQueries !== undefined) {
        if (!Array.isArray(value.additionalQueries) || !value.additionalQueries.every(isNonemptyString)) {
            throw new TypeError(`${caseId}.institution.additionalQueries must be strings`);
        }
        institution.additionalQueries = value.additionalQueries;
    }
    if (value.alternateNames !== undefined) {
        if (!Array.isArray(value.alternateNames) || !value.alternateNames.every(isNonemptyString)) {
            throw new TypeError(`${caseId}.institution.alternateNames must be strings`);
        }
        institution.alternateNames = value.alternateNames;
    }
    if (value.excludedNames !== undefined) {
        if (!Array.isArray(value.excludedNames) || !value.excludedNames.every(isNonemptyString)) {
            throw new TypeError(`${caseId}.institution.excludedNames must be strings`);
        }
        institution.excludedNames = value.excludedNames;
    }
    if (value.affiliationDefinition !== undefined) {
        institution.affiliationDefinition = requireText(
            value.affiliationDefinition,
            `${caseId}.institution.affiliationDefinition`,
        );
    }
    return institution;
}

function parseCandidate(
    value: unknown,
    institution: UniversityConfiguration,
    caseId: string,
): ClassificationCandidate {
    if (!isRecord(value)) throw new TypeError(`${caseId}.candidate must be an object`);
    const id = value.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
        throw new TypeError(`${caseId}.candidate.id must be a positive safe integer`);
    }
    const fork = value.fork;
    if (fork !== 0 && fork !== 1) {
        throw new TypeError(`${caseId}.candidate.fork must be 0 or 1`);
    }
    const size = value.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
        throw new TypeError(`${caseId}.candidate.size must be a non-negative safe integer`);
    }
    return {
        id,
        university: optionalText(value.university) ?? institution.key,
        fullName: nullableText(value.fullName, `${caseId}.candidate.fullName`),
        owner: requireText(value.owner, `${caseId}.candidate.owner`),
        htmlUrl: nullableText(value.htmlUrl, `${caseId}.candidate.htmlUrl`),
        description: nullableText(value.description, `${caseId}.candidate.description`),
        readme: nullableText(value.readme, `${caseId}.candidate.readme`),
        homepage: nullableText(value.homepage, `${caseId}.candidate.homepage`),
        language: nullableText(value.language, `${caseId}.candidate.language`),
        license: nullableText(value.license, `${caseId}.candidate.license`),
        fork,
        // Missing eligibility flags remain unknown; evaluation does not apply production gating.
        archived: value.archived === undefined ? null : requireNullableBoolean(value.archived, `${caseId}.candidate.archived`),
        isTemplate: value.isTemplate === undefined ? null : requireNullableBoolean(value.isTemplate, `${caseId}.candidate.isTemplate`),
        size,
        stargazersCount: nonnegativeInteger(value.stargazersCount, `${caseId}.candidate.stargazersCount`, 0),
        forksCount: nonnegativeInteger(value.forksCount, `${caseId}.candidate.forksCount`, 0),
        contributors: nullableText(value.contributors, `${caseId}.candidate.contributors`),
    };
}

function parseLabels(value: unknown, caseId: string): EvaluationCase['labels'] {
    if (value === undefined) return {};
    if (!isRecord(value)) throw new TypeError(`${caseId}.labels must be an object`);
    const labels: EvaluationCase['labels'] = {};
    if (value.affiliation !== undefined) {
        if (!['supported', 'not_supported', 'uncertain'].includes(String(value.affiliation))) {
            throw new TypeError(`${caseId}.labels.affiliation is unsupported`);
        }
        labels.affiliation = value.affiliation as EvaluationCase['labels']['affiliation'];
    }
    if (value.projectType !== undefined) {
        if (!['DEV', 'EDU', 'DOCS', 'WEB', 'DATA', 'OTHER'].includes(String(value.projectType))) {
            throw new TypeError(`${caseId}.labels.projectType is unsupported`);
        }
        labels.projectType = value.projectType as ProjectType;
    }
    return labels;
}

function parseHumanReview(value: unknown, caseId: string): EvaluationCase['humanReview'] | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value) || typeof value.unsupportedClaimsReviewed !== 'boolean') {
        throw new TypeError(`${caseId}.humanReview.unsupportedClaimsReviewed must be boolean`);
    }
    const unsupportedClaims = value.unsupportedClaims;
    if (unsupportedClaims !== undefined && (!Number.isSafeInteger(unsupportedClaims) || Number(unsupportedClaims) < 0)) {
        throw new TypeError(`${caseId}.humanReview.unsupportedClaims must be a non-negative integer`);
    }
    return {
        unsupportedClaimsReviewed: value.unsupportedClaimsReviewed,
        ...(unsupportedClaims === undefined ? {} : { unsupportedClaims: Number(unsupportedClaims) }),
    };
}

function emptyProjectTypeRow(): Record<ProjectType, number> {
    return { DEV: 0, EDU: 0, DOCS: 0, WEB: 0, DATA: 0, OTHER: 0 };
}

function metric(numerator: number, denominator: number) {
    return { value: denominator === 0 ? null : numerator / denominator, numerator, denominator };
}

function ratio(numerator: number, denominator: number) {
    return denominator === 0 ? null : numerator / denominator;
}

function mean(values: readonly number[]): number | null {
    return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1]! + sorted[middle]!) / 2
        : sorted[middle]!;
}

function percentile(values: readonly number[], proportion: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const position = (sorted.length - 1) * proportion;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const fraction = position - lower;
    return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * fraction;
}

function sumUsage(
    results: readonly EvaluationTaskResult[],
    key: keyof ClassificationTokenUsage,
): number | null {
    const values = results
        .map((result) => result.tokenUsage?.[key] ?? null)
        .filter((value): value is number => value !== null);
    return values.length === 0
        ? null
        : values.reduce((sum, value) => sum + value, 0);
}

function evidenceReferenceValidity(
    citationMode: ClassificationConfiguration['citationMode'],
    validation: ClassificationValidationError | null,
    rawResponse: string | null,
): boolean | null {
    if (citationMode !== 'evidence_id' || rawResponse === null || !validation) {
        return null;
    }
    if (validation.code === 'invalid_evidence_reference') return false;
    if (validation.code === 'invalid_json' || validation.code === 'invalid_schema') {
        return null;
    }
    return true;
}

function sanitizeFailure(error: unknown): string {
    const message = error instanceof Error ? error.message : 'Unknown classifier failure';
    return [...message]
        .map((character) => {
            const code = character.codePointAt(0)!;
            return (code <= 0x1f || code === 0x7f) ? ' ' : character;
        })
        .join('')
        .slice(0, 600);
}

function canonicalStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

function requireText(value: unknown, name: string, emptyAllowed = false): string {
    if (typeof value !== 'string' || (!emptyAllowed && value.trim() === '')) {
        throw new TypeError(`${name} must be ${emptyAllowed ? 'text' : 'non-empty text'}`);
    }
    return value;
}

function nullableText(value: unknown, name: string): string | null {
    if (value === undefined || value === null) return null;
    return requireText(value, name, true);
}

function optionalText(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function requireNullableBoolean(value: unknown, name: string): boolean | null {
    if (value === null) return null;
    if (typeof value !== 'boolean') throw new TypeError(`${name} must be boolean or null`);
    return value;
}

function nonnegativeInteger(value: unknown, name: string, fallback: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative safe integer`);
    }
    return value;
}

function isNonemptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '';
}

function isSnapshotKind(
    value: unknown,
): value is EvaluationCase['snapshotKind'] {
    return (
        value === 'newly_captured' ||
        value === 'recovered' ||
        value === 'fixture'
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function mapBounded<T>(
    values: readonly T[],
    concurrency: number,
    signal: AbortSignal | undefined,
    callback: (value: T) => Promise<void>,
): Promise<void> {
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(values.length, concurrency) }, async () => {
            while (!signal?.aborted) {
                const index = next++;
                if (index >= values.length) return;
                await callback(values[index]!);
            }
        }),
    );
}
