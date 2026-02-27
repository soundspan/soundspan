#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  CHANGELOG_PATH,
  STANDARD_CHANGELOG_CATEGORIES,
  findSectionByKey,
  parseChangelog,
  readChangelog,
} from "./changelog-utils.mjs";

const TEMPLATE_PATH = ".agents-config/docs/RELEASE_NOTES_TEMPLATE.md";
const RELEASE_VERIFY_SCRIPT = ".agents-config/scripts/release-version-sync.mjs";
const REQUIRED_TEMPLATE_SECTIONS = [
  "## Release Summary",
  "## Fixed",
  "## Added",
  "## Changed",
  "## Admin/Operations",
  "## Deployment and Distribution",
  "## Breaking Changes",
  "## Known Issues",
  "## Compatibility and Migration",
  "## Full Changelog",
];
const REQUIRED_TEMPLATE_TOKENS = [
  "{{VERSION}}",
  "{{RELEASE_DATE}}",
  "{{COMPARE_URL}}",
  "{{RELEASE_SUMMARY}}",
  "{{FIXED_ITEMS}}",
  "{{ADDED_ITEMS}}",
  "{{CHANGED_ITEMS}}",
  "{{ADMIN_ITEMS}}",
  "{{BREAKING_ITEMS}}",
  "{{KNOWN_ISSUES}}",
  "{{COMPATIBILITY_AND_MIGRATION}}",
  "{{FULL_CHANGELOG_URL}}",
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function isSemver(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function ensureReleaseTemplateContract() {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    fail(`Missing release notes template: ${TEMPLATE_PATH}`);
  }
  const content = fs.readFileSync(TEMPLATE_PATH, "utf8");

  for (const section of REQUIRED_TEMPLATE_SECTIONS) {
    if (!content.includes(section)) {
      fail(`${TEMPLATE_PATH} missing required section: ${section}`);
    }
  }
  for (const token of REQUIRED_TEMPLATE_TOKENS) {
    if (!content.includes(token)) {
      fail(`${TEMPLATE_PATH} missing required token: ${token}`);
    }
  }
}

function ensureUnreleasedShape(parsed) {
  const unreleased = findSectionByKey(parsed, "Unreleased");
  if (!unreleased) {
    fail(`${CHANGELOG_PATH} must include an [Unreleased] section.`);
  }

  for (const category of STANDARD_CHANGELOG_CATEGORIES) {
    const heading = `### ${category}`;
    if (!unreleased.section.body.includes(heading)) {
      fail(`${CHANGELOG_PATH} [Unreleased] is missing heading: ${heading}`);
    }
  }
}

function resolveLatestReleaseVersion(parsed) {
  const releaseSection = parsed.sections.find(
    (section) => section && section.key && section.key !== "Unreleased",
  );
  if (!releaseSection) {
    fail(
      `${CHANGELOG_PATH} must include at least one released semver section so release verification can run.`,
    );
  }
  if (!isSemver(releaseSection.key)) {
    fail(
      `${CHANGELOG_PATH} first released section key must be semver (found: ${releaseSection.key}).`,
    );
  }
  return releaseSection.key;
}

function runReleaseVerify(version) {
  const result = spawnSync(
    "node",
    [RELEASE_VERIFY_SCRIPT, "--check", "--version", version],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    const details = (result.stderr ?? "").trim() || (result.stdout ?? "").trim();
    fail(
      `Release runtime contract verification failed for version ${version}: ${
        details || "unknown failure"
      }`,
    );
  }
}

function ensurePackageScripts() {
  const packagePath = path.resolve("package.json");
  if (!fs.existsSync(packagePath)) {
    fail("Missing package.json for release contract validation.");
  }
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const scripts = pkg?.scripts ?? {};
  const requiredScripts = [
    "release:prepare",
    "release:verify",
    "release:notes",
    "release:contract:check",
  ];
  for (const scriptName of requiredScripts) {
    const value = typeof scripts[scriptName] === "string" ? scripts[scriptName].trim() : "";
    if (!value) {
      fail(`package.json scripts must define "${scriptName}".`);
    }
  }
}

function main() {
  ensureReleaseTemplateContract();
  ensurePackageScripts();

  let parsed;
  try {
    parsed = parseChangelog(readChangelog(CHANGELOG_PATH));
  } catch (error) {
    fail(`Failed to parse ${CHANGELOG_PATH}: ${error.message}`);
  }

  ensureUnreleasedShape(parsed);
  const latestVersion = resolveLatestReleaseVersion(parsed);
  runReleaseVerify(latestVersion);

  console.log(
    `Release contract check passed (template + changelog + release runtime verified against ${latestVersion}).`,
  );
}

main();
