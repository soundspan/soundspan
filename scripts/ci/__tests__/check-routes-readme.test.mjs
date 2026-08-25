import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { findMissingRouteModules } from "../check-routes-readme.mjs";

test("reports undocumented production route modules", () => {
    const fixtureRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "routes-readme-"),
    );
    const routesDirectory = path.join(fixtureRoot, "backend/src/routes");

    try {
        fs.mkdirSync(path.join(routesDirectory, "nested", "__tests__"), {
            recursive: true,
        });
        fs.writeFileSync(path.join(routesDirectory, "documented.ts"), "");
        fs.writeFileSync(path.join(routesDirectory, "missing.ts"), "");
        fs.writeFileSync(path.join(routesDirectory, "ignored.test.ts"), "");
        fs.writeFileSync(
            path.join(routesDirectory, "nested", "__tests__", "ignored.ts"),
            "",
        );
        fs.writeFileSync(
            path.join(routesDirectory, "README.md"),
            "`backend/src/routes/documented.ts`\n",
        );

        assert.deepEqual(findMissingRouteModules(fixtureRoot), [
            "backend/src/routes/missing.ts",
        ]);
    } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
});
