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
    "backend/src/routes/apiKeys.ts": 3,
    "backend/src/routes/artists.ts": 4,
    "backend/src/routes/audiobooks.ts": 12,
    "backend/src/routes/auth/accountSecurity.ts": 9,
    "backend/src/routes/auth/adminUserInvites.ts": 9,
    "backend/src/routes/auth/localCredentials.ts": 1,
    "backend/src/routes/browse.ts": 15,
    "backend/src/routes/deviceLink.ts": 6,
    "backend/src/routes/discover/exclusions.ts": 1,
    "backend/src/routes/discover/shared.ts": 4,
    "backend/src/routes/downloads.ts": 3,
    "backend/src/routes/enrichment.ts": 30,
    "backend/src/routes/homepage.ts": 2,
    "backend/src/routes/library/albums.ts": 1,
    "backend/src/routes/library/artists.ts": 2,
    "backend/src/routes/library/maintenance.ts": 1,
    "backend/src/routes/library/tracks.ts": 1,
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
    "backend/src/routes/shareLinks.ts": 6,
    "backend/src/routes/social.ts": 3,
    "backend/src/routes/soulseek.ts": 6,
    "backend/src/routes/system.ts": 2,
    "backend/src/routes/systemSettings.ts": 12,
    "backend/src/routes/tidalStreaming.ts": 10,
    "backend/src/routes/trackMappings.ts": 2,
    "backend/src/routes/webhooks.ts": 0,
    "backend/src/routes/youtube.ts": 1,
    "backend/src/routes/youtubeMusic.ts": 18,
});

