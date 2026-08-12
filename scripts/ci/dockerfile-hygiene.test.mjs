import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const dockerfilePaths = [
    "Dockerfile",
    "backend/Dockerfile",
    "frontend/Dockerfile",
    "services/audio-analyzer/Dockerfile",
    "services/tidal-downloader/Dockerfile",
    "services/ytmusic-streamer/Dockerfile",
    "services/audio-analyzer-clap/Dockerfile",
];

function readRepoFile(relativePath) {
    return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function fromImageReferences(dockerfile) {
    const references = [];
    for (const line of dockerfile.split(/\r?\n/)) {
        const match = line.match(/^\s*FROM\s+(\S+)/i);
        if (match) {
            references.push(match[1]);
        }
    }
    return references;
}

function isExternalImage(reference) {
    return /[:@/]/.test(reference);
}

function composeConfig(postgresPassword) {
    const environment = {
        ...process.env,
        INTERNAL_API_SECRET: "test-internal-secret",
        SESSION_SECRET: "test-session-secret",
        SETTINGS_ENCRYPTION_KEY: "test-settings-key",
    };
    if (postgresPassword === undefined) {
        delete environment.POSTGRES_PASSWORD;
    } else {
        environment.POSTGRES_PASSWORD = postgresPassword;
    }

    return childProcess.spawnSync(
        "docker",
        [
            "compose",
            "--env-file",
            os.devNull,
            "--profile",
            "*",
            "-f",
            path.join(repoRoot, "docker-compose.yml"),
            "config",
            "--format",
            "json",
        ],
        { cwd: repoRoot, encoding: "utf8", env: environment },
    );
}

function runPostgresEntrypoint(postgres, postgresPassword, executablePath) {
    const entrypoint = postgres.entrypoint.map((argument) =>
        argument.replaceAll("$$", "$"),
    );
    return childProcess.spawnSync(
        entrypoint[0],
        [...entrypoint.slice(1), ...(postgres.command ?? ["postgres"])],
        {
            encoding: "utf8",
            env: {
                ...process.env,
                PATH: `${executablePath}${path.delimiter}${process.env.PATH}`,
                POSTGRES_PASSWORD: postgresPassword,
            },
        },
    );
}

function createEntrypointFixture(t) {
    const fixtureDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), "soundspan-compose-entrypoint-"),
    );
    t.after(() =>
        fs.rmSync(fixtureDirectory, { recursive: true, force: true }),
    );
    fs.writeFileSync(
        path.join(fixtureDirectory, "docker-entrypoint.sh"),
        "#!/bin/sh\nexit 0\n",
        { mode: 0o700 },
    );
    return fixtureDirectory;
}

test("1. Dockerfile external base images are pinned by digest", () => {
    for (const relativePath of dockerfilePaths) {
        const references = fromImageReferences(readRepoFile(relativePath));
        for (const reference of references.filter(isExternalImage)) {
            assert.ok(
                reference.includes("@sha256:"),
                `${relativePath}: external FROM image ${reference} must contain @sha256:`,
            );
        }
    }
});

test("2. backend api-runtime uses compiled output without raw TypeScript", () => {
    const relativePath = "backend/Dockerfile";
    const dockerfile = readRepoFile(relativePath);
    const stages = dockerfile.split(/(?=^FROM )/gim);
    const apiRuntime = stages.find((stage) =>
        /^FROM .*\bAS\s+api-runtime\b/im.test(stage),
    );

    assert.ok(apiRuntime, `${relativePath}: api-runtime stage must exist`);
    assert.doesNotMatch(
        apiRuntime,
        /tsx/i,
        `${relativePath}: api-runtime stage must not contain tsx`,
    );
    assert.match(
        apiRuntime,
        /dist\/index\.js/,
        `${relativePath}: api-runtime stage must run dist/index.js`,
    );
    assert.doesNotMatch(
        apiRuntime,
        /COPY\s+src\s+\.\/src/,
        `${relativePath}: api-runtime stage must not copy raw TypeScript source`,
    );
});

