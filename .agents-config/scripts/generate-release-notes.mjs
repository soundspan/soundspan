#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  CHANGELOG_PATH,
  extractSectionBullets,
  findSectionByKey,
  parseChangelog,
  pickBulletsByHeadingAliases,
  readChangelog,
} from "./changelog-utils.mjs";

const TEMPLATE_PATH = ".agents-config/docs/RELEASE_NOTES_TEMPLATE.md";
const DEFAULT_REPO_WEB_URL = "https://github.com/soundspan/soundspan";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
  });

  if (result.error) {
    fail(`Failed to execute ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    fail(stderr || `Command failed: ${command} ${args.join(" ")}`);
  }

  return (result.stdout ?? "").trim();
}

function parseArgs(argv) {
  const options = {
    knownIssues: [],
    compatibilityNotes: [],
  };
  const repeatableFlags = new Set(["known-issue", "compat-note"]);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      fail(`Unexpected positional argument: ${token}`);
    }

    const key = token.slice(2).trim();
    if (!key) {
      fail("Invalid empty flag.");
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for --${key}`);
    }
    index += 1;

    if (repeatableFlags.has(key)) {
      if (key === "known-issue") {
        options.knownIssues.push(value.trim());
      } else if (key === "compat-note") {
        options.compatibilityNotes.push(value.trim());
      }
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(options, key)) {
      fail(`Duplicate flag: --${key}`);
    }
    options[key] = value.trim();
  }

  return options;
}

function ensureReleaseVersion(versionText) {
  if (!versionText) {
    fail("Release version is required (for example 1.0.1).");
  }
  if (versionText.startsWith("v")) {
    fail(
      `Invalid version "${versionText}". Use semantic versions without a "v" prefix (for example 1.0.1).`,
    );
  }

  const semverPattern =
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  if (!semverPattern.test(versionText)) {
    fail(
      `Invalid release version "${versionText}". Expected semantic version (for example 1.0.1 or 1.0.1-rc.1).`,
    );
  }
}

function ensureRefExists(refName, label) {
  if (!refName) {
    fail(`${label} git ref is required.`);
  }
  runCommand("git", ["rev-parse", "--verify", `${refName}^{commit}`]);
}

function normalizeRepoWebUrl(remoteUrl) {
  if (!remoteUrl) {
    return null;
  }

  const httpsMatch = remoteUrl.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (httpsMatch) {
    return `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}/${sshMatch[2]}`;
  }

  return null;
}

function resolveRepoWebUrl() {
  const result = spawnSync("git", ["config", "--get", "remote.origin.url"], {
    encoding: "utf8",
  });

  if (result.error || result.status !== 0) {
    return DEFAULT_REPO_WEB_URL;
  }

  const remoteUrl = (result.stdout ?? "").trim();
  return normalizeRepoWebUrl(remoteUrl) ?? DEFAULT_REPO_WEB_URL;
}

