import type {
    ClassificationCandidate,
    ClassificationConfiguration,
    ClassificationPrediction,
    ClassificationStatus,
    ClassificationTask,
    UniversityConfiguration,
} from '../types/scraping';
import type { ClassificationClient } from './client';
import {
    RESPONSE_CONTRACT_VERSION,
    type AffiliationResponse,
    type ProjectType,
    type ProjectTypeResponse,
    wireContractVersionForCitationMode,
} from './contracts';
import {
    classificationInputHash,
    prepareClassificationInference,
    runClassificationInference,
    type ClassificationInferenceResult,
    type PreparedClassificationInference,
} from './inference';
import {
    ClassificationValidationError,
    type CitationRepair,
} from './response';
import {
    affiliationGatePolicy,
    applyAffiliationEvidenceGate,
    prefilteredAffiliation,
    visibleTextNamesInstitution,
} from './gate';
import {
    type ClassificationPredictionKey,
    type ClassificationStorePort,
} from './store';
import {
    matchContextFor,
    reviewClassificationSemantics,
    type SemanticReviewReason,
} from './review';

export type ClassificationFailure = {
    university: string;
    repositoryId: number;
    repository: string | null;
    task: ClassificationTask;
    message: string;
};

export type UniversityClassificationReport = {
    university: string;
    candidates: number;
    eligible: number;
    ineligible: number;
    affiliationPredicted: number;
    belowThreshold: number;
    affiliationNotSupported: number;
    affiliationUncertain: number;
    projectTypesPredicted: number;
    reused: number;
    failed: number;
    /** Results accepted only after at least one citation was relabeled or dropped. */
    repairedResults: number;
    /** Individual citation repairs across those results. */
    citationRepairs: number;
    /** Affiliation requests that sent the missing-score follow-up. */
    scoreRetries: number;
    /** Those follow-ups whose reply was accepted. */
    scoreRetriesRecovered: number;
    /** Supported affiliations the evidence gate stored as uncertain (also counted as uncertain). */
    downgraded: number;
    /** Eligible repositories not sent to the model (see visibleTextNamesInstitution). */
    prefiltered: number;
};

export type ClassificationRepairRecord = {
    university: string;
    repositoryId: number;
    repository: string | null;
    task: ClassificationTask;
    repairs: CitationRepair[];
};

export type ClassificationProgressEvent = {
    university: string;
    task: ClassificationTask;
    completed: number;
    total: number;
    failed: number;
    elapsedMs: number;
};

export type ClassificationRunReport = {
    startedAt: string;
    finishedAt: string;
    elapsedMs: number;
    interrupted: boolean;
    simulated: boolean;
    simulationSeed?: number;
    provider: string;
    model: string;
    promptVersion: string;
    responseContractVersion: string;
    wireContractVersion: string;
    citationMode: ClassificationConfiguration['citationMode'];
    generation: ClassificationConfiguration['generation'];
    threshold: number;
    universities: UniversityClassificationReport[];
    failures: ClassificationFailure[];
    citationRepairs: ClassificationRepairRecord[];
    affiliationEvidenceGate: ClassificationConfiguration['affiliationEvidenceGate'];
    affiliationDowngrades: AffiliationDowngradeRecord[];
    scoreRetries: Array<{
        university: string;
        repositoryId: number;
        repository: string | null;
        task: ClassificationTask;
        recovered: boolean;
    }>;
    semanticReviewFindings: Array<{
        university: string;
        repositoryId: number;
        repository: string | null;
        reasons: SemanticReviewReason[];
    }>;
};

export type ClassificationRunnerDependencies = {
    store: ClassificationStorePort;
    client: ClassificationClient;
    configuration: ClassificationConfiguration;
    universities: readonly UniversityConfiguration[];
    signal?: AbortSignal;
    now?: () => Date;
    onProgress?: (event: ClassificationProgressEvent) => void;
};

export type AffiliationDowngradeRecord = {
    university: string;
    repositoryId: number;
    repository: string | null;
    /** The model's accepted response before the gate replaced it. */
    original: AffiliationResponse;
};

type RunLog = {
    affiliationDowngrades: AffiliationDowngradeRecord[];
    failures: ClassificationFailure[];
    citationRepairs: ClassificationRepairRecord[];
    scoreRetries: ClassificationRunReport['scoreRetries'];
};

