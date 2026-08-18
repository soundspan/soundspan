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
    "services/vibe-provider-dclap/Dockerfile",
];

const serviceDockerfilePaths = [
    "Dockerfile",
    ...fs
        .readdirSync(path.join(repoRoot, "services"), { withFileTypes: true })
        .filter(
            (entry) =>
                entry.isDirectory() &&
                fs.existsSync(
                    path.join(repoRoot, "services", entry.name, "Dockerfile"),
                ),
        )
        .map((entry) => `services/${entry.name}/Dockerfile`)
        .sort(),
];

// Keys use "Dockerfile path:Python source path". Add only documented cases
// where a top-level sidecar module must intentionally remain outside an image.
const pythonSidecarCopyExclusions = new Set();

const chartComponentDockerfiles = new Map([
    ["aio", "Dockerfile"],
    ["backend", "backend/Dockerfile"],
    ["backendWorker", "backend/Dockerfile"],
    ["frontend", "frontend/Dockerfile"],
    ["tidalSidecar", "services/tidal-downloader/Dockerfile"],
    ["ytmusicStreamer", "services/ytmusic-streamer/Dockerfile"],
    ["audioAnalyzer", "services/audio-analyzer/Dockerfile"],
]);

const binaryPackageProviders = new Map([["pgrep", "procps"]]);

// These assumptions are deliberately narrow. The chart's repo-built Python and
// Node images use the official Debian slim families, which provide /bin/sh and
// their named language executables. Add a binary only when the base contract is
// documented; distro utilities such as pgrep must be installed explicitly.
const baseImageFamilyBinaries = [
    {
        pattern: /^python:[^@]+-slim@sha256:/,
        binaries: new Set(["python", "python3", "sh"]),
    },
    {
        pattern: /^node:[^@]+-slim@sha256:/,
        binaries: new Set(["node", "sh"]),
    },
];

const probeNames = ["livenessProbe", "readinessProbe"];

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

function relativeImportFiles(configPath) {
    const config = readRepoFile(configPath);
    const configDirectory = path.posix.dirname(configPath);
    const importPattern =
        /(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)["'](\.[^"']+)["']/g;
    const imports = [...config.matchAll(importPattern)].map(
        (match) => match[1],
    );

    return imports.map((importPath) => {
        const unresolvedPath = path.posix.join(configDirectory, importPath);
        const candidates = [
            unresolvedPath,
            `${unresolvedPath}.js`,
            `${unresolvedPath}.ts`,
        ];
        const resolvedPath = candidates.find((candidate) =>
            fs.existsSync(path.join(repoRoot, candidate)),
        );
        assert.ok(resolvedPath, `${configPath}: cannot resolve ${importPath}`);
        return resolvedPath;
    });
}

function dockerfileStages(dockerfile) {
    return dockerfile
        .split(/(?=^FROM )/gim)
        .filter((stage) => /^FROM /i.test(stage))
        .map((text, index) => {
            const header = text.split(/\r?\n/, 1)[0];
            const match = header.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i);
            assert.ok(match, `invalid Dockerfile stage header: ${header}`);
            return {
                base: match[1],
                name: match[2] ?? `stage-${index + 1}`,
                text,
            };
        });
}

function execProbeReference(component, probeName) {
    const probe = component.text.match(
        new RegExp(
            `^  ${probeName}:\\s*$([\\s\\S]*?)(?=^  [A-Za-z][A-Za-z0-9]*:|(?![\\s\\S]))`,
            "m",
        ),
    )?.[1];
    if (!probe || !/^    exec:\s*$/m.test(probe)) return [];

    const command = probe.match(
        /^\s{6}command:\s*\[\s*(?:"([^"]+)"|'([^']+)'|([^,\]\s]+))/m,
    );
    assert.ok(
        command,
        `charts/soundspan/values.yaml: ${component.name}.${probeName} exec command must use an inline argv array`,
    );
    return [
        {
            component: component.name,
            probeName,
            binary: path.posix.basename(command[1] ?? command[2] ?? command[3]),
        },
    ];
}

function execProbeReferences(values) {
    return values
        .split(/(?=^[A-Za-z][A-Za-z0-9]*:\s*$)/gm)
        .map((text) => ({
            name: text.match(/^([A-Za-z][A-Za-z0-9]*):\s*$/m)?.[1],
            text,
        }))
        .filter(
            (component) =>
                component.name && /^  image:\s*$/m.test(component.text),
        )
        .flatMap((component) =>
            probeNames.flatMap((probeName) =>
                execProbeReference(component, probeName),
            ),
        );
}

