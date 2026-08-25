#!/usr/bin/env node

/**
 * Ratchets production source-file sizes without requiring a big-bang cleanup.
 * Scans backend/src; frontend app, components, features, hooks, and lib;
 * Python files recursively under services; and each package's src directory.
 * It excludes __tests__, tests, *.test.*, *.spec.*, Python test-prefixed and
 * _test.py files, conftest.py, generated files/directories (including Prisma
 * clients), .next, node_modules, dist, lockfiles, documentation, and
 * non-source data/assets.
 *
 * Regenerate the ratchet entries after intentional splits (review the diff):
 * node --input-type=module -e 'import { collectFileSizes } from "./scripts/ci/check-file-size.mjs"; const sizes = collectFileSizes(process.cwd()); console.log(JSON.stringify(Object.fromEntries(Object.entries(sizes).filter(([, lines]) => lines > 1500)), null, 4));'
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RATCHET_CAP = 1_500;
const HARD_CAP = 3_000;
const MAX_SCANNED_DIRECTORIES = 10_000;
const MAX_DIRECTORY_ENTRIES = 100_000;
const MAX_PACKAGES = 512;
const CODE_EXTENSIONS = Object.freeze([
    ".cjs",
    ".css",
    ".js",
    ".jsx",
    ".mjs",
    ".ts",
    ".tsx",
]);
const PYTHON_EXTENSIONS = Object.freeze([".py"]);
const EXCLUDED_DIRECTORIES = new Set([
    ".next",
    ".prisma",
    "__pycache__",
    "__tests__",
    "dist",
    "generated",
    "node_modules",
    "tests",
]);
const FIXED_SCAN_ROOTS = Object.freeze([
    { directory: "backend/src", extensions: CODE_EXTENSIONS },
    { directory: "frontend/app", extensions: CODE_EXTENSIONS },
    { directory: "frontend/components", extensions: CODE_EXTENSIONS },
    { directory: "frontend/features", extensions: CODE_EXTENSIONS },
    { directory: "frontend/hooks", extensions: CODE_EXTENSIONS },
    { directory: "frontend/lib", extensions: CODE_EXTENSIONS },
    { directory: "services", extensions: PYTHON_EXTENSIONS },
]);

const BASELINE = Object.freeze({
    "backend/src/routes/browse.ts": 1540,
    "backend/src/routes/enrichment.ts": 2249,
    "backend/src/routes/library/radio.ts": 1563,
    "backend/src/routes/library/tracks.ts": 1655,
    "backend/src/routes/playlists.ts": 2262,
    "backend/src/routes/podcasts.ts": 2541,
    "backend/src/routes/systemSettings.ts": 1506,
    "backend/src/routes/youtubeMusic.ts": 1604,
    "backend/src/services/lidarr.ts": 2951,
    "backend/src/services/simpleDownloadManager.ts": 2306,
    "backend/src/services/spotify.ts": 1624,
    "backend/src/workers/unifiedEnrichment.ts": 1825,
    "frontend/app/playlist/[id]/page.tsx": 1506,
    "frontend/app/vibe/page.tsx": 1524,
    "frontend/components/player/AudioPlaybackOrchestrator.tsx": 1595,
    "frontend/components/player/OverlayPlayer.tsx": 1352,
    "frontend/hooks/useQueries.ts": 1453,
    "frontend/lib/audio-controls-context.tsx": 2305,
    "frontend/lib/listen-together-context.tsx": 1954,
    "services/audio-analyzer/analyzer.py": 2248,
});

function packageScanRoots(repoRoot) {
    const packagesDirectory = path.join(repoRoot, "packages");
    const entries = fs.readdirSync(packagesDirectory, { withFileTypes: true });
    if (entries.length > MAX_PACKAGES) {
        throw new Error(`File-size scan exceeded ${MAX_PACKAGES} packages`);
    }
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => `packages/${entry.name}/src`)
        .filter((directory) => fs.existsSync(path.join(repoRoot, directory)))
        .sort()
        .map((directory) => ({ directory, extensions: CODE_EXTENSIONS }));
}

function scanRoots(repoRoot) {
    return [...FIXED_SCAN_ROOTS, ...packageScanRoots(repoRoot)];
}

function isExcludedFile(fileName) {
    return (
        fileName === "conftest.py" ||
        (fileName.endsWith(".py") && fileName.startsWith("test_")) ||
        fileName.endsWith("_test.py") ||
        fileName.includes(".test.") ||
        fileName.includes(".spec.") ||
        /(?:^|[.-])generated\.(?:cjs|css|js|jsx|mjs|ts|tsx)$/.test(fileName)
    );
}

function isSourceFile(fileName, extensions) {
    return (
        !isExcludedFile(fileName) && extensions.includes(path.extname(fileName))
    );
}

function sourceFiles(directory, extensions) {
    const pendingDirectories = [directory];
    const files = [];
    let scannedDirectories = 0;

    while (
        pendingDirectories.length > 0 &&
        scannedDirectories < MAX_SCANNED_DIRECTORIES
    ) {
        const currentDirectory = pendingDirectories.pop();
        scannedDirectories += 1;
        scanDirectory(currentDirectory, extensions, pendingDirectories, files);
    }
    if (pendingDirectories.length > 0) {
        throw new Error(
            `File-size scan exceeded ${MAX_SCANNED_DIRECTORIES} directories`,
        );
    }
    return files;
}

function scanDirectory(directory, extensions, pendingDirectories, files) {
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
        } else if (entry.isFile() && isSourceFile(entry.name, extensions)) {
            files.push(entryPath);
        }
    }
}

export function countLines(source) {
    if (source.length === 0) return 0;
    const newlineCount = source.match(/\r\n|\r|\n/g)?.length ?? 0;
    return newlineCount + (/(?:\r\n|\r|\n)$/.test(source) ? 0 : 1);
}

export function collectFileSizes(repoRoot) {
    const files = scanRoots(repoRoot).flatMap(({ directory, extensions }) =>
        sourceFiles(path.join(repoRoot, directory), extensions),
    );
    return Object.fromEntries(
        files
            .sort()
            .map((filePath) => [
                path.relative(repoRoot, filePath).split(path.sep).join("/"),
                countLines(fs.readFileSync(filePath, "utf8")),
            ]),
    );
}

function classifyViolation(file, count, baseline) {
    if (count > HARD_CAP) {
        return { cap: HARD_CAP, count, file, kind: "hard-cap" };
    }
    if (count <= RATCHET_CAP || count <= (baseline ?? RATCHET_CAP)) {
        return undefined;
    }
    return {
        baseline: baseline ?? RATCHET_CAP,
        count,
        file,
        kind: baseline === undefined ? "ratchet-cap" : "baseline",
    };
}

function classifyTightenable(file, count, baseline) {
    if (baseline === undefined || count >= baseline) return undefined;
    return { baseline, count, file, remove: count <= RATCHET_CAP };
}

export function analyzeFileSizes(fileSizes, baseline = BASELINE) {
    const files = [
        ...new Set([...Object.keys(fileSizes), ...Object.keys(baseline)]),
    ].sort();
    const violations = [];
    const tightenable = [];
    for (const file of files) {
        const count = fileSizes[file] ?? 0;
        const violation = classifyViolation(file, count, baseline[file]);
        if (violation !== undefined) violations.push(violation);
        const tighter =
            violation === undefined
                ? classifyTightenable(file, count, baseline[file])
                : undefined;
        if (tighter !== undefined) tightenable.push(tighter);
    }
    return { ok: violations.length === 0, violations, tightenable };
}

function violationLine(violation) {
    if (violation.kind === "hard-cap") {
        return `${violation.file}: ${violation.count} lines exceeds hard cap ${violation.cap}`;
    }
    if (violation.kind === "ratchet-cap") {
        return `${violation.file}: ${violation.count} lines exceeds ratchet cap ${violation.baseline} (not in baseline)`;
    }
    return `${violation.file}: ${violation.count} lines exceeds baseline ${violation.baseline}`;
}

function tightenableLine(item) {
    if (item.remove) {
        return `${item.file}: ${item.count} lines is at or below ratchet cap ${RATCHET_CAP}; can be removed from baseline`;
    }
    return `${item.file}: ${item.count} lines is below baseline ${item.baseline}`;
}

export function formatFileSizeReport(result, scannedCount, baselineCount) {
    const stdout = [];
    const stderr = [];
    if (result.ok) {
        stdout.push(
            `File-size guardrail passed (${scannedCount} source files, ${baselineCount} baseline files).`,
        );
    } else {
        stderr.push("File-size guardrail failed:");
        stderr.push(...result.violations.map(violationLine));
    }
    if (result.tightenable.length > 0) {
        stdout.push("Baseline can be tightened:");
        stdout.push(...result.tightenable.map(tightenableLine));
    }
    return { stderr, stdout };
}

function runCli() {
    const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(scriptDirectory, "../..");
    const fileSizes = collectFileSizes(repoRoot);
    const result = analyzeFileSizes(fileSizes);
    const report = formatFileSizeReport(
        result,
        Object.keys(fileSizes).length,
        Object.keys(BASELINE).length,
    );
    for (const line of report.stdout) console.log(line);
    for (const line of report.stderr) console.error(line);
    process.exit(result.ok ? 0 : 1);
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    runCli();
}
