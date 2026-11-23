import { createHash } from 'node:crypto';
import type {
    ClassificationCandidate,
    ClassificationConfiguration,
    ClassificationTask,
    UniversityConfiguration,
} from '../types/scraping';
import type {
    ClassificationClient,
    ClassificationCompletion,
    ClassificationAttemptDiagnostic,
} from './client';
import { ClassificationProviderError } from './client';
import {
    AFFILIATION_EVIDENCE_FIELDS,
    PROJECT_TYPE_EVIDENCE_FIELDS,
    RESPONSE_CONTRACT_VERSION,
    type AffiliationResponse,
    type EvidenceCitation,
    type ProjectTypeResponse,
    wireContractVersionForCitationMode,
} from './contracts';
import {
    EVIDENCE_CATALOG_VERSION,
    EVIDENCE_SPAN_MAX_CHARS,
    prepareRepositoryEvidence,
    type EvidenceReference,
    type PreparedRepositoryEvidence,
} from './evidence';
import { buildPrompt, type PromptMessage } from './prompts';
import {
    parseAffiliationResponse,
    parseProjectTypeResponse,
    ClassificationValidationError,
    repairCitations,
    resolveEvidenceReferences,
    validateCitations,
    type CitationRepair,
} from './response';

export type ClassificationInferenceResult = {
    task: ClassificationTask;
    messages: PromptMessage[];
    evidence: PreparedRepositoryEvidence;
    response: AffiliationResponse | ProjectTypeResponse;
    responseText: string;
    latencyMs: number;
    tokenUsage: { input: number | null; output: number | null; total: number | null } | null;
    completionStatus: 'complete' | 'truncated' | 'unknown' | null;
    requestAttempts: number | null;
    attemptDiagnostics: ClassificationAttemptDiagnostic[] | null;
    promptHash: string;
    promptCharacters: number;
    inputHash: string;
    evidenceCatalog: EvidenceCatalogSummary | null;
    /** Citation changes applied under the `repair` policy; empty when strict. */
    citationRepairs: CitationRepair[];
    /** True when a null score triggered the single corrective follow-up. */
    scoreRetried: boolean;
};

export type EvidenceCatalogSummary = {
    version: string;
    hash: string;
    entryCount: number;
    textCharacters: number;
    maxSpanChars: number;
};

export type PreparedClassificationInference = {
    evidence: PreparedRepositoryEvidence;
    messages: PromptMessage[];
    promptHash: string;
    promptCharacters: number;
};

export function prepareClassificationInference(options: {
    task: ClassificationTask;
    candidate: ClassificationCandidate;
    institution: UniversityConfiguration;
    configuration: ClassificationConfiguration;
}): PreparedClassificationInference {
    const evidence = prepareRepositoryEvidence(
        options.candidate,
        options.configuration,
    );
    const messages = buildPrompt(
        options.task,
        options.candidate,
        options.institution,
        options.configuration,
        evidence,
    );
    const serializedPrompt = canonicalStringify(messages);
    const promptHash = createHash('sha256')
        .update(serializedPrompt)
        .digest('hex');
    return {
        evidence,
        messages,
        promptHash,
        promptCharacters: messages.reduce(
            (sum, message) => sum + message.content.length,
            0,
        ),
    };
}

