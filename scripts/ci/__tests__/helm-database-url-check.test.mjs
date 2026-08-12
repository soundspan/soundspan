import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const checker = path.join(repoRoot, "scripts/ci/helm-database-url-check.mjs");
const MAX_SCRIPT_LINES = 32;
const postgresEnv = {
    POSTGRES_DB: "soundspan",
    POSTGRES_PASSWORD: "p@ss:w/rd",
    POSTGRES_USER: "user@tenant",
};

function deployment(name, startupScript) {
    const lines = startupScript.split("\n");
    assert.ok(lines.length <= MAX_SCRIPT_LINES);
    const indentedLines = [];
    for (let index = 0; index < MAX_SCRIPT_LINES; index += 1) {
        if (index >= lines.length) break;
        indentedLines.push(`              ${lines[index]}`);
    }
    const indentedScript = indentedLines.join("\n");
    return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
spec:
  template:
    spec:
      containers:
        - name: ${name}
          command:
            - /bin/sh
            - -c
          args:
            - |-
${indentedScript}
            - soundspan-database-url
            - node
            - -e
            - process.stdout.write(process.env.DATABASE_URL)
          env:
            - name: POSTGRES_USER
              valueFrom:
                secretKeyRef:
                  name: soundspan
                  key: POSTGRES_USER
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: soundspan
                  key: POSTGRES_PASSWORD
            - name: POSTGRES_DB
              valueFrom:
                secretKeyRef:
                  name: soundspan
                  key: POSTGRES_DB
            - name: SOUNDSPAN_DATABASE_HOST
              value: "soundspan-postgresql"
            - name: SOUNDSPAN_DATABASE_PORT
              value: "5432"
`;
}

function writeManifest(t, contents) {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "soundspan-helm-database-url-test-"),
    );
    t.after(() => fs.rmSync(directory, { recursive: true }));
    const manifest = path.join(directory, "manifest.yaml");
    fs.writeFileSync(manifest, contents);
    return manifest;
}

function runChecker(args, env = {}) {
    return spawnSync(process.execPath, [checker, ...args], {
        encoding: "utf8",
        env: { ...process.env, ...env },
    });
}

test("component mode executes rendered Node and Python URL builders", (t) => {
    const nodeScript = `# soundspan-database-url-start
export DATABASE_URL="$(node -e 'const env = process.env; process.stdout.write("postgresql://" + encodeURIComponent(env.POSTGRES_USER) + ":" + encodeURIComponent(env.POSTGRES_PASSWORD) + "@" + env.SOUNDSPAN_DATABASE_HOST + ":" + env.SOUNDSPAN_DATABASE_PORT + "/" + env.POSTGRES_DB)')"
# soundspan-database-url-end
exec "$@"`;
    const pythonScript = `# soundspan-database-url-start
export DATABASE_URL="$(python3 -c 'import os; from urllib.parse import quote; env = os.environ; print("postgresql://{}:{}@{}:{}/{}".format(quote(env["POSTGRES_USER"], safe=""), quote(env["POSTGRES_PASSWORD"], safe=""), env["SOUNDSPAN_DATABASE_HOST"], env["SOUNDSPAN_DATABASE_PORT"], env["POSTGRES_DB"]), end="")')"
# soundspan-database-url-end
exec "$@"`;
    const manifest = writeManifest(
        t,
        `${deployment("soundspan-backend", nodeScript)}---\n${deployment("soundspan-audio-analyzer", pythonScript)}`,
    );

    const result = runChecker(
        [
            "component",
            manifest,
            "soundspan-backend",
            "soundspan-audio-analyzer",
        ],
        postgresEnv,
    );

    assert.equal(result.status, 0, result.stderr);
});

test("component mode rejects a rendered builder that leaves reserved characters raw", (t) => {
    const unsafeScript = `# soundspan-database-url-start
export DATABASE_URL="postgresql://\${POSTGRES_USER}:\${POSTGRES_PASSWORD}@\${SOUNDSPAN_DATABASE_HOST}:\${SOUNDSPAN_DATABASE_PORT}/\${POSTGRES_DB}"
# soundspan-database-url-end
exec "$@"`;
    const manifest = writeManifest(
        t,
        deployment("soundspan-backend", unsafeScript),
    );

    const result = runChecker(
        ["component", manifest, "soundspan-backend"],
        postgresEnv,
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /percent-encoded DATABASE_URL/);
});

test("external mode requires the supplied DATABASE_URL verbatim", (t) => {
    const externalUrl =
        "postgresql://external-user:literal%2Fpass@database.example.com:5432/soundspan?sslmode=require";
    const manifest = writeManifest(
        t,
        `apiVersion: apps/v1
kind: Deployment
metadata:
  name: soundspan-backend
spec:
  template:
    spec:
      containers:
        - name: backend
          env:
            - name: DATABASE_URL
              value: "${externalUrl}"
`,
    );

    const result = runChecker(["external", manifest, "soundspan-backend"], {
        EXPECTED_DATABASE_URL: externalUrl,
    });

    assert.equal(result.status, 0, result.stderr);
});

test("external mode rejects a rendered startup builder", (t) => {
    const externalUrl =
        "postgresql://external-user:literal%2Fpass@database.example.com:5432/soundspan";
    const rebuiltScript = `# soundspan-database-url-start
export DATABASE_URL="postgresql://rebuilt.invalid/soundspan"
# soundspan-database-url-end
exec "$@"`;
    const manifest = writeManifest(
        t,
        deployment("soundspan-backend", rebuiltScript),
    );

    const result = runChecker(["external", manifest, "soundspan-backend"], {
        EXPECTED_DATABASE_URL: externalUrl,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /rebuilt the external DATABASE_URL/);
});
