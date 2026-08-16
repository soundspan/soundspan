import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
    analyzeFileSizes,
    collectFileSizes,
    formatFileSizeReport,
} from "../check-file-size.mjs";

const SCANNED_FIXTURE_FILES = Object.freeze([
    "backend/src/main.ts",
    "frontend/app/globals.css",
    "frontend/app/page.tsx",
    "frontend/components/Button.jsx",
    "frontend/features/player/index.ts",
    "frontend/hooks/usePlayer.js",
    "frontend/lib/player.mjs",
    "packages/example/src/index.ts",
    "services/example/app.py",
]);
const EXCLUDED_FIXTURE_FILES = Object.freeze([
    "backend/src/.prisma/client.ts",
    "backend/src/__tests__/main.ts",
    "backend/src/generated/client.ts",
    "backend/src/main.spec.ts",
    "backend/src/main.test.ts",
    "frontend/app/.next/bundle.js",
    "frontend/components/README.md",
    "frontend/components/node_modules/example/index.js",
    "frontend/features/dist/bundle.js",
    "packages/example/src/client.generated.ts",
    "services/__pycache__/module.py",
    "services/conftest.py",
    "services/example/app_test.py",
    "services/example/test_app.py",
    "services/example/tests/test_app.py",
]);

function writeFixtureFiles(fixtureRoot, relativePaths) {
    for (const relativePath of relativePaths) {
        const filePath = path.join(fixtureRoot, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, "source");
    }
}

test("accepts source files at or below the ratchet cap", () => {
    assert.deepEqual(analyzeFileSizes({ "source.ts": 1_500 }, {}), {
        ok: true,
        violations: [],
        tightenable: [],
    });
});

test("rejects a new source file over the ratchet cap", () => {
    assert.deepEqual(analyzeFileSizes({ "new-source.ts": 1_501 }, {}), {
        ok: false,
        violations: [
            {
                baseline: 1_500,
                count: 1_501,
                file: "new-source.ts",
                kind: "ratchet-cap",
            },
        ],
        tightenable: [],
    });
});

test("rejects growth above a file's frozen baseline", () => {
    assert.deepEqual(
        analyzeFileSizes(
            { "large-source.ts": 2_001 },
            {
                "large-source.ts": 2_000,
            },
        ),
        {
            ok: false,
            violations: [
                {
                    baseline: 2_000,
                    count: 2_001,
                    file: "large-source.ts",
                    kind: "baseline",
                },
            ],
            tightenable: [],
        },
    );
});

test("reports when a baseline entry can be removed", () => {
    const result = analyzeFileSizes(
        { "split-source.ts": 1_499 },
        { "split-source.ts": 2_000 },
    );

    assert.deepEqual(result, {
        ok: true,
        violations: [],
        tightenable: [
            {
                baseline: 2_000,
                count: 1_499,
                file: "split-source.ts",
                remove: true,
            },
        ],
    });
    assert.match(
        formatFileSizeReport(result, 1, 1).stdout.join("\n"),
        /split-source\.ts: 1499 lines is at or below ratchet cap 1500; can be removed from baseline/,
    );
});

test("enforces the hard cap regardless of a frozen baseline", () => {
    assert.deepEqual(
        analyzeFileSizes({ "oversized.ts": 3_001 }, { "oversized.ts": 3_500 }),
        {
            ok: false,
            violations: [
                {
                    cap: 3_000,
                    count: 3_001,
                    file: "oversized.ts",
                    kind: "hard-cap",
                },
            ],
            tightenable: [],
        },
    );
});

test("scans production source roots and excludes tests and generated files", () => {
    const fixtureRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "file-size-roots-"),
    );

    try {
        writeFixtureFiles(fixtureRoot, [
            ...SCANNED_FIXTURE_FILES,
            ...EXCLUDED_FIXTURE_FILES,
        ]);
        fs.mkdirSync(path.join(fixtureRoot, "frontend/hooks"), {
            recursive: true,
        });
        fs.mkdirSync(path.join(fixtureRoot, "frontend/lib"), {
            recursive: true,
        });

        assert.deepEqual(
            collectFileSizes(fixtureRoot),
            Object.fromEntries(SCANNED_FIXTURE_FILES.map((file) => [file, 1])),
        );
    } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
});
