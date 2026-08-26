import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
    analyzeEnvDocs,
    collectEnvReads,
    findEnvDocGaps,
    formatEnvDocsReport,
} from "../check-env-docs.mjs";

function writeFixture(root, relativePath, source) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
}

function createFixture(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "env-docs-"));
    fs.mkdirSync(path.join(root, "backend/src"), { recursive: true });
    fs.mkdirSync(path.join(root, "services"), { recursive: true });
    for (const [relativePath, source] of Object.entries(files)) {
        writeFixture(root, relativePath, source);
    }
    return root;
}

test("collects static production env reads and excludes tests, writes, and runtime names", () => {
    const root = createFixture({
        "backend/src/config.ts": [
            "const alpha = process.env.ALPHA_TOKEN;",
            "const lower = process.env.npm_package_version;",
            "const runtime = process.env.NODE_ENV;",
            "const injected = process.env.KUBERNETES_SERVICE_HOST;",
        ].join("\n"),
        "backend/src/config.test.ts": "process.env.TEST_ONLY;",
        "backend/src/__tests__/fixture.ts": "process.env.TEST_ONLY;",
        "backend/src/tests-integration/fixture.ts":
            "process.env.INTEGRATION_ONLY;",
        "services/example/app.py": [
            'first = os.environ["PYTHON_TOKEN"]',
            "second = os.environ.get('PYTHON_OPTION')",
            'third = os.getenv("PYTHON_FALLBACK")',
            'duplicate = os.getenv("ALPHA_TOKEN")',
            'os.environ["WRITE_ONLY"] = "value"',
            "dynamic = os.getenv(name)",
        ].join("\n"),
        "services/example/tests/test_app.py": "os.getenv('TEST_ONLY')",
    });

    try {
        assert.deepEqual(collectEnvReads(root), {
            ALPHA_TOKEN: [
                "backend/src/config.ts:1",
                "services/example/app.py:4",
            ],
            PYTHON_FALLBACK: ["services/example/app.py:3"],
            PYTHON_OPTION: ["services/example/app.py:2"],
            PYTHON_TOKEN: ["services/example/app.py:1"],
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("reports the exact documentation and deployment surfaces missing per variable", () => {
    const root = createFixture({
        ".env.example": "DEPLOYED_ONLY=\nBOTH_PRESENT=\n",
        "backend/src/config.ts": [
            "process.env.DOCS_ONLY;",
            "process.env.DEPLOYED_ONLY;",
            "process.env.BOTH_MISSING;",
            "process.env.BOTH_PRESENT;",
        ].join("\n"),
        "docker-compose.aio.yml": "environment: {}\n",
        "docker-compose.yml": "environment: {}\n",
        "docs/ENVIRONMENT_VARIABLES.md": "`DOCS_ONLY`\n`BOTH_PRESENT`\n",
    });

    try {
        assert.deepEqual(findEnvDocGaps(root), [
            {
                locations: ["backend/src/config.ts:3"],
                missingSurfaces: [
                    "docs/ENVIRONMENT_VARIABLES.md",
                    "docker-compose.yml, docker-compose.aio.yml, or .env.example",
                ],
                name: "BOTH_MISSING",
            },
            {
                locations: ["backend/src/config.ts:2"],
                missingSurfaces: ["docs/ENVIRONMENT_VARIABLES.md"],
                name: "DEPLOYED_ONLY",
            },
            {
                locations: ["backend/src/config.ts:1"],
                missingSurfaces: [
                    "docker-compose.yml, docker-compose.aio.yml, or .env.example",
                ],
                name: "DOCS_ONLY",
            },
        ]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("rejects new gaps and identifies fixed baseline entries", () => {
    const gaps = [
        {
            locations: ["backend/src/config.ts:7"],
            missingSurfaces: ["docs/ENVIRONMENT_VARIABLES.md"],
            name: "KNOWN_GAP",
        },
        {
            locations: ["services/example/app.py:9"],
            missingSurfaces: [
                "docker-compose.yml, docker-compose.aio.yml, or .env.example",
            ],
            name: "NEW_GAP",
        },
    ];

    assert.deepEqual(analyzeEnvDocs(gaps, ["FIXED_GAP", "KNOWN_GAP"]), {
        currentGaps: gaps,
        newGaps: [gaps[1]],
        ok: false,
        tightenable: ["FIXED_GAP"],
    });
});

test("formats an actionable failure and the ratchet-tightening convention", () => {
    const result = analyzeEnvDocs(
        [
            {
                locations: ["backend/src/config.ts:7"],
                missingSurfaces: ["docs/ENVIRONMENT_VARIABLES.md"],
                name: "NEW_GAP",
            },
        ],
        ["FIXED_GAP"],
    );

    assert.deepEqual(formatEnvDocsReport(result, 4, 1), {
        stderr: [
            "Environment-variable documentation guardrail failed:",
            "NEW_GAP: read at backend/src/config.ts:7; missing docs/ENVIRONMENT_VARIABLES.md",
        ],
        stdout: [
            "Baseline can be tightened:",
            "FIXED_GAP: no longer has an environment-documentation gap; can be removed from baseline",
        ],
    });
});
