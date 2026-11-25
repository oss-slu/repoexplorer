import {
    parseClassificationCliOptions,
    ClassificationCliHelpRequested,
} from '../classificationCli';

test('classify CLI selects a client mode and rejects conflicting options', () => {
    expect(parseClassificationCliOptions([])).toMatchObject({
        mode: 'provider',
    });
    expect(
        parseClassificationCliOptions([
            '--config',
            'universities.json',
            '--mock',
        ]),
    ).toMatchObject({ configPath: 'universities.json', mode: 'mock' });
    expect(
        parseClassificationCliOptions(['--simulate', '--seed', '42']),
    ).toMatchObject({ mode: 'simulate', seed: 42 });

    expect(() => parseClassificationCliOptions(['--simulate'])).toThrow(
        /requires --seed/,
    );
    expect(() => parseClassificationCliOptions(['--seed', '42'])).toThrow(
        /only be used/,
    );
    expect(() =>
        parseClassificationCliOptions(['--mock', '--simulate', '--seed', '1']),
    ).toThrow(/mutually exclusive/);
    expect(() => parseClassificationCliOptions(['--help'])).toThrow(
        ClassificationCliHelpRequested,
    );
});
