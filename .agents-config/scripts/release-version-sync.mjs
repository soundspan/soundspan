#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  CHANGELOG_PATH,
  assertChangelogPreparedForRelease,
  formatReleaseDate,
  prepareChangelogForRelease,
  readChangelog,
  writeChangelog,
} from "./changelog-utils.mjs";

const POLICY_PATH = ".agents-config/policies/agent-governance.json";
const DEFAULT_RELEASE_IMAGE_SECTIONS = [
  "app",
];
const DEFAULT_PACKAGE_TARGETS = [
  {
    label: "root",
    dir: ".",
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

function toNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Failed to parse JSON at ${filePath}: ${error.message}`);
  }
}

function ensureReleaseVersion(versionText) {
  if (!versionText) {
    fail("Release version is required (for example 1.6.0).");
  }
  if (versionText.startsWith("v")) {
    fail(
      `Invalid version "${versionText}". Use semantic versions without a "v" prefix (for example 1.6.0).`,
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

function parseReleaseImageTags(valuesYamlPath, releaseImageSections) {
  const lines = fs.readFileSync(valuesYamlPath, "utf8").split(/\r?\n/);
  const targetSections = new Set(releaseImageSections);
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

function updateChangelogForRelease(releaseVersion) {
  let prepared;
  try {
    prepared = prepareChangelogForRelease({
      changelogContent: readChangelog(),
      version: releaseVersion,
      releaseDate: formatReleaseDate(),
    });
  } catch (error) {
    fail(`${CHANGELOG_PATH} release-prepare update failed: ${error.message}`);
  }

  if (prepared.changed) {
    writeChangelog(prepared.content);
  }
}

function verifyChangelogForRelease(releaseVersion) {
  try {
    assertChangelogPreparedForRelease({
      changelogContent: readChangelog(),
      version: releaseVersion,
    });
  } catch (error) {
    fail(`${CHANGELOG_PATH} release-prepare validation failed: ${error.message}`);
  }
}

function normalizePackageTargets(policy) {
  const configured = policy?.contracts?.releaseVersion?.packageTargets;
  if (!Array.isArray(configured) || configured.length === 0) {
    return DEFAULT_PACKAGE_TARGETS;
  }

  const normalized = [];
  for (const target of configured) {
    const dir = toNonEmptyString(target?.dir);
    if (!dir) {
      continue;
    }

    normalized.push({
      label: toNonEmptyString(target?.label) ?? dir,
      dir,
      expectedName: toNonEmptyString(target?.expectedName),
    });
  }

  return normalized.length > 0 ? normalized : DEFAULT_PACKAGE_TARGETS;
}

function resolveHelmChartDir(policy) {
  const configuredDir = toNonEmptyString(policy?.contracts?.releaseVersion?.chartDir);
  if (configuredDir) {
    return configuredDir;
  }

  const chartName = toNonEmptyString(policy?.contracts?.releaseNotes?.helmChartName);
  if (!chartName) {
    return null;
  }
  return path.join("charts", chartName);
}

function resolveReleaseImageSections(policy) {
  const configured = policy?.contracts?.releaseVersion?.releaseImageSections;
  if (!Array.isArray(configured) || configured.length === 0) {
    return DEFAULT_RELEASE_IMAGE_SECTIONS;
  }

  const sections = configured
    .map((entry) => toNonEmptyString(entry))
    .filter((entry) => entry !== null);
  return sections.length > 0 ? sections : DEFAULT_RELEASE_IMAGE_SECTIONS;
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

  const packageName = toNonEmptyString(packageJson.name);
  if (!packageName) {
    fail(`${packageJsonPath} name must be a non-empty string.`);
  }

  const expectedName = toNonEmptyString(target.expectedName) ?? packageName;
  if (packageName !== expectedName) {
    fail(
      `${packageJsonPath} name mismatch. Expected "${expectedName}", found "${packageName}".`,
    );
  }

  if (lockJson.name !== expectedName) {
    fail(
      `${lockJsonPath} top-level name mismatch. Expected "${expectedName}", found "${lockJson.name}".`,
    );
  }

  if (!lockRoot || lockRoot.name !== expectedName) {
    fail(`${lockJsonPath} packages[""] name mismatch. Expected "${expectedName}".`);
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
        `${lockJsonPath} packages[""] version mismatch. Expected "${releaseVersion}", found "${lockRoot.version}".`,
      );
    }
  }

  return expectedName;
}

function verifyHelmSurface(releaseVersion, chartDir, releaseImageSections) {
  if (!chartDir) {
    return;
  }

  const chartYamlPath = path.join(chartDir, "Chart.yaml");
  const valuesYamlPath = path.join(chartDir, "values.yaml");

  if (!fs.existsSync(chartYamlPath) || !fs.existsSync(valuesYamlPath)) {
    console.log(`Skipping Helm surface checks (missing chart files under ${chartDir}).`);
    return;
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

  const tags = parseReleaseImageTags(valuesYamlPath, releaseImageSections);
  const missingSections = releaseImageSections.filter((section) => !tags.has(section));
  if (missingSections.length > 0) {
    fail(
      `${valuesYamlPath} is missing image tag entries for section(s): ${missingSections.join(", ")}.`,
    );
  }

  const mismatchedSections = releaseImageSections.filter(
    (section) => tags.get(section) !== releaseVersion,
  );

  if (mismatchedSections.length > 0) {
    const details = mismatchedSections
      .map((section) => `${section}=${tags.get(section)}`)
      .join(", ");
    fail(`${valuesYamlPath} release image tags do not match ${releaseVersion}: ${details}.`);
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
  const policy = readJsonIfExists(POLICY_PATH);
  const packageTargets = normalizePackageTargets(policy);
  const chartDir = resolveHelmChartDir(policy);
  const releaseImageSections = resolveReleaseImageSections(policy);

  for (const target of packageTargets) {
    assertPackageSurface(target);
  }

  if (mode === "write") {
    for (const target of packageTargets) {
      runCommand("npm", [
        "--prefix",
        target.dir,
        "version",
        releaseVersion,
        "--no-git-tag-version",
        "--allow-same-version",
      ]);
    }

    if (chartDir) {
      const chartYamlPath = path.join(chartDir, "Chart.yaml");
      const valuesYamlPath = path.join(chartDir, "values.yaml");
      if (fs.existsSync(chartYamlPath) && fs.existsSync(valuesYamlPath)) {
        runCommand("node", [
          ".agents-config/scripts/prepare-helm-chart-release.mjs",
          "--chart-dir",
          chartDir,
          "--release-tag",
          releaseVersion,
        ]);
      } else {
        console.log(`Skipping chart update (missing chart files under ${chartDir}).`);
      }
    }

    updateChangelogForRelease(releaseVersion);
  }

  const validatedPackageNames = packageTargets.map((target) =>
    assertPackageSurface(target, releaseVersion),
  );
  verifyChangelogForRelease(releaseVersion);
  verifyHelmSurface(releaseVersion, chartDir, releaseImageSections);

  console.log(
    mode === "write"
      ? `Release surfaces updated and verified for ${releaseVersion}.`
      : `Release surfaces already aligned for ${releaseVersion}.`,
  );

  console.log("Validated package names:");
  for (const packageName of validatedPackageNames) {
    console.log(`- ${packageName}`);
  }
}

main();
