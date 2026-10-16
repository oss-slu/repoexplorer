import { readFile, writeFile } from 'node:fs/promises';
import { findRecentParquetInDir, getParquet, parquetToObjects, readParquetFile } from '../utils/parquet';
import { parseArgs } from 'util';
import type { parqFileOpts } from '../types/scripts';
import type { repoData, secrData } from '../types/appData';
import { capitalize } from '../utils/strings';

// read positional arg to determine whether to get each parquet file or only a specific one
const { positionals } = parseArgs({ allowPositionals: true });
const modeOpts = ['REPO', 'SECR', 'ORGS', 'EACH'];
const mode = positionals[0]?.toUpperCase();
const runMode: string = modeOpts.includes(mode) ? mode : 'EACH';
const QUEUE = runMode === 'EACH' ? ['REPO', 'SECR', 'ORGS'] : [runMode];

// limit sample data to 100 rows for each parquet file
const SAMPLE_SECURITY_LIMIT = 100;
const SAMPLE_EXTRA_REPO_LIMIT = 100;

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

function getMatchingSecurityData(repos: repoData[], securityRows: secrData[]): secrData[] {
    const repoUrls = new Set(repos.map((repo) => repo.htmlUrl));

    return securityRows.filter((securityRepo) => repoUrls.has(securityRepo.htmlUrl));
}

let securityUrls = new Set<string>();
let sampleRepos: repoData[] = [];

if (runMode === 'EACH' || runMode === 'REPO') {
    const securityRows = await parquetToObjects(
        (await readParquetFile(await findRecentParquetInDir('SECR'))) || (await getParquet('SECR')),
    );

    securityUrls = new Set((securityRows as secrData[]).map((row) => row.htmlUrl));
}

if (runMode === 'SECR') {
    sampleRepos = JSON.parse(await readFile('data/sample/sampleRepoData.json', 'utf-8')) as repoData[];
}

for (const run of QUEUE) {
    // read existing parquet if it exists or download/save new one
    const objs = await parquetToObjects(
        (await readParquetFile(await findRecentParquetInDir(run as parqFileOpts))) ||
            (await getParquet(run as parqFileOpts)),
    );

    if (run === 'SECR') {
        securityUrls = new Set((objs as secrData[]).map((row) => row.htmlUrl));
    }

    // filter to only sample repo data
    const data =
        run === 'REPO'
            ? [
                  ...(objs as repoData[]).filter((r) => SAMPLE_REPO_ORGS.includes(r.owner)),
                  ...Array.from(
                      new Map(
                          (objs as repoData[])
                              .filter(
                                  (r) =>
                                      !SAMPLE_REPO_ORGS.includes(r.owner) &&
                                      r.htmlUrl !== null &&
                                      securityUrls.has(r.htmlUrl),
                              )
                              .map((r) => [r.htmlUrl, r] as const),
                      ).values(),
                  ).slice(0, SAMPLE_EXTRA_REPO_LIMIT),
              ]
            : run === 'SECR'
              ? getMatchingSecurityData(sampleRepos, objs as secrData[]).slice(0, SAMPLE_SECURITY_LIMIT)
              : objs.slice(0, 100);

    if (run === 'REPO') {
        sampleRepos = data as repoData[];
    }

    await writeFile(`data/sample/sample${capitalize(run)}Data.json`, JSON.stringify(data, null, 2));
}
