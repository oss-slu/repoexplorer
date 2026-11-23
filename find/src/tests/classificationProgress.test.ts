import {
    ClassificationProgressPrinter,
    formatClassificationProgress,
} from '../classification/progress';
import type { ClassificationProgressEvent } from '../classification/runner';

function output(isTTY: boolean) {
    const chunks: string[] = [];
    return {
        chunks,
        stream: {
            isTTY,
            write(value: string) {
                chunks.push(value);
                return true;
            },
        },
    };
}

function event(
    completed: number,
    overrides: Partial<ClassificationProgressEvent> = {},
): ClassificationProgressEvent {
    return {
        university: 'Saint\nLouis University',
        task: 'affiliation',
        completed,
        total: 20,
        failed: 1,
        elapsedMs: 65_000,
        ...overrides,
    };
}

describe('classification progress printer', () => {
    test('formats university, task, counts, failures, and elapsed time', () => {
        expect(formatClassificationProgress(event(3, { task: 'project_type' }))).toBe(
            'Saint Louis University | project type 3/20 | failed so far: 1 | elapsed 01:05',
        );
    });

    test('writes whole lines at task boundaries and every tenth when redirected', () => {
        const { chunks, stream } = output(false);
        let clock = 0;
        const printer = new ClassificationProgressPrinter({
            output: stream,
            now: () => clock,
            intervalMs: 60_000,
        });
        for (let completed = 0; completed <= 20; completed += 1) {
            clock += 1_000;
            printer.onProgress(event(completed));
        }
        printer.finish();
        expect(chunks.every((chunk) => chunk.endsWith('\n'))).toBe(true);
        expect(chunks.join('')).not.toContain('\r');
        expect(chunks.map((chunk) => chunk.match(/ (\d+)\/20 /)?.[1])).toEqual([
            '0', '2', '4', '6', '8', '10', '12', '14', '16', '18', '20',
        ]);
    });

    test('also writes a line after the interval when a task progresses slowly', () => {
        const { chunks, stream } = output(false);
        let clock = 0;
        const printer = new ClassificationProgressPrinter({
            output: stream,
            now: () => clock,
            intervalMs: 30_000,
        });
        printer.onProgress(event(0, { total: 1_000 }));
        clock = 10_000;
        printer.onProgress(event(1, { total: 1_000 }));
        clock = 31_000;
        printer.onProgress(event(2, { total: 1_000 }));
        expect(chunks).toHaveLength(2);
        expect(chunks[1]).toContain(' 2/1000 ');
    });

    test('rewrites one terminal line and ends it when the task completes', () => {
        const { chunks, stream } = output(true);
        const printer = new ClassificationProgressPrinter({ output: stream });
        printer.onProgress(event(19));
        printer.onProgress(event(20));
        printer.finish();
        expect(chunks[0]!.startsWith('\r\u001b[2K')).toBe(true);
        expect(chunks[0]).toContain(' 19/20 ');
        expect(chunks.at(-1)).toBe('\n');
        expect(chunks.filter((chunk) => chunk === '\n')).toHaveLength(1);
    });
});