test("3. frontend runtime uses the base node image UID 1000 user", () => {
    const relativePath = "frontend/Dockerfile";
    const dockerfile = readRepoFile(relativePath);

    assert.ok(
        !dockerfile.includes("1001"),
        `${relativePath}: must not contain UID or GID 1001`,
    );
    assert.match(
        dockerfile,
        /^\s*USER\s+node\s*$/im,
        `${relativePath}: runtime must end as USER node`,
    );
});

test("4. ytmusic-streamer has no world-writable token directory", () => {
    const relativePath = "services/ytmusic-streamer/Dockerfile";
    const dockerfile = readRepoFile(relativePath);

    assert.ok(
        !dockerfile.includes("chmod 777"),
        `${relativePath}: must not contain chmod 777`,
    );
});

test("5. docker-compose.yml infra images are pinned by digest", () => {
    const relativePath = "docker-compose.yml";
    const lines = readRepoFile(relativePath).split(/\r?\n/);
    const postgresLine = lines.find((line) =>
        /image:\s*pgvector\/pgvector/.test(line),
    );
    const redisLine = lines.find((line) => /image:\s*redis:/.test(line));

    assert.ok(
        postgresLine?.includes("@sha256:"),
        `${relativePath}: pgvector image must contain @sha256:`,
    );
    assert.ok(
        redisLine?.includes("@sha256:"),
        `${relativePath}: redis image must contain @sha256:`,
    );
});

test("6. docker-bake.json inline infra images are pinned by digest", () => {
    const relativePath = "docker-bake.json";
    const inlineInfraLines = readRepoFile(relativePath)
        .split(/\r?\n/)
        .filter(
            (line) =>
                line.includes('"dockerfile-inline"') &&
                /pgvector\/pgvector|redis:/.test(line),
        );

    for (const line of inlineInfraLines) {
        assert.ok(
            line.includes("@sha256:"),
            `${relativePath}: inline infra FROM must contain @sha256: (${line.trim()})`,
        );
    }
});

test("7. split-stack compose refuses a missing or empty PostgreSQL password", () => {
    const missingResult = composeConfig(undefined);
    const emptyResult = composeConfig("");

    assert.notEqual(missingResult.status, 0);
    assert.match(missingResult.stderr, /POSTGRES_PASSWORD is required/);
    assert.notEqual(emptyResult.status, 0);
    assert.match(emptyResult.stderr, /POSTGRES_PASSWORD is required/);
});

test("8. split-stack compose applies the configured PostgreSQL password everywhere", () => {
    const password = "test-explicit-postgres-password";
    const result = composeConfig(password);

    assert.equal(result.status, 0, result.stderr);
    const services = JSON.parse(result.stdout).services;
    const databaseUrl = `postgresql://soundspan:${password}@postgres:5432/soundspan`;

    assert.equal(services.backend.environment.POSTGRES_PASSWORD, password);
    assert.equal(services.backend.environment.DATABASE_URL, databaseUrl);
    assert.equal(
        services["backend-worker"].environment.POSTGRES_PASSWORD,
        password,
    );
    assert.equal(
        services["backend-worker"].environment.DATABASE_URL,
        databaseUrl,
    );
    assert.equal(services.postgres.environment.POSTGRES_PASSWORD, password);
    assert.equal(
        services["audio-analyzer"].environment.DATABASE_URL,
        databaseUrl,
    );
    assert.equal(
        services["audio-analyzer-clap"].environment.DATABASE_URL,
        databaseUrl,
    );
});

test("9. split-stack PostgreSQL startup rejects the published sentinel", (t) => {
    const configResult = composeConfig("changeme");
    assert.equal(configResult.status, 0, configResult.stderr);

    const fixtureDirectory = createEntrypointFixture(t);
    const postgres = JSON.parse(configResult.stdout).services.postgres;
    const sentinelResult = runPostgresEntrypoint(
        postgres,
        "changeme",
        fixtureDirectory,
    );
    const configuredResult = runPostgresEntrypoint(
        postgres,
        "test-explicit-postgres-password",
        fixtureDirectory,
    );

    assert.notEqual(sentinelResult.status, 0);
    assert.match(sentinelResult.stderr, /must not be changeme/);
    assert.equal(configuredResult.status, 0, configuredResult.stderr);
});
