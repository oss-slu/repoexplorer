import { createHash } from 'node:crypto';
import type {
    ClassificationEvaluationReport,
    EvaluationCaseResult,
    EvaluationTaskResult,
} from './evaluation';
import type { ClassificationTask } from '../types/scraping';

export type PairingMismatchReason =
    | 'missing_from_baseline'
    | 'missing_from_candidate'
    | 'input_hash_mismatch'
    | 'institution_context_mismatch'
    | 'candidate_context_mismatch'
    | 'split_mismatch'
    | 'label_mismatch'
    | 'repository_group_mismatch';

export type PairingMismatch = {
    caseId: string;
    reason: PairingMismatchReason;
};

export type ProportionWithInterval = {
    count: number;
    denominator: number;
    value: number | null;
    interval95: { lower: number; upper: number } | null;
};

export type PairedTaskRow = {
    caseId: string;
    inputHash: string;
    institutionKey: string;
    repositoryGroupId: string;
    split: EvaluationCaseResult['split'];
    baselineValid: boolean;
    candidateValid: boolean;
    baselinePrediction: string | null;
    candidatePrediction: string | null;
    baselineFailureCode: string | null;
    candidateFailureCode: string | null;
    exactAgreement: boolean;
    expectedLabel: string | null;
};

export type PairedTaskMetrics = {
    scheduledPairs: number;
    baselineContractValid: number;
    candidateContractValid: number;
    bothContractValid: number;
    neitherContractValid: number;
    oneContractInvalid: number;
    exactAgreementAllScheduled: ProportionWithInterval;
    exactAgreementWhenBothValid: ProportionWithInterval;
    humanLabelPairs: number;
    baselineCorrect: number;
    candidateCorrect: number;
    baselineAccuracy: ProportionWithInterval;
    candidateAccuracy: ProportionWithInterval;
    rows: PairedTaskRow[];
};

export type PairedClassificationComparison = {
    generatedAt: string;
    rubricVersion: string;
    responseContractVersion: string;
    baseline: {
        provider: string;
        model: string;
        promptVersion: string;
        wireContractVersion: string;
        citationMode: string;
    };
    candidate: {
        provider: string;
        model: string;
        promptVersion: string;
        wireContractVersion: string;
        citationMode: string;
    };
    settingsDifferences: string[];
    casePairing: {
        baselineCases: number;
        candidateCases: number;
        matchedCases: number;
        mismatches: PairingMismatch[];
        complete: boolean;
    };
    tasks: Record<ClassificationTask, PairedTaskMetrics>;
    pairedGroupBootstrap: {
        groupCount: number;
        replicates: number;
        affiliationAccuracyDifference95: { lower: number; upper: number } | null;
        projectTypeMacroF1Difference95: { lower: number; upper: number } | null;
    };
};

type MatchedCasePair = {
    baseline: EvaluationCaseResult;
    candidate: EvaluationCaseResult;
};

