import { createApp } from './app';
import { PORT, VITE_ORIGIN } from './consts';
import { MMDDYY_HHMMSS } from './utils/datetime';

function main() {
    const app = createApp(VITE_ORIGIN);
    app.listen(PORT, () => console.log(`API listening on port ${PORT} at ${MMDDYY_HHMMSS(new Date())}...`));
}

// BACKEND ENTRYPOINT
main();
