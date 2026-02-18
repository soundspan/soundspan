#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const RELEASE_IMAGE_SECTIONS = [
  "aio",
  "backend",
  "backendWorker",
  "frontend",
  "tidalSidecar",
  "ytmusicStreamer",
  "audioAnalyzer",
  "audioAnalyzerClap",
];

const PACKAGE_TARGETS = [
  {
    label: "frontend",
    dir: "frontend",
    expectedName: "soundspan-frontend",
  },
  {
    label: "backend",
    dir: "backend",
    expectedName: "soundspan-backend",
  },
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      fail(`Unexpected positional argument: ${token}`);
    }

    const key = token.slice(2).trim();
    if (!key) {
      fail("Invalid empty flag.");
    }

    if (key === "write" || key === "check") {
      options.set(key, "true");
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for --${key}`);
    }

    options.set(key, value.trim());
    index += 1;
  }

  return options;
}

function ensureReleaseVersion(versionText) {
  if (!versionText) {
    fail("Release version is required (for example 1.6.0).");
  }
  if (versionText.startsWith("v")) {
    fail(
      `Invalid version "${versionText}". Use semantic versions without a \"v\" prefix (for example 1.6.0).`,
    );
  }

  const semverPattern =
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  if (!semverPattern.test(versionText)) {
    fail(
      `Invalid release version "${versionText}". Expected semantic version (for example 1.6.0 or 1.6.0-rc.1).`,
    );
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Failed to read JSON at ${filePath}: ${error.message}`);
  }
}

function parseChartYaml(chartYamlPath) {
  const content = fs.readFileSync(chartYamlPath, "utf8");
  const versionMatch = content.match(/^version:\s*([^\n]+)$/m);
  const appVersionMatch = content.match(/^appVersion:\s*"?([^"\n]+)"?$/m);

  if (!versionMatch) {
    fail(`Missing version field in ${chartYamlPath}.`);
  }
  if (!appVersionMatch) {
    fail(`Missing appVersion field in ${chartYamlPath}.`);
  }

  return {
    version: versionMatch[1].trim(),
    appVersion: appVersionMatch[1].trim(),
  };
}

function parseReleaseImageTags(valuesYamlPath) {
  const lines = fs.readFileSync(valuesYamlPath, "utf8").split(/\r?\n/);
  const targetSections = new Set(RELEASE_IMAGE_SECTIONS);
  const tags = new Map();

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

    if (!currentTopLevelSection || !targetSections.has(currentTopLevelSection)) {
      continue;
    }

    if (/^  image:\s*$/.test(line)) {
      inTargetImageBlock = true;
      continue;
    }

    if (inTargetImageBlock && /^  [A-Za-z][A-Za-z0-9]*:\s*$/.test(line)) {
      inTargetImageBlock = false;
      continue;
    }

    if (inTargetImageBlock) {
      const tagMatch = /^    tag:\s*([^\s#]+)\s*$/.exec(line);
      if (tagMatch) {
        tags.set(currentTopLevelSection, tagMatch[1]);
      }
    }
  }

  return tags;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });

  if (result.status !== 0) {
    fail(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function assertPackageSurface(target, releaseVersion) {
  const packageJsonPath = path.join(target.dir, "package.json");
  const lockJsonPath = path.join(target.dir, "package-lock.json");

  if (!fs.existsSync(packageJsonPath)) {
    fail(`Missing package manifest: ${packageJsonPath}`);
  }
  if (!fs.existsSync(lockJsonPath)) {
    fail(`Missing lockfile: ${lockJsonPath}`);
  }

  const packageJson = readJson(packageJsonPath);
  const lockJson = readJson(lockJsonPath);
  const lockRoot = lockJson.packages?.[""];

  if (packageJson.name !== target.expectedName) {
    fail(
      `${packageJsonPath} name mismatch. Expected "${target.expectedName}", found "${packageJson.name}".`,
    );
  }

  if (lockJson.name !== target.expectedName) {
    fail(
      `${lockJsonPath} top-level name mismatch. Expected "${target.expectedName}", found "${lockJson.name}".`,
    );
  }

  if (!lockRoot || lockRoot.name !== target.expectedName) {
    fail(
      `${lockJsonPath} packages[\"\"] name mismatch. Expected "${target.expectedName}".`,
    );
  }

  if (releaseVersion) {
    if (packageJson.version !== releaseVersion) {
      fail(
        `${packageJsonPath} version mismatch. Expected "${releaseVersion}", found "${packageJson.version}".`,
      );
    }

    if (lockJson.version !== releaseVersion) {
      fail(
        `${lockJsonPath} top-level version mismatch. Expected "${releaseVersion}", found "${lockJson.version}".`,
      );
    }

    if (lockRoot.version !== releaseVersion) {
      fail(
        `${lockJsonPath} packages[\"\"] version mismatch. Expected "${releaseVersion}", found "${lockRoot.version}".`,
      );
    }
  }
}

