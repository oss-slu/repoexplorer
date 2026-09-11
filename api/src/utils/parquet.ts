import path from 'node:path';
import * as fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createWriteStream, Dirent } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { parquetMetadataAsync } from 'hyparquet';
import { MMDDYY_HHMMSS } from '../utils/datetime';
import { UCOSPO_REPO_PARQ_S3_URL, PARQUET_DATA_DIR, UCOSPO_SECR_PARQ_S3_URL, UCOSPO_ORGS_PARQ_S3_URL } from '../consts';
import { confirmDirExists } from './cli';
import type { repoData, orgsData, secrData } from '../types/appData';
import { readParquet } from 'parquet-wasm/node';
import { tableFromIPC } from 'apache-arrow';
import { toCamel } from './strings';
import type { parqFileOpts } from '../types/scripts';

// Fetch and save a parquet file from the UC OSPO S3 bucket
export async function getParquet(runMode: parqFileOpts): Promise<void> {
    let url = '';
    switch (runMode) {
        case 'REPO':
            url = UCOSPO_REPO_PARQ_S3_URL;
            break;
        case 'SECR':
            url = UCOSPO_SECR_PARQ_S3_URL;
            break;
        case 'ORGS':
            url = UCOSPO_ORGS_PARQ_S3_URL;
            break;
    }

    console.log(`Awaiting ${runMode} response from ${url}...`);
    const resp = await fetch(url, {
        method: 'GET',
        headers: {
            Accept: 'application/octet-stream, application/x-parquet',
        },
    });

    if (!resp.ok) {
        throw new Error(`HTTP error: ${resp.status}`);
    }

    const buf = await resp.arrayBuffer();

    const fname = `${PARQUET_DATA_DIR}/UC_OSPO_${runMode}_${MMDDYY_HHMMSS(new Date())}.parquet`;

    console.log(`Saving fetched parquet as ${fname}...`);
    await pipeline(Readable.from(Buffer.from(buf)), createWriteStream(fname));
}

/*
    Find the most recent parquet file in the passed directory, return full path as string
    Looks in the parquet data directory by default
*/
// export async function findRecentParquetInDir(dir: string = PARQUET_DATA_DIR): Promise<string> {
export async function findRecentParquetInDir(runMode: parqFileOpts): Promise<string> {
    const dir: string = PARQUET_DATA_DIR;
    const exists = await confirmDirExists(dir);
    if (!exists) return '';

    const entries: Dirent<string>[] = await fs.readdir(dir, { withFileTypes: true });
    const parqFiles = entries.filter(
        (f) => f.isFile() && f.name.toLowerCase().endsWith('.parquet') && f.name.includes(runMode),
    );
    if (parqFiles.length === 0) return '';

    const withStats = await Promise.all(
        parqFiles.map(async (f) => {
            const fullPath = path.join(dir, f.name);
            const stat = await fs.stat(fullPath);
            return { fullPath, mtime: stat.mtime.getTime() };
        }),
    );

    withStats.sort((a, b) => b.mtime - a.mtime);

    return withStats[0].fullPath;
}

/* 
    Read the parquet file at the passed path, return an ArrayBuffer
*/
export async function readParquetFile(path: string): Promise<ArrayBuffer> {
    const buf = await fs.readFile(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/*
    Get an array of column name strings from a pargquet buffer
*/
export async function parquetColumnNames(buf: ArrayBuffer): Promise<string[]> {
    return (await parquetMetadataAsync(buf)).schema.slice(1).map((f) => f.name);
}

export async function parquetToObjects(buf: ArrayBuffer): Promise<repoData[] | secrData[] | orgsData[]> {
    const wasmTable = readParquet(new Uint8Array(buf));
    const arrowTable = tableFromIPC(wasmTable.intoIPCStream());

    const rows: repoData[] | secrData[] | orgsData[] = [];
    for (const row of arrowTable) {
        const obj: Record<string, unknown> = {};
        for (const field of arrowTable.schema.fields) {
            let value = row[field.name];
            if (typeof value === 'bigint') value = Number(value);
            obj[toCamel(field.name)] = value;
        }
        rows.push(obj as repoData & secrData & orgsData);
    }
    return rows;
}
