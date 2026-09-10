import { writeFile } from 'node:fs/promises';
import { findRecentParquetInDir, getParquet, parquetToObjects, readParquetFile } from '../utils/parquet';
import { parseArgs } from 'util';
import type { parqFileOpts } from '../types/scripts';
import type { appData } from '../types/appData';
import { capitalize } from '../utils/strings';

const { positionals } = parseArgs({ allowPositionals: true });
const modeOpts = ['REPO', 'SECR', 'ORGS', 'EACH'];
const mode = positionals[0]?.toUpperCase();
const runMode: string = modeOpts.includes(mode) ? mode : 'EACH';

// const QUEUE = ['REPO', 'SECR', 'ORGS'];
const QUEUE = runMode === 'EACH' ? ['REPO', 'SECR', 'ORGS'] : [runMode];

QUEUE.forEach(async (run) => {
    const objs = await parquetToObjects(
        (await readParquetFile(await findRecentParquetInDir(run as parqFileOpts))) ||
            (await getParquet(run as parqFileOpts)),
    );

    let data = objs;
    // filter to oss-slu repos
    if (run === 'REPO') {
        data = (objs as appData[]).filter((r) => ['UC-OSPO-Network', 'oss-slu'].includes(r.owner));
    } else {
        data = objs.slice(0, 100);
    }

    await writeFile(`data/sample/sample${capitalize(run)}Data.json`, JSON.stringify(data, null, 2));

    // console.log(filtered);
});