export function compareClassificationReports(
    baseline: ClassificationEvaluationReport,
    candidate: ClassificationEvaluationReport,
    options: { generatedAt?: Date; bootstrapReplicates?: number } = {},
): PairedClassificationComparison {
    if (baseline.rubricVersion !== candidate.rubricVersion) {
        throw new TypeError('Cannot pair reports with different rubric versions');
    }
    if (baseline.responseContractVersion !== candidate.responseContractVersion) {
        throw new TypeError(
            'Cannot pair reports with different canonical response contracts',
        );
    }
    const generatedAt = options.generatedAt ?? new Date();
    if (!Number.isFinite(generatedAt.getTime())) {
        throw new TypeError('Paired comparison clock returned an invalid date');
    }
    const baselineById = uniqueCaseMap(baseline.cases, 'baseline');
    const candidateById = uniqueCaseMap(candidate.cases, 'candidate');
    const mismatches: PairingMismatch[] = [];
    const matched: MatchedCasePair[] = [];
    const caseIds = [...new Set([...baselineById.keys(), ...candidateById.keys()])]
        .sort((left, right) => left.localeCompare(right));

    for (const caseId of caseIds) {
        const baselineCase = baselineById.get(caseId);
        const candidateCase = candidateById.get(caseId);
        if (!baselineCase) {
            mismatches.push({ caseId, reason: 'missing_from_baseline' });
            continue;
        }
        if (!candidateCase) {
            mismatches.push({ caseId, reason: 'missing_from_candidate' });
            continue;
        }
        const reason = caseMismatchReason(baselineCase, candidateCase);
        if (reason) {
            mismatches.push({ caseId, reason });
            continue;
        }
        matched.push({ baseline: baselineCase, candidate: candidateCase });
    }

    const affiliationRows = matched.map((pair) => pairTaskRow(pair, 'affiliation'));
    const projectTypeRows = matched.map((pair) => pairTaskRow(pair, 'project_type'));
    const replicates = options.bootstrapReplicates ?? 2000;
    if (!Number.isSafeInteger(replicates) || replicates < 100 || replicates > 50_000) {
        throw new TypeError('Bootstrap replicates must be an integer from 100 to 50000');
    }
    const bootstrap = pairedGroupBootstrap(
        matched,
        replicates,
        `${baseline.generatedAt}:${candidate.generatedAt}:${baseline.rubricVersion}`,
    );

    return {
        generatedAt: generatedAt.toISOString(),
        rubricVersion: baseline.rubricVersion,
        responseContractVersion: baseline.responseContractVersion,
        baseline: reportIdentity(baseline),
        candidate: reportIdentity(candidate),
        settingsDifferences: reportSettingsDifferences(baseline, candidate),
        casePairing: {
            baselineCases: baseline.cases.length,
            candidateCases: candidate.cases.length,
            matchedCases: matched.length,
            mismatches,
            complete:
                mismatches.length === 0 &&
                matched.length === baseline.cases.length &&
                matched.length === candidate.cases.length,
        },
        tasks: {
            affiliation: pairedTaskMetrics(affiliationRows, 'affiliation'),
            project_type: pairedTaskMetrics(projectTypeRows, 'project_type'),
        },
        pairedGroupBootstrap: {
            groupCount: bootstrap.groupCount,
            replicates: bootstrap.replicates,
            affiliationAccuracyDifference95:
                bootstrap.affiliationAccuracyDifference95,
            projectTypeMacroF1Difference95:
                bootstrap.projectTypeMacroF1Difference95,
        },
    };
}

function uniqueCaseMap(
    cases: readonly EvaluationCaseResult[],
    label: 'baseline' | 'candidate',
): Map<string, EvaluationCaseResult> {
    const result = new Map<string, EvaluationCaseResult>();
    for (const testCase of cases) {
        if (result.has(testCase.caseId)) {
            throw new TypeError(`${label} report contains duplicate case IDs`);
        }
        result.set(testCase.caseId, testCase);
    }
    return result;
}

function caseMismatchReason(
    baseline: EvaluationCaseResult,
    candidate: EvaluationCaseResult,
): PairingMismatchReason | null {
    if (baseline.inputHash !== candidate.inputHash) return 'input_hash_mismatch';
    if (
        canonicalHash(baseline.institution) !==
        canonicalHash(candidate.institution)
    ) {
        return 'institution_context_mismatch';
    }
    if (canonicalHash(baseline.candidate) !== canonicalHash(candidate.candidate)) {
        return 'candidate_context_mismatch';
    }
    if (baseline.split !== candidate.split) return 'split_mismatch';
    if (baseline.repositoryGroupId !== candidate.repositoryGroupId) {
        return 'repository_group_mismatch';
    }
    if (
        baseline.labelProvenance !== candidate.labelProvenance ||
        canonicalHash(baseline.labels) !== canonicalHash(candidate.labels)
    ) {
        return 'label_mismatch';
    }
    return null;
}

function pairTaskRow(
    pair: MatchedCasePair,
    task: ClassificationTask,
): PairedTaskRow {
    const baselineTask = taskResult(pair.baseline, task);
    const candidateTask = taskResult(pair.candidate, task);
    const baselinePrediction = predictionValue(baselineTask, task);
    const candidatePrediction = predictionValue(candidateTask, task);
    const baselineValid = baselineTask.response !== null;
    const candidateValid = candidateTask.response !== null;
    const expectedLabel =
        pair.baseline.labelProvenance !== 'independent_human'
            ? null
            : task === 'affiliation'
              ? pair.baseline.labels.affiliation === 'uncertain'
                  ? null
                  : (pair.baseline.labels.affiliation ?? null)
              : (pair.baseline.labels.projectType ?? null);
    return {
        caseId: pair.baseline.caseId,
        inputHash: pair.baseline.inputHash,
        institutionKey: pair.baseline.institution.key,
        repositoryGroupId: pair.baseline.repositoryGroupId,
        split: pair.baseline.split,
        baselineValid,
        candidateValid,
        baselinePrediction,
        candidatePrediction,
        baselineFailureCode: baselineTask.failure?.code ?? null,
        candidateFailureCode: candidateTask.failure?.code ?? null,
        exactAgreement:
            baselineValid &&
            candidateValid &&
            baselinePrediction === candidatePrediction,
        expectedLabel,
    };
}

