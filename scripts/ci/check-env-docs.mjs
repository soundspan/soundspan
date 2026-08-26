#!/usr/bin/env node

/**
 * Ratchets environment-variable documentation and deployment coverage without
 * requiring pre-existing gaps to be fixed in one change.
 *
 * Regenerate the baseline after intentional fixes (review the diff):
 * node --input-type=module -e 'import { findEnvDocGaps } from "./scripts/ci/check-env-docs.mjs"; console.log(JSON.stringify(findEnvDocGaps(process.cwd()).map(({ name }) => name), null, 4));'
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_SCANNED_DIRECTORIES = 10_000;
const MAX_DIRECTORY_ENTRIES = 100_000;
const MAX_SOURCE_BYTES = 2_000_000;
const DOCS_SURFACE = "docs/ENVIRONMENT_VARIABLES.md";
const DEPLOYMENT_SURFACE =
    "docker-compose.yml, docker-compose.aio.yml, or .env.example";
const DEPLOYMENT_FILES = Object.freeze([
    "docker-compose.yml",
    "docker-compose.aio.yml",
    ".env.example",
]);

const EXCLUDED_NAMES = new Set([
    "CI", // CI runners inject their execution marker.
    "HOME", // The operating system supplies the process home directory.
    "HOSTNAME", // Container runtimes inject the running container hostname.
    "JEST_WORKER_ID", // Jest injects its worker identifier during tests.
    "NODE_ENV", // Node tooling supplies the standard runtime mode.
    "PATH", // The shell supplies the executable search path.
    "PWD", // The shell supplies the process working directory.
    "SCALE_TESTS", // The opt-in scale-test harness owns this test-only flag.
    "TZ", // The runtime or operating system supplies the process timezone.
]);

// Kubernetes service discovery injects KUBERNETES_* values into pods.
function isExcludedName(name) {
    return EXCLUDED_NAMES.has(name) || name.startsWith("KUBERNETES_");
}

const BASELINE = Object.freeze([]);

function isExcludedSource(relativePath, language) {
    const parts = relativePath.split("/");
    if (language === "typescript") {
        return (
            parts.includes("__tests__") ||
            parts.includes("tests-integration") ||
            relativePath.endsWith(".test.ts") ||
            relativePath.endsWith(".spec.ts")
        );
    }
    return parts.includes("tests");
}

function sourceFiles(repoRoot, relativeRoot, extension, language) {
    const root = path.join(repoRoot, relativeRoot);
    const pending = [root];
    const files = [];
    let scannedDirectories = 0;
    while (pending.length > 0 && scannedDirectories < MAX_SCANNED_DIRECTORIES) {
        const directory = pending.pop();
        scannedDirectories += 1;
        const entries = fs.readdirSync(directory, { withFileTypes: true });
        if (entries.length > MAX_DIRECTORY_ENTRIES) {
            throw new Error(
                `${directory} exceeds ${MAX_DIRECTORY_ENTRIES} directory entries`,
            );
        }
        for (const entry of entries) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) pending.push(entryPath);
            if (!entry.isFile() || !entry.name.endsWith(extension)) continue;
            const relativePath = path
                .relative(repoRoot, entryPath)
                .split(path.sep)
                .join("/");
            if (!isExcludedSource(relativePath, language))
                files.push(entryPath);
        }
    }
    if (pending.length > 0) {
        throw new Error(
            `Environment-variable scan exceeded ${MAX_SCANNED_DIRECTORIES} directories`,
        );
    }
    return files.sort();
}

function readSource(filePath) {
    const size = fs.statSync(filePath).size;
    if (size > MAX_SOURCE_BYTES) {
        throw new Error(`${filePath} exceeds ${MAX_SOURCE_BYTES} bytes`);
    }
    return fs.readFileSync(filePath, "utf8");
}

function matchNames(source, patterns) {
    const matches = [];
    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
            const name = match.groups?.name;
            if (name !== undefined && !isExcludedName(name)) {
                matches.push({ index: match.index, name });
            }
        }
    }
    return matches;
}

function typescriptEnvReads(source) {
    return matchNames(source, [/\bprocess\.env\.(?<name>[A-Z][A-Z0-9_]*)\b/g]);
}

function pythonEnvReads(source) {
    return matchNames(source, [
        /\bos\.environ\s*\[\s*["'](?<name>[A-Z][A-Z0-9_]*)["']\s*\](?!\s*=)/g,
        /\bos\.environ\.get\s*\(\s*["'](?<name>[A-Z][A-Z0-9_]*)["']/g,
        /\bos\.getenv\s*\(\s*["'](?<name>[A-Z][A-Z0-9_]*)["']/g,
    ]);
}

function lineNumberAt(source, index) {
    return (source.slice(0, index).match(/\n/g)?.length ?? 0) + 1;
}

function addFileReads(repoRoot, filePath, findReads, locationsByName) {
    const source = readSource(filePath);
    const relativePath = path
        .relative(repoRoot, filePath)
        .split(path.sep)
        .join("/");
    for (const { index, name } of findReads(source)) {
        const location = `${relativePath}:${lineNumberAt(source, index)}`;
        const locations = locationsByName.get(name) ?? new Set();
        locations.add(location);
        locationsByName.set(name, locations);
    }
}

export function collectEnvReads(repoRoot) {
    const locationsByName = new Map();
    const scans = [
        {
            files: sourceFiles(repoRoot, "backend/src", ".ts", "typescript"),
            findReads: typescriptEnvReads,
        },
        {
            files: sourceFiles(repoRoot, "services", ".py", "python"),
            findReads: pythonEnvReads,
        },
    ];
    for (const scan of scans) {
        for (const filePath of scan.files) {
            addFileReads(repoRoot, filePath, scan.findReads, locationsByName);
        }
    }
    return Object.fromEntries(
        [...locationsByName.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, locations]) => [name, [...locations].sort()]),
    );
}

function mentionsName(source, name, backtickQuoted = false) {
    const target = backtickQuoted ? `\`${name}\`` : name;
    if (backtickQuoted) return source.includes(target);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^A-Z0-9_])${escaped}(?:$|[^A-Z0-9_])`).test(
        source,
    );
}

export function findEnvDocGaps(repoRoot, reads = collectEnvReads(repoRoot)) {
    const docs = fs.readFileSync(path.join(repoRoot, DOCS_SURFACE), "utf8");
    const deploymentSources = DEPLOYMENT_FILES.map((file) =>
        fs.readFileSync(path.join(repoRoot, file), "utf8"),
    );
    const gaps = [];
    for (const [name, locations] of Object.entries(reads)) {
        const missingSurfaces = [];
        if (!mentionsName(docs, name, true)) missingSurfaces.push(DOCS_SURFACE);
        if (!deploymentSources.some((source) => mentionsName(source, name))) {
            missingSurfaces.push(DEPLOYMENT_SURFACE);
        }
        if (missingSurfaces.length > 0) {
            gaps.push({ locations, missingSurfaces, name });
        }
    }
    return gaps;
}

export function analyzeEnvDocs(gaps, baseline = BASELINE) {
    const baselineNames = new Set(baseline);
    const currentNames = new Set(gaps.map(({ name }) => name));
    const newGaps = gaps.filter(({ name }) => !baselineNames.has(name));
    const tightenable = baseline.filter((name) => !currentNames.has(name));
    return {
        currentGaps: gaps,
        newGaps,
        ok: newGaps.length === 0,
        tightenable,
    };
}

function gapLine(gap) {
    return `${gap.name}: read at ${gap.locations.join(", ")}; missing ${gap.missingSurfaces.join(" and ")}`;
}

export function formatEnvDocsReport(result, scannedCount, baselineCount) {
    const stdout = [];
    const stderr = [];
    if (result.ok) {
        stdout.push(
            `Environment-variable documentation guardrail passed (${scannedCount} variables, ${baselineCount} baseline gaps).`,
        );
    } else {
        stderr.push("Environment-variable documentation guardrail failed:");
        stderr.push(...result.newGaps.map(gapLine));
    }
    if (result.tightenable.length > 0) {
        stdout.push("Baseline can be tightened:");
        stdout.push(
            ...result.tightenable.map(
                (name) =>
                    `${name}: no longer has an environment-documentation gap; can be removed from baseline`,
            ),
        );
    }
    return { stderr, stdout };
}

function runCli() {
    const repoRoot = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../..",
    );
    const reads = collectEnvReads(repoRoot);
    const result = analyzeEnvDocs(findEnvDocGaps(repoRoot, reads));
    const report = formatEnvDocsReport(
        result,
        Object.keys(reads).length,
        BASELINE.length,
    );
    for (const line of report.stdout) console.log(line);
    for (const line of report.stderr) console.error(line);
    process.exitCode = result.ok ? 0 : 1;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    runCli();
}
