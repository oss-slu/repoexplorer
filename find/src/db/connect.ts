import { Pool, type PoolConfig } from 'pg';

export type DatabaseEnvironment = {
    PGHOST?: string;
    PGPORT?: string;
    PGDATABASE?: string;
    PGUSER?: string;
    PGPASSWORD?: string;
};

export function getDatabasePoolConfig(
    environment: DatabaseEnvironment = process.env,
): PoolConfig {
    const host = environment.PGHOST?.trim() || '127.0.0.1';
    const database = requireEnvironmentValue(
        environment.PGDATABASE,
        'PGDATABASE',
    );
    const user = requireEnvironmentValue(environment.PGUSER, 'PGUSER');
    const password = requireEnvironmentValue(
        environment.PGPASSWORD,
        'PGPASSWORD',
    );
    const portValue = environment.PGPORT ?? '5433';
    const port = Number(portValue);
    if (
        !/^\d+$/.test(portValue) ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
    ) {
        throw new TypeError('PGPORT must be an integer from 1 to 65535');
    }
    return { host, port, database, user, password };
}

export function createDatabasePool(
    environment: DatabaseEnvironment = process.env,
): Pool {
    return new Pool(getDatabasePoolConfig(environment));
}

function requireEnvironmentValue(
    value: string | undefined,
    name: string,
): string {
    if (!value || value.trim() === '') {
        throw new TypeError(`${name} must be set to connect to PostgreSQL`);
    }
    return value;
}
