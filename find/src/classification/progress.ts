import type { ClassificationProgressEvent } from './runner';

export interface ClassificationProgressOutput {
    write(value: string): unknown;
    isTTY?: boolean;
}

export type ClassificationProgressPrinterOptions = {
    output: ClassificationProgressOutput;
    now?: () => number;
    /** Minimum time between periodic lines when output is not a terminal. */
    intervalMs?: number;
};

/**
 * Writes classification progress. A terminal gets one line rewritten in
 * place; redirected output gets whole lines when a task starts, roughly every
 * tenth of the task, at most once per interval otherwise, and when it ends.
 */
export class ClassificationProgressPrinter {
    readonly onProgress: (event: ClassificationProgressEvent) => void;
    private readonly now: () => number;
    private readonly intervalMs: number;
    private lastLineAt = Number.NEGATIVE_INFINITY;
    private lastStep = -1;
    private lineVisible = false;

    constructor(private readonly options: ClassificationProgressPrinterOptions) {
        this.now = options.now ?? Date.now;
        this.intervalMs = options.intervalMs ?? 30_000;
        this.onProgress = (event) => this.update(event);
    }

    finish(): void {
        if (this.lineVisible) {
            this.options.output.write('\n');
            this.lineVisible = false;
        }
    }

    private update(event: ClassificationProgressEvent): void {
        const line = formatClassificationProgress(event);
        if (this.options.output.isTTY) {
            this.options.output.write(`\r\u001b[2K${line}`);
            this.lineVisible = true;
            if (event.completed >= event.total) this.finish();
            return;
        }
        const step =
            event.total === 0
                ? 10
                : Math.floor((event.completed * 10) / event.total);
        const boundary =
            event.completed === 0 || event.completed >= event.total;
        const now = this.now();
        if (
            boundary ||
            step > this.lastStep ||
            now - this.lastLineAt >= this.intervalMs
        ) {
            this.options.output.write(`${line}\n`);
            this.lastLineAt = now;
        }
        this.lastStep = event.completed === 0 ? 0 : Math.max(this.lastStep, step);
    }
}

export function formatClassificationProgress(
    event: ClassificationProgressEvent,
): string {
    const task = event.task === 'affiliation' ? 'affiliation' : 'project type';
    return `${sanitize(event.university)} | ${task} ${event.completed}/${event.total} | failed so far: ${event.failed} | elapsed ${formatDuration(event.elapsedMs)}`;
}

function sanitize(value: string): string {
    return Array.from(value)
        .map((character) => {
            const code = character.charCodeAt(0);
            return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
                ? ' '
                : character;
        })
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
}

function formatDuration(milliseconds: number): string {
    const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const secondsPart = String(seconds % 60).padStart(2, '0');
    const minutesPart = String(minutes % 60).padStart(2, '0');
    return hours
        ? `${String(hours).padStart(2, '0')}:${minutesPart}:${secondsPart}`
        : `${minutesPart}:${secondsPart}`;
}
