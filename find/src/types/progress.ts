export type ScrapingPhase =
    'search' | 'owner listing' | 'enrichment' | 'database write';

export type ScrapingProgressEvent =
    | {
          type: 'search-retry';
          searchKind: 'repository' | 'organization' | 'user';
          reason: string;
          attempt: number;
          totalAttempts: number;
          university?: string;
          elapsedMs: number;
      }
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
          skipped?: number;
          warnings?: number;
          label?: string;
          elapsedMs: number;
      }
    | {
          type: 'warning';
          university: string;
          repository: string;
          field: string;
          replacementCount: number;
          code: 'nul_replaced';
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
