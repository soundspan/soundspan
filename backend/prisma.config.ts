import { defineConfig, env } from "prisma/config";

const { resolveDatabaseUrl } = require("./databaseUrl") as {
    resolveDatabaseUrl: (environment: NodeJS.ProcessEnv) => string | undefined;
};

// Prisma 7 moved datasource connection URLs out of schema.prisma.
// This config is used by the Prisma CLI (generate/validate/migrate/studio);
// the runtime client gets its connection via the pg driver adapter in
// src/utils/db.ts. See https://pris.ly/d/config-datasource
// env() throws at config load when the variable is unset. `prisma generate`
// runs during Docker builds with no database available, so only wire the
// datasource when an explicit URL or a complete component set resolves;
// commands that need a database still fail fast when neither is available.
const databaseUrl = resolveDatabaseUrl(process.env);
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const datasource = databaseUrl ? { url: env("DATABASE_URL") } : undefined;

export default defineConfig({
    schema: "prisma/schema.prisma",
    migrations: {
        path: "prisma/migrations",
    },
    ...(datasource ? { datasource } : {}),
});