function verifyAllSurfaces(releaseVersion) {
  for (const target of PACKAGE_TARGETS) {
    assertPackageSurface(target, releaseVersion);
  }

  const chartYamlPath = path.join("charts", "soundspan", "Chart.yaml");
  const valuesYamlPath = path.join("charts", "soundspan", "values.yaml");

  if (!fs.existsSync(chartYamlPath)) {
    fail(`Missing Helm chart manifest: ${chartYamlPath}`);
  }
  if (!fs.existsSync(valuesYamlPath)) {
    fail(`Missing Helm values: ${valuesYamlPath}`);
  }

  const chart = parseChartYaml(chartYamlPath);
  if (chart.version !== releaseVersion) {
    fail(
      `${chartYamlPath} version mismatch. Expected "${releaseVersion}", found "${chart.version}".`,
    );
  }
  if (chart.appVersion !== releaseVersion) {
    fail(
      `${chartYamlPath} appVersion mismatch. Expected "${releaseVersion}", found "${chart.appVersion}".`,
    );
  }

  const tags = parseReleaseImageTags(valuesYamlPath);
  const missingSections = RELEASE_IMAGE_SECTIONS.filter(
    (section) => !tags.has(section),
  );
  if (missingSections.length > 0) {
    fail(
      `${valuesYamlPath} is missing image tag entries for section(s): ${missingSections.join(", ")}.`,
    );
  }

  const mismatchedSections = RELEASE_IMAGE_SECTIONS.filter(
    (section) => tags.get(section) !== releaseVersion,
  );

  if (mismatchedSections.length > 0) {
    const details = mismatchedSections
      .map((section) => `${section}=${tags.get(section)}`)
      .join(", ");
    fail(
      `${valuesYamlPath} release image tags do not match ${releaseVersion}: ${details}.`,
    );
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const releaseVersion = options.get("version")?.trim() ?? "";
  ensureReleaseVersion(releaseVersion);

  const writeMode = options.has("write");
  const checkMode = options.has("check");

  if (writeMode && checkMode) {
    fail("Use either --write or --check, not both.");
  }

  const mode = writeMode ? "write" : "check";

  for (const target of PACKAGE_TARGETS) {
    assertPackageSurface(target);
  }

  if (mode === "write") {
    for (const target of PACKAGE_TARGETS) {
      runCommand("npm", [
        "--prefix",
        target.dir,
        "version",
        releaseVersion,
        "--no-git-tag-version",
        "--allow-same-version",
      ]);
    }

    runCommand("node", [
      ".github/scripts/prepare-helm-chart-release.mjs",
      "--chart-dir",
      "charts/soundspan",
      "--release-tag",
      releaseVersion,
    ]);
  }

  verifyAllSurfaces(releaseVersion);

  console.log(
    mode === "write"
      ? `Release surfaces updated and verified for ${releaseVersion}.`
      : `Release surfaces already aligned for ${releaseVersion}.`,
  );

  console.log("Validated package names:");
  for (const target of PACKAGE_TARGETS) {
    console.log(`- ${target.expectedName}`);
  }
}

main();
