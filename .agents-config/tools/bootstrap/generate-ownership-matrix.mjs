#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function runCommandSafe(cmd, args, cwd = process.cwd()) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
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
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizePath(input) {
  return input.split(path.sep).join("/");
}

function parseArgs(argv) {
  const options = {
    manifest: ".agents-config/tools/bootstrap/managed-files.template.json",
    output: ".agents-config/OWNERSHIP.md",
    write: false,
    check: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--manifest": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          fail("Missing value for --manifest");
        }
        options.manifest = value.trim();
        index += 1;
        break;
      }
      case "--output": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          fail("Missing value for --output");
        }
        options.output = value.trim();
        index += 1;
        break;
      }
      case "--write":
        options.write = true;
        break;
      case "--check":
        options.check = true;
        break;
      default:
        fail(`Unknown argument: ${token}`);
    }
  }

  if (options.write === options.check) {
    fail("Specify exactly one mode: --write or --check.");
  }

  return options;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Failed to read JSON ${normalizePath(filePath)}: ${error.message}`);
  }
}

function sortByPath(a, b) {
  return a.path.localeCompare(b.path);
}

function toProfiles(profiles) {
  if (!Array.isArray(profiles) || profiles.length === 0) {
    return "all";
  }
  return profiles.join(", ");
}

function renderTable(rows, columns) {
  if (rows.length === 0) {
    return "_None._\n";
  }

  const header = `| ${columns.map((column) => column.label).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => {
    const values = columns.map((column) => String(column.value(row)).replace(/\|/g, "\\|"));
    return `| ${values.join(" | ")} |`;
  });

  return `${header}\n${divider}\n${body.join("\n")}\n`;
}

function buildOwnershipDoc({ manifestPath, managedFiles }) {
  const normalizedManifestPath = normalizePath(manifestPath);
  const normalized = managedFiles.map((entry) => ({
    path: toNonEmptyString(entry?.path) ?? "",
    profiles: Array.isArray(entry?.profiles) ? entry.profiles : [],
    authority: toNonEmptyString(entry?.authority) ?? "template",
    allowOverride: entry?.allow_override === true,
  })).filter((entry) => entry.path.length > 0);

  normalized.sort(sortByPath);

  const templateOwned = normalized.filter((entry) => entry.authority === "template");
  const structuredOwned = normalized.filter((entry) => entry.authority === "structured");
  const projectOwned = normalized.filter((entry) => entry.authority === "project");
  const overrideable = normalized.filter((entry) => entry.allowOverride);

  const lines = [];
  lines.push("# OWNERSHIP.md");
  lines.push("");
  lines.push("Managed ownership matrix for bootstrap/sync behavior.");
  lines.push(`Generated from \`${normalizedManifestPath}\`.`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Managed entries: ${normalized.length}`);
  lines.push(`- Template-owned managed entries: ${templateOwned.length}`);
  lines.push(`- Structured managed entries: ${structuredOwned.length}`);
  lines.push(`- Project-owned managed entries: ${projectOwned.length}`);
  lines.push(`- Overrideable managed entries: ${overrideable.length}`);
  lines.push("");
  lines.push("## Overrideable Managed Files");
  lines.push("");
  lines.push(
    renderTable(overrideable, [
      { label: "Path", value: (row) => `\`${row.path}\`` },
      { label: "Profiles", value: (row) => `\`${toProfiles(row.profiles)}\`` },
      { label: "Default Authority", value: (row) => `\`${row.authority}\`` },
      { label: "Local Modes", value: () => "adjacent `.override` or `.append`" },
    ]).trimEnd(),
  );
  lines.push("");
  lines.push("## Project-Owned After Initial Seed");
  lines.push("");
  lines.push(
    renderTable(projectOwned, [
      { label: "Path", value: (row) => `\`${row.path}\`` },
      { label: "Profiles", value: (row) => `\`${toProfiles(row.profiles)}\`` },
      { label: "Authority", value: () => "`project`" },
    ]).trimEnd(),
  );
  lines.push("");
  lines.push("## Structured Managed Files");
  lines.push("");
  lines.push(
    renderTable(structuredOwned, [
      { label: "Path", value: (row) => `\`${row.path}\`` },
      { label: "Profiles", value: (row) => `\`${toProfiles(row.profiles)}\`` },
      { label: "Authority", value: () => "`structured`" },
    ]).trimEnd(),
  );
  lines.push("");
  lines.push("## Template-Owned Managed Files");
  lines.push("");
  lines.push(
    renderTable(templateOwned, [
      { label: "Path", value: (row) => `\`${row.path}\`` },
      { label: "Profiles", value: (row) => `\`${toProfiles(row.profiles)}\`` },
      { label: "Authority", value: () => "`template`" },
    ]).trimEnd(),
  );
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("- Project-owned managed files are seeded once and then maintained locally.");
  lines.push("- Structured managed files keep template-defined required sections/paths while preserving project-authored content.");
  lines.push("- Template-owned managed files continue to follow template sync behavior.");
  lines.push("- Generated artifacts may still be policy-required even when they are not managed entries.");

  return `${lines.join("\n")}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolveRepoRoot();
  process.chdir(repoRoot);

  const manifestPath = path.resolve(repoRoot, args.manifest);
  if (!fs.existsSync(manifestPath)) {
    fail(`Managed manifest not found: ${normalizePath(path.relative(repoRoot, manifestPath))}`);
  }

  const manifest = readJson(manifestPath);
  const managedFiles = Array.isArray(manifest?.managed_files) ? manifest.managed_files : [];
  if (managedFiles.length === 0) {
    fail("Managed manifest defines no managed_files entries.");
  }

  const outputPath = path.resolve(repoRoot, args.output);
  const expected = buildOwnershipDoc({
    manifestPath: path.relative(repoRoot, manifestPath),
    managedFiles,
  });

  if (args.write) {
    fs.writeFileSync(outputPath, expected, "utf8");
    console.log(`Wrote ${normalizePath(path.relative(repoRoot, outputPath))}`);
    return;
  }

  if (!fs.existsSync(outputPath)) {
    fail(`Ownership matrix missing: ${normalizePath(path.relative(repoRoot, outputPath))}`);
  }

  const actual = fs.readFileSync(outputPath, "utf8");
  if (actual !== expected) {
    fail(
      `Ownership matrix drift detected: ${normalizePath(path.relative(repoRoot, outputPath))}. Run with --write.`,
    );
  }

  console.log(`Ownership matrix check passed: ${normalizePath(path.relative(repoRoot, outputPath))}`);
}

main();