type AffiliationOutcome = {
    status:
        | 'supported'
        | 'below_threshold'
        | 'not_supported'
        | 'uncertain'
        | 'ineligible'
        | 'failed';
    score: number | null;
    decision: AffiliationResponse['decision'] | null;
    relationship: AffiliationResponse['relationship'] | null;
    evidence: AffiliationResponse['evidence'] | null;
    explanation: string | null;
};

export async function runClassification(
    dependencies: ClassificationRunnerDependencies,
): Promise<ClassificationRunReport> {
    const now = dependencies.now ?? (() => new Date());
    const started = now();
    if (!Number.isFinite(started.getTime()))
        throw new TypeError('Classification clock returned an invalid date');
    const failures: ClassificationFailure[] = [];
    const log: RunLog = {
        failures,
        citationRepairs: [],
        scoreRetries: [],
        affiliationDowngrades: [],
    };
    const universityReports: UniversityClassificationReport[] = [];
    const semanticReviewFindings: ClassificationRunReport['semanticReviewFindings'] = [];

    for (const university of dependencies.universities) {
        if (dependencies.signal?.aborted) break;
        const candidates = await dependencies.store.listCandidates(
            university.key,
        );
        const report: UniversityClassificationReport = {
            university: university.key,
            candidates: candidates.length,
            eligible: 0,
            ineligible: 0,
            affiliationPredicted: 0,
            belowThreshold: 0,
            affiliationNotSupported: 0,
            affiliationUncertain: 0,
            projectTypesPredicted: 0,
            reused: 0,
            failed: 0,
            repairedResults: 0,
            citationRepairs: 0,
            scoreRetries: 0,
            scoreRetriesRecovered: 0,
            downgraded: 0,
            prefiltered: 0,
        };
        const progress = (task: ClassificationTask) => {
            let completed = 0;
            const emit = () =>
                dependencies.onProgress?.({
                    university: university.key,
                    task,
                    completed,
                    total: candidates.length,
                    failed: report.failed,
                    elapsedMs: Math.max(0, now().getTime() - started.getTime()),
                });
            emit();
            return () => {
                completed += 1;
                emit();
            };
        };
        const outcomes = new Map<number, AffiliationOutcome>();
        const projectTypes = new Map<number, ProjectType | null>();
        const affiliationDone = progress('affiliation');
        await mapBounded(
            candidates,
            dependencies.configuration.concurrency,
            dependencies.signal,
            async (candidate) => {
                outcomes.set(
                    candidate.id,
                    await classifyAffiliation(
                        candidate,
                        university,
                        dependencies,
                        report,
                        log,
                        now,
                    ),
                );
                affiliationDone();
            },
        );

        const projectTypeDone = progress('project_type');
        await mapBounded(
            candidates,
            dependencies.configuration.concurrency,
            dependencies.signal,
            async (candidate) => {
                projectTypes.set(
                    candidate.id,
                    await classifyProjectType(
                        candidate,
                        university,
                        outcomes.get(candidate.id),
                        dependencies,
                        report,
                        log,
                        now,
                    ),
                );
                projectTypeDone();
            },
        );
        for (const candidate of candidates) {
            const affiliation = outcomes.get(candidate.id);
            const review = reviewClassificationSemantics(
                affiliation?.status === 'supported' && affiliation.relationship
                    ? {
                          decision: 'supported',
                          relationship: affiliation.relationship,
                          evidence: affiliation.evidence ?? [],
                      }
                    : null,
                projectTypes.get(candidate.id) ?? null,
                university,
                matchContextFor(candidate),
            );
            if (review.required) {
                semanticReviewFindings.push({
                    university: university.key,
                    repositoryId: candidate.id,
                    repository: candidate.fullName,
                    reasons: review.reasons,
                });
            }
        }
        universityReports.push(report);
    }

    const finished = now();
    if (!Number.isFinite(finished.getTime()))
        throw new TypeError('Classification clock returned an invalid date');
    return {
        startedAt: started.toISOString(),
        finishedAt: finished.toISOString(),
        elapsedMs: Math.max(0, finished.getTime() - started.getTime()),
        interrupted: dependencies.signal?.aborted ?? false,
        simulated: dependencies.client.simulated,
        ...(dependencies.client.simulationSeed === undefined
            ? {}
            : { simulationSeed: dependencies.client.simulationSeed }),
        provider: dependencies.client.provider,
        model: dependencies.client.model,
        promptVersion: dependencies.configuration.promptVersion,
        responseContractVersion: RESPONSE_CONTRACT_VERSION,
        wireContractVersion: wireContractVersionForCitationMode(
            dependencies.configuration.citationMode,
        ),
        citationMode: dependencies.configuration.citationMode,
        generation: dependencies.configuration.generation,
        threshold: dependencies.configuration.threshold,
        universities: universityReports,
        failures,
        citationRepairs: log.citationRepairs,
        affiliationEvidenceGate:
            dependencies.configuration.affiliationEvidenceGate,
        affiliationDowngrades: log.affiliationDowngrades,
        scoreRetries: log.scoreRetries,
        semanticReviewFindings,
    };
}