// Raw error details can disclose internal implementation data to clients (OWASP).
// This independent ratchet prevents raw error properties and conversions from
// being assigned or interpolated outside logger calls.
const LEAK_BASELINE = Object.freeze({
    // auth/adminUserInvites.ts remaining 2: Zod firstError.message validation detail in 400 responses (~L479 and ~L897); code-owned schema messages, not raw errors.
    "backend/src/routes/auth/adminUserInvites.ts": 2,
    // discover/legacy/maintenance.ts +1: cleanup-loop detail const used only by logger.error; server-side only; frozen with deprecated legacy discovery.
    // discover/legacy/maintenance.ts +1: the same logger-only cleanup detail's ternary-consequent error.message; frozen with deprecated legacy discovery.
    "backend/src/routes/discover/legacy/maintenance.ts": 2,
    "backend/src/routes/downloads.ts": 0,
    // library/artists.ts remaining 1: admin-only Lidarr deletion diagnostics (lidarrError = err?.message) returned to the initiating admin, not a general-user 500 leak.
    "backend/src/routes/library/artists.ts": 1,
    "backend/src/routes/listenTogether.ts": 1,
    // notifications.ts remaining 2: stored downloadJob.error strings from the soulseek retry result (~L702) and Lidarr fallback (~L864); stored-then-returned to the owning user via GET /api/downloads — client-reachable, flagged for follow-up sanitization under the slice-J scope guard (the POST retry response leak itself was sanitized).
    "backend/src/routes/notifications.ts": 2,
    "backend/src/routes/playbackState.ts": 0,
    // playlistImport.ts remaining 2: substring-guarded 400 echoes of playlistImportService's own thrown validation messages (~L434 preview, ~L516 "Invalid track reference" execute); code-owned text, not raw transport errors.
    "backend/src/routes/playlistImport.ts": 2,
    // playlists.ts remaining 2: prefix-guarded ensureRemoteTrack validation message (code-owned 400 detail, ~L904); plus stored downloadJob.error from the soulseek retry result (~L1725), stored-then-returned to the owning user via GET /api/downloads — flagged for follow-up sanitization under the slice-J scope guard (the sessionLog WARN leak was sanitized).
    "backend/src/routes/playlists.ts": 2,
    // podcasts.ts remaining 2: Prisma-retry classification helper (~L83) and logger-only describeAxiosError (~L133); neither reaches a response body.
    // podcasts.ts +1: retry classification's ternary-consequent error.message (~L108); frozen under the ratchet-widening (slice-X1) scope guard.
    "backend/src/routes/podcasts.ts": 3,
    // settings.ts remaining 1: multer MulterError.message in a 400 upload-validation response (~L307), behind an instanceof MulterError guard; library-owned validation text.
    "backend/src/routes/settings.ts": 1,
    // soulseek.ts at zero for the property-value pattern; the admin-gated direct-download 404 still forwards result.error as the sendRouteError message (admin-only surface, slice-J follow-up).
    "backend/src/routes/soulseek.ts": 0,
    // subsonic/mediaRetrieval.ts +1: cover-fetch failure classification's ternary-consequent error.message; frozen under the ratchet-widening (slice-X1) scope guard.
    "backend/src/routes/subsonic/mediaRetrieval.ts": 1,
    // youtube.ts remaining 4: yt-dlp sidecar err.response?.data?.detail echoed in error responses (L68, L126, L335, L341); known backlog item, frozen under the slice-J scope guard.
    "backend/src/routes/youtube.ts": 4,
    // youtubeMusic.ts remaining 11: ytmusic sidecar err.response?.data?.detail echoes (10x) plus one result.error response (~L434); same sidecar-detail class as youtube.ts, frozen under the slice-J scope guard, flagged for follow-up.
    "backend/src/routes/youtubeMusic.ts": 11,
    // acquisitionService.ts remaining 4: { success:false, error } acquisition result objects (~L482, ~L678, ~L767) consumed by the download orchestration/admin surface, not raw route 500 bodies; frozen under the slice-E scope guard; plus a result.error passthrough in a { success:false, error } result object (~L748); frozen under the slice-J scope guard.
    "backend/src/services/acquisitionService.ts": 4,
    // artistCountsService.ts +2: numeric backfill error counters returned in result/progress objects (~L237 and ~L277); no error text; frozen under the ratchet-widening (slice-B2) scope guard.
    "backend/src/services/artistCountsService.ts": 2,
    // audioStreaming.ts remaining 3: internal ffmpeg-error classification (~L285) plus transcode-failure AppError messages (~L303, ~L347); frozen under the slice-E scope guard — AppError messages are echoed by errorHandler, flagged for follow-up sanitization.
    "backend/src/services/audioStreaming.ts": 3,
    // audiobookCache.ts remaining 2: sync-failure detail string recorded server-side (~L104) and an internal thrown sync-error message (~L398); frozen under the slice-E scope guard.
    "backend/src/services/audiobookCache.ts": 2,
    // discoverWeekly/generationService.ts remaining 4: discoveryLogger and discoveryBatchLogger interpolations plus a stored job error field in the server-side generation pipeline; frozen under the slice-E and slice-J scope guards.
    "backend/src/services/discoverWeekly/generationService.ts": 4,
    // discoverWeekly/playlistPersistence.ts remaining 1: internal transaction-failure message; server-side only, frozen under the slice-E scope guard.
    "backend/src/services/discoverWeekly/playlistPersistence.ts": 1,
    // discoverWeekly/state.ts remaining 2: Prisma retry classification error.message reads; internal retry decisions only, frozen under the slice-E and slice-X1 scope guards.
    "backend/src/services/discoverWeekly/state.ts": 2,
    // enrichmentState.ts +1: Redis retry classification's ternary-consequent error.message (~L77); frozen under the ratchet-widening (slice-X1) scope guard.
    "backend/src/services/enrichmentState.ts": 1,
    // genericImportJobRunner.ts remaining 1: latestJob.error passthrough on user cancel (~L91); import-job state plumbing, frozen under the slice-J scope guard.
    "backend/src/services/genericImportJobRunner.ts": 1,
    // imageProxy.ts +1: image-fetch result's ternary-consequent lastError.message (~L248); frozen under the ratchet-widening (slice-X1) scope guard.
    "backend/src/services/imageProxy.ts": 1,
    // importJobStore.ts remaining 1: persisted input.error passthrough (~L192); job-state plumbing, frozen under the slice-J scope guard.
    "backend/src/services/importJobStore.ts": 1,
    // lastfm.ts +1: album-info error detail const consumed only by logger.error (~L303); server-side only; frozen under the ratchet-widening (slice-B2) scope guard.
    // lastfm.ts +1: the same logger-only detail's ternary-consequent error.message; frozen under the ratchet-widening (slice-X1) scope guard.
    "backend/src/services/lastfm.ts": 2,
    // listenTogetherSocket.ts +4: GroupError ternary-consequent messages forwarded through socket acknowledgements; frozen under the ratchet-widening (slice-X1) scope guard.
    "backend/src/services/listenTogetherSocket.ts": 0,
    // lidarr.ts remaining 3: { success, message } Lidarr client results (~L1651, ~L1732, ~L2152) consumed by admin Lidarr management flows; frozen under the slice-E scope guard.
    "backend/src/services/lidarr.ts": 3,
    // moodBucketService.ts remaining 1: error-classification const (~L185), never a response body; frozen under the slice-E scope guard.
    // moodBucketService.ts +1: Redis retry classification's ternary-consequent error.message (~L193); frozen under the ratchet-widening (slice-X1) scope guard.
    "backend/src/services/moodBucketService.ts": 2,
    // vibeProvider.ts remaining 1: the provider's {error} body string becomes the typed VibeProvider*Error message for logs and cause chains (~parseErrorBody); routes map every provider error to canonical response text via the TextEmbeddingProviderError guard before responding, so the string never reaches a client body.
    "backend/src/services/vibeProvider.ts": 1,
    // musicScanner.ts remaining 1: per-file scan-error detail stored in scan progress/health records (~L211); server-side scan state, admin-only surface.
    "backend/src/services/musicScanner.ts": 1,
    // podcastCache.ts remaining 2: cover-sync failure strings recorded server-side (~L90, ~L172); frozen under the slice-E scope guard.
    "backend/src/services/podcastCache.ts": 2,
    // podcastDownload.ts remaining 1: error-classification const (~L92), never a response body; frozen under the slice-E scope guard.
    // podcastDownload.ts +1: describePodcastDownloadError fallback (~L77) is consumed only by logger.warn calls; server-side only; frozen under the ratchet-widening (slice-B2) scope guard.
    // podcastDownload.ts +2: logger-detail and Redis-classifier ternary-consequent error.message uses (~L80 and ~L103); frozen under the ratchet-widening (slice-X1) scope guard.
    "backend/src/services/podcastDownload.ts": 4,
    // remoteTrackBackfillService.ts +2: numeric phase error counters (~L164 and ~L168); no error text; frozen under the ratchet-widening (slice-B2) scope guard.
    "backend/src/services/remoteTrackBackfillService.ts": 2,
    // rssParser.ts +1: feed-failure result's ternary-consequent error.message (~L252); frozen under the ratchet-widening (slice-X1) scope guard.
    "backend/src/services/rssParser.ts": 1,
    // simpleDownloadManager.ts remaining 4: download-job status objects (~L350, ~L371, ~L415, ~L436) persisted for the admin download-queue surface; frozen under the slice-E scope guard.
    "backend/src/services/simpleDownloadManager.ts": 4,
    // soulseek.ts remaining 9: download-result error objects and downstream aggregations/passthroughs in Soulseek orchestration; the session log is client-visible and its raw error/path entries are sanitized rather than frozen.
    "backend/src/services/soulseek.ts": 9,
    // spotify.ts +1: track-scraper error detail const consumed only by logger.debug (~L663); server-side only; frozen under the ratchet-widening (slice-B2) scope guard.
    // spotify.ts +1: the same logger-only detail's ternary-consequent error.message; frozen under the ratchet-widening (slice-X1) scope guard.
    "backend/src/services/spotify.ts": 2,
    // spotifyImport split: the prior spotifyImport.ts baseline of 14 is relocated verbatim across focused modules with the same total.
    "backend/src/services/spotifyImport/jobManagement.ts": 1,
    "backend/src/services/spotifyImport/lifecycle.ts": 3,
    "backend/src/services/spotifyImport/matching.ts": 2,
    "backend/src/services/spotifyImport/preview.ts": 2,
    "backend/src/services/spotifyImport/state.ts": 6,
    // youtubeDownload.ts remaining 4: sidecar job-state plumbing — data.error in the per-video mapper (~L433), and data.errors / entry.error / data.error in the album-job mapper (~L443-459). The sidecar sanitizes these to code-owned generic strings ("Track download failed", "Album download failed") before they enter any payload; frozen under the slice-J scope guard.
    "backend/src/services/youtubeDownload.ts": 4,
    // queueCleaner.ts remaining 2: Prisma/retry error classification used only to decide whether the internal cleanup job retries.
    "backend/src/jobs/queueCleaner.ts": 2,
    // errorHandler.ts remaining 5: typed AppError fields plus development-only unknown-error detail; this is an existing transport-boundary policy exception frozen as the middleware root enters the ratchet.
    "backend/src/middleware/errorHandler.ts": 5,
    // dataIntegrity.ts remaining 2: Prisma/retry error classification used only by internal worker retry decisions.
    "backend/src/workers/dataIntegrity.ts": 2,
    // index.ts remaining 4: one scheduler retry classifier, one numeric error counter, and two worker-result details used only in scoped server logs.
    "backend/src/workers/index.ts": 4,
    // moodBucketWorker.ts remaining 2: internal retry classification and a scoped server-log diagnostic.
    "backend/src/workers/moodBucketWorker.ts": 2,
    // organizeSingles.ts is explicitly frozen at zero after sanitizing its client-visible session-log errors and absolute paths.
    "backend/src/workers/organizeSingles.ts": 0,
    // discoverProcessor.ts remaining 1: Redis retry classification used only by the internal worker.
    "backend/src/workers/processors/discoverProcessor.ts": 1,
    // imageProcessor.ts remaining 1: an existing internal queue-result error field returned to its Bull processor.
    "backend/src/workers/processors/imageProcessor.ts": 1,
    // umapWorker.ts remaining 2: error normalization and an internal parent-worker message.
    "backend/src/workers/umapWorker.ts": 2,
    // unifiedEnrichment.ts remaining 13: retry classifiers, scoped worker diagnostics, and internal failure/batch-state records.
    "backend/src/workers/unifiedEnrichment.ts": 13,
});

