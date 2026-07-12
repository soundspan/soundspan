import { defineConfig, env } from "prisma/config";

// Prisma 7 moved datasource connection URLs out of schema.prisma.
// This config is used by the Prisma CLI (generate/validate/migrate/studio);
// the runtime client gets its connection via the pg driver adapter in
// src/utils/db.ts. See https://pris.ly/d/config-datasource
// env() throws at config load when the variable is unset. `prisma generate`
// runs during Docker builds with no database available, so only wire the
// datasource when DATABASE_URL is present; commands that actually need a
// database (migrate/studio) fail fast with a missing-datasource error instead.
const datasource =
    process.env.DATABASE_URL ? { url: env("DATABASE_URL") } : undefined;

export default defineConfig({
    schema: "prisma/schema.prisma",
    migrations: {
        path: "prisma/migrations",
    },
    ...(datasource ? { datasource } : {}),
});