function dockerfileInstallsPackage(dockerfile, packageName) {
    // Intentional string heuristic: the provider name must occur in the same
    // RUN instruction as a recognized system package-manager install command.
    const packagePattern = new RegExp(
        `(?:^|\\s)${packageName.replaceAll("-", "\\-")}(?:[=\\s\\\\]|$)`,
    );
    return dockerfile
        .split(/(?=^[A-Z][A-Z0-9]*\s)/gm)
        .some(
            (instruction) =>
                /^RUN\s/i.test(instruction) &&
                /\b(?:apt-get\s+install|apk\s+add|dnf\s+install|yum\s+install)\b/i.test(
                    instruction,
                ) &&
                packagePattern.test(instruction),
        );
}

function dockerfileProvesBinary(relativePath, binary) {
    const dockerfile = readRepoFile(relativePath);
    const baseImages = fromImageReferences(dockerfile);

    // Fail closed on multi-stage files. Searching every stage could mistake a
    // build-only package for a runtime binary; add explicit stage handling when
    // a multi-stage chart image gains an exec probe.
    assert.equal(
        baseImages.length,
        1,
        `${relativePath}: exec-probe guard requires explicit runtime-stage handling`,
    );
    const packageName = binaryPackageProviders.get(binary);
    if (packageName && dockerfileInstallsPackage(dockerfile, packageName)) {
        return true;
    }

    return baseImageFamilyBinaries.some(
        (family) =>
            family.pattern.test(baseImages[0]) && family.binaries.has(binary),
    );
}

function componentDockerfile(componentName) {
    const relativePath = chartComponentDockerfiles.get(componentName);
    assert.ok(
        relativePath,
        `charts/soundspan/values.yaml: ${componentName} exec probes need a Dockerfile mapping`,
    );
    return relativePath;
}

function dockerCopySources(stage) {
    return stage
        .replace(/\\\r?\n\s*/g, " ")
        .split(/\r?\n/)
        .flatMap((line) => {
            const match = line.match(/^\s*COPY\s+(.+)$/i);
            if (!match) return [];
            const tokens = match[1].trim().split(/\s+/);
            const operands = tokens.filter((token) => !token.startsWith("--"));
            return operands.slice(0, -1);
        });
}

function copiedPythonSidecarDirectories(sources) {
    return [
        ...new Set(
            sources.flatMap((source) => {
                const normalizedSource = path.posix.normalize(source);
                const match = normalizedSource.match(
                    /^services\/([^/]+)\/(?:[^/]+\.py|\*\.py)$/,
                );
                return match ? [match[1]] : [];
            }),
        ),
    ].sort();
}

function topLevelPythonFiles(serviceDirectory) {
    const relativeDirectory = `services/${serviceDirectory}`;
    return fs
        .readdirSync(path.join(repoRoot, relativeDirectory), {
            withFileTypes: true,
        })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".py"))
        .map((entry) => `${relativeDirectory}/${entry.name}`)
        .sort();
}

function sourceCopiesPythonFile(source, relativePath) {
    const normalizedSource = path.posix.normalize(source);
    const normalizedPath = path.posix.normalize(relativePath);
    return (
        normalizedSource === normalizedPath ||
        normalizedSource === `${path.posix.dirname(normalizedPath)}/*.py`
    );
}

function sourceCopiesFile(source, relativePath) {
    const normalizedSource = path.posix.normalize(source.replaceAll('"', ""));
    const normalizedPath = path.posix.normalize(relativePath);
    return (
        path.posix.basename(normalizedSource) ===
            path.posix.basename(normalizedPath) ||
        normalizedSource === "." ||
        normalizedPath.startsWith(`${normalizedSource}/`)
    );
}

function stageRunsPrisma(stage) {
    const commands = stage
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
    return /\bnpx\s+prisma\s+(?:generate|migrate)\b/i.test(commands);
}

function effectiveStageCopies(stages) {
    const copiesByStage = new Map();
    return stages.map((stage) => {
        const inheritedCopies = copiesByStage.get(stage.base) ?? [];
        const copies = [...inheritedCopies, ...dockerCopySources(stage.text)];
        copiesByStage.set(stage.name, copies);
        return { ...stage, copies };
    });
}

function composeConfig(
    postgresPassword,
    profiles = ["*"],
    environmentOverrides = {},
) {
    const environment = {
        ...process.env,
        INTERNAL_API_SECRET: "test-internal-secret",
        SESSION_SECRET: "test-session-secret",
        SETTINGS_ENCRYPTION_KEY: "test-settings-key",
        ...environmentOverrides,
    };
    delete environment.DATABASE_URL;
    if (postgresPassword === undefined) {
        delete environment.POSTGRES_PASSWORD;
    } else {
        environment.POSTGRES_PASSWORD = postgresPassword;
    }

    const profileArgs = profiles.flatMap((profile) => ["--profile", profile]);
    const args = [
        "compose",
        "--env-file",
        os.devNull,
        ...profileArgs,
        "-f",
        path.join(repoRoot, "docker-compose.yml"),
        "config",
        "--format",
        "json",
    ];

    return childProcess.spawnSync("docker", args, {
        cwd: repoRoot,
        encoding: "utf8",
        env: environment,
    });
}

