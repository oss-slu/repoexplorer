# RepoExplorer

## Open Source Repository Browser

Helping universities, researchers, and open-source communities better understand open-source software through data visualization and interactive analytics.

## Overview

RepoExplorer is an open-source repository browser developed by [Open Source with SLU](https://oss-slu.github.io). It is a fork of the original [RepoExplorer project](https://github.com/UC-OSPO-Network/repoexplorer) developed by the [UC OSPO Network](https://ucospo.net).

The project builds a modern web architecture around the original work by providing an interactive web application that makes open-source repository and organization data easier to access, explore, and understand. Users can interact with dashboards, charts, tables, and filters to identify trends and gain insights into open-source software.

For more information about the original project, see the [UC OSPO original about.md file](docs/about.md).

## Key Features

### Repository Dashboards

- **Overview:** Displays general repository statistics, programming language distribution, and university affiliations.
- **Browse:** Allows users to explore individual repositories and their associated information.
- **Impact:** Provides insights into the impact and engagement of open-source repositories.
- **Sustainability:** Displays metrics related to repository activity and long-term sustainability.
- **Security:** Provides repository security scorecard information and security metrics.

### Organization Dashboards

- **Overview:** Provides a summary of open-source organization data.
- **Browse:** Allows users to search, filter, and explore individual organizations and their associated details.

### Interactive Filtering

RepoExplorer provides interactive filters that allow users to narrow down data based on specific criteria.

Repository filters include:

- University affiliation
- Affiliation prediction threshold
- Project type
- License
- Programming language
- Minimum number of stars
- Minimum number of forks
- Minimum number of release downloads

Organization filters include:

- University affiliation
- Affiliation prediction threshold

### Data Visualization

The application uses interactive charts, tables, and summary cards to present complex data in a more accessible and understandable format.

## Tech Stack

**TypeScript is used throughout the project.**

### Frontend (`app/`)

- React
- Vite
- Recharts
- Nginx

### Backend (`api/`)

- Node.js
- Express

### Database and Data Sources

- PostgreSQL
- Sample JSON files
- Shared data source interface

### Data Collection (`find/`)

- TypeScript
- PostgreSQL
- GitHub APIs
- Local LLMs (under development)

The data collection component is a rebuild of the original [RepoFinder](https://github.com/UC-OSPO-Network/repofinder) project developed by the UC OSPO Network.

RepoFinder supports repository discovery, data collection, and enrichment. For more information, see the [RepoFinder Documentation](find/README.md).

### Infrastructure

- Docker
- Docker Compose

### Testing

- Vitest
- React Testing Library
- Jest
- Supertest

## Project Architecture

RepoExplorer is organized into several components that work together to collect, retrieve, and display open-source data.

- **Data Collection:** RepoFinder supports the discovery, collection, and enrichment of repository data.
- **Data Storage:** PostgreSQL provides persistent storage for open-source data. Sample JSON files are also available for development and testing.
- **Backend:** The Express API retrieves and processes data through a shared data source interface.
- **Frontend:** The React application sends requests to the API and displays the returned data through interactive dashboards, charts, tables, and filters.
- **Deployment:** Docker Compose manages application services, while Nginx serves the production frontend and forwards API requests to the backend.

### Data Sources

The API uses the `AppDataSource` interface to support two configurable data sources:

- `json`: Uses sample JSON files (default).
- `postgres`: Uses the PostgreSQL database.

The `DATA_SOURCE` environment variable determines which data source the API uses. This allows developers to switch between data sources without changing the frontend or API route logic.

For additional information, see the [Data Source Documentation](docs/dev/DataSourceDocumentation.md).


For a more detailed explanation of the system architecture, component responsibilities, and data flow, see the [System Overview](docs/dev/system_overview.md) and [System Architecture Diagram](docs/dev/system_architecture_diagram.png).

## Project Installation and Setup

### 1. Install Docker Desktop

Download and install [Docker Desktop](https://www.docker.com/get-started/).

### 2. Clone the Repository

Clone the repository and open the project locally:

```bash
git clone https://github.com/oss-slu/repoexplorer.git
cd repoexplorer
```

### 3. Create Local Database Credentials

Run the following command once to create a private `.env` file with separate PostgreSQL administrator and application credentials:

```bash
./scripts/setup-env
```

For additional configuration and database operations, see the [Database Setup Guide](docs/dev/database.md).

Do not commit the `.env` file or share private database credentials.

### 4. Run the Application with Docker Compose

The frontend can be served through Nginx using the `app` container (production behavior) or through Vite's development server, which allows developers to take advantage of hot reloading.

#### Option 1: Docker Frontend

Start the application services:

```bash
docker compose --profile prod up --build -d
```

The frontend should now be accessible in your browser through Nginx at:

**http://localhost:8087**

#### Option 2: Vite Development Server

First, make sure [Node.js](https://nodejs.org/en) is installed.

Start the backend container:

```bash
docker compose up api --build -d
```

Install the frontend dependencies and start the Vite development server:

```bash
cd app
npm ci
npm run dev
```

The frontend should now be accessible in your browser through Vite at:

**http://localhost:6284**

### 5. Optional: Download the UC OSPO Network Parquet File

See the [Developer Setup Scripts](docs/dev/setup_scripts.md) for instructions on downloading the UC OSPO Network Parquet file locally.

## Testing

RepoExplorer includes frontend and backend tests to help maintain application functionality and reliability.

### Frontend Tests

The frontend uses Vitest and React Testing Library.

From the repository root, run:

```bash
cd app
npm ci
npm run test:run
```

### Backend Tests

The backend uses Jest and Supertest.

From the repository root, run:

```bash
cd api
npm ci
npm test -- --runInBand
```

## API Routes

The Express API provides endpoints for retrieving repository, organization, impact, sustainability, and security data.

See the [API Route Reference](docs/dev/api_routes.md) for information on available endpoints, parameters, responses, and usage.

## Documentation

Additional documentation is available to help developers understand, maintain, and contribute to RepoExplorer.

| Document | Description |
| --- | --- |
| [Original UC OSPO About Document](docs/about.md) | Background and information about the original project |
| [API Route Reference](docs/dev/api_routes.md) | API endpoints, parameters, and responses |
| [Database Setup Guide](docs/dev/database.md) | PostgreSQL setup, configuration, and schema |
| [API Database Connection](docs/dev/db.md) | Backend database connection and connection pool |
| [Data Source Documentation](docs/dev/DataSourceDocumentation.md) | JSON and PostgreSQL data source implementations |
| [Layout and Dashboard Integration](docs/dev/layout.md) | Frontend layout and dashboard development |
| [Adding a New API Route](docs/dev/new_api_route.md) | Instructions for adding API routes |
| [Developer Setup Scripts](docs/dev/setup_scripts.md) | Additional setup instructions |
| [Sustainability API](docs/dev/sustainability_api.md) | Sustainability API documentation |
| [Scraping Analysis](docs/dev/scraping-analysis.md) | Repository scraping analysis |
| [RepoFinder Documentation](find/README.md) | Repository discovery, collection, and enrichment |
| [GraphQL Enrichment Plan](docs/plans/graphql-enrichment.md) | Development plan for GraphQL enrichment |
| [Coding Conventions](docs/CONVENTIONS.md) | Project coding standards and conventions |
| [Contribution Guidelines](docs/CONTRIBUTING.md) | Information for new and existing contributors |
| [System Overview](docs/dev/system_overview.md) | System architecture, component responsibilities, and data flow |
| [System Architecture Diagram](docs/dev/system_architecture_diagram.png) | Visual representation of the system architecture |


## Contributing

Contributions to RepoExplorer are welcome!

New contributors are encouraged to:

1. Review the project overview and documentation.
2. Set up and run the application locally.
3. Review the existing [GitHub issues](https://github.com/oss-slu/repoexplorer/issues).
4. Communicate with the project team before beginning work on an issue.
5. Follow the project's coding conventions.
6. Test changes before submitting a pull request.
7. Submit changes through a pull request for review.

For more information, see:

- [Contribution Guidelines](docs/CONTRIBUTING.md)
- [Coding Conventions](docs/CONVENTIONS.md)
- [Code of Conduct](docs/CODE_OF_CONDUCT.md)
- [Contributors](docs/CONTRIBUTORS.md)

## SBOMs

See the [SBOM Guide](docs/dev/sbom.md) for information on where to download the backend and frontend Software Bills of Materials (SBOMs) and how to verify them.