function pairedTaskMetrics(
    rows: readonly PairedTaskRow[],
    task: ClassificationTask,
): PairedTaskMetrics {
    const bothValid = rows.filter((row) => row.baselineValid && row.candidateValid);
    const expected = rows.filter((row) => row.expectedLabel !== null);
    const baselineCorrect = expected.filter((row) =>
        isCorrect(row.baselinePrediction, row.expectedLabel, task),
    ).length;
    const candidateCorrect = expected.filter((row) =>
        isCorrect(row.candidatePrediction, row.expectedLabel, task),
    ).length;
    return {
        scheduledPairs: rows.length,
        baselineContractValid: rows.filter((row) => row.baselineValid).length,
        candidateContractValid: rows.filter((row) => row.candidateValid).length,
        bothContractValid: bothValid.length,
        neitherContractValid: rows.filter(
            (row) => !row.baselineValid && !row.candidateValid,
        ).length,
        oneContractInvalid: rows.filter(
            (row) => row.baselineValid !== row.candidateValid,
        ).length,
        exactAgreementAllScheduled: proportion(
            rows.filter((row) => row.exactAgreement).length,
            rows.length,
        ),
        exactAgreementWhenBothValid: proportion(
            bothValid.filter((row) => row.exactAgreement).length,
            bothValid.length,
        ),
        humanLabelPairs: expected.length,
        baselineCorrect,
        candidateCorrect,
        baselineAccuracy: proportion(baselineCorrect, expected.length),
        candidateAccuracy: proportion(candidateCorrect, expected.length),
        rows: [...rows],
    };
}

function isCorrect(
    prediction: string | null,
    expected: string | null,
    task: ClassificationTask,
): boolean {
    if (prediction === null || expected === null) return false;
    return task === 'affiliation'
        ? prediction.split('/')[0] === expected
        : prediction === expected;
}

function predictionValue(
    result: EvaluationTaskResult,
    task: ClassificationTask,
): string | null {
    if (!result.response) return null;
    if (task === 'affiliation' && 'decision' in result.response) {
        return `${result.response.decision}/${result.response.relationship}`;
    }
    if (task === 'project_type' && 'category' in result.response) {
        return result.response.category;
    }
    return null;
}

function taskResult(
    result: EvaluationCaseResult,
    task: ClassificationTask,
): EvaluationTaskResult {
    return task === 'affiliation' ? result.affiliation : result.projectType;
}

function proportion(count: number, denominator: number): ProportionWithInterval {
    return {
        count,
        denominator,
        value: denominator === 0 ? null : count / denominator,
        interval95: wilsonInterval(count, denominator),
    };
}

function wilsonInterval(
    count: number,
    denominator: number,
): { lower: number; upper: number } | null {
    if (denominator === 0) return null;
    const z = 1.959963984540054;
    const proportionValue = count / denominator;
    const denominatorAdjustment = 1 + (z * z) / denominator;
    const center =
        (proportionValue + (z * z) / (2 * denominator)) /
        denominatorAdjustment;
    const halfWidth =
        (z *
            Math.sqrt(
                (proportionValue * (1 - proportionValue)) / denominator +
                    (z * z) / (4 * denominator * denominator),
            )) /
        denominatorAdjustment;
    return {
        lower: Math.max(0, center - halfWidth),
        upper: Math.min(1, center + halfWidth),
    };
}

function reportIdentity(report: ClassificationEvaluationReport) {
    return {
        provider: report.provider,
        model: report.model,
        promptVersion: report.promptVersion,
        wireContractVersion: report.wireContractVersion,
        citationMode: report.citationMode,
    };
}

function reportSettingsDifferences(
    baseline: ClassificationEvaluationReport,
    candidate: ClassificationEvaluationReport,
): string[] {
    const fields: Array<keyof ClassificationEvaluationReport> = [
        'provider',
        'model',
        'endpointIdentity',
        'wireContractVersion',
        'promptVersion',
        'citationMode',
        'generation',
        'concurrency',
        'timeoutMs',
        'maxRetries',
    ];
    return fields.filter(
        (field) => canonicalHash(baseline[field]) !== canonicalHash(candidate[field]),
    );
}

