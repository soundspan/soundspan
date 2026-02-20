#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const FEATURE_INDEX_FILE = "docs/FEATURE_INDEX.json";
const FRONTEND_FEATURES_ROOT = "frontend/features";

function runCommandSafe(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    ok: !result.error && result.status === 0,
    stdout: (result.stdout ?? "").trim(),
  };
}

function resolveRepoRoot() {
  const gitRoot = runCommandSafe("git", ["rev-parse", "--show-toplevel"]);
  if (gitRoot.ok && gitRoot.stdout) {
    return path.resolve(gitRoot.stdout);
  }
  return process.cwd();
}

function toNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => toNonEmptyString(item))
    .filter((item) => item !== null);
}

function sortUnique(items) {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}

function listFrontendFeatureDirs(repoRoot) {
  const featuresAbs = path.resolve(repoRoot, FRONTEND_FEATURES_ROOT);
  if (!fs.existsSync(featuresAbs)) {
    return [];
  }
  return fs
    .readdirSync(featuresAbs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function readFeatureIndex(repoRoot) {
  const featureIndexAbs = path.resolve(repoRoot, FEATURE_INDEX_FILE);
  if (!fs.existsSync(featureIndexAbs)) {
    throw new Error(`Missing ${FEATURE_INDEX_FILE}`);
  }
  const raw = fs.readFileSync(featureIndexAbs, "utf8");
  return JSON.parse(raw);
}

function minus(left, rightSet) {
  return left.filter((item) => !rightSet.has(item));
}

function main() {
  const args = new Set(process.argv.slice(2));
  const strict = args.has("--strict");
  const jsonOutput = args.has("--json");

  const repoRoot = resolveRepoRoot();
  const issues = [];

  let featureIndex;
  try {
    featureIndex = readFeatureIndex(repoRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (jsonOutput) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: message }, null, 2)}\n`,
      );
      process.exit(2);
    }
    console.error(`Feature index check failed: ${message}`);
    process.exit(2);
  }

  const actualFeatureDirs = listFrontendFeatureDirs(repoRoot);
  const actualSet = new Set(actualFeatureDirs);

  const coverageDirs = sortUnique(
    normalizeStringArray(featureIndex?.coverage?.frontend_feature_dirs),
  );
  const coverageSet = new Set(coverageDirs);

  const features = Array.isArray(featureIndex?.features)
    ? featureIndex.features
    : [];

  const featureIds = [];
  const mappedDirsRaw = [];
  for (const feature of features) {
    const featureId = toNonEmptyString(feature?.id);
    if (featureId) {
      featureIds.push(featureId);
    } else {
      issues.push("Found feature entry without a valid non-empty `id`.");
    }

    const mappedDirs = normalizeStringArray(feature?.frontend?.feature_dirs);
    mappedDirsRaw.push(...mappedDirs);
  }

  const mappedDirs = sortUnique(mappedDirsRaw);
  const mappedSet = new Set(mappedDirs);

  const duplicateFeatureIds = featureIds.filter(
    (item, index) => featureIds.indexOf(item) !== index,
  );

  const missingInCoverage = minus(actualFeatureDirs, coverageSet);
  const unknownInCoverage = minus(coverageDirs, actualSet);
  const uncoveredByFeatures = minus(coverageDirs, mappedSet);
  const mappedUnknown = minus(mappedDirs, actualSet);

  if (duplicateFeatureIds.length > 0) {
    issues.push(
      `Duplicate feature IDs in ${FEATURE_INDEX_FILE}: ${sortUnique(duplicateFeatureIds).join(", ")}`,
    );
  }
  if (missingInCoverage.length > 0) {
    issues.push(
      `Missing directories in coverage.frontend_feature_dirs: ${missingInCoverage.join(", ")}`,
    );
  }
  if (unknownInCoverage.length > 0) {
    issues.push(
      `Unknown directories listed in coverage.frontend_feature_dirs: ${unknownInCoverage.join(", ")}`,
    );
  }
  if (uncoveredByFeatures.length > 0) {
    issues.push(
      `Directories listed in coverage.frontend_feature_dirs but not mapped by any features[].frontend.feature_dirs: ${uncoveredByFeatures.join(", ")}`,
    );
  }
  if (mappedUnknown.length > 0) {
    issues.push(
      `features[].frontend.feature_dirs references unknown directories: ${mappedUnknown.join(", ")}`,
    );
  }

  const result = {
    ok: issues.length === 0,
    feature_index_file: FEATURE_INDEX_FILE,
    frontend_features_root: FRONTEND_FEATURES_ROOT,
    actual_frontend_feature_dirs: actualFeatureDirs,
    coverage_frontend_feature_dirs: coverageDirs,
    mapped_frontend_feature_dirs: mappedDirs,
    missing_in_coverage: missingInCoverage,
    unknown_in_coverage: unknownInCoverage,
    uncovered_by_features: uncoveredByFeatures,
    mapped_unknown: mappedUnknown,
    issues,
  };

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    console.log("Feature index coverage check");
    console.log(`- File: ${FEATURE_INDEX_FILE}`);
    console.log(`- Frontend features root: ${FRONTEND_FEATURES_ROOT}`);
    console.log(
      `- Actual frontend feature dirs (${actualFeatureDirs.length}): ${actualFeatureDirs.join(", ") || "(none)"}`,
    );
    if (issues.length === 0) {
      console.log("- Result: OK");
    } else {
      console.log("- Result: ISSUES FOUND");
      for (const issue of issues) {
        console.log(`  - ${issue}`);
      }

      if (missingInCoverage.length > 0) {
        console.log(
          `- Suggestion: add these to coverage.frontend_feature_dirs in ${FEATURE_INDEX_FILE}: ${missingInCoverage.join(", ")}`,
        );
      }
      if (uncoveredByFeatures.length > 0) {
        console.log(
          `- Suggestion: add or update feature entries so frontend.feature_dirs includes: ${uncoveredByFeatures.join(", ")}`,
        );
      }
    }
  }

  if (strict && issues.length > 0) {
    process.exit(1);
  }
}

main();
