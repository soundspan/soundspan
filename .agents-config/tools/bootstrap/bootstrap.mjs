#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SUPPORTED_PROFILES = new Set(["base", "node-web"]);
const SUPPORTED_BOOTSTRAP_MODES = new Set(["new", "existing"]);
const DOWNSTREAM_SCRIPT_EXCLUDES = new Set(["bootstrap"]);
const DEFAULT_AGENTS_WORKFILES_PATH = "../agents-workfiles";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function toNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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

function parseProfiles(rawProfiles) {
  const candidate = toNonEmptyString(rawProfiles) ?? "base";
  const parsed = candidate
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (parsed.length === 0) {
    fail("At least one profile must be selected.");
  }

  const unique = [];
  const seen = new Set();
  for (const profile of parsed) {
    if (!SUPPORTED_PROFILES.has(profile)) {
      fail(`Unknown profile \"${profile}\". Supported: ${[...SUPPORTED_PROFILES].join(", ")}`);
    }
    if (seen.has(profile)) {
      continue;
    }
    seen.add(profile);
    unique.push(profile);
  }

  if (!unique.includes("base")) {
    fail('The "base" profile is required.');
  }

  return unique;
}

function normalizeBootstrapMode(rawMode) {
  const mode = toNonEmptyString(rawMode) ?? "new";
  if (!SUPPORTED_BOOTSTRAP_MODES.has(mode)) {
    fail(`Invalid --mode "${mode}". Use "new" or "existing".`);
  }
  return mode;
}

function normalizeAgentsMode(rawMode) {
  const mode = toNonEmptyString(rawMode);
  if (!mode) {
    return null;
  }
  if (!["external", "local"].includes(mode)) {
    fail('Invalid --agents-mode. Use "external" or "local".');
  }
  return mode;
}

function parseArgs(argv) {
  const options = {
    mode: "new",
    projectName: "",
    targetPath: "",
    projectId: "",
    repoOwner: "",
    repoName: "",
    packageName: "",
    profiles: "base",
    agentsMode: "",
    agentsWorkfilesPath: "",
    templateRepo: "BonzTM/agents-template",
    templateRef: "main",
    skipPreflight: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--skip-preflight") {
      options.skipPreflight = true;
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
      case "mode":
        options.mode = value.trim();
        break;
      case "project-name":
        options.projectName = value.trim();
        break;
      case "target-path":
        options.targetPath = value.trim();
        break;
      case "project-id":
        options.projectId = value.trim();
        break;
      case "repo-owner":
        options.repoOwner = value.trim();
        break;
      case "repo-name":
        options.repoName = value.trim();
        break;
      case "package-name":
        options.packageName = value.trim();
        break;
      case "profiles":
        options.profiles = value.trim();
        break;
      case "agents-mode":
        options.agentsMode = value.trim();
        break;
      case "agents-workfiles-path":
        options.agentsWorkfilesPath = value.trim();
        break;
      case "template-repo":
        options.templateRepo = value.trim();
        break;
      case "template-ref":
        options.templateRef = value.trim();
        break;
      default:
        fail(`Unknown option: --${key}`);
    }
  }

  return options;
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function resolveRepoRoot() {
  const result = run("git", ["rev-parse", "--show-toplevel"], process.cwd());
  if (result.ok && result.stdout) {
    return path.resolve(result.stdout);
  }
  return process.cwd();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function parseGitHubRemote(url) {
  const value = toNonEmptyString(url);
  if (!value) {
    return null;
  }

  const sshMatch = value.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
    };
  }

  const httpsMatch = value.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (httpsMatch) {
    return {
      owner: httpsMatch[1],
      repo: httpsMatch[2],
    };
  }

  return null;
}

function inferRemoteInfo(targetRoot) {
  const remote = run("git", ["remote", "get-url", "origin"], targetRoot);
  if (!remote.ok || !remote.stdout) {
    return null;
  }
  return parseGitHubRemote(remote.stdout);
}

function entryIsActive(entry, activeProfiles) {
  const profiles = Array.isArray(entry?.profiles)
    ? entry.profiles.map((profile) => toNonEmptyString(profile)).filter(Boolean)
    : [];

  if (profiles.length === 0) {
    return true;
  }
  return profiles.some((profile) => activeProfiles.has(profile));
}

