import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
