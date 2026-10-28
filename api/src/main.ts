import { createApp } from './app';
import { PORT, VITE_ORIGIN } from './consts';
import { connectDB, closeDB } from './db/connect';
import { MMDDYY_HHMMSS } from './utils/datetime';

async function main() {
    const app = createApp(VITE_ORIGIN);

    await connectDB();

    app.listen(PORT, () =>
        console.log(`API listening on port ${PORT} at ${MMDDYY_HHMMSS(new Date())}...`),
    );

    process.on('SIGTERM', () => void closeDB());
}

// BACKEND ENTRYPOINT
await main();