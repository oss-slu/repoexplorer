export type ScrapingPhase =
    'search' | 'owner listing' | 'enrichment' | 'database write';

export type ScrapingProgressEvent =
    | {
          type: 'phase';
          phase: ScrapingPhase;
          university: string;
          elapsedMs: number;
      }
    | {
          type: 'progress';
          phase: ScrapingPhase;
          university: string;
          completed: number;
          total: number;
          label?: string;
          elapsedMs: number;
      }
    | {
          type: 'request-queue';
          activeRequests: number;
          queuedRequests: number;
          waits: Partial<Record<'core' | 'search', number>>;
          elapsedMs: number;
      }
    | {
          type: 'rate-limit-wait';
          bucket: 'core' | 'search' | 'all';
          until: number;
          reason: 'primary' | 'secondary';
          elapsedMs: number;
      };

export type ScrapingProgressCallback = (event: ScrapingProgressEvent) => void;
