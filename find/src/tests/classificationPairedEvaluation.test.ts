import { validateClassificationConfiguration } from '../config';
import { FakeClassificationClient } from '../classification/client';
import {
    parseEvaluationCases,
    runClassificationEvaluation,
} from '../classification/evaluation';
import { compareClassificationReports } from '../classification/pairedEvaluation';

describe('paired classification evaluation', () => {
    test('pairs identical cases, counts rejected outputs, and bootstraps by repository group', async () => {
        const baseline = await report('v2', 'DEV');
        const candidate = await report('v3', 'EDU');
        const comparison = compareClassificationReports(baseline, candidate, {
            generatedAt: new Date('2026-10-27T12:00:00.000Z'),
            bootstrapReplicates: 200,
        });

        expect(comparison.casePairing).toMatchObject({
            baselineCases: 2,
            candidateCases: 2,
            matchedCases: 2,
            mismatches: [],
            complete: true,
        });
        expect(comparison.settingsDifferences).toContain('promptVersion');
        expect(comparison.tasks.project_type).toMatchObject({
            scheduledPairs: 2,
            bothContractValid: 2,
            exactAgreementAllScheduled: {
                count: 0,
                denominator: 2,
                value: 0,
            },
            humanLabelPairs: 2,
            baselineCorrect: 0,
            candidateCorrect: 2,
            candidateAccuracy: { value: 1 },
        });
        expect(comparison.pairedGroupBootstrap.groupCount).toBe(2);
        expect(
            comparison.pairedGroupBootstrap.projectTypeMacroF1Difference95,
        ).not.toBeNull();
        expect(comparison.pairedGroupBootstrap.projectTypeMacroF1Difference95?.lower).toBeGreaterThan(
            0,
        );
    });

    test('reports input mismatches instead of silently dropping them from a complete comparison', async () => {
        const baseline = await report('v2', 'DEV');
        const candidate = await report('v3', 'EDU');
        const mismatched = {
            ...candidate,
            cases: candidate.cases.map((item, index) =>
                index === 0 ? { ...item, inputHash: 'f'.repeat(64) } : item,
            ),
        };
        const comparison = compareClassificationReports(baseline, mismatched, {
            bootstrapReplicates: 100,
        });

        expect(comparison.casePairing).toMatchObject({
            matchedCases: 1,
            complete: false,
            mismatches: [{ caseId: 'case-one', reason: 'input_hash_mismatch' }],
        });
        expect(comparison.tasks.project_type.scheduledPairs).toBe(1);
    });

    test('rejects reports with incompatible rubric or canonical contract versions', async () => {
        const baseline = await report('v2', 'DEV');
        const candidate = await report('v3', 'EDU');
        const incompatibleRubric = { ...candidate };
        Reflect.set(incompatibleRubric, 'rubricVersion', 'different-rubric');
        expect(() =>
            compareClassificationReports(baseline, incompatibleRubric),
        ).toThrow(/rubric versions/);
        expect(() =>
            compareClassificationReports(
                baseline,
                { ...candidate, responseContractVersion: 'different-contract' },
            ),
        ).toThrow(/canonical response contracts/);
    });

    test('does not treat historical model labels as independent human truth', async () => {
        const baseline = await report('v2', 'DEV', 'historical_model');
        const candidate = await report('v3', 'EDU', 'historical_model');
        const comparison = compareClassificationReports(baseline, candidate, {
            bootstrapReplicates: 100,
        });
        expect(comparison.tasks.project_type.humanLabelPairs).toBe(0);
        expect(comparison.pairedGroupBootstrap.projectTypeMacroF1Difference95).toBeNull();
    });
});

async function report(
    promptVersion: string,
    predictedType: 'DEV' | 'EDU',
    labelProvenance: 'independent_human' | 'historical_model' = 'independent_human',
) {
    const configuration = validateClassificationConfiguration({
        promptVersion,
        citationMode: 'exact_quote',
    });
    const client = new FakeClassificationClient(
        [
            (task) =>
                task === 'affiliation'
                    ? JSON.stringify({
                          decision: 'supported',
                          relationship: 'coursework',
                          score: 0.8,
                          evidence: [{ field: 'readme', quote: 'Course assignment evidence' }],
                          explanation: 'The README describes course work.',
                      })
                    : JSON.stringify({
                          category: predictedType,
                          evidence: [{ field: 'readme', quote: 'Course assignment evidence' }],
                          explanation: 'The README describes the repository purpose.',
                      }),
        ],
        'ollama-local',
        'llama3.2:3b',
    );
    return runClassificationEvaluation({
        cases: parseEvaluationCases([
            evaluationCase('case-one', 101, 'group-one', labelProvenance),
            evaluationCase('case-two', 202, 'group-two', labelProvenance),
        ]),
        client,
        configuration,
        concurrency: 1,
        now: () => new Date('2026-10-27T11:00:00.000Z'),
    });
}

function evaluationCase(
    caseId: string,
    repositoryId: number,
    repositoryGroupId: string,
    labelProvenance: 'independent_human' | 'historical_model',
) {
    return {
        caseId,
        snapshotAt: '2026-10-27T10:00:00.000Z',
        inputHash: repositoryId === 101 ? 'a'.repeat(64) : 'b'.repeat(64),
        repositoryGroupId,
        institution: {
            key: 'Example Institute',
            fullName: 'Example Institute',
            acronym: 'EI',
        },
        candidate: {
            id: repositoryId,
            university: 'Example Institute',
            fullName: `example/repository-${repositoryId}`,
            owner: 'example',
            htmlUrl: `https://example.test/example/repository-${repositoryId}`,
            description: 'A course assignment',
            readme: 'Course assignment evidence',
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
        },
        labelProvenance,
        labels: { affiliation: 'supported', projectType: 'EDU' },
        labelRationale: 'Independently reviewed synthetic test label.',
        split: 'development',
    };
}
