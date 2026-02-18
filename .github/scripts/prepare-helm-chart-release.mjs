#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const TARGET_IMAGE_SECTIONS = [
  "aio",
  "backend",
  "backendWorker",
  "frontend",
  "tidalSidecar",
  "ytmusicStreamer",
  "audioAnalyzer",
  "audioAnalyzerClap",
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const options = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      fail(`Unexpected positional argument: ${token}`);
    }
    const key = token.slice(2).trim();
    const value = argv[i + 1];
    if (!key || !value || value.startsWith("--")) {
      fail(`Missing value for --${key || "unknown"}`);
    }
    options.set(key, value.trim());
    i += 1;
  }
  return options;
}

function ensureSemverVersion(versionText) {
  const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  if (!semverPattern.test(versionText)) {
    fail(
      `Invalid release version "${versionText}". Expected semantic version (for example 1.2.3 or 1.2.3-rc.1).`,
    );
  }
}

function updateChartYaml(chartYamlPath, chartVersion, releaseTag) {
  const original = fs.readFileSync(chartYamlPath, "utf8");

  let versionReplacements = 0;
  let appVersionReplacements = 0;

  const updated = original
    .replace(/^version:\s*.*$/m, () => {
      versionReplacements += 1;
      return `version: ${chartVersion}`;
    })
    .replace(/^appVersion:\s*.*$/m, () => {
      appVersionReplacements += 1;
      return `appVersion: "${releaseTag}"`;
    });

  if (versionReplacements !== 1) {
    fail(`Expected exactly one version field in ${chartYamlPath}.`);
  }
  if (appVersionReplacements !== 1) {
    fail(`Expected exactly one appVersion field in ${chartYamlPath}.`);
  }

  fs.writeFileSync(chartYamlPath, updated, "utf8");
}

function updateValuesYaml(valuesYamlPath, releaseTag) {
  const lines = fs.readFileSync(valuesYamlPath, "utf8").split(/\r?\n/);
  const targetSections = new Set(TARGET_IMAGE_SECTIONS);
  const updatedSections = new Set();

  let currentTopLevelSection = null;
  let inTargetImageBlock = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const topLevelMatch = /^([A-Za-z][A-Za-z0-9]*)\s*:\s*$/.exec(line);
    if (topLevelMatch) {
      currentTopLevelSection = topLevelMatch[1];
      inTargetImageBlock = false;
      continue;
    }

    if (currentTopLevelSection && targetSections.has(currentTopLevelSection)) {
      if (/^  image:\s*$/.test(line)) {
        inTargetImageBlock = true;
        continue;
      }

      if (inTargetImageBlock && /^  [A-Za-z][A-Za-z0-9]*:\s*$/.test(line)) {
        inTargetImageBlock = false;
      }

      if (inTargetImageBlock && /^    tag:\s*.*$/.test(line)) {
        lines[index] = `    tag: ${releaseTag}`;
        updatedSections.add(currentTopLevelSection);
      }
    }
  }

  const missingSections = TARGET_IMAGE_SECTIONS.filter(
    (sectionName) => !updatedSections.has(sectionName),
  );
  if (missingSections.length > 0) {
    fail(
      `Failed to update image tag fields for section(s): ${missingSections.join(", ")} in ${valuesYamlPath}.`,
    );
  }

  fs.writeFileSync(valuesYamlPath, `${lines.join("\n")}\n`, "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const chartDirArg = args.get("chart-dir");
  const releaseTagArg = args.get("release-tag");

  if (!chartDirArg) {
    fail("Missing required flag --chart-dir.");
  }
  if (!releaseTagArg) {
    fail("Missing required flag --release-tag.");
  }

  const chartDir = path.resolve(chartDirArg);
  const releaseTag = releaseTagArg.trim();
  if (!releaseTag) {
    fail("Release tag must be non-empty.");
  }
  if (releaseTag.startsWith("v")) {
    fail(
      `Invalid release tag "${releaseTag}". Use semantic versions without a "v" prefix (for example 1.2.3).`,
    );
  }

  const chartVersion = releaseTag;
  ensureSemverVersion(chartVersion);

  const chartYamlPath = path.join(chartDir, "Chart.yaml");
  const valuesYamlPath = path.join(chartDir, "values.yaml");
  if (!fs.existsSync(chartYamlPath)) {
    fail(`Chart.yaml not found at ${chartYamlPath}.`);
  }
  if (!fs.existsSync(valuesYamlPath)) {
    fail(`values.yaml not found at ${valuesYamlPath}.`);
  }

  updateChartYaml(chartYamlPath, chartVersion, releaseTag);
  updateValuesYaml(valuesYamlPath, releaseTag);

  console.log(
    `Prepared Helm chart release metadata at ${chartDir} (version=${chartVersion}, appVersion=${releaseTag}, imageTags=${releaseTag}).`,
  );
}

main();
