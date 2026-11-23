import type { Pool } from 'pg';
import { jest } from '@jest/globals';
import { ClassificationStore } from '../classification/store';
import type {
    ClassificationCandidate,
    ClassificationPrediction,
} from '../types/scraping';

describe('ClassificationStore', () => {
    test('maps staged evidence and preserves unknown eligibility flags', async () => {
        const query = jest.fn(async (sql: string, values?: unknown[]) => ({
            rows:
                sql.includes('repository_scraping') &&
                values?.[0] === 'University'
                    ? [candidateRow()]
                    : [],
            rowCount: 1,
        }));
        const store = new ClassificationStore({ query } as unknown as Pool);

        await expect(store.listCandidates('University')).resolves.toEqual([
            expect.objectContaining({
                id: 77,
                university: 'University',
                archived: null,
                isTemplate: null,
                stargazersCount: 4,
                forksCount: 2,
            }),
        ]);
        expect(query.mock.calls[0]?.[0]).toContain(
            'FROM public.repository_scraping',
        );
        expect(query.mock.calls[0]?.[1]).toEqual(['University']);
    });

    test('reads and upserts predictions with the full resume key and threshold', async () => {
        const prediction = savedPrediction();
        const query = jest.fn(async (sql: string, values?: unknown[]) => ({
            rows:
                sql.includes('SELECT id, university, task') &&
                values?.length === 8
                    ? [predictionRow(prediction)]
                    : [],
            rowCount: 1,
        }));
        const store = new ClassificationStore({ query } as unknown as Pool);

        await expect(store.findPrediction(prediction)).resolves.toMatchObject(
            prediction,
        );
        expect(query.mock.calls[0]?.[1]).toEqual([
            prediction.id,
            prediction.university,
            prediction.task,
            prediction.provider,
            prediction.model,
            prediction.promptVersion,
            prediction.threshold,
            prediction.inputHash,
        ]);

        await store.savePrediction(prediction);
        expect(query.mock.calls[1]?.[0]).toContain('ON CONFLICT');
        expect(query.mock.calls[1]?.[0]).toContain(
            'public.repository_classification_predictions',
        );
        expect(query.mock.calls[1]?.[1]).toHaveLength(18);
        expect(query.mock.calls[1]?.[1]?.[6]).toBe(prediction.threshold);
        expect(query.mock.calls[1]?.[1]?.[7]).toBe(prediction.inputHash);
        expect(query.mock.calls[1]?.[1]?.[10]).toBe('supported');
        expect(query.mock.calls[1]?.[1]?.[12]).toBe(
            JSON.stringify([{ field: 'readme', quote: 'Evidence supports' }]),
        );
    });
});

function candidateRow(): Record<string, unknown> {
    return {
        id: '77',
        university: 'University',
        full_name: 'owner/repository',
        owner: 'owner',
        html_url: 'https://github.com/owner/repository',
        description: 'Project',
        readme: '# Project',
        homepage: null,
        language: 'TypeScript',
        license: 'mit',
        fork: 0,
        archived: null,
        is_template: null,
        size: '12',
        stargazers_count: '4',
        forks_count: '2',
        contributors: '["alice"]',
    } satisfies Record<keyof ClassificationCandidate | string, unknown>;
}

function savedPrediction(): ClassificationPrediction {
    return {
        id: 77,
        university: 'University',
        task: 'affiliation',
        provider: 'mock',
        model: 'fixed-v1',
        promptVersion: 'v1',
        threshold: 0.4,
        inputHash: 'a'.repeat(64),
        score: 0.8,
        category: null,
        affiliationDecision: 'supported',
        affiliationRelationship: 'institutional_project',
        affiliationEvidence: [{ field: 'readme', quote: 'Evidence supports' }],
        explanation: 'Evidence supports affiliation.',
        status: 'predicted',
        simulated: true,
        errorMessage: null,
        classifiedAt: '2026-10-26T12:00:00.000Z',
    };
}

function predictionRow(
    prediction: ClassificationPrediction,
): Record<string, unknown> {
    return {
        id: prediction.id,
        university: prediction.university,
        task: prediction.task,
        provider: prediction.provider,
        model: prediction.model,
        prompt_version: prediction.promptVersion,
        threshold: prediction.threshold,
        input_hash: prediction.inputHash,
        score: prediction.score,
        category: prediction.category,
        affiliation_decision: prediction.affiliationDecision,
        affiliation_relationship: prediction.affiliationRelationship,
        affiliation_evidence: prediction.affiliationEvidence,
        explanation: prediction.explanation,
        status: prediction.status,
        simulated: prediction.simulated,
        error_message: prediction.errorMessage,
        classified_at: prediction.classifiedAt,
    };
}