async function classifyAffiliation(
    candidate: ClassificationCandidate,
    university: UniversityConfiguration,
    dependencies: ClassificationRunnerDependencies,
    report: UniversityClassificationReport,
    log: RunLog,
    now: () => Date,
): Promise<AffiliationOutcome> {
    const failures = log.failures;
    const task = 'affiliation' as const;
    const prepared = prepareClassificationInference({
        task,
        candidate,
        institution: university,
        configuration: dependencies.configuration,
    });
    const key = predictionKey(
        task,
        candidate,
        prepared,
        dependencies,
        affiliationGatePolicy(
            dependencies.configuration.affiliationEvidenceGate,
            university,
        ),
    );
    try {
        const existing = await dependencies.store.findPrediction(key);
        const eligibility = getEligibility(candidate);
        if (!eligibility.eligible) {
            report.ineligible += 1;
            if (existing?.status === 'ineligible') report.reused += 1;
            else
                await dependencies.store.savePrediction(
                    makePrediction(
                        key,
                        emptyStructuredResult({
                            explanation: eligibility.reason,
                            status: 'ineligible',
                        }),
                        dependencies.client,
                        now,
                    ),
                );
            return emptyAffiliationOutcome('ineligible', eligibility.reason);
        }

        report.eligible += 1;
        let response: AffiliationResponse;
        if (isReusableAffiliation(existing)) {
            report.reused += 1;
            response = {
                decision: existing.affiliationDecision!,
                relationship:
                    existing.affiliationRelationship as AffiliationResponse['relationship'],
                score: existing.score,
                evidence: existing.affiliationEvidence as AffiliationResponse['evidence'],
                explanation: existing.explanation ?? '',
            };
        } else if (
            dependencies.configuration.affiliationEvidenceGate !== 'off' &&
            !visibleTextNamesInstitution(
                prepared.evidence.citationSegments,
                university,
                matchContextFor(candidate),
            )
        ) {
            report.prefiltered += 1;
            response = prefilteredAffiliation(university);
        } else {
            const inference = await runClassificationInference({
                task,
                candidate,
                institution: university,
                configuration: dependencies.configuration,
                client: dependencies.client,
                signal: dependencies.signal,
                prepared,
                citationPolicy: 'repair',
                retryMissingScore: true,
            });
            recordInferenceAdjustments(candidate, task, inference, report, log);
            const gated = applyAffiliationEvidenceGate(
                inference.response as AffiliationResponse,
                university,
                matchContextFor(candidate),
                dependencies.configuration.affiliationEvidenceGate,
            );
            response = gated.response;
            if (gated.downgradedFrom) {
                report.downgraded += 1;
                log.affiliationDowngrades.push({
                    university: candidate.university,
                    repositoryId: candidate.id,
                    repository: candidate.fullName,
                    original: gated.downgradedFrom,
                });
            }
        }

        const status: ClassificationStatus = affiliationStatus(
            response,
            dependencies.configuration.threshold,
        );
        const outcomeStatus = affiliationOutcomeStatus(status);
        if (status === 'predicted') report.affiliationPredicted += 1;
        else if (status === 'below_threshold') report.belowThreshold += 1;
        else if (status === 'not_supported') report.affiliationNotSupported += 1;
        else if (status === 'uncertain') report.affiliationUncertain += 1;

        const predictionResult = {
            score: response.score,
            category: null,
            affiliationDecision: response.decision,
            affiliationRelationship: response.relationship,
            affiliationEvidence: response.evidence,
            explanation: response.explanation,
            status,
            errorMessage: null,
        };
        if (!sameAffiliation(existing, predictionResult, dependencies.client)) {
            await dependencies.store.savePrediction(
                makePrediction(key, predictionResult, dependencies.client, now),
            );
        }
        return {
            status: outcomeStatus,
            score: response.score,
            decision: response.decision,
            relationship: response.relationship,
            evidence: response.evidence,
            explanation: response.explanation,
        };
    } catch (error) {
        if (dependencies.signal?.aborted) {
            return emptyAffiliationOutcome('failed', null);
        }
        const message = errorMessage(error);
        report.failed += 1;
        failures.push(toFailure(candidate, task, message));
        if (
            error instanceof ClassificationValidationError &&
            error.afterScoreRetry
        ) {
            report.scoreRetries += 1;
            log.scoreRetries.push({
                university: candidate.university,
                repositoryId: candidate.id,
                repository: candidate.fullName,
                task,
                recovered: false,
            });
        }
        await saveFailure(key, message, dependencies, failures, candidate, task, now);
        return emptyAffiliationOutcome('failed', null);
    }
}

