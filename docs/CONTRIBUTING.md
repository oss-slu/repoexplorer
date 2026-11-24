# Contributing to RepoExplorer

Thank you for your interest in contributing to RepoExplorer! This guide provides information to help new and existing contributors get started, follow project conventions, and contribute to the continued development of the application.

## Getting Started

Before contributing to RepoExplorer:

1. Review the [Project README](../README.md) to understand the project's purpose, features, and architecture.
2. Follow the installation and setup instructions in the README.
3. Make sure the application runs successfully on your local machine.
4. Review the existing [GitHub issues](https://github.com/oss-slu/repoexplorer/issues).
5. Communicate with the project team before beginning work on an issue.

## Project Structure

| Directory | Description |
| --- | --- |
| `app/` | React frontend, dashboard components, styling, and frontend tests |
| `api/` | Express backend, API routes, data sources, database connection, and backend tests |
| `find/` | RepoFinder repository discovery, data collection, and enrichment |
| `docs/` | Project and developer documentation |
| `scripts/` | Project setup and utility scripts |
| `data/` | Project data resources |

## Development Workflow

### 1. Select an Issue

Review the available GitHub issues and choose an issue that aligns with your interests and experience.

Coordinate with the project team to avoid duplicating work or creating conflicts with other contributors.

### 2. Update Your Local Repository

Before beginning work, make sure your local main branch is up to date:

```bash
git switch main
git pull origin main
```

### 3. Create a New Branch

Create a separate branch for your changes:

```bash
git switch -c feature/your-feature-name
```

Use a descriptive branch name that reflects the work being completed.

Examples:

- `feature/dashboard-filters`
- `fix/api-response`
- `docs/update-readme`

### 4. Implement Your Changes

When making changes:

- Follow the project's existing structure and coding conventions.
- Keep changes focused on the issue being addressed.
- Write clear and maintainable code.
- Reuse existing components and utility functions when appropriate.
- Add or update tests when necessary.
- Update relevant documentation when functionality changes.
- Never commit private credentials, API tokens, or `.env` files.

## Coding Conventions

RepoExplorer uses TypeScript throughout the project.

Contributors should follow the established naming conventions, indentation requirements, and framework-specific standards.

See the [Coding Conventions](CONVENTIONS.md) document for detailed guidelines.

## Testing

Before submitting a pull request, test your changes and make sure existing functionality continues to work as expected.

### Frontend Testing

The frontend uses Vitest and React Testing Library.

From the repository root, run:

```bash
cd app
npm ci
npm run test:run
```

To check the frontend build:

```bash
npm run build
```

### Backend Testing

The backend uses Jest and Supertest.

From the repository root, run:

```bash
cd api
npm ci
npm test -- --runInBand
```

To check the backend build:

```bash
npm run build
```

### Linting

Both the frontend and backend provide linting commands.

From the appropriate directory (`app/` or `api/`), run:

```bash
npm run lint
```

### Manual Testing

In addition to automated tests, contributors should manually verify relevant changes when appropriate.

Examples include:

- Confirming that dashboards load correctly.
- Checking that filters behave as expected.
- Verifying that API endpoints return the expected responses.
- Checking that frontend changes display correctly at different screen sizes.
- Confirming that updated setup instructions and documentation links work.

## Working with Data Sources

RepoExplorer supports two configurable API data sources:

- `json`: Sample JSON files (default).
- `postgres`: PostgreSQL database.

The shared `AppDataSource` interface allows the API to retrieve data from either source.

Contributors working with API routes or database functionality should review the following documentation:

- [Data Source Documentation](dev/DataSourceDocumentation.md)
- [Database Setup Guide](dev/database.md)
- [API Database Connection](dev/db.md)
- [API Route Reference](dev/api_routes.md)

Contributors working on repository discovery, collection, or enrichment should review the [RepoFinder Documentation](../find/README.md).

## Committing Changes

Review your changes before creating a commit:

```bash
git status
git diff
git diff --check
```

Stage the files related to your changes:

```bash
git add path/to/modified-file
```

Create a commit with a clear and descriptive message:

```bash
git commit -m "Add repository dashboard filters"
```

Push your branch to GitHub:

```bash
git push -u origin feature/your-feature-name
```

Replace the example branch name and commit message with values appropriate for your contribution.

## Submitting a Pull Request

When your changes are ready:

1. Open a pull request on GitHub targeting the `main` branch.
2. Provide a clear and descriptive title.
3. Explain what changes were made and why.
4. Reference the related GitHub issue, if applicable.
5. Describe how the changes were tested.
6. Include screenshots when making visual or frontend changes, if appropriate.
7. Request a review from the tech lead or appropriate team members.
8. Address any feedback received during the review process.

Avoid merging changes before the appropriate review and approval.

## Documentation

Documentation is an important part of maintaining RepoExplorer and helping future contributors understand the project.

When introducing new features or modifying existing functionality, update relevant documentation as needed.

Helpful resources include:

- [Project README](../README.md)
- [Layout and Dashboard Integration](dev/layout.md)
- [Adding a New API Route](dev/new_api_route.md)
- [API Route Reference](dev/api_routes.md)
- [Database Setup Guide](dev/database.md)
- [Developer Setup Scripts](dev/setup_scripts.md)
- [RepoFinder Documentation](../find/README.md)

## Communication

Contributors are encouraged to communicate regularly with the project team through the Open Source with SLU Slack workspace.

Ask questions, provide progress updates, communicate blockers, and coordinate with other contributors when working on related issues.

## Code of Conduct

All contributors are expected to maintain a respectful, inclusive, and collaborative environment.

Please review the project's [Code of Conduct](CODE_OF_CONDUCT.md).

## Contributors

Thank you to everyone who has contributed to the development and improvement of RepoExplorer.

See the [Contributors](CONTRIBUTORS.md) document for more information.
