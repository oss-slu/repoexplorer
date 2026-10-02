import { writeFile } from 'node:fs/promises';
import { findRecentParquetInDir, getParquet, parquetToObjects, readParquetFile } from '../utils/parquet';
import { parseArgs } from 'util';
import type { parqFileOpts } from '../types/scripts';
import type { repoData } from '../types/appData';
import { capitalize } from '../utils/strings';

// read positional arg to determine whether to get each parquet file or only a specific one
const { positionals } = parseArgs({ allowPositionals: true });
const modeOpts = ['REPO', 'SECR', 'ORGS', 'EACH'];
const mode = positionals[0]?.toUpperCase();
const runMode: string = modeOpts.includes(mode) ? mode : 'EACH';
const QUEUE = runMode === 'EACH' ? ['REPO', 'SECR', 'ORGS'] : [runMode];

// include only repos with these orgs as owner for sample repo data
const SAMPLE_REPO_ORGS = [
    'UC-OSPO-Network',
    'oss-slu',
    'uccross',
    'sluseallab',
    'SLURM-CLI-API-Proxy',
    'Fossil-Free-UC-Santa-Cruz',
    'OSS-PREY',
    'Saint-Louis-University',
    'UAVLab-SLU',
    'slu-dss',
];

QUEUE.forEach(async (run) => {
    // read existing parquet if it exists or download/save new one
    const objs = await parquetToObjects(
        (await readParquetFile(await findRecentParquetInDir(run as parqFileOpts))) ||
            (await getParquet(run as parqFileOpts)),
    );

    // filter to only sample repo data
    const data =
        run === 'REPO' ? (objs as repoData[]).filter((r) => SAMPLE_REPO_ORGS.includes(r.owner)) : objs.slice(0, 100);

    await writeFile(`data/sample/sample${capitalize(run)}Data.json`, JSON.stringify(data, null, 2));
});
