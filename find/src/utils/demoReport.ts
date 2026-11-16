import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DemoRunResult } from '../demoRunner';
import { DEMO_OMITTED_STAGES } from '../demoRunner';
import {
    sanitizeDiagnosticText,
    type ScrapingDiagnostic,
} from './scrapingDiagnostics';

export type DemoReport = {
    schemaVersion: 1;
    mode: 'demo';
    coverage: 'sampled';
    publication: 'not published';
    startedAt: string;
    finishedAt: string;
    omittedStages: readonly string[];
    summary: {
        outcome: DemoRunResult['status'];
        university: string;
        searchTotal: number | null;
        sampled: number;
        succeeded: number;
        skipped: number;
        failed: number;
        fatalFailures: number;
        notRun: number;
        warningCount: number;
        elapsedMs: number;
        searchElapsedMs: number;
    };
    repositories: Array<{
        repositoryId: number;
        repositoryName: string;
        status: DemoRunResult['repositories'][number]['status'];
        elapsedMs: number;
        warningCount: number;
        diagnostic: ScrapingDiagnostic;
    }>;
    diagnostic?: ScrapingDiagnostic;
};

export function createDemoReport(input: {
    startedAt: Date;
    finishedAt: Date;
    result: DemoRunResult;
}): DemoReport {
    const repositories = input.result.repositories.map((repository) => ({
        repositoryId: repository.repositoryId,
        repositoryName: sanitizeDiagnosticText(repository.repositoryName),
        status: repository.status,
        elapsedMs: repository.elapsedMs,
        warningCount: repository.warningCount,
        diagnostic: { ...repository.diagnostic },
    }));
    return {
        schemaVersion: 1,
        mode: 'demo',
        coverage: 'sampled',
        publication: 'not published',
        startedAt: input.startedAt.toISOString(),
        finishedAt: input.finishedAt.toISOString(),
        omittedStages: [...DEMO_OMITTED_STAGES],
        summary: {
            outcome: input.result.status,
            university: sanitizeDiagnosticText(input.result.university),
            searchTotal: input.result.searchTotal ?? null,
            sampled: input.result.sampled,
            succeeded: repositories.filter(
                (repository) => repository.status === 'success',
            ).length,
            skipped: repositories.filter(
                (repository) => repository.status === 'skipped',
            ).length,
            failed: repositories.filter(
                (repository) => repository.status === 'failed',
            ).length,
            fatalFailures: input.result.status === 'failed' ? 1 : 0,
            notRun: repositories.filter(
                (repository) => repository.status === 'not_run',
            ).length,
            warningCount: repositories.reduce(
                (total, repository) => total + repository.warningCount,
                0,
            ),
            elapsedMs: input.result.elapsedMs,
            searchElapsedMs: input.result.searchElapsedMs,
        },
        repositories,
        ...(input.result.diagnostic
            ? {
                  diagnostic: { ...input.result.diagnostic },
              }
            : {}),
    };
}

export async function writeDemoReport(
    report: DemoReport,
    directory: string,
): Promise<string> {
    const reportDirectory = path.resolve(directory);
    const timestamp = report.finishedAt.replace(/[:.]/g, '-');
    const reportPath = path.join(
        reportDirectory,
        `demo-report-${timestamp}-${randomUUID()}.json`,
    );
    const temporaryPath = `${reportPath}.${randomUUID()}.tmp`;
    await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
    try {
        await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'wx',
        });
        await rename(temporaryPath, reportPath);
        return reportPath;
    } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}
