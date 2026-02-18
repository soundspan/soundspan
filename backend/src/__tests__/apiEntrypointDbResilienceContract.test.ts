import fs from "fs";
import path from "path";

describe("api entrypoint db resilience contract", () => {
    const entrypointPath = path.resolve(
        __dirname,
        "../../docker-entrypoint.sh"
    );
    const entrypointSource = fs.readFileSync(entrypointPath, "utf8");

    it("supports bounded Prisma migrate retry under transient database saturation", () => {
        expect(entrypointSource).toContain("PRISMA_MIGRATE_MAX_ATTEMPTS");
        expect(entrypointSource).toContain("PRISMA_MIGRATE_RETRY_DELAY_SECONDS");
        expect(entrypointSource).toContain("too many clients already");
        expect(entrypointSource).toContain("npx prisma migrate deploy");
    });

    it("allows operators to disable startup migration/generate hooks explicitly", () => {
        expect(entrypointSource).toContain("RUN_DB_MIGRATIONS_ON_STARTUP");
        expect(entrypointSource).toContain("PRISMA_GENERATE_ON_STARTUP");
    });
});