export async function runClassificationInference(options: {
    task: ClassificationTask;
    candidate: ClassificationCandidate;
    institution: UniversityConfiguration;
    configuration: ClassificationConfiguration;
    client: ClassificationClient;
    signal?: AbortSignal;
    prepared?: PreparedClassificationInference;
    /**
     * `strict` (default) rejects the whole result for any unverifiable
     * citation, which is what evaluation reports as first-pass validity.
     * `repair` relabels or drops citations as described by repairCitations.
     */
    citationPolicy?: 'strict' | 'repair';
    /** Send one corrective follow-up when a decision omits its score. */
    retryMissingScore?: boolean;
    onRawResponse?: (
        text: string,
        usage?: ClassificationCompletion['usage'],
        diagnostics?: ClassificationAttemptDiagnostic[],
        completionStatus?: ClassificationCompletion['completionStatus'],
    ) => void;
    onRequestPrepared?: (prepared: {
        promptHash: string;
        promptCharacters: number;
        inputHash: string;
        evidenceCatalog: EvidenceCatalogSummary | null;
    }) => void;
}): Promise<ClassificationInferenceResult> {
    if (options.signal?.aborted) {
        throw new ClassificationProviderError(
            'provider_cancelled',
            options.signal.reason instanceof Error
                ? options.signal.reason.message
                : 'Classification cancelled',
        );
    }
    const prepared =
        options.prepared ?? prepareClassificationInference(options);
    const { evidence, messages, promptHash, promptCharacters } = prepared;
    const inputHash = classificationInputHash({
        task: options.task,
        client: options.client,
        configuration: options.configuration,
        messages,
        evidence,
    });
    const evidenceCatalog =
        options.configuration.citationMode === 'evidence_id'
            ? summarizeEvidenceCatalog(
                  evidence.evidenceCatalog,
                  evidence.evidenceCatalogHash,
              )
            : null;
    options.onRequestPrepared?.({
        promptHash,
        promptCharacters,
        inputHash,
        evidenceCatalog,
    });
    const startedAt = performance.now();
    const request = (requestMessages: readonly PromptMessage[]) =>
        requestClassificationCompletion({
            task: options.task,
            client: options.client,
            configuration: options.configuration,
            messages: requestMessages,
            signal: options.signal,
            onRawResponse: options.onRawResponse,
        });
    const interpret = (text: string) =>
        interpretClassificationResponse({
            task: options.task,
            configuration: options.configuration,
            evidence,
            text,
            citationPolicy: options.citationPolicy ?? 'strict',
        });

    let completion = await request(messages);
    let scoreRetried = false;
    let interpreted: InterpretedClassificationResponse;
    try {
        interpreted = interpret(completion.text);
    } catch (error) {
        if (!options.retryMissingScore || !isMissingScore(error)) throw error;
        // One corrective follow-up; the model must either score its decision
        // or withdraw it as uncertain. No score is ever filled in locally.
        scoreRetried = true;
        const first = completion;
        const retry = await request(
            missingScoreFollowUpMessages(messages, first.text),
        );
        completion = {
            ...retry,
            usage: sumUsage(first.usage, retry.usage),
            attemptDiagnostics:
                first.attemptDiagnostics || retry.attemptDiagnostics
                    ? [
                          ...(first.attemptDiagnostics ?? []),
                          ...(retry.attemptDiagnostics ?? []),
                      ]
                    : undefined,
        };
        try {
            interpreted = interpret(completion.text);
        } catch (retryError) {
            throw markAfterScoreRetry(retryError);
        }
    }
    const latencyMs = Math.max(0, performance.now() - startedAt);
    return {
        task: options.task,
        messages,
        evidence,
        response: interpreted.response,
        responseText: completion.text,
        latencyMs,
        tokenUsage: completion.usage ?? null,
        completionStatus: completion.completionStatus ?? 'unknown',
        requestAttempts: completion.attemptDiagnostics?.length ?? null,
        attemptDiagnostics: completion.attemptDiagnostics ?? null,
        promptHash,
        promptCharacters,
        inputHash,
        evidenceCatalog,
        citationRepairs: interpreted.citationRepairs,
        scoreRetried,
    };
}

/** Sends one request and rejects a reply the provider marked truncated. */
export async function requestClassificationCompletion(options: {
    task: ClassificationTask;
    client: ClassificationClient;
    configuration: ClassificationConfiguration;
    messages: readonly PromptMessage[];
    signal?: AbortSignal;
    onRawResponse?: (
        text: string,
        usage?: ClassificationCompletion['usage'],
        diagnostics?: ClassificationAttemptDiagnostic[],
        completionStatus?: ClassificationCompletion['completionStatus'],
    ) => void;
}): Promise<ClassificationCompletion> {
    const completion = options.client.classifyDetailed
        ? await options.client.classifyDetailed(
              options.task,
              options.messages,
              options.signal,
              { citationMode: options.configuration.citationMode },
          )
        : {
              text: await options.client.classify(
                  options.task,
                  options.messages,
                  options.signal,
              ),
          };
    options.onRawResponse?.(
        completion.text,
        completion.usage,
        completion.attemptDiagnostics,
        completion.completionStatus,
    );
    if (completion.completionStatus === 'truncated') {
        throw new ClassificationProviderError(
            'provider_truncated_completion',
            'Classification provider stopped before completing its response',
            completion.attemptDiagnostics ?? [],
        );
    }
    return completion;
}

export type InterpretedClassificationResponse = {
    response: AffiliationResponse | ProjectTypeResponse;
    citationRepairs: CitationRepair[];
};

/**
 * Turns one reply into a canonical response: resolves evidence IDs, parses
 * the contract, then validates citations strictly or repairs them.
 */
