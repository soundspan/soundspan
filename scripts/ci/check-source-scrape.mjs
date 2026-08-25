#!/usr/bin/env node

/**
 * Ratchets deprecated tests that read production source and assert on its text.
 * Existing offenders are frozen per file so the debt can shrink but cannot grow.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_SCANNED_DIRECTORIES = 10_000;
const MAX_DIRECTORY_ENTRIES = 100_000;
const TEST_FILE_REGEX = /\.(?:test|spec)\.(?:cjs|js|jsx|mjs|ts|tsx)$/;
const SOURCE_READ_REGEX = /\b(?:fs\.)?readFileSync\s*\(/;
const TO_CONTAIN_REGEX = /\.toContain\s*\(/g;
const EXCLUDED_DIRECTORIES = new Set([
    ".git",
    ".next",
    ".venv",
    "coverage",
    "dist",
    "generated",
    "node_modules",
    "venv",
]);

export const BASELINE = Object.freeze({
    "backend/src/__tests__/apiEntrypointDbResilienceContract.test.ts": 6,
    "backend/src/__tests__/dependencyReadinessContract.test.ts": 4,
    "backend/src/__tests__/discoverProcessorIdempotencyContract.test.ts": 11,
    "backend/src/__tests__/embeddingSpaceMigration.test.ts": 9,
    "backend/src/__tests__/enrichmentCycleClaimContract.test.ts": 14,
    "backend/src/__tests__/enrichmentStateRedisRetryContract.test.ts": 12,
    "backend/src/__tests__/healthEndpointContract.test.ts": 9,
    "backend/src/__tests__/moodBucketPrismaRetryContract.test.ts": 7,
    "backend/src/__tests__/moodBucketWorkerReconciliationContract.test.ts": 3,
    "backend/src/__tests__/prismaBinaryTargetContract.test.ts": 10,
    "backend/src/__tests__/prismaConnectionResilienceContract.test.ts": 19,
    "backend/src/__tests__/queueCleanerPrismaRetryContract.test.ts": 7,
    "backend/src/__tests__/workerHealthEndpointContract.test.ts": 10,
    "backend/src/__tests__/workerRuntimeIsolationContract.test.ts": 6,
    "backend/src/__tests__/workerSchedulerClaimContract.test.ts": 9,
    "backend/src/__tests__/workerShutdownResilienceContract.test.ts": 2,
    "backend/src/__tests__/workerStartupMaintenanceQueueContract.test.ts": 20,
    "backend/src/routes/__tests__/podcastsRefreshPrismaRetryCompat.test.ts": 7,
    "backend/tests-integration/vibeSearchPostgres.integration.test.ts": 3,
});

function scanDirectory(directory, pendingDirectories, testFiles) {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    if (entries.length > MAX_DIRECTORY_ENTRIES) {
        throw new Error(
            `${directory} exceeds ${MAX_DIRECTORY_ENTRIES} directory entries`,
        );
    }
    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) {
            pendingDirectories.push(entryPath);
        } else if (entry.isFile() && TEST_FILE_REGEX.test(entry.name)) {
            testFiles.push(entryPath);
        }
    }
}

function findTestFiles(repoRoot) {
    const pendingDirectories = [repoRoot];
    const testFiles = [];
    let scannedDirectories = 0;
    while (
        pendingDirectories.length > 0 &&
        scannedDirectories < MAX_SCANNED_DIRECTORIES
    ) {
        const directory = pendingDirectories.pop();
        scannedDirectories += 1;
        scanDirectory(directory, pendingDirectories, testFiles);
    }
    if (pendingDirectories.length > 0) {
        throw new Error(
            `Source-scrape scan exceeded ${MAX_SCANNED_DIRECTORIES} directories`,
        );
    }
    return testFiles.sort();
}

export function countSourceScrapeAssertions(source) {
    if (typeof source !== "string") {
        throw new TypeError("source must be a string");
    }
    if (!SOURCE_READ_REGEX.test(source)) return 0;
    return source.match(TO_CONTAIN_REGEX)?.length ?? 0;
}

export function collectSourceScrapes(repoRoot) {
    const testFiles = findTestFiles(repoRoot);
    const entries = testFiles.flatMap((filePath) => {
        const source = fs.readFileSync(filePath, "utf8");
        const assertions = countSourceScrapeAssertions(source);
        if (assertions === 0) return [];
        const relativePath = path
            .relative(repoRoot, filePath)
            .split(path.sep)
            .join("/");
        return [[relativePath, assertions]];
    });
    return {
        assertionCounts: Object.fromEntries(entries),
        scannedCount: testFiles.length,
    };
}

function item(file, assertions, baseline) {
    return { assertions, baseline, file };
}

export function analyzeSourceScrapes(assertionCounts, baseline = BASELINE) {
    const files = [
        ...new Set([...Object.keys(assertionCounts), ...Object.keys(baseline)]),
    ].sort();
    const offenders = [];
    const tightenable = [];
    const violations = [];
    for (const file of files) {
        const assertions = assertionCounts[file] ?? 0;
        const baselineCount = baseline[file] ?? 0;
        if (assertions > 0) {
            offenders.push(item(file, assertions, baselineCount));
        }
        if (assertions > baselineCount) {
            violations.push(item(file, assertions, baselineCount));
        } else if (assertions < baselineCount) {
            tightenable.push(item(file, assertions, baselineCount));
        }
    }
    return {
        offenders,
        ok: violations.length === 0,
        tightenable,
        violations,
    };
}

function totalAssertions(items, field = "assertions") {
    return items.reduce((total, entry) => total + entry[field], 0);
}

function offenderLine(entry) {
    return `${entry.file}: ${entry.assertions} toContain assertions (baseline ${entry.baseline})`;
}

export function formatSourceScrapeReport(
    result,
    scannedCount,
    baselineFileCount,
    baselineAssertionCount,
) {
    const offenderCount = result.offenders.length;
    const assertionCount = totalAssertions(result.offenders);
    const fileLabel = offenderCount === 1 ? "file" : "files";
    const stdout = [
        `Deprecated source-scraping tests (${offenderCount} offender ${fileLabel}):`,
        ...result.offenders.map(offenderLine),
    ];
    const stderr = [];
    if (result.ok) {
        stdout.unshift(
            `Source-scrape guardrail passed (${scannedCount} test files, ${offenderCount} offender ${fileLabel}, ${assertionCount} assertions; baseline ${baselineFileCount} files, ${baselineAssertionCount} assertions).`,
        );
    } else {
        stderr.push("Source-scrape guardrail failed:");
        stderr.push(...result.violations.map(offenderLine));
    }
    if (result.tightenable.length > 0) {
        stdout.push("Baseline can be tightened:");
        stdout.push(
            ...result.tightenable.map(
                (entry) =>
                    `${entry.file}: ${entry.assertions} assertions is below baseline ${entry.baseline}`,
            ),
        );
    }
    return { stderr, stdout };
}

function runCli() {
    const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(scriptDirectory, "../..");
    const inventory = collectSourceScrapes(repoRoot);
    const result = analyzeSourceScrapes(inventory.assertionCounts);
    const report = formatSourceScrapeReport(
        result,
        inventory.scannedCount,
        Object.keys(BASELINE).length,
        totalAssertions(
            Object.values(BASELINE).map((assertions) => ({ assertions })),
        ),
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
