# API Database Connection

The RepoExplorer API supports PostgreSQL as a configurable data source using a shared connection pool defined in `api/src/db/connect.ts`.

This file manages the database connection, provides a reusable query function, and handles connection startup and shutdown.

## Data Sources

The RepoExplorer API supports two configurable data sources:

- `json`: Uses sample JSON files (default).
- `postgres`: Uses the PostgreSQL database.

The `DATA_SOURCE` environment variable determines which data source the API uses.

Both data sources implement the shared `AppDataSource` interface, allowing API routes to retrieve data without depending directly on a specific data source.

The PostgreSQL connection is initialized when `DATA_SOURCE` is set to `postgres`.

For more information, see the [Data Source Documentation](DataSourceDocumentation.md).

## Database Connection

The API uses the `pg` package to connect to PostgreSQL.

The connection module provides four exports:

- `pool`: A shared PostgreSQL connection pool.
- `query()`: Executes SQL queries using the connection pool.
- `connectDB()`: Verifies the database connection by running `select 1`.
- `closeDB()`: Closes the connection pool.

Example:

```typescript
import { query } from '../db/connect';

const result = await query(
    'SELECT $1::text AS university',
    ['Saint Louis University'],
);
```

The import path may vary depending on the location of the file using the connection module.

SQL values should be passed as parameters rather than inserted directly into query strings.

## Environment Variables

The PostgreSQL connection uses environment variables instead of hardcoded credentials.

The main variables are:

| Variable | Description |
| --- | --- |
| `DATA_SOURCE` | API data source (`json` or `postgres`) |
| `PGHOST` | PostgreSQL server hostname |
| `PGPORT` | PostgreSQL server port |
| `PGDATABASE` | Database name |
| `PGUSER` | Application database username |
| `PGPASSWORD` | Application database password |

The database connection variables are provided to the API through Docker Compose.

The PostgreSQL container listens on port `5432` internally. The database is also accessible from the host through port `5433` by default.

When connecting from another Docker container, the API should use the `db` service hostname and the internal PostgreSQL port.

For database setup and configuration instructions, see the [Database Setup Guide](database.md).

Private database credentials should be stored in the local `.env` file and should never be committed to the repository.

## Selecting a Data Source

### JSON Data Source

The JSON data source is the default option and uses sample JSON files.

To explicitly select this data source, add or update the following variable in the repository-root .env file:

```bash
DATA_SOURCE=json
```

This option is useful for development and testing without requiring the API to query PostgreSQL.

### PostgreSQL Data Source

To configure the API to retrieve data from PostgreSQL, add or update the following variable in the repository-root .env file:

```bash
DATA_SOURCE=postgres
```

Make sure the database has been configured and populated with the required data before using this option.

After updating the configuration, rebuild and restart the API container from the repository root:

```bash
docker compose up -d --build api
```

See the [Database Setup Guide](database.md) and [Data Source Documentation](DataSourceDocumentation.md) for additional instructions.

## Connection Pool Configuration

The connection pool uses the following settings:

| Setting | Value | Description |
| --- | --- | --- |
| `max` | 10 | Maximum number of connections |
| `idleTimeoutMillis` | 30000 | Closes idle connections after 30 seconds |
| `connectionTimeoutMillis` | 5000 | Maximum wait time for a connection |
| `statement_timeout` | 15000 | Cancels SQL statements after 15 seconds |

These settings help manage database connections and prevent queries from running indefinitely.

## API Startup and Shutdown

The API selects its data source in `api/src/main.ts`.

During startup, the API reads the `DATA_SOURCE` environment variable to determine which data source to use. If no data source is specified, the API defaults to JSON.

When PostgreSQL is selected, `main.ts` calls:

```typescript
await connectDB();
```

This verifies that PostgreSQL is available before the API begins accepting requests.

If the PostgreSQL connection fails, the API does not start listening.

When JSON is selected, the API does not initialize the PostgreSQL connection.

An unsupported `DATA_SOURCE` value prevents the API from starting successfully.

When the API receives a `SIGTERM` signal, it calls `closeDB()` if PostgreSQL is the selected data source.

This closes the connection pool and releases database resources.

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

The tests use Jest to mock PostgreSQL, so a running database is not required for these tests.

They verify:

- Connection pool configuration
- Pool error handling
- SQL query execution
- Database connection success and failure
- Connection pool cleanup

To run the database connection tests, navigate to the `api` directory from the repository root and execute:

```bash
cd api
npm test -- --runInBand src/tests/db/connect.test.ts
```

To run the complete backend test suite, execute:

```bash
npm test -- --runInBand
```

## Current Considerations

- The JSON data source remains the default configuration.
- PostgreSQL must be configured and populated before it can be used as the API data source.
- The API explicitly closes the PostgreSQL connection pool on `SIGTERM`, but not on `SIGINT`.
- Changes to the database schema or data source implementations should be reflected in the relevant developer documentation.

## Related Documentation

- [Project README](../../README.md)
- [Database Setup Guide](database.md)
- [Data Source Documentation](DataSourceDocumentation.md)
- [API Route Reference](api_routes.md)
- [Developer Setup Scripts](setup_scripts.md)