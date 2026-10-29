# API Database Connection

The RepoExplorer API connects to PostgreSQL using a shared connection pool defined in `api/src/db/connect.ts`.

This file manages the database connection, provides a reusable query function, and handles connection startup and shutdown.

## Database Connection

The API uses the `pg` package to connect to PostgreSQL.

The connection module provides four exports:

- `pool`: A shared PostgreSQL connection pool.
- `query()`: Executes SQL queries using the connection pool.
- `connectDB()`: Verifies the database connection by running `select 1`.
- `closeDB()`: Closes the connection pool.

Example:

```typescript
import { query } from '../../api/src/db/connect';

const result = await query(
    'SELECT * FROM repositories WHERE university = $1',
    ['Saint Louis University'],
);
```

SQL values should be passed as parameters rather than inserted directly into query strings.

## Environment Variables

The PostgreSQL connection uses environment variables instead of hardcoded credentials.

The main variables are:

- `PGHOST`: PostgreSQL server hostname.
- `PGPORT`: PostgreSQL server port.
- `PGDATABASE`: Database name.
- `PGUSER`: Application database username.
- `PGPASSWORD`: Application database password.

These variables are provided to the API through Docker Compose.

Inside Docker, the API connects to the `db` service on port `5432`.

The database is also accessible from the host through port `5433` by default.

For database setup instructions, see `docs/dev/database.md`.

## Connection Pool Configuration

The connection pool uses the following settings:

| Setting | Value | Description |
|---|---|---|
| `max` | 10 | Maximum number of connections |
| `idleTimeoutMillis` | 30000 | Closes idle connections after 30 seconds |
| `connectionTimeoutMillis` | 5000 | Maximum wait time for a connection |
| `statement_timeout` | 15000 | Cancels SQL statements after 15 seconds |

These settings help manage database connections and prevent queries from running indefinitely.

## API Startup and Shutdown

The API initializes its PostgreSQL connection in `api/src/main.ts`.

Before starting the server, `main.ts` calls:

```typescript
await connectDB();
```

This verifies that PostgreSQL is available before the API begins accepting requests.

If the database connection fails, the API does not start listening.

When the API receives a `SIGTERM` signal, it calls `closeDB()` to close the connection pool.

## Error Handling

The connection pool includes an error listener:

```typescript
pool.on('error', (err) => console.error('Unexpected PG pool error', err));
```

This logs unexpected errors from idle PostgreSQL connections.

Database query and connection errors are propagated to the caller.

## Testing

Database connection tests are located in:

`api/src/tests/db/connect.test.ts`

The tests use Jest to mock PostgreSQL, so a running database is not required.

They verify:

- Connection pool configuration
- Pool error handling
- SQL query execution
- Database connection success and failure
- Connection pool cleanup

To run the tests, navigate to the `api` directory and execute:

```bash
npm test -- --runInBand src/tests/db/connect.test.ts
```

## Current Limitations

The API currently reads dashboard data from Parquet files. The PostgreSQL connection is available for future database integration, but this change does not replace the existing data sources.

The connection pool is closed on `SIGTERM`, but not explicitly on `SIGINT`.