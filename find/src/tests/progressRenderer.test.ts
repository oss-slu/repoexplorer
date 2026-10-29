import { jest } from '@jest/globals';
import { CliProgressRenderer } from '../utils/progressRenderer';
import type { ScrapingProgressEvent } from '../types/progress';

function output(isTTY: boolean, columns?: number) {
    const chunks: string[] = [];
    return {
        chunks,
        stream: {
            isTTY,
            columns,
            write(value: string) {
                chunks.push(value);
                return true;
            },
        },
    };
}

const phaseEvent: ScrapingProgressEvent = {
    type: 'phase',
    phase: 'owner listing',
    university: 'SLU',
    elapsedMs: 1_000,
};

test('renders one throttled TTY line with known counts and terminal width', () => {
    jest.useFakeTimers();
    let now = 1_000;
    const sink = output(true, 38);
    const renderer = new CliProgressRenderer({
        stdout: sink.stream,
        now: () => now,
        refreshMs: 250,
    });
    renderer.start();
    renderer.onProgress(phaseEvent);
    renderer.onProgress({
        type: 'progress',
        phase: 'owner listing',
        university: 'SLU',
        completed: 342,
        total: 1_201,
        label: 'organization octo',
        elapsedMs: 1_000,
    });
    expect(sink.chunks).toHaveLength(1);
    expect(sink.chunks[0]).toContain('\r\u001b[2K');
    expect(sink.chunks[0].length - '\r\u001b[2K'.length).toBeLessThanOrEqual(
        38,
    );

    now += 100;
    renderer.onProgress(phaseEvent);
    expect(sink.chunks).toHaveLength(1);
    now += 150;
    jest.advanceTimersByTime(250);
    expect(sink.chunks).toHaveLength(2);
    renderer.finish();
    expect(sink.chunks.at(-1)).toBe('\r\u001b[2K\n');
    jest.useRealTimers();
});

test('uses sparse phase and significant wait messages when stdout is redirected', () => {
    let now = 5_000;
    const sink = output(false);
    const renderer = new CliProgressRenderer({
        stdout: sink.stream,
        now: () => now,
    });
    renderer.start();
    renderer.onProgress(phaseEvent);
    renderer.onProgress({
        type: 'rate-limit-wait',
        bucket: 'search',
        until: now + 4_000,
        reason: 'primary',
        elapsedMs: 1_000,
    });
    renderer.onProgress({
        type: 'rate-limit-wait',
        bucket: 'search',
        until: now + 8_000,
        reason: 'primary',
        elapsedMs: 1_000,
    });
    renderer.finish();
    const text = sink.chunks.join('');
    expect(text).toContain('SLU: owner listing');
    expect(text).toContain('primary search quota wait 00:08');
    expect(text).not.toContain('\u001b');
    expect(sink.chunks).toHaveLength(2);
    now += 1;
});

test('prints concise structured search retry progress to redirected output', () => {
    const sink = output(false);
    const renderer = new CliProgressRenderer({ stdout: sink.stream });
    renderer.start();
    renderer.onProgress({
        type: 'search-retry',
        searchKind: 'organization',
        reason: 'incomplete-results',
        attempt: 2,
        totalAttempts: 3,
        university: 'SLU',
        elapsedMs: 1_500,
    });
    renderer.finish();
    expect(sink.chunks.join('')).toContain(
        'SLU: retrying organization search after incomplete-results (attempt 2/3)',
    );
    expect(sink.chunks.join('')).not.toContain('\u001b');
});
