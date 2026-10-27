import type {
    ScrapingProgressCallback,
    ScrapingProgressEvent,
    ScrapingPhase,
} from '../types/progress';

export interface ProgressOutput {
    write(value: string): unknown;
    isTTY?: boolean;
    columns?: number;
}

export interface ProgressRendererOptions {
    stdout: ProgressOutput;
    now?: () => number;
    refreshMs?: number;
    significantWaitMs?: number;
}

type PhaseProgress = {
    phase: ScrapingPhase;
    university: string;
    completed?: number;
    total?: number;
    skipped?: number;
    warnings?: number;
    label?: string;
};

export class CliProgressRenderer {
    readonly onProgress: ScrapingProgressCallback;
    private readonly now: () => number;
    private readonly refreshMs: number;
    private readonly significantWaitMs: number;
    private current: PhaseProgress | undefined;
    private elapsedMs = 0;
    private activeRequests = 0;
    private queuedRequests = 0;
    private waits: Partial<Record<'core' | 'search', number>> = {};
    private timer: ReturnType<typeof setInterval> | undefined;
    private startedAt: number | undefined;
    private lastRender = Number.NEGATIVE_INFINITY;
    private lineVisible = false;
    private closed = false;

    constructor(private readonly options: ProgressRendererOptions) {
        this.now = options.now ?? Date.now;
        this.refreshMs = options.refreshMs ?? 250;
        this.significantWaitMs = options.significantWaitMs ?? 5_000;
        this.onProgress = (event) => this.update(event);
    }

    start(): void {
        this.startedAt ??= this.now();
        if (this.options.stdout.isTTY && !this.timer) {
            this.timer = setInterval(() => this.renderIfDue(), this.refreshMs);
        }
    }

    clearForOutput(): void {
        if (this.lineVisible && this.options.stdout.isTTY) {
            this.options.stdout.write('\r\u001b[2K\n');
            this.lineVisible = false;
        }
    }

    finish(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        this.clearForOutput();
    }

    private update(event: ScrapingProgressEvent): void {
        if (this.closed) return;
        this.elapsedMs = event.elapsedMs;
        if (event.type === 'phase') {
            this.current = {
                phase: event.phase,
                university: event.university,
            };
            if (!this.options.stdout.isTTY) {
                this.options.stdout.write(
                    `${sanitize(event.university)}: ${event.phase}\n`,
                );
            }
        } else if (event.type === 'progress') {
            this.current = {
                phase: event.phase,
                university: event.university,
                completed: event.completed,
                total: event.total,
                skipped: event.skipped,
                warnings: event.warnings,
                label: event.label,
            };
        } else if (event.type === 'request-queue') {
            this.activeRequests = event.activeRequests;
            this.queuedRequests = event.queuedRequests;
            this.waits = event.waits;
        } else if (event.type === 'rate-limit-wait') {
            const until = event.until;
            if (event.bucket === 'all') {
                this.waits = { ...this.waits, core: until, search: until };
            } else {
                this.waits = { ...this.waits, [event.bucket]: until };
            }
            if (!this.options.stdout.isTTY) {
                const remaining = Math.max(0, until - this.now());
                if (remaining >= this.significantWaitMs) {
                    this.options.stdout.write(
                        `${sanitize(this.current?.university ?? 'GitHub')}: ${event.reason} ${event.bucket} quota wait ${formatDuration(remaining)}\n`,
                    );
                }
            }
        } else if (event.type === 'warning' && !this.options.stdout.isTTY) {
            this.options.stdout.write(
                `${sanitize(event.university)}: ${sanitize(event.repository)} field ${sanitize(event.field)}; replaced ${event.replacementCount} NUL character${event.replacementCount === 1 ? '' : 's'}\n`,
            );
        }
        this.renderIfDue();
    }

    private renderIfDue(): void {
        if (
            this.closed ||
            !this.options.stdout.isTTY ||
            this.now() - this.lastRender < this.refreshMs
        ) {
            return;
        }
        this.render();
    }

    private render(): void {
        if (!this.current || !this.options.stdout.isTTY || this.closed) return;
        const progress =
            this.current.completed === undefined ||
            this.current.total === undefined
                ? ''
                : ` ${this.current.completed}/${this.current.total}`;
        const label = this.current.label
            ? ` (${sanitize(this.current.label)})`
            : '';
        const recovery = [
            this.current.skipped ? `${this.current.skipped} skipped` : undefined,
            this.current.warnings
                ? `${this.current.warnings} text warnings`
                : undefined,
        ]
            .filter((part): part is string => part !== undefined)
            .join(', ');
        const recoveryText = recovery ? ` | ${recovery}` : '';
        const queue =
            this.activeRequests || this.queuedRequests
                ? ` | ${this.activeRequests} active${this.queuedRequests ? `, ${this.queuedRequests} queued` : ''}`
                : '';
        const waitLabels = (['search', 'core'] as const)
            .filter((bucket) => (this.waits[bucket] ?? 0) > this.now())
            .map(
                (bucket) =>
                    `${bucket} quota wait ${formatDuration((this.waits[bucket] ?? this.now()) - this.now())}`,
            );
        const waits = waitLabels.length ? ` | ${waitLabels.join(', ')}` : '';
        const elapsed = Math.max(
            this.elapsedMs,
            this.startedAt === undefined ? 0 : this.now() - this.startedAt,
        );
        const line = `${sanitize(this.current.university)} | ${this.current.phase}${progress}${label}${recoveryText}${queue}${waits} | elapsed ${formatDuration(elapsed)}`;
        const width = this.options.stdout.columns;
        const visible = width && width > 0 ? truncate(line, width) : line;
        this.options.stdout.write(`\r\u001b[2K${visible}`);
        this.lastRender = this.now();
        this.lineVisible = true;
    }
}

function truncate(value: string, width: number): string {
    if (value.length <= width) return value;
    if (width <= 1) return value.slice(0, width);
    return `${value.slice(0, width - 1)}…`;
}

function sanitize(value: string): string {
    // Filter config and GitHub supplied control characters before terminal output.
    const withoutControls = Array.from(value)
        .map((character) => {
            const code = character.charCodeAt(0);
            return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
                ? ' '
                : character;
        })
        .join('');
    return withoutControls.replace(/\s+/g, ' ').trim();
}

function formatDuration(milliseconds: number): string {
    const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const secondsPart = String(seconds % 60).padStart(2, '0');
    const minutesPart = String(minutes % 60).padStart(2, '0');
    return hours
        ? `${String(hours).padStart(2, '0')}:${minutesPart}:${secondsPart}`
        : `${minutesPart}:${secondsPart}`;
}