function formatCount(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function joinNaturalLanguage(parts) {
  if (parts.length === 0) {
    return "";
  }
  if (parts.length === 1) {
    return parts[0];
  }
  if (parts.length === 2) {
    return `${parts[0]} and ${parts[1]}`;
  }
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function buildReleaseSummary(counts, manualSummary) {
  if (manualSummary) {
    return manualSummary;
  }

  const parts = [];
  if (counts.fixed > 0) {
    parts.push(formatCount(counts.fixed, "fix", "fixes"));
  }
  if (counts.added > 0) {
    parts.push(formatCount(counts.added, "addition", "additions"));
  }
  if (counts.changed > 0) {
    parts.push(formatCount(counts.changed, "change", "changes"));
  }
  if (counts.admin > 0) {
    parts.push(
      `${formatCount(counts.admin, "admin/operations update", "admin/operations updates")}`,
    );
  }

  if (parts.length === 0) {
    return "This release does not include user-visible code changes.";
  }

  return `This release includes ${joinNaturalLanguage(parts)}.`;
}

function formatBulletBlock(items, emptyLabel) {
  if (!items || items.length === 0) {
    return `- ${emptyLabel}`;
  }
  return items.join("\n");
}

function loadReleaseItemsFromChangelog(version) {
  let parsed;
  try {
    parsed = parseChangelog(readChangelog(CHANGELOG_PATH));
  } catch (error) {
    fail(`Failed to parse ${CHANGELOG_PATH}: ${error.message}`);
  }

  const releaseSection = findSectionByKey(parsed, version);
  if (!releaseSection) {
    fail(
      `Missing ${CHANGELOG_PATH} section [${version}]. Run npm run release:prepare -- --version ${version} before generating release notes.`,
    );
  }

  const bulletsByHeading = extractSectionBullets(releaseSection.section.body);
  const fixed = pickBulletsByHeadingAliases(bulletsByHeading, ["Fixed", "Fixes"]);
  const added = pickBulletsByHeadingAliases(bulletsByHeading, ["Added", "New"]);
  const changed = pickBulletsByHeadingAliases(bulletsByHeading, [
    "Changed",
    "Updated",
  ]);
  const admin = pickBulletsByHeadingAliases(bulletsByHeading, [
    "Admin/Operations",
    "Admin",
    "Operations",
  ]);
  const breaking = pickBulletsByHeadingAliases(bulletsByHeading, [
    "Breaking Changes",
    "Breaking",
  ]);

  return {
    fixed,
    added,
    changed,
    admin,
    breaking,
  };
}

function renderTemplate(templateText, replacements) {
  let rendered = templateText;
  for (const [token, value] of Object.entries(replacements)) {
    if (!rendered.includes(token)) {
      fail(`Template token missing from ${TEMPLATE_PATH}: ${token}`);
    }
    rendered = rendered.split(token).join(value);
  }
  return rendered;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = options.version ?? "";
  const fromRef = options.from ?? "";
  const toRef = options.to ?? "HEAD";
  const outputPath = options.output;

  ensureReleaseVersion(version);
  ensureRefExists(fromRef, "--from");
  ensureRefExists(toRef, "--to");

  const repoWebUrl = resolveRepoWebUrl();
  const compareUrl = `${repoWebUrl}/compare/${encodeURIComponent(fromRef)}...${encodeURIComponent(toRef)}`;
  const releaseDate = new Date().toISOString().slice(0, 10);
  const categorized = loadReleaseItemsFromChangelog(version);

  const counts = {
    fixed: categorized.fixed.length,
    added: categorized.added.length,
    changed: categorized.changed.length,
    admin: categorized.admin.length,
  };

  const summary = buildReleaseSummary(counts, options.summary);
  const knownIssues = formatBulletBlock(
    options.knownIssues,
    "None documented in this release.",
  );
  const compatibilityNotes = formatBulletBlock(
    options.compatibilityNotes,
    "No manual migration steps required for standard Docker and Helm deployments.",
  );

  const templateText = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const rendered = renderTemplate(templateText, {
    "{{VERSION}}": version,
    "{{RELEASE_DATE}}": releaseDate,
    "{{COMPARE_URL}}": `[${fromRef}...${toRef}](${compareUrl})`,
    "{{RELEASE_SUMMARY}}": summary,
    "{{FIXED_ITEMS}}": formatBulletBlock(
      categorized.fixed,
      "No bug fixes documented in this release.",
    ),
    "{{ADDED_ITEMS}}": formatBulletBlock(
      categorized.added,
      "No new features documented in this release.",
    ),
    "{{CHANGED_ITEMS}}": formatBulletBlock(
      categorized.changed,
      "No behavior changes documented in this release.",
    ),
    "{{ADMIN_ITEMS}}": formatBulletBlock(
      categorized.admin,
      "No admin/operations updates documented in this release.",
    ),
    "{{BREAKING_ITEMS}}": formatBulletBlock(
      categorized.breaking,
      "None documented in this release.",
    ),
    "{{KNOWN_ISSUES}}": knownIssues,
    "{{COMPATIBILITY_AND_MIGRATION}}": compatibilityNotes,
    "{{FULL_CHANGELOG_URL}}": compareUrl,
  });

  if (outputPath) {
    const outputAbsolutePath = path.resolve(outputPath);
    fs.writeFileSync(outputAbsolutePath, rendered, "utf8");
    console.log(`Release notes written to ${outputAbsolutePath}`);
    return;
  }

  process.stdout.write(`${rendered}\n`);
}

main();
