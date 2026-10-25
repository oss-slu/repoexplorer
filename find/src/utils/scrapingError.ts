import type { ScrapingPhase } from '../types/progress';

export interface ScrapingErrorContext {
    phase: ScrapingPhase;
    university?: string;
    owner?: string;
    repository?: string;
    detail?: string;
}

export class ScrapingContextError extends Error {
    constructor(
        readonly context: ScrapingErrorContext,
        cause: unknown,
    ) {
        super(context.phase, { cause });
        this.name = 'ScrapingContextError';
    }
}

export function withScrapingContext(
    error: unknown,
    context: ScrapingErrorContext,
): ScrapingContextError {
    return new ScrapingContextError(context, error);
}
