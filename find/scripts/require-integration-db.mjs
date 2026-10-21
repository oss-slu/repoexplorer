const databaseUrl = process.env.FINDER_TEST_DATABASE_URL;
const adminDatabaseUrl =
    process.env.FINDER_TEST_ADMIN_DATABASE_URL ?? databaseUrl;

if (!databaseUrl) {
    console.error('Set FINDER_TEST_DATABASE_URL to an isolated test database.');
    process.exit(1);
}

for (const [name, value] of [
    ['FINDER_TEST_DATABASE_URL', databaseUrl],
    ['FINDER_TEST_ADMIN_DATABASE_URL', adminDatabaseUrl],
]) {
    try {
        const databaseName = decodeURIComponent(
            new URL(value).pathname.slice(1),
        );
        if (!/(test|integration|verify)/i.test(databaseName)) {
            console.error(
                `${name} must point to a database named for testing.`,
            );
            process.exit(1);
        }
    } catch {
        console.error(`${name} must be a valid PostgreSQL URL.`);
        process.exit(1);
    }
}