async function classifyProjectType(
    candidate: ClassificationCandidate,
    university: UniversityConfiguration,
    affiliation: AffiliationOutcome | undefined,
    dependencies: ClassificationRunnerDependencies,
    report: UniversityClassificationReport,
    log: RunLog,
    now: () => Date,
): Promise<ProjectType | null> {
    const failures = log.failures;
    const task = 'project_type' as const;
    const prepared = prepareClassificationInference({
        task,
        candidate,
        institution: university,
        configuration: dependencies.configuration,
    });
    const eligibility = getEligibility(candidate);
    if (!eligibility.eligible) {
        await saveSkipped(
            candidate,
            task,
            'skipped_eligibility',
            eligibility.reason,
            prepared,
            { status: 'ineligible' },
            dependencies,
            now,
            report,
            failures,
        );
        return null;
    }
    if (!affiliation || affiliation.status === 'failed') {
        await saveSkipped(
            candidate,
            task,
            'skipped_affiliation_failed',
            'Affiliation prediction failed; project type was not requested.',
            prepared,
            { status: 'affiliation_failed' },
            dependencies,
            now,
            report,
            failures,
        );
        return null;
    }
    if (affiliation.status === 'uncertain') {
        await saveSkipped(
            candidate,
            task,
            'skipped_affiliation_uncertain',
            'Affiliation evidence was uncertain; project type was not requested.',
            prepared,
            { status: 'affiliation_uncertain' },
            dependencies,
            now,
            report,
            failures,
        );
        return null;
    }
    if (affiliation.status === 'not_supported') {
        await saveSkipped(
            candidate,
            task,
            'skipped_affiliation_rejected',
            'Affiliation evidence did not support a relationship; project type was not requested.',
            prepared,
            { status: 'affiliation_rejected' },
            dependencies,
            now,
            report,
            failures,
        );
        return null;
    }
    if (affiliation.status === 'ineligible') {
        await saveSkipped(
            candidate,
            task,
            'skipped_eligibility',
            'Candidate did not pass affiliation eligibility checks.',
            prepared,
            { status: 'ineligible' },
            dependencies,
            now,
            report,
            failures,
        );
        return null;
    }
    if (affiliation.status === 'below_threshold') {
        await saveSkipped(
            candidate,
            task,
            'skipped_threshold',
            `Affiliation score ${affiliation.score} is below threshold ${dependencies.configuration.threshold}.`,
            prepared,
            {
                status: 'below_threshold',
                affiliationScore: affiliation.score,
            },
            dependencies,
            now,
            report,
            failures,
        );
        return null;
    }

    const key = predictionKey(task, candidate, prepared, dependencies, {
        status: 'supported',
        affiliationScore: affiliation.score,
    });
    try {
        const existing = await dependencies.store.findPrediction(key);
        if (existing?.status === 'predicted' && existing.category) {
            report.reused += 1;
            report.projectTypesPredicted += 1;
            return existing.category as ProjectType;
        }
        const inference = await runClassificationInference({
            task,
            candidate,
            institution: university,
            configuration: dependencies.configuration,
            client: dependencies.client,
            signal: dependencies.signal,
            prepared,
            citationPolicy: 'repair',
        });
        const response = inference.response as ProjectTypeResponse;
        recordInferenceAdjustments(candidate, task, inference, report, log);
        report.projectTypesPredicted += 1;
        await dependencies.store.savePrediction(
            makePrediction(
                key,
                {
                    score: null,
                    category: response.category,
                    affiliationDecision: null,
                    affiliationRelationship: null,
                    affiliationEvidence: null,
                    explanation: response.explanation,
                    status: 'predicted',
                    errorMessage: null,
                },
                dependencies.client,
                now,
            ),
        );
        return response.category;
    } catch (error) {
        if (dependencies.signal?.aborted) return null;
        const message = errorMessage(error);
        report.failed += 1;
        failures.push(toFailure(candidate, task, message));
        await saveFailure(key, message, dependencies, failures, candidate, task, now);
        return null;
    }
}

