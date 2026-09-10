import express from 'express';
import cors from 'cors';
import health from './routes/health';
import overview from './routes/overview';
import impact from './routes/impact';
import security from './routes/security';

export const ROUTES = [
    { router: health, route: '/health' },
    { router: overview, route: '/overview' },
    { router: impact, route: '/impact' },
    { router: security, route: '/security' },
];

export function createApp(origin?: string) {
    const app = express();
    app.use(express.json());
    app.use(cors({ origin: origin, credentials: true }));

    ROUTES.forEach((r) => app.use(r.router));

    return app;
}
