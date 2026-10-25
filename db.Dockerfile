FROM postgres:17-alpine

COPY scripts/db/setup.sql /docker-entrypoint-initdb.d/010-setup.sql
COPY scripts/db/schema.sql /docker-entrypoint-initdb.d/020-schema.sql
COPY scripts/db/repository-scraping.sql /docker-entrypoint-initdb.d/repository-scraping.sql
COPY scripts/db/repository-scraping-table.sql /docker-entrypoint-initdb.d/repository-scraping-table.sql
