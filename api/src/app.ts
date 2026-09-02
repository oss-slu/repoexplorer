import express from 'express';
import cors from 'cors';
import health from './routes/health';
import langdist from './routes/langdist';
import typedist from './routes/typedist';
import licndist from './routes/licndist';

export const ROUTES = [
    { router: health, route: '/health' },
    { router: langdist, route: '/langdist' },
    { router: typedist, route: '/typedist' },
    { router: licndist, route: '/licndist' },
];

export function createApp(origin?: string) {
    const app = express();
    app.use(express.json());
    app.use(cors({ origin: origin, credentials: true }));

    ROUTES.forEach((r) => app.use(r.router));

    return app;
}
