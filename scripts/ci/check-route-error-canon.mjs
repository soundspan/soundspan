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

export function countPattern(source) {
  const pattern = /res\s*\.\s*status\s*\(\s*500\s*\)\s*\.\s*json\s*\(/g;
  return source.match(pattern)?.length ?? 0;
}

export function analyzeRouteErrorCanon(counts, baseline) {
  const results = Object.entries(counts).map(([file, count]) => ({
    file,
    count,
    baseline: baseline[file] ?? 0,
  }));
  const violations = results.filter((result) => result.count > result.baseline);
  const tightenable = results.filter(
    (result) => baseline[result.file] !== undefined && result.count < result.baseline,
  );

  return { ok: violations.length === 0, violations, tightenable };
}

function routeFiles(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(directory, entry.name));
}

function collectCounts(repoRoot) {
  const routesDirectory = path.join(repoRoot, "backend/src/routes");
  return Object.fromEntries(
    routeFiles(routesDirectory)
      .sort()
      .map((filePath) => {
        const relativePath = path.relative(repoRoot, filePath).split(path.sep).join("/");
        return [relativePath, countPattern(fs.readFileSync(filePath, "utf8"))];
      }),
  );
}

function printReport(result) {
  if (result.ok) {
    console.log("Route error canonicalization ratchet passed.");
  } else {
    console.error("Route error canonicalization ratchet failed:");
    for (const violation of result.violations) {
      console.error(`${violation.file}: ${violation.count} exceeds baseline ${violation.baseline}`);
    }
  }

  if (result.tightenable.length > 0) {
    console.log("Baseline can be tightened:");
    for (const item of result.tightenable) {
      console.log(`${item.file}: ${item.count} is below baseline ${item.baseline}`);
    }
  }

  console.log(
    "Use sendInternalRouteError/AppError instead; see backend/src/routes/README.md.",
  );
}

function runCli() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDirectory, "../..");
  const result = analyzeRouteErrorCanon(collectCounts(repoRoot), BASELINE);
  printReport(result);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
