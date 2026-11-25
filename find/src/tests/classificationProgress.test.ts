import { ClassificationProgressPrinter } from '../classification/progress';

test('redirected progress writes whole lines at task boundaries and every tenth', () => {
    const chunks: string[] = [];
    const printer = new ClassificationProgressPrinter({
        output: { isTTY: false, write: (value: string) => chunks.push(value) },
        now: () => 0,
    });
    for (let completed = 0; completed <= 20; completed += 1) {
        printer.onProgress({
            university: 'Saint\nLouis University',
            task: 'affiliation',
            completed,
            total: 20,
            failed: 1,
            elapsedMs: 65_000,
        });
    }
    printer.finish();

    expect(chunks.map((chunk) => chunk.match(/ (\d+)\/20 /)?.[1])).toEqual([
        '0',
        '2',
        '4',
        '6',
        '8',
        '10',
        '12',
        '14',
        '16',
        '18',
        '20',
    ]);
    expect(chunks[0]).toBe(
        'Saint Louis University | affiliation 0/20 | failed so far: 1 | elapsed 01:05\n',
    );
});
