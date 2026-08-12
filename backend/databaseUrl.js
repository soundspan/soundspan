"use strict";

const POSTGRES_COMPONENT_KEYS = [
    "POSTGRES_HOST",
    "POSTGRES_PORT",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
];

/**
 * Resolve the PostgreSQL connection URL without changing an explicit URL.
 *
 * @param {Record<string, string | undefined>} environment process environment
 * @returns {string | undefined} explicit, constructed, or absent database URL
 */
function resolveDatabaseUrl(environment) {
    const explicitDatabaseUrl = environment.DATABASE_URL;
    if (explicitDatabaseUrl) return explicitDatabaseUrl;

    const hasAllComponents = POSTGRES_COMPONENT_KEYS.every(
        (key) => environment[key],
    );
    if (!hasAllComponents) return explicitDatabaseUrl;

    const user = encodeURIComponent(environment.POSTGRES_USER);
    const password = encodeURIComponent(environment.POSTGRES_PASSWORD);
    return (
        `postgresql://${user}:${password}@${environment.POSTGRES_HOST}:` +
        `${environment.POSTGRES_PORT}/${environment.POSTGRES_DB}`
    );
}

module.exports = { resolveDatabaseUrl };