function recordInferenceAdjustments(
    candidate: ClassificationCandidate,
    task: ClassificationTask,
    inference: ClassificationInferenceResult,
    report: UniversityClassificationReport,
    log: RunLog,
): void {
    const identity = {
        university: candidate.university,
        repositoryId: candidate.id,
        repository: candidate.fullName,
        task,
    };
    if (inference.citationRepairs.length > 0) {
        report.repairedResults += 1;
        report.citationRepairs += inference.citationRepairs.length;
        log.citationRepairs.push({
            ...identity,
            repairs: inference.citationRepairs,
        });
    }
    if (inference.scoreRetried) {
        report.scoreRetries += 1;
        report.scoreRetriesRecovered += 1;
        log.scoreRetries.push({ ...identity, recovered: true });
    }
}

async function saveSkipped(
    candidate: ClassificationCandidate,
    task: ClassificationTask,
    status: Extract<
        ClassificationStatus,
        | 'skipped_eligibility'
        | 'skipped_affiliation_failed'
        | 'skipped_affiliation_uncertain'
        | 'skipped_affiliation_rejected'
        | 'skipped_threshold'
    >,
    explanation: string,
    prepared: PreparedClassificationInference,
    policy: Record<string, unknown>,
    dependencies: ClassificationRunnerDependencies,
    now: () => Date,
    report: UniversityClassificationReport,
    failures: ClassificationFailure[],
): Promise<void> {
    const key = predictionKey(task, candidate, prepared, dependencies, policy);
    try {
        const existing = await dependencies.store.findPrediction(key);
        if (existing?.status === status) {
            report.reused += 1;
            return;
        }
        await dependencies.store.savePrediction(
            makePrediction(
                key,
                {
                    score: null,
                    category: null,
                    affiliationDecision: null,
                    affiliationRelationship: null,
                    affiliationEvidence: null,
                    explanation,
                    status,
                    errorMessage: null,
                },
                dependencies.client,
                now,
            ),
        );
    } catch (error) {
        if (dependencies.signal?.aborted) return;
        report.failed += 1;
        failures.push(toFailure(candidate, task, errorMessage(error)));
    }
}

async function saveFailure(
    key: ClassificationPredictionKey,
    message: string,
    dependencies: ClassificationRunnerDependencies,
    failures: ClassificationFailure[],
    candidate: ClassificationCandidate,
    task: ClassificationTask,
    now: () => Date,
): Promise<void> {
    try {
        await dependencies.store.savePrediction(
            makePrediction(
                key,
                {
                    score: null,
                    category: null,
                    affiliationDecision: null,
                    affiliationRelationship: null,
                    affiliationEvidence: null,
                    explanation: null,
                    status: 'failed',
                    errorMessage: message,
                },
                dependencies.client,
                now,
            ),
        );
    } catch (error) {
        failures.push(
            toFailure(
                candidate,
                task,
                `Could not persist failure: ${errorMessage(error)}`,
            ),
        );
    }
}

function predictionKey(
    task: ClassificationTask,
    candidate: ClassificationCandidate,
    prepared: PreparedClassificationInference,
    dependencies: ClassificationRunnerDependencies,
    policy: Record<string, unknown> = {},
): ClassificationPredictionKey {
    return {
        id: candidate.id,
        university: candidate.university,
        task,
        provider: dependencies.client.provider,
        model: dependencies.client.model,
        promptVersion: dependencies.configuration.promptVersion,
        threshold: dependencies.configuration.threshold,
        inputHash: classificationInputHash({
            task,
            client: dependencies.client,
            configuration: dependencies.configuration,
            messages: prepared.messages,
            evidence: prepared.evidence,
            policy,
        }),
    };
}

function makePrediction(
    key: ClassificationPredictionKey,
    result: Pick<
        ClassificationPrediction,
        | 'score'
        | 'category'
        | 'affiliationDecision'
        | 'affiliationRelationship'
        | 'affiliationEvidence'
        | 'explanation'
        | 'status'
        | 'errorMessage'
    >,
    client: ClassificationClient,
    now: () => Date,
): ClassificationPrediction {
    const classifiedAt = now();
    if (!Number.isFinite(classifiedAt.getTime()))
        throw new TypeError('Classification clock returned an invalid date');
    return {
        ...key,
        ...result,
        simulated: client.simulated,
        classifiedAt: classifiedAt.toISOString(),
    };
}