function copyManagedFiles({ templateRoot, targetRoot, manifest, profiles, mode }) {
  const activeProfiles = new Set(profiles);
  const entries = Array.isArray(manifest?.managed_files) ? manifest.managed_files : [];
  let copied = 0;
  let preserved = 0;

  for (const entry of entries) {
    if (!entryIsActive(entry, activeProfiles)) {
      continue;
    }

    const targetRelativePath = toNonEmptyString(entry?.path);
    if (!targetRelativePath) {
      continue;
    }
    const sourceRelativePath = toNonEmptyString(entry?.source_path) ?? targetRelativePath;

    const srcPath = path.resolve(templateRoot, sourceRelativePath);
    if (!fs.existsSync(srcPath)) {
      fail(`Managed source file missing in template: ${normalizePath(sourceRelativePath)}`);
    }

    const dstPath = path.resolve(targetRoot, targetRelativePath);
    const preserveExistingOverride =
      mode === "existing" &&
      entry?.allow_override === true &&
      fs.existsSync(dstPath) &&
      fs.statSync(dstPath).isFile();

    if (preserveExistingOverride) {
      preserved += 1;
      continue;
    }

    ensureDir(path.dirname(dstPath));
    fs.copyFileSync(srcPath, dstPath);
    copied += 1;
  }

  return { copied, preserved };
}

function mergePackageScripts({ templateRoot, targetRoot, packageName }) {
  const templatePackagePath = path.resolve(templateRoot, "package.json");
  const templatePackage = readJson(templatePackagePath);

  const targetPackagePath = path.resolve(targetRoot, "package.json");
  let targetPackage;
  let created = false;

  if (fs.existsSync(targetPackagePath)) {
    targetPackage = readJson(targetPackagePath);
  } else {
    targetPackage = {
      name: packageName,
      version: "0.1.0",
      private: true,
      scripts: {},
    };
    created = true;
  }

  targetPackage.scripts = targetPackage.scripts && typeof targetPackage.scripts === "object"
    ? targetPackage.scripts
    : {};

  const overwritten = [];
  const templateScripts = templatePackage.scripts && typeof templatePackage.scripts === "object"
    ? templatePackage.scripts
    : {};

  for (const [scriptName, scriptValue] of Object.entries(templateScripts)) {
    if (DOWNSTREAM_SCRIPT_EXCLUDES.has(scriptName)) {
      continue;
    }

    const current = targetPackage.scripts[scriptName];
    if (typeof current === "string" && current !== scriptValue) {
      overwritten.push(scriptName);
    }
    targetPackage.scripts[scriptName] = scriptValue;
  }

  targetPackage.devDependencies =
    targetPackage.devDependencies && typeof targetPackage.devDependencies === "object"
      ? targetPackage.devDependencies
      : {};
  const templateDevDeps =
    templatePackage.devDependencies && typeof templatePackage.devDependencies === "object"
      ? templatePackage.devDependencies
      : {};
  for (const [depName, depVersion] of Object.entries(templateDevDeps)) {
    if (!(depName in targetPackage.devDependencies)) {
      targetPackage.devDependencies[depName] = depVersion;
    }
  }

  if (!toNonEmptyString(targetPackage.name)) {
    targetPackage.name = packageName;
  }

  writeJson(targetPackagePath, targetPackage);

  const targetLockPath = path.resolve(targetRoot, "package-lock.json");
  if (!fs.existsSync(targetLockPath)) {
    const templateLock = readJson(path.resolve(templateRoot, "package-lock.json"));
    templateLock.name = targetPackage.name;
    if (templateLock.packages && templateLock.packages[""]) {
      templateLock.packages[""].name = targetPackage.name;
    }
    writeJson(targetLockPath, templateLock);
  }

  return {
    created,
    overwritten,
  };
}

