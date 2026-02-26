#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_MANIFEST_PATH = ".agents-config/agent-managed.json";
const DEFAULT_PROFILES = ["base", "node-web"];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function toNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const text = toNonEmptyString(entry);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    out.push(text);
  }
  return out;
}

function parseArgs(argv) {
  const args = {
    manifestPath: DEFAULT_MANIFEST_PATH,
    baseRef: "",
    prBodyFile: "",
    profilesOverride: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      fail(`Unexpected positional argument: ${token}`);
    }

    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for --${key}`);
    }
    i += 1;

    if (key === "manifest") {
      args.manifestPath = value;
      continue;
    }
    if (key === "base-ref") {
      args.baseRef = value;
      continue;
    }
    if (key === "pr-body-file") {
      args.prBodyFile = value;
      continue;
    }
    if (key === "profiles") {
      args.profilesOverride = value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      continue;
    }

    fail(`Unknown option: --${key}`);
  }

  return args;
}

function resolveRepoRoot() {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const root = toNonEmptyString(result.stdout);
  if (result.status === 0 && root) {
    return path.resolve(root);
  }
  return process.cwd();
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Unable to parse JSON at ${filePath}: ${error.message}`);
  }
}

function resolveActiveProfiles(manifest, args) {
  const manifestProfiles = normalizeStringArray(manifest?.profiles);
  const selected = args.profilesOverride.length > 0 ? args.profilesOverride : manifestProfiles;
  const activeProfiles = selected.length > 0 ? selected : DEFAULT_PROFILES;
  return new Set(activeProfiles);
}

function profileApplies(entry, activeProfiles) {
  const requiredProfiles = normalizeStringArray(entry?.profiles);
  if (requiredProfiles.length === 0) {
    return true;
  }
  return requiredProfiles.some((profile) => activeProfiles.has(profile));
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patternToRegex(pattern) {
  let escaped = escapeRegex(pattern);
  escaped = escaped.replace(/\\\*\\\*/g, ".*");
  escaped = escaped.replace(/\\\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function matchesPattern(filePath, pattern) {
  const normalizedFile = normalizePath(filePath);
  const normalizedPattern = normalizePath(pattern);

  if (normalizedPattern.includes("*")) {
    return patternToRegex(normalizedPattern).test(normalizedFile);
  }

  if (normalizedPattern.endsWith("/")) {
    return normalizedFile.startsWith(normalizedPattern);
  }

  return (
    normalizedFile === normalizedPattern ||
    normalizedFile.startsWith(`${normalizedPattern}/`)
  );
}

function parseDiffFiles(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => normalizePath(line));
}

function resolveChangedFiles(repoRoot, baseRef) {
  const candidates = [];

  const explicitBase = toNonEmptyString(baseRef);
  if (explicitBase) {
    candidates.push(explicitBase);
  }

  const envBase = toNonEmptyString(process.env.GITHUB_BASE_REF);
  if (envBase) {
    candidates.push(`origin/${envBase}`);
    candidates.push(envBase);
  }

  candidates.push("HEAD~1");

  const seen = new Set();
  for (const candidate of candidates) {
    const value = toNonEmptyString(candidate);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);

    const diff = runGit(["diff", "--name-only", `${value}...HEAD`], repoRoot);
    if (diff.ok) {
      return parseDiffFiles(diff.stdout);
    }
  }

  fail("Unable to resolve changed files for template-impact check (could not diff against base ref).");
}

function loadPrBody(repoRoot, args) {
  const file = toNonEmptyString(args.prBodyFile);
  if (file) {
    const full = path.resolve(repoRoot, file);
    if (!fs.existsSync(full)) {
      fail(`PR body file not found: ${normalizePath(path.relative(repoRoot, full))}`);
    }
    return fs.readFileSync(full, "utf8");
  }

  return (
    process.env.PR_BODY ??
    process.env.GITHUB_PR_BODY ??
    ""
  );
}

function parseDeclaration(text, key) {
  const regex = new RegExp(`^${key}:\\s*(.+)$`, "im");
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolveRepoRoot();
  process.chdir(repoRoot);

  const manifestPath = path.resolve(repoRoot, args.manifestPath);
  if (!fs.existsSync(manifestPath)) {
    fail(`Managed manifest not found: ${normalizePath(path.relative(repoRoot, manifestPath))}`);
  }

  const manifest = readJson(manifestPath);
  const activeProfiles = resolveActiveProfiles(manifest, args);

  const meaningfulEntries = Array.isArray(manifest?.meaningful_paths)
    ? manifest.meaningful_paths.filter((entry) => profileApplies(entry, activeProfiles))
    : [];

  if (meaningfulEntries.length === 0) {
    console.log("No meaningful paths configured for active profiles; template-impact check skipped.");
    return;
  }

  const changedFiles = resolveChangedFiles(repoRoot, args.baseRef);
  const matchedFiles = [];

  for (const filePath of changedFiles) {
    let matched = false;
    for (const entry of meaningfulEntries) {
      const pattern = toNonEmptyString(entry?.path);
      if (!pattern) {
        continue;
      }
      if (matchesPattern(filePath, pattern)) {
        matched = true;
        break;
      }
    }

    if (matched) {
      matchedFiles.push(filePath);
    }
  }

  if (matchedFiles.length === 0) {
    console.log("Template-impact check passed (no meaningful managed paths changed).");
    return;
  }

  const prBody = loadPrBody(repoRoot, args);
  const impactValue = parseDeclaration(prBody, "Template-Impact").toLowerCase();

  if (!impactValue) {
    console.error("Template-impact declaration missing.");
    console.error("Required PR body field: Template-Impact: yes|none");
    console.error("Changed meaningful paths:");
    for (const filePath of matchedFiles) {
      console.error(`- ${filePath}`);
    }
    process.exit(1);
  }

  if (!["yes", "none"].includes(impactValue)) {
    fail(`Template-Impact must be \"yes\" or \"none\" (found: ${impactValue}).`);
  }

  if (impactValue === "yes") {
    const templateRef = parseDeclaration(prBody, "Template-Ref");
    if (!templateRef) {
      fail("Template-Impact is yes, but Template-Ref is missing.");
    }
  }

  if (impactValue === "none") {
    const reason = parseDeclaration(prBody, "Template-Impact-Reason");
    if (!reason) {
      fail("Template-Impact is none, but Template-Impact-Reason is missing.");
    }
  }

  console.log(`Template-impact check passed (${matchedFiles.length} meaningful changed paths).`);
}

run();
