import 'dotenv/config';
import { createApp } from './app';
import { PORT, VITE_ORIGIN } from './consts';
import { connectDB, closeDB } from './db/connect';
import { JsonDataSource } from './db/JsonDataSource';
import { PostgresDataSource } from './db/PostgresDataSource';
import type { AppDataSource } from './types/AppDataSource';
import { MMDDYY_HHMMSS } from './utils/datetime';

async function main() {
    const dataSourceType = process.env.DATA_SOURCE ?? 'json';

    if (dataSourceType !== 'json' && dataSourceType !== 'postgres') {
        throw new Error(`Invalid DATA_SOURCE: ${dataSourceType}`);
    }

    let dataSource: AppDataSource;

    if (dataSourceType === 'postgres') {
        await connectDB();
        dataSource = new PostgresDataSource();
    } else {
        dataSource = new JsonDataSource();
    }

    const app = createApp(VITE_ORIGIN, dataSource);

    app.listen(PORT, () =>
        console.log(`API listening on port ${PORT} at ${MMDDYY_HHMMSS(new Date())}...`),
    );

    if (dataSourceType === 'postgres') {
        process.on('SIGTERM', () => void closeDB());
    }
}

// BACKEND ENTRYPOINT
await main();