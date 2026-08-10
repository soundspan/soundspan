#!/usr/bin/env node

/**
 * Ratchets ad-hoc route 500 responses without requiring a big-bang cleanup.
 * When a route is canonicalized, lower its BASELINE count (or remove a zero entry)
 * so later changes cannot reintroduce the eliminated literals.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BASELINE = Object.freeze({
    "backend/src/routes/admin.ts": 3,
    "backend/src/routes/analysis.ts": 12,
    "backend/src/routes/analysisInternal.ts": 2,
    "backend/src/routes/apiKeys.ts": 3,
    "backend/src/routes/artists.ts": 4,
    "backend/src/routes/audiobooks.ts": 12,
    "backend/src/routes/auth.ts": 19,
    "backend/src/routes/browse.ts": 16,
    "backend/src/routes/deviceLink.ts": 6,
    "backend/src/routes/discover.ts": 5,
    "backend/src/routes/downloads.ts": 3,
    "backend/src/routes/enrichment.ts": 30,
    "backend/src/routes/homepage.ts": 2,
    "backend/src/routes/library.ts": 5,
    "backend/src/routes/listenTogether.ts": 1,
    "backend/src/routes/listeningState.ts": 3,
    "backend/src/routes/lyrics.ts": 1,
    "backend/src/routes/mixes.ts": 10,
    "backend/src/routes/offline.ts": 5,
    "backend/src/routes/onboarding.ts": 7,
    "backend/src/routes/playbackState.ts": 3,
    "backend/src/routes/playlistImport.ts": 8,
    "backend/src/routes/playlists.ts": 15,
    "backend/src/routes/plays.ts": 4,
    "backend/src/routes/podcasts.ts": 17,
    "backend/src/routes/recommendations.ts": 4,
    "backend/src/routes/releases.ts": 4,
    "backend/src/routes/search.ts": 4,
    "backend/src/routes/settings.ts": 5,
    "backend/src/routes/shareLinks.ts": 7,
    "backend/src/routes/social.ts": 3,
    "backend/src/routes/soulseek.ts": 7,
    "backend/src/routes/spotify.ts": 8,
    "backend/src/routes/streaming.ts": 3,
    "backend/src/routes/system.ts": 2,
    "backend/src/routes/systemSettings.ts": 13,
    "backend/src/routes/tidalStreaming.ts": 10,
    "backend/src/routes/trackMappings.ts": 2,
    "backend/src/routes/webhooks.ts": 1,
    "backend/src/routes/youtube.ts": 1,
    "backend/src/routes/youtubeMusic.ts": 18,
});

// Raw error details can disclose internal implementation data to clients (OWASP).
// This independent ratchet prevents new error.message/error.stack response leaks.
const LEAK_BASELINE = Object.freeze({
    "backend/src/routes/discover.ts": 0,
    "backend/src/routes/downloads.ts": 1,
    "backend/src/routes/listenTogether.ts": 1,
    "backend/src/routes/notifications.ts": 2,
    "backend/src/routes/playbackState.ts": 1,
    // playlists.ts remaining 1: prefix-guarded ensureRemoteTrack validation message (code-owned 400 detail, ~L904).
    "backend/src/routes/playlists.ts": 1,
    // podcasts.ts remaining 2: Prisma-retry classification helper (~L83) and logger-only describeAxiosError (~L133); neither reaches a response body.
    "backend/src/routes/podcasts.ts": 2,
});

export function countPattern(source) {
    const pattern = /res\s*\.\s*status\s*\(\s*500\s*\)\s*\.\s*json\s*\(/g;
    return source.match(pattern)?.length ?? 0;
}

export function stripLoggerCalls(source) {
    const callStart = /logger\s*\.\s*[a-zA-Z]+\s*\(/g;
    let out = "";
    let cursor = 0;
    let match;
    let guard = 0;
    while ((match = callStart.exec(source)) !== null && guard++ < 100000) {
        let index = match.index + match[0].length;
        let depth = 1;
        let innerGuard = 0;
        while (index < source.length && depth > 0 && innerGuard++ < 1000000) {
            const char = source[index];
            if (char === "(") depth++;
            else if (char === ")") depth--;
            index++;
        }
        out += source.slice(cursor, match.index);
        cursor = index;
        callStart.lastIndex = index;
    }
    return out + source.slice(cursor);
}

export function countLeakPattern(source) {
    const stripped = stripLoggerCalls(source);
    const normalizedSource = stripped.replace(
        /error\s*(\??)\s*\.\s*(message|stack)\b/g,
        "error$1.$2",
    );
    const pattern = /(?::\s*|=\s*|\$\{[^}]*)error\??\.(?:message|stack)\b/g;
    return normalizedSource.match(pattern)?.length ?? 0;
}

export function analyzeRouteErrorCanon(counts, baseline) {
    const results = Object.entries(counts).map(([file, count]) => ({
        file,
        count,
        baseline: baseline[file] ?? 0,
    }));
    const violations = results.filter(
        (result) => result.count > result.baseline,
    );
    const tightenable = results.filter(
        (result) =>
            baseline[result.file] !== undefined &&
            result.count < result.baseline,
    );

    return { ok: violations.length === 0, violations, tightenable };
}

function routeFiles(directory) {
    return fs
        .readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => path.join(directory, entry.name));
}

function collectCounts(repoRoot, counter = countPattern) {
    const routesDirectory = path.join(repoRoot, "backend/src/routes");
    return Object.fromEntries(
        routeFiles(routesDirectory)
            .sort()
            .map((filePath) => {
                const relativePath = path
                    .relative(repoRoot, filePath)
                    .split(path.sep)
                    .join("/");
                return [
                    relativePath,
                    counter(fs.readFileSync(filePath, "utf8")),
                ];
            }),
    );
}

function printReport(label, result) {
    console.log(`${label}:`);
    if (result.ok) {
        console.log("Route error canonicalization ratchet passed.");
    } else {
        console.error("Route error canonicalization ratchet failed:");
        for (const violation of result.violations) {
            console.error(
                `${violation.file}: ${violation.count} exceeds baseline ${violation.baseline}`,
            );
        }
    }

    if (result.tightenable.length > 0) {
        console.log("Baseline can be tightened:");
        for (const item of result.tightenable) {
            console.log(
                `${item.file}: ${item.count} is below baseline ${item.baseline}`,
            );
        }
    }
}

function runCli() {
    const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(scriptDirectory, "../..");
    const canonicalResult = analyzeRouteErrorCanon(
        collectCounts(repoRoot),
        BASELINE,
    );
    const leakResult = analyzeRouteErrorCanon(
        collectCounts(repoRoot, countLeakPattern),
        LEAK_BASELINE,
    );

    printReport("500-literal ratchet", canonicalResult);
    printReport("Raw-error leak ratchet", leakResult);
    console.log(
        "Use sendInternalRouteError/AppError instead; see backend/src/routes/README.md.",
    );
    process.exit(canonicalResult.ok && leakResult.ok ? 0 : 1);
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    runCli();
}
