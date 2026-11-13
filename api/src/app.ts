import express from 'express';
import cors from 'cors';
import health from './routes/health';
import { createOverviewRouter } from './routes/overview';
import type { AppDataSource } from './types/AppDataSource';
import { createImpactRouter } from './routes/impact';
import { createSecurityRouter } from './routes/security';
import { createSustainabilityRouter } from './routes/sustainability';
import { createOrganizationRouter } from './routes/organization';
import { PostgresDataSource } from './db/PostgresDataSource';
import { JsonDataSource } from './db/JsonDataSource';

export const ROUTES = [
    { router: health, route: '/health' },
];

export function createApp(
    origin?: string,
    dataSource: AppDataSource = process.env.DATA_SOURCE === 'postgres'
        ? new PostgresDataSource() : new JsonDataSource(), 
) {
    const app = express();

    app.use(express.json());
    app.use(cors({ origin: origin, credentials: true }));

    app.use(createOverviewRouter(dataSource));
    app.use(createImpactRouter(dataSource));
    app.use(createSecurityRouter(dataSource));
    app.use(createSustainabilityRouter(dataSource));
    app.use(createOrganizationRouter(dataSource));

    ROUTES.forEach((r) => app.use(r.router));

    return app;
}
