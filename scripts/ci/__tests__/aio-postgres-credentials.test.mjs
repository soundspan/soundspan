import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const credentialHelper = path.join(
    repoRoot,
    "scripts/aio-postgres-credentials.sh",
);

test("AIO DATABASE_URL preserves reserved PostgreSQL password characters", () => {
    const password = "quote' slash/ query? hash# percent% at@ colon: space ";
    const databaseUrl = execFileSync(credentialHelper, ["database-url"], {
        encoding: "utf8",
        env: { ...process.env, POSTGRES_PASSWORD: password },
    });

    const parsed = new URL(databaseUrl);
    assert.equal(parsed.protocol, "postgresql:");
    assert.equal(parsed.username, "soundspan");
    assert.equal(decodeURIComponent(parsed.password), password);
    assert.equal(parsed.hostname, "localhost");
    assert.equal(parsed.port, "5432");
    assert.equal(parsed.pathname, "/soundspan");
});

test("AIO role synchronization keeps the password out of SQL and argv", (t) => {
    const temporaryDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), "soundspan-aio-postgres-test-"),
    );
    t.after(() => fs.rmSync(temporaryDirectory, { recursive: true }));

    const invocationLog = path.join(temporaryDirectory, "invocations.log");
    const stdinLog = path.join(temporaryDirectory, "stdin.log");
    const fakeGosu = path.join(temporaryDirectory, "gosu");
    fs.writeFileSync(
        fakeGosu,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$INVOCATION_LOG"
if [[ "$*" == *"SELECT 1 FROM pg_roles"* ]]; then
    exit 0
fi
cat >> "$STDIN_LOG"
`,
        { mode: 0o700 },
    );

    const password =
        "x'; SELECT pg_sleep(99); -- $() `command` \\ newline\nend";
    const result = spawnSync(credentialHelper, ["sync-role"], {
        encoding: "utf8",
        env: {
            ...process.env,
            INVOCATION_LOG: invocationLog,
            PATH: `${temporaryDirectory}:${process.env.PATH}`,
            POSTGRES_PASSWORD: password,
            STDIN_LOG: stdinLog,
        },
    });

    assert.equal(result.status, 0, result.stderr);
    const invocations = fs.readFileSync(invocationLog, "utf8");
    const sql = fs.readFileSync(stdinLog, "utf8");
    assert.doesNotMatch(invocations, /pg_sleep|command|newline/);
    assert.doesNotMatch(sql, /pg_sleep|command|newline/);
    assert.match(sql, /\\getenv postgres_password POSTGRES_PASSWORD/);
    assert.match(sql, /PASSWORD :'postgres_password'/);
});

test("AIO credential operations fail closed without a password", () => {
    const operations = ["database-url", "sync-role"];
    for (let index = 0; index < 2; index += 1) {
        const operation = operations[index];
        const result = spawnSync(credentialHelper, [operation], {
            encoding: "utf8",
            env: { ...process.env, POSTGRES_PASSWORD: "" },
        });

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /POSTGRES_PASSWORD must not be empty/);
    }
});
