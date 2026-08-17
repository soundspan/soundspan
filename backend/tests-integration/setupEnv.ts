const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

if (integrationDatabaseUrl) {
    // Prisma 7 driver adapters ignore the Prisma-native `?schema=` URL
    // parameter, so schema-based isolation silently splits the app client
    // (public) from the test's own connection. Isolate with a dedicated
    // database per run instead: the suite creates it before the app client
    // first connects.
    const databaseName = `vibe_x2_${process.pid}_${Date.now()}`;
    const runtimeUrl = new URL(integrationDatabaseUrl);
    runtimeUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = runtimeUrl.toString();
    process.env.VIBE_INTEGRATION_DATABASE = databaseName;
}

process.env.DATABASE_URL ??= "postgresql://unused:unused@127.0.0.1:1/unused";
process.env.REDIS_URL ??= "redis://127.0.0.1:1";
process.env.SESSION_SECRET ??= "integration-test-session-secret-32-chars";
process.env.SETTINGS_ENCRYPTION_KEY ??=
    "integration-test-settings-key-not-for-runtime";
process.env.INTERNAL_API_SECRET ??=
    "integration-test-internal-key-not-for-runtime";
process.env.MUSIC_PATH ??= "/tmp";
process.env.NODE_ENV = "test";