function composeServiceBlock(compose, serviceName) {
    const lines = compose.split(/\r?\n/);
    const startIndex = lines.findIndex(
        (line) => line.trimStart() === `${serviceName}:`,
    );
    assert.notEqual(
        startIndex,
        -1,
        `docker-compose.yml: ${serviceName} service must exist`,
    );

    const indentation = lines[startIndex].match(/^\s*/)[0];
    const endOffset = lines
        .slice(startIndex + 1)
        .findIndex(
            (line) =>
                line.startsWith(indentation) &&
                /^[A-Za-z0-9_-]+:\s*$/.test(line.slice(indentation.length)),
        );
    const endIndex =
        endOffset === -1 ? lines.length : startIndex + endOffset + 1;
    return lines.slice(startIndex, endIndex).join("\n");
}

function requiredSecretSubstitution(serviceBlock, serviceName, secretName) {
    const pattern = new RegExp(
        `^\\s*${secretName}:\\s*"?(\\$\\{${secretName}:\\?[^}\\r\\n]*\\})"?\\s*$`,
        "m",
    );
    const match = serviceBlock.match(pattern);
    assert.ok(
        match,
        `docker-compose.yml: ${serviceName} must require ${secretName} with \${${secretName}:?...}`,
    );
    return match[1];
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

test("4a. root Docker context excludes Python bytecode caches", () => {
    const dockerignore = readRepoFile(".dockerignore");

    assert.match(
        dockerignore,
        /^\*\*\/__pycache__\s*$/m,
        ".dockerignore: host Python cache directories must not enter image contexts",
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

test("8. split-stack compose passes PostgreSQL components to database consumers", () => {
    const password = "test@:/?#% password 雪";
    const result = composeConfig(password);

    assert.equal(result.status, 0, result.stderr);
    const services = JSON.parse(result.stdout).services;
    const databaseConsumers = ["backend", "backend-worker", "audio-analyzer"];

    for (const serviceName of databaseConsumers) {
        const environment = services[serviceName].environment;
        assert.equal(environment.DATABASE_URL, "");
        assert.equal(environment.POSTGRES_HOST, "postgres");
        assert.equal(environment.POSTGRES_PORT, "5432");
        assert.equal(environment.POSTGRES_USER, "soundspan");
        assert.equal(environment.POSTGRES_PASSWORD, password);
        assert.equal(environment.POSTGRES_DB, "soundspan");
    }
    assert.equal(services.postgres.environment.POSTGRES_PASSWORD, password);
});

test("8a. split-stack compose defaults to the DCLAP vibe provider", () => {
    const defaultResult = composeConfig("test-password", []);
    const workerResult = composeConfig("test-password", ["worker"]);
    const customPortResult = composeConfig("test-password", [], {
        DCLAP_HTTP_PORT: "8192",
    });

    assert.equal(defaultResult.status, 0, defaultResult.stderr);
    assert.equal(workerResult.status, 0, workerResult.stderr);
    assert.equal(customPortResult.status, 0, customPortResult.stderr);

    const defaultServices = JSON.parse(defaultResult.stdout).services;
    const workerServices = JSON.parse(workerResult.stdout).services;
    const customPortServices = JSON.parse(customPortResult.stdout).services;
    const providerUrl = "http://vibe-provider-dclap:8092";

    assert.equal(defaultServices["audio-analyzer-clap"], undefined);
    assert.ok(defaultServices["vibe-provider-dclap"]);
    assert.equal(
        defaultServices.backend.environment.VIBE_PROVIDER_URL,
        providerUrl,
    );
    assert.equal(
        workerServices["backend-worker"].environment.VIBE_PROVIDER_URL,
        providerUrl,
    );
    assert.equal(
        customPortServices.backend.environment.VIBE_PROVIDER_URL,
        "http://vibe-provider-dclap:8192",
    );
});

test("9. compose files never interpolate PostgreSQL components into DATABASE_URL", () => {
    for (const relativePath of [
        "docker-compose.yml",
        "docker-compose.aio.yml",
    ]) {
        const compose = readRepoFile(relativePath);
        assert.doesNotMatch(
            compose,
            /^\s*-?\s*DATABASE_URL\s*[:=][^\r\n]*\$\{POSTGRES_(?:HOST|PORT|USER|PASSWORD|DB)/m,
            `${relativePath}: DATABASE_URL must not interpolate raw PostgreSQL components`,
        );
    }

    assert.match(
        readRepoFile("docker-compose.aio.yml"),
        /^\s*- POSTGRES_PASSWORD=\$\{POSTGRES_PASSWORD:-\}\s*$/m,
        "docker-compose.aio.yml: AIO must receive its separately supplied PostgreSQL password",
    );
});

test("10. split-stack worker requires its startup secrets", () => {
    const compose = readRepoFile("docker-compose.yml");
    const backendBlock = composeServiceBlock(compose, "backend");
    const workerBlock = composeServiceBlock(compose, "backend-worker");
    const requiredSecrets = [
        "SESSION_SECRET",
        "SETTINGS_ENCRYPTION_KEY",
        "INTERNAL_API_SECRET",
    ];

    for (const secret of requiredSecrets) {
        const backendSubstitution = requiredSecretSubstitution(
            backendBlock,
            "backend",
            secret,
        );
        const workerSubstitution = requiredSecretSubstitution(
            workerBlock,
            "backend-worker",
            secret,
        );
        assert.equal(
            workerSubstitution,
            backendSubstitution,
            `backend-worker must use backend's required substitution for ${secret}`,
        );
    }
});

test("11. split-stack PostgreSQL startup rejects the published sentinel", (t) => {
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

test("12. Prisma CLI stages copy relative prisma.config.ts imports", () => {
    const configPath = "backend/prisma.config.ts";
    const importedFiles = relativeImportFiles(configPath);
    const dockerfiles = [
        {
            relativePath: "Dockerfile",
            configCopyPath: configPath,
            importedCopyPaths: importedFiles,
        },
        {
            relativePath: "backend/Dockerfile",
            configCopyPath: path.posix.basename(configPath),
            importedCopyPaths: importedFiles.map((importedFile) =>
                path.posix.relative("backend", importedFile),
            ),
        },
    ];

    for (const dockerfile of dockerfiles) {
        const stages = effectiveStageCopies(
            dockerfileStages(readRepoFile(dockerfile.relativePath)),
        );
        for (const stage of stages) {
            const copiesConfig = stage.copies.some((source) =>
                sourceCopiesFile(source, dockerfile.configCopyPath),
            );
            if (!copiesConfig && !stageRunsPrisma(stage.text)) continue;

            assert.ok(
                copiesConfig,
                `${dockerfile.relativePath} ${stage.name}: Prisma CLI stage must copy ${dockerfile.configCopyPath}`,
            );
            for (const importedFile of dockerfile.importedCopyPaths) {
                assert.ok(
                    stage.copies.some((source) =>
                        sourceCopiesFile(source, importedFile),
                    ),
                    `${dockerfile.relativePath} ${stage.name}: Prisma config import ${importedFile} must be copied into the stage`,
                );
            }
        }
    }
});

test("13. Helm exec probe binaries exist in component runtime images", () => {
    const references = execProbeReferences(
        readRepoFile("charts/soundspan/values.yaml"),
    );
    assert.ok(references.length > 0, "expected at least one chart exec probe");

    for (const reference of references) {
        const relativePath = componentDockerfile(reference.component);
        const packageName = binaryPackageProviders.get(reference.binary);
        assert.ok(
            dockerfileProvesBinary(relativePath, reference.binary),
            `charts/soundspan/values.yaml: ${reference.component}.${reference.probeName} exec binary "${reference.binary}" is not proven present in ${relativePath}; install ${packageName ?? "a mapped provider package"} in the runtime image or document a base-image family assumption`,
        );
    }
});

test("14. sidecar images copy every top-level Python module", () => {
    const missingFiles = [];

    for (const relativePath of serviceDockerfilePaths) {
        const sources = dockerCopySources(readRepoFile(relativePath));
        const serviceDirectories = copiedPythonSidecarDirectories(sources);

        for (const serviceDirectory of serviceDirectories) {
            for (const pythonFile of topLevelPythonFiles(serviceDirectory)) {
                const exclusionKey = `${relativePath}:${pythonFile}`;
                if (pythonSidecarCopyExclusions.has(exclusionKey)) continue;
                if (
                    !sources.some((source) =>
                        sourceCopiesPythonFile(source, pythonFile),
                    )
                ) {
                    missingFiles.push(`${relativePath}: ${pythonFile}`);
                }
            }
        }
    }

    assert.deepEqual(
        missingFiles,
        [],
        `Dockerfile COPY instructions omit top-level sidecar modules:\n${missingFiles.join("\n")}`,
    );
});
