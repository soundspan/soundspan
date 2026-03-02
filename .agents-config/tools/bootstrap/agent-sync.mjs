#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_TEMPLATE_REPO = "BonzTM/agents-template";
const DEFAULT_TEMPLATE_REF = "main";
const DEFAULT_TEMPLATE_LOCAL_PATH = "../agents-template";
const DEFAULT_PROFILES = ["base"];
const MANIFEST_PATH = ".agents-config/agent-managed.json";
const POLICY_PATH = ".agents-config/policies/agent-governance.json";
const TOOLING_CONFIG_PATH = ".agents-config/config/project-tooling.json";
const TEMPLATE_BOOTSTRAP_PATH = ".agents-config/tools/bootstrap/bootstrap.mjs";
const LOCAL_BOOTSTRAP_PROJECT_PATH = ".agents-config/tools/bootstrap/bootstrap-project.mjs";
const GOVERNANCE_ID_SUFFIX = "-agent-governance";
const TOOLING_ID_SUFFIX = "-tooling-config";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function toNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", encoding: "utf8" });
  if (result.error) {
    fail(`Failed to run ${cmd}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`Command failed (${cmd} ${args.join(" ")}).`);
  }
}

function runRead(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return null;
  }
  return toNonEmptyString(result.stdout);
}

function resolveRepoRoot() {
  const resolved = runRead("git", ["rev-parse", "--show-toplevel"], process.cwd());
  return resolved ? path.resolve(resolved) : process.cwd();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseProfiles(value) {
  if (!toNonEmptyString(value)) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseArgs(argv) {
  const args = {
    preferRemote: false,
    templateRepo: "",
    templateRef: "",
    profiles: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--prefer-remote") {
      args.preferRemote = true;
      continue;
    }
    if (!token.startsWith("--")) {
      fail(`Unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for --${key}`);
    }
    index += 1;
    switch (key) {
      case "template-repo":
        args.templateRepo = value.trim();
        break;
      case "template-ref":
        args.templateRef = value.trim();
        break;
      case "profiles":
        args.profiles = value.trim();
        break;
      default:
        fail(`Unknown option: --${key}`);
    }
  }

  return args;
}

function normalizePath(input) {
  return input.split(path.sep).join("/");
}

function slugifyProjectId(input) {
  const value = (toNonEmptyString(input) ?? "project")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return value || "project";
}

function deriveProjectId({ repoRoot, manifest }) {
  const explicit = toNonEmptyString(manifest?.projectId);
  if (explicit) {
    return slugifyProjectId(explicit);
  }

  const toolingConfigPath = path.resolve(repoRoot, TOOLING_CONFIG_PATH);
  if (fs.existsSync(toolingConfigPath)) {
    const toolingConfig = readJson(toolingConfigPath);
    const metadataId = toNonEmptyString(toolingConfig?.metadata?.id);
    if (metadataId && metadataId.endsWith(TOOLING_ID_SUFFIX)) {
      return slugifyProjectId(metadataId.slice(0, -TOOLING_ID_SUFFIX.length));
    }
  }

  const policyPath = path.resolve(repoRoot, POLICY_PATH);
  if (fs.existsSync(policyPath)) {
    const policy = readJson(policyPath);
    const metadataId = toNonEmptyString(policy?.metadata?.id);
    if (metadataId && metadataId.endsWith(GOVERNANCE_ID_SUFFIX)) {
      return slugifyProjectId(metadataId.slice(0, -GOVERNANCE_ID_SUFFIX.length));
    }
  }

  return slugifyProjectId(path.basename(repoRoot));
}

function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  const repoRoot = resolveRepoRoot();
  const manifestPath = path.resolve(repoRoot, MANIFEST_PATH);
  if (!fs.existsSync(manifestPath)) {
    fail(`Missing managed manifest: ${MANIFEST_PATH}`);
  }

  const manifest = readJson(manifestPath);
  const manifestProfiles = Array.isArray(manifest?.profiles)
    ? manifest.profiles.map((profile) => toNonEmptyString(profile)).filter(Boolean)
    : [];
  const cliProfiles = parseProfiles(cliArgs.profiles);
  const profiles =
    cliProfiles.length > 0
      ? cliProfiles
      : manifestProfiles.length > 0
      ? manifestProfiles
      : DEFAULT_PROFILES;

  const templateRepo =
    toNonEmptyString(cliArgs.templateRepo) ??
    toNonEmptyString(manifest?.template?.repo) ??
    DEFAULT_TEMPLATE_REPO;
  const templateRef =
    toNonEmptyString(cliArgs.templateRef) ??
    toNonEmptyString(manifest?.template?.ref) ??
    DEFAULT_TEMPLATE_REF;
  const templateLocalPath =
    toNonEmptyString(manifest?.template?.localPath) ?? DEFAULT_TEMPLATE_LOCAL_PATH;
  const agentsMode = toNonEmptyString(manifest?.agentsMode);
  const agentsWorkfilesPath = toNonEmptyString(manifest?.agentsWorkfilesPath);
  const projectId = deriveProjectId({ repoRoot, manifest });

  const templateRoot = path.resolve(repoRoot, templateLocalPath);
  const templateBootstrapPath = path.resolve(templateRoot, TEMPLATE_BOOTSTRAP_PATH);

  if (fs.existsSync(templateBootstrapPath) && fs.statSync(templateBootstrapPath).isFile()) {
    const relativeTargetPathRaw = path.relative(templateRoot, repoRoot);
    const relativeTargetPath = toNonEmptyString(normalizePath(relativeTargetPathRaw)) ?? ".";
    const bootstrapArgs = [
      templateBootstrapPath,
      "--mode",
      "existing",
      "--target-path",
      relativeTargetPath,
      "--profiles",
      profiles.join(","),
      "--template-repo",
      templateRepo,
      "--template-ref",
      templateRef,
      "--skip-preflight",
      "--project-id",
      projectId,
    ];

    if (agentsMode) {
      bootstrapArgs.push("--agents-mode", agentsMode);
      if (agentsMode === "external" && agentsWorkfilesPath) {
        bootstrapArgs.push("--agents-workfiles-path", agentsWorkfilesPath);
      }
    }
    run(process.execPath, bootstrapArgs, templateRoot);
  } else {
    const fallbackBootstrapProjectPath = path.resolve(repoRoot, LOCAL_BOOTSTRAP_PROJECT_PATH);
    if (!fs.existsSync(fallbackBootstrapProjectPath)) {
      fail(
        `Cannot find template bootstrap (${normalizePath(templateBootstrapPath)}) or local bootstrap-project (${normalizePath(fallbackBootstrapProjectPath)}).`,
      );
    }
    const bootstrapArgs = [
      fallbackBootstrapProjectPath,
      "--bootstrap-mode",
      "existing",
      "--project-id",
      projectId,
      "--profiles",
      profiles.join(","),
      "--template-repo",
      templateRepo,
      "--template-ref",
      templateRef,
      "--template-local-path",
      templateLocalPath,
      "--skip-preflight",
    ];

    if (agentsMode) {
      bootstrapArgs.push("--agents-mode", agentsMode);
      if (agentsMode === "external" && agentsWorkfilesPath) {
        bootstrapArgs.push("--agents-workfiles-path", agentsWorkfilesPath);
      }
    }
    run(process.execPath, bootstrapArgs, repoRoot);
  }

  const managedFixArgs = ["run", "agent:managed", "--", "--fix", "--recheck"];
  if (cliArgs.preferRemote) {
    managedFixArgs.push("--prefer-remote");
  }
  run("npm", managedFixArgs, repoRoot);
  run("npm", ["run", "rules:canonical:sync"], repoRoot);
  run("npm", ["run", "policy:check"], repoRoot);
  run("npm", ["run", "agent:preflight"], repoRoot);
}

main();