export function interpretClassificationResponse(options: {
    task: ClassificationTask;
    configuration: ClassificationConfiguration;
    evidence: PreparedRepositoryEvidence;
    text: string;
    citationPolicy: 'strict' | 'repair';
}): InterpretedClassificationResponse {
    const canonicalResponseText =
        options.configuration.citationMode === 'evidence_id'
            ? resolveEvidenceReferences(
                  options.text,
                  options.evidence.evidenceCatalog,
                  options.task,
              )
            : options.text;
    const response =
        options.task === 'affiliation'
            ? parseAffiliationResponse(canonicalResponseText)
            : parseProjectTypeResponse(canonicalResponseText);
    const allowedFields =
        options.task === 'affiliation'
            ? AFFILIATION_EVIDENCE_FIELDS
            : PROJECT_TYPE_EVIDENCE_FIELDS;
    if (options.citationPolicy === 'strict') {
        validateCitations(
            response.evidence,
            options.evidence.citationSegments,
            allowedFields,
        );
        return { response, citationRepairs: [] };
    }
    const repaired = repairCitations(
        response.evidence as EvidenceCitation<string>[],
        options.evidence.citationSegments,
        allowedFields as readonly string[],
    );
    return {
        response: {
            ...response,
            evidence: repaired.citations,
        } as AffiliationResponse | ProjectTypeResponse,
        citationRepairs: repaired.repairs,
    };
}

export function isMissingScore(error: unknown): boolean {
    return (
        error instanceof ClassificationValidationError &&
        error.detail === 'missing_score'
    );
}

/** The conversation for the single missing-score follow-up. */
export function missingScoreFollowUpMessages(
    messages: readonly PromptMessage[],
    firstReply: string,
): PromptMessage[] {
    return [
        ...messages,
        { role: 'assistant', content: firstReply },
        { role: 'user', content: MISSING_SCORE_RETRY_MESSAGE },
    ];
}

/** Marks a validation error from the follow-up reply so callers can count it. */
export function markAfterScoreRetry(error: unknown): unknown {
    if (!(error instanceof ClassificationValidationError)) return error;
    return new ClassificationValidationError(
        error.code,
        `After one missing-score follow-up: ${error.message}`,
        { cause: error },
        error.citationDiagnostics,
        error.detail,
        true,
    );
}

export const MISSING_SCORE_RETRY_MESSAGE =
    'Your previous reply chose supported or not_supported but gave a null score, which the schema forbids. Return the complete JSON object again. Give a score from 0 to 1 that reflects how strongly the cited evidence supports your decision, or, if you cannot score it, change the decision to uncertain with relationship insufficient_evidence and a null score.';

function sumUsage(
    first: ClassificationCompletion['usage'],
    second: ClassificationCompletion['usage'],
): ClassificationCompletion['usage'] {
    if (!first || !second) return second ?? first;
    const add = (a: number | null, b: number | null) =>
        a === null || b === null ? null : a + b;
    return {
        input: add(first.input, second.input),
        output: add(first.output, second.output),
        total: add(first.total, second.total),
    };
}

export function classificationInputHash(options: {
    task: ClassificationTask;
    client: ClassificationClient;
    configuration: ClassificationConfiguration;
    messages: readonly PromptMessage[];
    evidence: PreparedRepositoryEvidence;
    policy?: Record<string, unknown>;
}): string {
    const canonicalInput = {
        provider: options.client.provider,
        model: options.client.model,
        endpointIdentity: options.client.cacheIdentity ?? '',
        contractVersion: RESPONSE_CONTRACT_VERSION,
        wireContractVersion: wireContractVersionForCitationMode(
            options.configuration.citationMode,
        ),
        citationMode: options.configuration.citationMode,
        task: options.task,
        promptVersion: options.configuration.promptVersion,
        threshold: options.configuration.threshold,
        messages: options.messages,
        preparedEvidence: {
            sourceHash: options.evidence.sourceHash,
            ...(options.configuration.citationMode === 'evidence_id'
                ? {
                      evidenceCatalogVersion: EVIDENCE_CATALOG_VERSION,
                      evidenceCatalogHash:
                          options.evidence.evidenceCatalogHash,
                  }
                : {}),
            affiliation: options.evidence.affiliation,
            projectType: options.evidence.projectType,
        },
        generation: options.configuration.generation,
        decisionPolicy: options.policy ?? {},
    };
    return createHash('sha256')
        .update(canonicalStringify(canonicalInput))
        .digest('hex');
}

export function summarizeEvidenceCatalog(
    catalog: readonly EvidenceReference[],
    hash: string,
): EvidenceCatalogSummary {
    return {
        version: EVIDENCE_CATALOG_VERSION,
        hash,
        entryCount: catalog.length,
        textCharacters: catalog.reduce(
            (sum, reference) => sum + reference.text.length,
            0,
        ),
        maxSpanChars: EVIDENCE_SPAN_MAX_CHARS,
    };
}

function canonicalStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalStringify).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}
