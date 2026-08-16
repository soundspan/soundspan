#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_DIRECTORIES = Object.freeze([
    "backend",
    "frontend",
    "packages/media-metadata-contract",
]);
const MAX_LOCK_ENTRIES = 100_000;
const MAX_OVERRIDES = 512;

function fail(message) {
    throw new Error(message);
}

function packageNameFromSelector(selector) {
    if (typeof selector !== "string" || selector.length === 0) {
        fail("override selector must be a non-empty string");
    }
    if (!selector.startsWith("@")) {
        const separator = selector.indexOf("@");
        return separator === -1 ? selector : selector.slice(0, separator);
    }

    const scopeSeparator = selector.indexOf("/");
    if (scopeSeparator === -1) fail(`invalid scoped override: ${selector}`);
    const rangeSeparator = selector.indexOf("@", scopeSeparator);
    return rangeSeparator === -1 ? selector : selector.slice(0, rangeSeparator);
}

function packageNameFromLockPath(lockPath) {
    const marker = "node_modules/";
    const markerIndex = lockPath.lastIndexOf(marker);
    if (markerIndex === -1) return undefined;

    const remainder = lockPath.slice(markerIndex + marker.length);
    const parts = remainder.split("/");
    if (!remainder.startsWith("@")) return parts[0];
    if (parts.length < 2) fail(`invalid scoped lock path: ${lockPath}`);
    return `${parts[0]}/${parts[1]}`;
}

function parseSemver(version) {
    if (typeof version !== "string") return undefined;
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/);
    if (match === null) return undefined;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        version,
    };
}

function safeFloor(overrideValue) {
    if (typeof overrideValue !== "string") {
        fail(
            "nested or non-string npm overrides are not supported by this gate",
        );
    }
    const match = overrideValue.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
    return match === null ? undefined : parseSemver(match[0]);
}

function compareSemver(left, right) {
    for (const key of ["major", "minor", "patch"]) {
        if (left[key] !== right[key]) return left[key] - right[key];
    }
    return 0;
}

function collectLockedVersions(lockfile) {
    const packages = lockfile?.packages;
    if (packages === undefined || packages === null) {
        fail("package-lock.json does not contain a packages graph");
    }

    const entries = Object.entries(packages);
    if (entries.length > MAX_LOCK_ENTRIES) {
        fail(`package lock exceeds ${MAX_LOCK_ENTRIES} entries`);
    }
    const versionsByName = new Map();
    for (const [lockPath, metadata] of entries) {
        addLockedVersion(versionsByName, lockPath, metadata);
    }
    return versionsByName;
}

function addLockedVersion(versionsByName, lockPath, metadata) {
    const name = packageNameFromLockPath(lockPath);
    if (name === undefined || typeof metadata?.version !== "string") return;
    const versions = versionsByName.get(name) ?? new Set();
    versions.add(metadata.version);
    versionsByName.set(name, versions);
}

function newerVersionsOnPinnedLine(versions, pinned) {
    const newerVersions = [];
    for (const version of versions) {
        const parsed = parseSemver(version);
        if (
            parsed !== undefined &&
            parsed.major === pinned.major &&
            compareSemver(parsed, pinned) > 0
        ) {
            newerVersions.push(parsed);
        }
    }
    return newerVersions
        .sort(compareSemver)
        .map((candidate) => candidate.version);
}

export function analyzeOverrides(overrides, lockfile) {
    if (overrides === undefined || overrides === null) {
        fail("overrides must be provided");
    }
    const overrideEntries = Object.entries(overrides);
    if (overrideEntries.length > MAX_OVERRIDES) {
        fail(`package has more than ${MAX_OVERRIDES} overrides`);
    }

    const lockedVersions = collectLockedVersions(lockfile);
    const dangling = [];
    const candidates = [];
    for (const [selector, overrideValue] of overrideEntries) {
        analyzeOverride(
            selector,
            overrideValue,
            lockedVersions,
            dangling,
            candidates,
        );
    }
    return { dangling, candidates };
}

function analyzeOverride(
    selector,
    overrideValue,
    lockedVersions,
    dangling,
    candidates,
) {
    const name = packageNameFromSelector(selector);
    const versions = lockedVersions.get(name);
    if (versions === undefined || versions.size === 0) {
        dangling.push({ name, selector });
        return;
    }

    const pinned = safeFloor(overrideValue);
    if (pinned === undefined) return;
    const resolvedVersions = newerVersionsOnPinnedLine(versions, pinned);
    if (resolvedVersions.length === 0) return;
    candidates.push({
        name,
        pinnedVersion: pinned.version,
        resolvedVersions,
        selector,
    });
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        fail(`cannot parse ${filePath}: ${detail}`);
    }
}

function analyzePackage(repoRoot, packageDirectory) {
    const manifestPath = path.join(repoRoot, packageDirectory, "package.json");
    const manifest = readJson(manifestPath);
    const overrides = manifest.overrides ?? {};
    if (Object.keys(overrides).length === 0) return undefined;

    const lockPath = path.join(repoRoot, packageDirectory, "package-lock.json");
    return {
        ...analyzeOverrides(overrides, readJson(lockPath)),
        manifestPath: path.relative(repoRoot, manifestPath),
        overrideCount: Object.keys(overrides).length,
    };
}

function printDangling(result) {
    for (const item of result.dangling) {
        console.error(
            `${result.manifestPath}: override "${item.selector}" targets ` +
                `${item.name}, but package-lock.json has no resolved entry.`,
        );
    }
}

function printCandidates(result) {
    for (const item of result.candidates) {
        console.warn(
            `WARNING: ${result.manifestPath}: override "${item.selector}" ` +
                `pins ${item.pinnedVersion}, while the lock resolves ` +
                `${item.resolvedVersions.join(", ")}. Review it in the next shed pass.`,
        );
    }
}

function runCli() {
    const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(scriptDirectory, "../..");
    const results = PACKAGE_DIRECTORIES.map((packageDirectory) =>
        analyzePackage(repoRoot, packageDirectory),
    ).filter((result) => result !== undefined);
    const overrideCount = results.reduce(
        (total, result) => total + result.overrideCount,
        0,
    );

    for (const result of results) printCandidates(result);
    const failedResults = results.filter(
        (result) => result.dangling.length > 0,
    );
    if (failedResults.length > 0) {
        console.error("Override staleness check failed:");
        for (const result of failedResults) printDangling(result);
        process.exitCode = 1;
        return;
    }
    console.log(
        `Override staleness check passed (${results.length} packages, ` +
            `${overrideCount} overrides).`,
    );
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    try {
        runCli();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Override staleness check failed: ${message}\n`);
        process.exitCode = 1;
    }
}