function runBootstrapProject({
  targetRoot,
  templateRoot,
  projectId,
  repoOwner,
  repoName,
  packageName,
  profiles,
  agentsMode,
  agentsWorkfilesPath,
  templateRepo,
  templateRef,
  skipPreflight,
}) {
  const bootstrapScript = path.resolve(targetRoot, ".agents-config/tools/bootstrap/bootstrap-project.mjs");
  if (!fs.existsSync(bootstrapScript)) {
    fail("Missing target bootstrap script after managed copy: .agents-config/tools/bootstrap/bootstrap-project.mjs");
  }

  const templateLocalPath = normalizePath(path.relative(targetRoot, templateRoot));

  const args = [
    ".agents-config/tools/bootstrap/bootstrap-project.mjs",
    "--project-id",
    projectId,
    "--repo-owner",
    repoOwner,
    "--repo-name",
    repoName,
    "--package-name",
    packageName,
    "--profiles",
    profiles.join(","),
    "--agents-mode",
    agentsMode,
    "--template-repo",
    templateRepo,
    "--template-ref",
    templateRef,
    "--template-local-path",
    templateLocalPath,
  ];

  if (agentsMode === "external") {
    args.push("--agents-workfiles-path", agentsWorkfilesPath);
  }

  if (skipPreflight) {
    args.push("--skip-preflight");
  }

  const result = spawnSync("node", args, {
    cwd: targetRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fail("Target bootstrap-project command failed.");
  }
}

function resolveTargetRoot({ templateRoot, mode, projectName, targetPath }) {
  const explicitTarget = toNonEmptyString(targetPath);
  const normalizedProjectName = toNonEmptyString(projectName);

  if (explicitTarget) {
    return path.resolve(templateRoot, explicitTarget);
  }

  if (normalizedProjectName) {
    return path.resolve(templateRoot, "..", normalizedProjectName);
  }

  if (mode === "new") {
    fail('Missing target. Provide --project-name <name> or --target-path <path> when --mode is "new".');
  }

  fail(
    'Missing target. Provide --target-path <path> or --project-name <name> when --mode is "existing".',
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const templateRoot = resolveRepoRoot();
  const mode = normalizeBootstrapMode(args.mode);

  const targetRoot = resolveTargetRoot({
    templateRoot,
    mode,
    projectName: args.projectName,
    targetPath: args.targetPath,
  });
  if (path.resolve(targetRoot) === path.resolve(templateRoot)) {
    fail(
      "Refusing to bootstrap the template repository itself. Target a different repo via --project-name or --target-path.",
    );
  }

  if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()) {
    fail(`Target project directory not found: ${targetRoot}`);
  }

  const gitCheck = run("git", ["rev-parse", "--show-toplevel"], targetRoot);
  if (!gitCheck.ok) {
    fail(`Target directory is not a git repository: ${targetRoot}`);
  }

  const profiles = parseProfiles(args.profiles);
  const explicitAgentsMode = normalizeAgentsMode(args.agentsMode);
  const explicitWorkfilesPath = toNonEmptyString(args.agentsWorkfilesPath);
  let agentsMode = explicitAgentsMode ?? "external";
  let agentsWorkfilesPath = null;
  if (agentsMode === "local") {
    if (explicitWorkfilesPath) {
      fail("Cannot use --agents-mode local with --agents-workfiles-path.");
    }
  } else {
    agentsWorkfilesPath = explicitWorkfilesPath ?? DEFAULT_AGENTS_WORKFILES_PATH;
    if (path.isAbsolute(agentsWorkfilesPath)) {
      fail("--agents-workfiles-path must be relative to the target repository root.");
    }
  }

  const remoteInfo = inferRemoteInfo(targetRoot);
  const inferredProjectName = toNonEmptyString(args.projectName) ?? path.basename(targetRoot);
  const projectId = slugifyProjectId(args.projectId || inferredProjectName);
  const repoOwner = toNonEmptyString(args.repoOwner) ?? remoteInfo?.owner ?? "example";
  const repoName = toNonEmptyString(args.repoName) ?? remoteInfo?.repo ?? inferredProjectName;
  const packageName = toNonEmptyString(args.packageName) ?? slugifyProjectId(repoName);

  const managedManifestTemplatePath = path.resolve(
    templateRoot,
    ".agents-config/tools/bootstrap/managed-files.template.json",
  );
  if (!fs.existsSync(managedManifestTemplatePath)) {
    fail("Template manifest missing: .agents-config/tools/bootstrap/managed-files.template.json");
  }
  const managedManifestTemplate = readJson(managedManifestTemplatePath);

  const copyStats = copyManagedFiles({
    templateRoot,
    targetRoot,
    manifest: managedManifestTemplate,
    profiles,
    mode,
  });

  const packageMerge = mergePackageScripts({
    templateRoot,
    targetRoot,
    packageName,
  });

  ensureDir(path.resolve(targetRoot, ".agents-config/agent-overrides"));

  runBootstrapProject({
    targetRoot,
    templateRoot,
    projectId,
    repoOwner,
    repoName,
    packageName,
    profiles,
    agentsMode,
    agentsWorkfilesPath,
    templateRepo: args.templateRepo,
    templateRef: args.templateRef,
    skipPreflight: args.skipPreflight,
  });

  console.log(`Bootstrapped project: ${normalizePath(path.relative(templateRoot, targetRoot))}`);
  console.log(`- mode: ${mode}`);
  console.log(`- project-id: ${projectId}`);
  console.log(`- profiles: ${profiles.join(", ")}`);
  console.log(`- agents mode: ${agentsMode}`);
  if (agentsMode === "external") {
    console.log(`- agents workfiles path: ${agentsWorkfilesPath}`);
  }
  console.log(`- managed files copied: ${copyStats.copied}`);
  if (copyStats.preserved > 0) {
    console.log(
      `- preserved existing allowlisted managed files (existing mode): ${copyStats.preserved}`,
    );
  }
  if (packageMerge.created) {
    console.log("- created package.json for agent workflow scripts");
  }
  if (packageMerge.overwritten.length > 0) {
    console.log(`- overwritten package scripts: ${packageMerge.overwritten.join(", ")}`);
  }
}

main();
