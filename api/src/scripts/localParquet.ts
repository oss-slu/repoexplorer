// fetch the parquet file from the public UC OSPO S3 bucket
import { parseArgs } from 'util';
import { confirm } from '../utils/cli';
import { findRecentParquetInDir, getParquet } from '../utils/parquet';
import type { parqFileOpts } from '../types/scripts';

const { positionals } = parseArgs({ allowPositionals: true });
const modeOpts = ['REPO', 'SECR', 'ORGS', 'EACH'];
const mode = positionals[0]?.toUpperCase();

// const runMode: parqFileOpts = (mode === 'REPO' || mode === 'SECR' || mode === 'ORGS' || mode == 'EACH') ? mode : 'REPO';
const runMode: string = modeOpts.includes(mode) ? mode : 'EACH';

// const QUEUE = ['REPO', 'SECR', 'ORGS'];
const QUEUE = runMode === 'EACH' ? ['REPO', 'SECR', 'ORGS'] : [runMode];

QUEUE.forEach(async (run) => {
    console.log(`Beginning ${run} parquet fetch...`);
    const existingParq = await findRecentParquetInDir(run as parqFileOpts);
    if (existingParq) {
        const proceed = await confirm(
            `A ${run} parquet file already exists locally (${existingParq}) - continue to fetch new file?`,
        );
        if (!proceed) {
            console.log('Aborted');
            process.exit(1);
        }
    }

    await getParquet(run as parqFileOpts);
});