function pairedGroupBootstrap(
    pairs: readonly MatchedCasePair[],
    replicates: number,
    seedInput: string,
): {
    groupCount: number;
    replicates: number;
    affiliationAccuracyDifference95: { lower: number; upper: number } | null;
    projectTypeMacroF1Difference95: { lower: number; upper: number } | null;
} {
    const groups = new Map<string, MatchedCasePair[]>();
    for (const pair of pairs) {
        const group = groups.get(pair.baseline.repositoryGroupId) ?? [];
        group.push(pair);
        groups.set(pair.baseline.repositoryGroupId, group);
    }
    const groupValues = [...groups.values()];
    if (groupValues.length < 2) {
        return {
            groupCount: groupValues.length,
            replicates: 0,
            affiliationAccuracyDifference95: null,
            projectTypeMacroF1Difference95: null,
        };
    }
    const digest = createHash('sha256').update(seedInput).digest();
    let state = digest.readUInt32BE(0) || 1;
    const random = () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x1_0000_0000;
    };
    const affiliationDifferences: number[] = [];
    const typeDifferences: number[] = [];
    for (let sample = 0; sample < replicates; sample += 1) {
        const resampled: MatchedCasePair[] = [];
        for (let index = 0; index < groupValues.length; index += 1) {
            const selected = groupValues[Math.floor(random() * groupValues.length)]!;
            resampled.push(...selected);
        }
        const affiliation = accuracyDifference(resampled, 'affiliation');
        if (affiliation !== null) affiliationDifferences.push(affiliation);
        const type = macroF1Difference(resampled);
        if (type !== null) typeDifferences.push(type);
    }
    return {
        groupCount: groupValues.length,
        replicates,
        affiliationAccuracyDifference95: percentileInterval(affiliationDifferences),
        projectTypeMacroF1Difference95: percentileInterval(typeDifferences),
    };
}

function accuracyDifference(
    pairs: readonly MatchedCasePair[],
    task: ClassificationTask,
): number | null {
    const labeled = pairs.filter(
        (pair) =>
            pair.baseline.labelProvenance === 'independent_human' &&
            (task === 'affiliation'
                ? pair.baseline.labels.affiliation !== undefined &&
                  pair.baseline.labels.affiliation !== 'uncertain'
                : pair.baseline.labels.projectType !== undefined),
    );
    if (labeled.length === 0) return null;
    let baselineCorrect = 0;
    let candidateCorrect = 0;
    for (const pair of labeled) {
        const expected =
            task === 'affiliation'
                ? pair.baseline.labels.affiliation!
                : pair.baseline.labels.projectType!;
        const baselinePrediction = predictionValue(taskResult(pair.baseline, task), task);
        const candidatePrediction = predictionValue(taskResult(pair.candidate, task), task);
        if (isCorrect(baselinePrediction, expected, task)) baselineCorrect += 1;
        if (isCorrect(candidatePrediction, expected, task)) candidateCorrect += 1;
    }
    return (candidateCorrect - baselineCorrect) / labeled.length;
}

function macroF1Difference(pairs: readonly MatchedCasePair[]): number | null {
    const labeled = pairs.filter(
        (pair) =>
            pair.baseline.labelProvenance === 'independent_human' &&
            pair.baseline.labels.projectType !== undefined,
    );
    if (labeled.length === 0) return null;
    return (
        macroF1(labeled, 'candidate') - macroF1(labeled, 'baseline')
    );
}

function macroF1(
    pairs: readonly MatchedCasePair[],
    side: 'baseline' | 'candidate',
): number {
    const classes = new Set(
        pairs
            .map((pair) => pair.baseline.labels.projectType)
            .filter((label): label is NonNullable<typeof label> => label !== undefined),
    );
    const scores = [...classes].map((category) => {
        let truePositive = 0;
        let falsePositive = 0;
        let falseNegative = 0;
        for (const pair of pairs) {
            const expected = pair.baseline.labels.projectType;
            const prediction = predictionValue(
                taskResult(pair[side], 'project_type'),
                'project_type',
            );
            if (expected === category && prediction === category) truePositive += 1;
            else {
                if (prediction === category) falsePositive += 1;
                if (expected === category) falseNegative += 1;
            }
        }
        const denominator = 2 * truePositive + falsePositive + falseNegative;
        return denominator === 0 ? 0 : (2 * truePositive) / denominator;
    });
    return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

function percentileInterval(
    values: readonly number[],
): { lower: number; upper: number } | null {
    if (values.length < 100) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return {
        lower: quantile(sorted, 0.025),
        upper: quantile(sorted, 0.975),
    };
}

function quantile(sorted: readonly number[], proportion: number): number {
    const position = (sorted.length - 1) * proportion;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function canonicalHash(value: unknown): string {
    return createHash('sha256').update(canonicalStringify(value)).digest('hex');
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
