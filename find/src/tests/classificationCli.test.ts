import {
    formatClassificationSummary,
    parseClassificationCliOptions,
    ClassificationCliHelpRequested,
} from '../classificationCli';
import type { ClassificationRunReport } from '../classification/runner';

describe('classification CLI options', () => {
    test('selects the provider, deterministic mock, or seeded simulator', () => {
        expect(parseClassificationCliOptions([])).toMatchObject({
            mode: 'provider',
        });
        expect(parseClassificationCliOptions(['--mock'])).toMatchObject({
            mode: 'mock',
        });
        expect(
            parseClassificationCliOptions(['--simulate', '--seed', '42']),
        ).toMatchObject({
            mode: 'simulate',
            seed: 42,
        });
        expect(
            parseClassificationCliOptions([
                '--config',
                'universities.json',
                '--mock',
            ]),
        ).toMatchObject({
            configPath: 'universities.json',
            mode: 'mock',
        });
    });

    test('requires an explicit seed for random simulation and rejects conflicting modes', () => {
        expect(() => parseClassificationCliOptions(['--simulate'])).toThrow(
            /requires --seed/,
        );
        expect(() => parseClassificationCliOptions(['--seed', '42'])).toThrow(
            /only be used/,
        );
        expect(() =>
            parseClassificationCliOptions([
                '--mock',
                '--simulate',
                '--seed',
                '1',
            ]),
        ).toThrow(/mutually exclusive/);
        expect(() => parseClassificationCliOptions(['--help'])).toThrow(
            ClassificationCliHelpRequested,
        );
    });

    test('keeps the summary format and adds repair and retry counters', () => {
        const university = {
            university: 'Example',
            candidates: 3,
            eligible: 3,
            ineligible: 0,
            affiliationPredicted: 2,
            belowThreshold: 0,
            affiliationNotSupported: 1,
            affiliationUncertain: 0,
            projectTypesPredicted: 2,
            reused: 0,
            failed: 0,
            repairedResults: 2,
            citationRepairs: 3,
            scoreRetries: 1,
            scoreRetriesRecovered: 1,
            downgraded: 1,
        };
        const report = {
            elapsedMs: 1500,
            interrupted: false,
            simulated: true,
            provider: 'mock',
            model: 'deterministic-evidence-v1',
            universities: [university, { ...university, university: 'Other' }],
            failures: [],
            semanticReviewFindings: [],
        } as unknown as ClassificationRunReport;
        expect(formatClassificationSummary(report, 'reports/run.json')).toBe(
            'COMPLETED in 1.5s; candidates: 6; eligible: 6; ineligible: 0; affiliation supported: 4; below threshold: 0; not supported: 2; uncertain: 0; downgraded: 2; project types: 4; semantic review: 0; repaired citations: 6 in 4 results; score retries: 2 (2 recovered); resumed: 0; failed: 0; provider: mock/deterministic-evidence-v1; simulated: true; report: reports/run.json\n',
        );
    });
});
