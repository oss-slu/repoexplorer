# Data Source Documentation

## Overview

The API supports two data sources: sample JSON files and PostgreSQL. Both implementations use a shared `AppDataSource` interface, allowing the API to retrieve data without depending on a specific data source.

## Data Source Interface

The `AppDataSource` interface is defined in `api/src/types/AppDataSource.ts` and includes three methods:

- `getRepoData()` - Retrieves repository data.
- `getSecrData()` - Retrieves security data.
- `getOrgsData()` - Retrieves organization data.

All three methods return the same data types regardless of which data source is selected.

## Data Source Implementations

### JsonDataSource

`JsonDataSource.ts` retrieves repository, security, and organization data from the sample JSON files.

This is the default data source and does not require a PostgreSQL connection.

### PostgresDataSource

`PostgresDataSource.ts` retrieves data from the PostgreSQL database using the following tables:

- `repositories_parquet` - Repository data
- `security_parquet` - Security data
- `organizations_parquet` - Organization data

The implementation converts PostgreSQL column names from snake_case to camelCase to match the API's existing data types. Numeric values are also converted where applicable.

## Selecting a Data Source

The API uses the `DATA_SOURCE` environment variable to select which implementation to use.

- `json` - Uses sample JSON files (default).
- `postgres` - Uses PostgreSQL.

To run the API with PostgreSQL using Docker Compose:

```bash
DATA_SOURCE=postgres docker compose up -d --build api
```

To run the API with the default JSON data source:

```bash
DATA_SOURCE=json docker compose up -d --build api
```

These commands can be run from the repository root. PostgreSQL must be running and contain the required data when using `DATA_SOURCE=postgres`.

## Database Connection

The PostgreSQL connection is managed in `api/src/db/connect.ts`.

The connection uses PostgreSQL environment variables (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, and `PGDATABASE`) and a shared connection pool.

The connection pool includes limits and timeouts to manage database connections.

## API Routes

The following API routes use the selected data source:

- `/overview`
- `/impact`
- `/security`
- `/sustainability`
- `/organization`
- `/organization/organizations`

These routes work with either JSON or PostgreSQL without requiring changes to their data-processing logic.

## Testing

Unit tests are included for both data-source implementations, the database connection, and the API routes.

To run the API tests from the repository root:

```bash
cd api
npm test -- --runInBand
```

The API endpoints can also be tested with PostgreSQL by starting the API with `DATA_SOURCE=postgres` and sending requests to the endpoints.

## Summary

The shared data-source interface allows the API to switch between sample JSON files and PostgreSQL while keeping the existing API routes and data types consistent. This makes it easier to change or extend the data source without modifying the downstream application logic.