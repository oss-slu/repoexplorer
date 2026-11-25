import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ClassificationRunReport } from './runner';

export async function writeClassificationReport(
    report: ClassificationRunReport,
    reportsDirectory: string,
): Promise<string> {
    await mkdir(reportsDirectory, { recursive: true });
    const timestamp = report.finishedAt.replace(/[:.]/g, '-');
    const reportPath = path.join(
        reportsDirectory,
        `classification-${timestamp}-${randomUUID()}.json`,
    );
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
    });
    return reportPath;
}