function emptyStructuredResult(options: {
    explanation: string;
    status: ClassificationStatus;
}) {
    return {
        score: null,
        category: null,
        affiliationDecision: null,
        affiliationRelationship: null,
        affiliationEvidence: null,
        explanation: options.explanation,
        status: options.status,
        errorMessage: null,
    } as const;
}

function emptyAffiliationOutcome(
    status: AffiliationOutcome['status'],
    explanation: string | null,
): AffiliationOutcome {
    return {
        status,
        score: null,
        decision: null,
        relationship: null,
        evidence: null,
        explanation,
    };
}

function affiliationStatus(
    response: AffiliationResponse,
    threshold: number,
): ClassificationStatus {
    if (response.decision === 'uncertain') return 'uncertain';
    if (response.decision === 'not_supported') return 'not_supported';
    return response.score! >= threshold ? 'predicted' : 'below_threshold';
}

function affiliationOutcomeStatus(
    status: ClassificationStatus,
): AffiliationOutcome['status'] {
    if (status === 'predicted') return 'supported';
    if (
        status === 'below_threshold' ||
        status === 'not_supported' ||
        status === 'uncertain'
    ) {
        return status;
    }
    throw new TypeError(`Unexpected affiliation status: ${status}`);
}

function isReusableAffiliation(
    prediction: ClassificationPrediction | null,
): prediction is ClassificationPrediction & {
    affiliationDecision: NonNullable<ClassificationPrediction['affiliationDecision']>;
    affiliationRelationship: string;
    affiliationEvidence: NonNullable<ClassificationPrediction['affiliationEvidence']>;
} {
    return Boolean(
        prediction &&
            ['predicted', 'below_threshold', 'not_supported', 'uncertain'].includes(
                prediction.status,
            ) &&
            prediction.affiliationDecision !== null &&
            prediction.affiliationRelationship !== null &&
            prediction.affiliationEvidence !== null,
    );
}

function sameAffiliation(
    existing: ClassificationPrediction | null,
    expected: Pick<
        ClassificationPrediction,
        | 'score'
        | 'category'
        | 'affiliationDecision'
        | 'affiliationRelationship'
        | 'affiliationEvidence'
        | 'explanation'
        | 'status'
        | 'errorMessage'
    >,
    client: ClassificationClient,
): boolean {
    return Boolean(
        existing &&
            existing.score === expected.score &&
            existing.category === expected.category &&
            existing.affiliationDecision === expected.affiliationDecision &&
            existing.affiliationRelationship === expected.affiliationRelationship &&
            JSON.stringify(existing.affiliationEvidence) ===
                JSON.stringify(expected.affiliationEvidence) &&
            existing.explanation === expected.explanation &&
            existing.status === expected.status &&
            existing.errorMessage === expected.errorMessage &&
            existing.simulated === client.simulated,
    );
}

function getEligibility(candidate: ClassificationCandidate): {
    eligible: boolean;
    reason: string;
} {
    const reasons: string[] = [];
    if (candidate.fork === 1) reasons.push('repository is a fork');
    if (candidate.size <= 0) reasons.push('repository is empty');
    if (candidate.archived === true) reasons.push('repository is archived');
    if (candidate.archived === null)
        reasons.push(
            'archived status is unknown; scrape again to collect eligibility metadata',
        );
    if (candidate.isTemplate === true) reasons.push('repository is a template');
    if (candidate.isTemplate === null)
        reasons.push(
            'template status is unknown; scrape again to collect eligibility metadata',
        );
    return {
        eligible: reasons.length === 0,
        reason: reasons.length ? reasons.join('; ') : 'eligible',
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toFailure(
    candidate: ClassificationCandidate,
    task: ClassificationTask,
    message: string,
): ClassificationFailure {
    return {
        university: candidate.university,
        repositoryId: candidate.id,
        repository: candidate.fullName,
        task,
        message,
    };
}

async function mapBounded<T>(
    values: readonly T[],
    concurrency: number,
    signal: AbortSignal | undefined,
    callback: (value: T) => Promise<void>,
): Promise<void> {
    let next = 0;
    const workers = Math.min(values.length, concurrency);
    await Promise.all(
        Array.from({ length: workers }, async () => {
            while (!signal?.aborted) {
                const index = next++;
                if (index >= values.length) return;
                await callback(values[index]!);
            }
        }),
    );
}