export function countPattern(source) {
    const pattern = /res\s*\.\s*status\s*\(\s*500\s*\)\s*\.\s*json\s*\(/g;
    return source.match(pattern)?.length ?? 0;
}

export function stripLoggerCalls(source) {
    const callStart = /logger\s*\??\s*\.\s*[a-zA-Z]+\s*\(/g;
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

const ERROR_ID = String.raw`(?<![\w$.])(?:[A-Za-z_$][\w$]*(?:Error|Err)|error|err|ex|e)(?![\w$])`;
const CHAIN = String.raw`(?<![\w$.])[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*`;
const VALUE_PREFIX = String.raw`(?::\s*|=\s*|\$\{[^}]*?|(?<!\?)\?(?![.?])\s+)`;

export function countLeakPattern(source) {
    const stripped = stripLoggerCalls(source).replace(
        new RegExp(String.raw`\(\s*(${ERROR_ID})\s+as\s+[^()]*\)`, "g"),
        "$1",
    );
    const normalizedSource = stripped.replace(
        new RegExp(
            String.raw`(${ERROR_ID})\s*(\??)\s*\.\s*(message|stack|name)\b`,
            "g",
        ),
        "$1$2.$3",
    );
    const propertyPattern = new RegExp(
        String.raw`${VALUE_PREFIX}${ERROR_ID}\??\.(?:message|stack|name)\b`,
        "g",
    );
    const identifierPropertyCount = countMatches(
        normalizedSource,
        propertyPattern,
    );
    return (
        identifierPropertyCount +
        countErrorPropertyLeaks(stripped) +
        countErrorConversions(stripped) +
        countAxiosResponseDataLeaks(stripped)
    );
}

function countMatches(source, pattern) {
    return source.match(pattern)?.length ?? 0;
}

// Widened leak class: `.error` / `.errors` / `.detail` / `.details` property values on any object chain
// (result.error, err.response?.data?.detail, ...) assigned or interpolated
// outside logger.* calls. Derived access (parsedBody.error.issues,
// .error.flatten(), .error[...]) is excluded — only terminal values leak.
function countErrorPropertyLeaks(strippedSource) {
    const normalized = strippedSource.replace(
        new RegExp(
            String.raw`(${CHAIN})\s*(\??)\s*\.\s*(error|errors|detail|details)\b`,
            "g",
        ),
        "$1$2.$3",
    );
    const pattern = new RegExp(
        String.raw`${VALUE_PREFIX}${CHAIN}\??\.(?:error|errors|detail|details)\b(?!\s*(?:\??\.|\(|\[))`,
        "g",
    );
    return countMatches(normalized, pattern);
}

function countErrorConversions(strippedSource) {
    const patterns = [
        new RegExp(
            String.raw`${VALUE_PREFIX}String\s*\(\s*${ERROR_ID}\s*(?=[,)])`,
            "g",
        ),
        new RegExp(String.raw`\$\{\s*${ERROR_ID}(?:\s*\|\|[^}]*)?\s*\}`, "g"),
        new RegExp(
            String.raw`${VALUE_PREFIX}${ERROR_ID}\s*\??\s*\.\s*toString\s*\(\s*\)`,
            "g",
        ),
        new RegExp(
            String.raw`${VALUE_PREFIX}JSON\s*\.\s*stringify\s*\(\s*${ERROR_ID}\s*(?=[,)])`,
            "g",
        ),
    ];
    return patterns.reduce(
        (count, pattern) => count + countMatches(strippedSource, pattern),
        0,
    );
}

function countAxiosResponseDataLeaks(strippedSource) {
    const pattern = new RegExp(
        String.raw`${VALUE_PREFIX}${CHAIN}\s*\??\s*\.\s*response\s*\??\s*\.\s*data\b(?!\s*(?:\??\.|\(|\[))`,
        "g",
    );
    return countMatches(strippedSource, pattern);
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

const MAX_SCANNED_DIRECTORIES = 10_000;

function typescriptSourceFiles(directory) {
    const pendingDirectories = [directory];
    const sourceFiles = [];
    let scannedDirectories = 0;

    while (
        pendingDirectories.length > 0 &&
        scannedDirectories < MAX_SCANNED_DIRECTORIES
    ) {
        const currentDirectory = pendingDirectories.pop();
        scannedDirectories += 1;
        for (const entry of fs.readdirSync(currentDirectory, {
            withFileTypes: true,
        })) {
            const entryPath = path.join(currentDirectory, entry.name);
            if (entry.isDirectory() && entry.name !== "__tests__") {
                pendingDirectories.push(entryPath);
            } else if (
                entry.isFile() &&
                entry.name.endsWith(".ts") &&
                !entry.name.endsWith(".test.ts")
            ) {
                sourceFiles.push(entryPath);
            }
        }
    }

    if (pendingDirectories.length > 0) {
        throw new Error(
            `Route error scan exceeded ${MAX_SCANNED_DIRECTORIES} directories`,
        );
    }
    return sourceFiles;
}

export function collectCounts(
    repoRoot,
    counter = countPattern,
    relativeDirectory = "backend/src/routes",
) {
    const directory = path.join(repoRoot, relativeDirectory);
    return Object.fromEntries(
        typescriptSourceFiles(directory)
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

const LEAK_SCAN_DIRECTORIES = Object.freeze([
    "backend/src/routes",
    "backend/src/services",
    "backend/src/workers",
    "backend/src/jobs",
    "backend/src/middleware",
]);

export function collectLeakCounts(repoRoot) {
    return Object.assign(
        {},
        ...LEAK_SCAN_DIRECTORIES.map((relativeDirectory) =>
            collectCounts(repoRoot, countLeakPattern, relativeDirectory),
        ),
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
        collectLeakCounts(repoRoot),
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
