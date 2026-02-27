#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SUPPORTED_PROFILES = new Set(["base", "node-web"]);
const DEFAULT_PROFILES = ["base"];
const SUPPORTED_AGENTS_MODES = new Set(["external", "local"]);
const DEFAULT_AGENTS_WORKFILES_PATH = "../agents-workfiles";
const REQUIRED_GITIGNORE_SNIPPETS = [".agents", ".agents/", ".agents/**"];
const DEFAULT_CHANGELOG_TEXT = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project follows Semantic Versioning.

## [Unreleased]

### Added
- None.

### Changed
- None.

### Fixed
- None.
`;
const NODE_WEB_PROFILE_CONTRACTS = [
  "featureIndex",
  "testMatrix",
  "routeMap",
  "domainReadmes",
  "jsdocCoverage",
  "loggingStandards",
];

const FILES = {
  policy: ".agents-config/policies/agent-governance.json",
  contextIndex: ".agents-config/docs/CONTEXT_INDEX.json",
  featureIndex: ".agents-config/docs/FEATURE_INDEX.json",
  loggingBaseline: ".agents-config/policies/logging-compliance-baseline.json",
  packageJson: "package.json",
  packageLock: "package-lock.json",
  releaseTemplate: ".agents-config/docs/RELEASE_NOTES_TEMPLATE.md",
  generateReleaseNotes: ".agents-config/scripts/generate-release-notes.mjs",
  verifyLoggingCompliance: ".agents-config/scripts/verify-logging-compliance.mjs",
  indexConfig: ".agents-config/tools/index/index.config.json",
  agentsDoc: "AGENTS.md",
  rulesDoc: ".agents-config/docs/AGENT_RULES.md",
  contextDoc: ".agents-config/docs/AGENT_CONTEXT.md",
  readme: "README.md",
  managedTemplate: ".agents-config/tools/bootstrap/managed-files.template.json",
  managedManifest: ".agents-config/agent-managed.json",
  agentsSeedTemplateRoot: ".agents-config/templates/agents",
  changelog: "CHANGELOG.md",
  gitignore: ".gitignore",
};

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

function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function normalizeRelativePath(filePath) {
  const normalized = path.posix
    .normalize(toPosixPath(filePath))
    .replace(/^\.\//, "");
  if (normalized === ".") {
    return "";
  }
  return normalized;
}

function assertSafeRepoRelativePath(candidatePath, label) {
  const normalized = normalizeRelativePath(candidatePath);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    fail(`${label} must remain inside the repository root (received: ${candidatePath}).`);
  }
}

function resolveManagedOverrideRepoPath({ entry, targetRelativePath, overrideRoot }) {
  const explicitOverridePath = toNonEmptyString(entry?.override_path);
  if (explicitOverridePath) {
    if (path.isAbsolute(explicitOverridePath)) {
      fail(
        `Managed entry ${JSON.stringify(entry?.path ?? "<unknown>")} uses absolute override_path; use a repo-relative path.`,
      );
    }
    assertSafeRepoRelativePath(
      explicitOverridePath,
      `Managed entry ${JSON.stringify(entry?.path ?? "<unknown>")} override_path`,
    );
    return normalizeRelativePath(explicitOverridePath);
  }

  const normalizedOverrideRoot = toNonEmptyString(overrideRoot)
    ? normalizeRelativePath(overrideRoot)
    : "";
  if (normalizedOverrideRoot) {
    assertSafeRepoRelativePath(normalizedOverrideRoot, "overrideRoot");
  }
  if (!normalizedOverrideRoot) {
    return null;
  }

  return normalizeRelativePath(
    path.posix.join(normalizedOverrideRoot, normalizeRelativePath(targetRelativePath)),
  );
}

function validateProjectId(projectId) {
  if (!projectId) {
    fail("Missing required --project-id <id>.");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(projectId)) {
    fail(
      `Invalid project-id "${projectId}". Use lowercase letters, numbers, '.', '_' or '-'.`,
    );
  }
}

function parseProfiles(rawProfiles) {
  const candidate = toNonEmptyString(rawProfiles) ?? DEFAULT_PROFILES.join(",");
  const parsed = candidate
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (parsed.length === 0) {
    fail("At least one profile must be provided.");
  }

  const unique = [];
  const seen = new Set();
  for (const profile of parsed) {
    if (!SUPPORTED_PROFILES.has(profile)) {
      fail(
        `Unknown profile "${profile}". Supported profiles: ${[...SUPPORTED_PROFILES].join(", ")}`,
      );
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

function managedEntryIsActive(entry, activeProfiles) {
  const requiredProfiles = Array.isArray(entry?.profiles)
    ? entry.profiles.map((profile) => toNonEmptyString(profile)).filter(Boolean)
    : [];

  if (requiredProfiles.length === 0) {
    return true;
  }

  return requiredProfiles.some((profile) => activeProfiles.has(profile));
}

function normalizeAgentsMode(rawMode) {
  const mode = toNonEmptyString(rawMode);
  if (!mode) {
    return null;
  }
  if (!SUPPORTED_AGENTS_MODES.has(mode)) {
    fail(
      `Unknown --agents-mode "${mode}". Supported: ${[...SUPPORTED_AGENTS_MODES].join(", ")}`,
    );
  }
  return mode;
}

function parseArgs(argv) {
  const options = {
    projectId: "",
    repoOwner: "example",
    repoName: "",
    packageName: "",
    agentsMode: "",
    agentsWorkfilesPath: "",
    helmRepoUrl: "",
    helmChartName: "",
    helmReleaseName: "",
    dockerImage: "",
    profiles: DEFAULT_PROFILES.join(","),
    templateRepo: "BonzTM/agents-template",
    templateRef: "main",
    templateLocalPath: "../agents-template",
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

    const key = token.slice(2).trim();
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for --${key}`);
    }
    index += 1;

    switch (key) {
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
      case "agents-mode":
        options.agentsMode = value.trim();
        break;
      case "agents-workfiles-path":
        options.agentsWorkfilesPath = value.trim();
        break;
      case "helm-repo-url":
        options.helmRepoUrl = value.trim();
        break;
      case "helm-chart-name":
        options.helmChartName = value.trim();
        break;
      case "helm-release-name":
        options.helmReleaseName = value.trim();
        break;
      case "docker-image":
        options.dockerImage = value.trim();
        break;
      case "profiles":
        options.profiles = value.trim();
        break;
      case "template-repo":
        options.templateRepo = value.trim();
        break;
      case "template-ref":
        options.templateRef = value.trim();
        break;
      case "template-local-path":
        options.templateLocalPath = value.trim();
        break;
      default:
        fail(`Unknown flag: --${key}`);
    }
  }

  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readJson(filePath);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function deepReplaceStrings(value, replacements) {
  if (typeof value === "string") {
    let next = value;
    for (const [from, to] of replacements) {
      next = next.split(from).join(to);
    }
    return next;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => deepReplaceStrings(entry, replacements));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = deepReplaceStrings(entry, replacements);
    }
    return out;
  }
  return value;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeFileIfMissing(filePath, content) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, "utf8");
  }
}

function copyAgentsSeedTemplate({ repoRoot, canonicalAgentsRootAbs, agentsMode, nowIso }) {
  const templateRoot = path.resolve(repoRoot, FILES.agentsSeedTemplateRoot);
  if (!fs.existsSync(templateRoot)) {
    return;
  }
  const stats = fs.statSync(templateRoot);
  if (!stats.isDirectory()) {
    fail(`${FILES.agentsSeedTemplateRoot} must be a directory when present.`);
  }

  const enabledModeLabel = agentsMode === "local" ? "local" : "external";
  const replacements = new Map([
    ["{{NOW_ISO}}", nowIso],
    ["{{AGENTS_MODE_LABEL}}", enabledModeLabel],
  ]);

  const stack = [templateRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.resolve(current, entry.name);
      const relativePath = path.relative(templateRoot, sourcePath);
      const targetPath = path.resolve(canonicalAgentsRootAbs, relativePath);

      if (entry.isDirectory()) {
        ensureDir(targetPath);
        stack.push(sourcePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }
      if (fs.existsSync(targetPath)) {
        continue;
      }

      let content = fs.readFileSync(sourcePath, "utf8");
      for (const [from, to] of replacements) {
        content = content.split(from).join(to);
      }
      ensureDir(path.dirname(targetPath));
      fs.writeFileSync(targetPath, content, "utf8");
    }
  }
}

function ensureGitignoreEntries(repoRoot) {
  const gitignorePath = path.resolve(repoRoot, FILES.gitignore);
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  let next = existing;
  const missing = REQUIRED_GITIGNORE_SNIPPETS.filter((snippet) => !existing.includes(snippet));

  if (missing.length === 0) {
    return;
  }

  if (!next.endsWith("\n") && next.length > 0) {
    next += "\n";
  }

  if (!next.includes("# Local agent state")) {
    next += "\n# Local agent state\n";
  }

  for (const snippet of missing) {
    next += `${snippet}\n`;
  }

  fs.writeFileSync(gitignorePath, next, "utf8");
}

function resolveCanonicalAgentsRoot({ repoRoot, projectId, agentsMode, agentsWorkfilesPath }) {
  if (agentsMode === "local") {
    const localPath = path.resolve(repoRoot, ".agents");
    return {
      canonicalAgentsRootAbs: localPath,
      canonicalAgentsRootRel: ".agents",
    };
  }

  const resolvedBase = toNonEmptyString(agentsWorkfilesPath);
  if (!resolvedBase) {
    fail('External agents mode requires --agents-workfiles-path <relative-path>.');
  }
  if (path.isAbsolute(resolvedBase)) {
    fail('--agents-workfiles-path must be a relative path from the target repository root.');
  }
  const canonicalAgentsRootAbs = path.resolve(repoRoot, resolvedBase, projectId);
  return {
    canonicalAgentsRootAbs,
    canonicalAgentsRootRel: toPosixPath(path.relative(repoRoot, canonicalAgentsRootAbs)),
  };
}

function ensureAgentsStorage({ repoRoot, canonicalAgentsRootAbs, agentsMode }) {
  const localAgentsPath = path.resolve(repoRoot, ".agents");
  const canonicalAgentsRootResolved = path.resolve(canonicalAgentsRootAbs);

  if (agentsMode === "local") {
    if (!fs.existsSync(localAgentsPath)) {
      ensureDir(localAgentsPath);
      return;
    }

    const stats = fs.lstatSync(localAgentsPath);
    if (stats.isSymbolicLink()) {
      const targetResolved = path.resolve(fs.realpathSync(localAgentsPath));
      fs.unlinkSync(localAgentsPath);
      ensureDir(localAgentsPath);
      if (fs.existsSync(targetResolved) && fs.statSync(targetResolved).isDirectory()) {
        fs.cpSync(targetResolved, localAgentsPath, { recursive: true, force: true });
      }
      return;
    }

    if (!stats.isDirectory()) {
      fail(`${localAgentsPath} exists but is not a directory.`);
    }
    return;
  }

  ensureDir(canonicalAgentsRootResolved);

  if (!fs.existsSync(localAgentsPath)) {
    fs.symlinkSync(canonicalAgentsRootResolved, localAgentsPath, "dir");
    return;
  }

  const stats = fs.lstatSync(localAgentsPath);
  if (stats.isSymbolicLink()) {
    const currentTarget = path.resolve(fs.realpathSync(localAgentsPath));
    if (currentTarget !== canonicalAgentsRootResolved) {
      fs.unlinkSync(localAgentsPath);
      fs.symlinkSync(canonicalAgentsRootResolved, localAgentsPath, "dir");
    }
    return;
  }

  if (!stats.isDirectory()) {
    fail(`${localAgentsPath} exists but is not a directory/symlink.`);
  }

  fs.cpSync(localAgentsPath, canonicalAgentsRootResolved, { recursive: true, force: true });
  const backupPath = `${localAgentsPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.renameSync(localAgentsPath, backupPath);
  fs.symlinkSync(canonicalAgentsRootResolved, localAgentsPath, "dir");

  console.log(`Moved existing .agents directory to backup: ${backupPath}`);
}

function ensureAgentsSeedFiles({ repoRoot, canonicalAgentsRootAbs, agentsMode }) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  copyAgentsSeedTemplate({
    repoRoot,
    canonicalAgentsRootAbs,
    agentsMode,
    nowIso: now,
  });
  const enabledModeLabel = agentsMode === "local" ? "local" : "external";

  writeFileIfMissing(
    path.resolve(canonicalAgentsRootAbs, "EXECUTION_QUEUE.json"),
    `${JSON.stringify(
      {
        version: "1.0",
        created_at: now,
        updated_at: now,
        last_updated: now,
        state: "pending",
        feature_id: "unassigned",
        task_id: "",
        objective: "",
        in_scope: [],
        out_of_scope: [],
        acceptance_criteria: [],
        constraints: [],
        references: [],
        open_questions: [],
        deferred_reason: null,
        cancel_reason: null,
        items: [],
      },
      null,
      2,
    )}\n`,
  );

  writeFileIfMissing(
    path.resolve(canonicalAgentsRootAbs, "EXECUTION_ARCHIVE_INDEX.json"),
    `${JSON.stringify(
      {
        version: "1.0",
        last_updated: now,
        items: [],
      },
      null,
      2,
    )}\n`,
  );

  writeFileIfMissing(
    path.resolve(canonicalAgentsRootAbs, "CONTINUITY.md"),
    `# CONTINUITY\n\n## [PLANS]\n- ${now} [TOOL] Initialize continuity baseline.\n\n## [DECISIONS]\n- ${now} [CODE] ${enabledModeLabel} canonical agents root enabled for this project.\n\n## [PROGRESS]\n- ${now} [TOOL] Baseline continuity initialized.\n\n## [DISCOVERIES]\n- ${now} [TOOL] None.\n\n## [OUTCOMES]\n- ${now} [TOOL] Ready for preflight.\n`,
  );

  ensureDir(path.resolve(canonicalAgentsRootAbs, "archives"));
  ensureDir(path.resolve(canonicalAgentsRootAbs, "plans/current"));
  ensureDir(path.resolve(canonicalAgentsRootAbs, "plans/deferred"));
  ensureDir(path.resolve(canonicalAgentsRootAbs, "plans/archived"));
}

function rewriteReleaseTemplate(filePath, values) {
  let text = fs.readFileSync(filePath, "utf8");
  text = text.replace(
    /^# .*\{\{VERSION\}\} Release Notes - \{\{RELEASE_DATE\}\}$/m,
    `# ${values.repoName} {{VERSION}} Release Notes - {{RELEASE_DATE}}`,
  );
  text = text.replace(/^- Docker image: `[^`]+`$/m, `- Docker image: \`${values.dockerImage}\``);
  text = text.replace(
    /^- Helm chart repository: `[^`]+`$/m,
    `- Helm chart repository: \`${values.helmRepoUrl}\``,
  );
  text = text.replace(/^- Helm chart name: `[^`]+`$/m, `- Helm chart name: \`${values.helmChartName}\``);
  text = text.replace(
    /^- Helm chart reference: `[^`]+`$/m,
    `- Helm chart reference: \`${values.helmChartReference}\``,
  );
  text = text.replace(
    /^helm repo add .*$/m,
    `helm repo add ${values.helmRepoName} ${values.helmRepoUrl}`,
  );
  text = text.replace(
    /^helm upgrade --install .*$/m,
    `helm upgrade --install ${values.helmReleaseName} ${values.helmChartReference} --version {{VERSION}}`,
  );

  fs.writeFileSync(filePath, text, "utf8");
}

function rewriteTextToken(filePath, replacements) {
  let text = fs.readFileSync(filePath, "utf8");
  for (const [from, to] of replacements) {
    text = text.split(from).join(to);
  }
  fs.writeFileSync(filePath, text, "utf8");
}

function rewriteTextRegex(filePath, pattern, replacement) {
  const text = fs.readFileSync(filePath, "utf8");
  const next = text.replace(pattern, replacement);
  fs.writeFileSync(filePath, next, "utf8");
}

function setNodeWebContractState(policy, profiles) {
  if (!policy.contracts || typeof policy.contracts !== "object") {
    return;
  }

  const nodeWebEnabled = profiles.includes("node-web");

  policy.contracts.profiles = {
    availableProfiles: [...SUPPORTED_PROFILES],
    activeProfiles: profiles,
  };

  for (const contractName of NODE_WEB_PROFILE_CONTRACTS) {
    const contract = policy.contracts[contractName];
    if (!contract || typeof contract !== "object") {
      continue;
    }
    contract.profiles = ["node-web"];
    contract.enabled = nodeWebEnabled;
  }
}

function applyProfiles({ policy, contextIndex, profiles }) {
  setNodeWebContractState(policy, profiles);

  contextIndex.profiles = {
    availableProfiles: [...SUPPORTED_PROFILES],
    activeProfiles: profiles,
  };
}

function syncAllowlistedManagedOverrides({
  repoRoot,
  managedManifest,
  templateLocalPathOverride,
}) {
  if (!managedManifest || typeof managedManifest !== "object") {
    return;
  }

  const overrideRoot =
    toNonEmptyString(managedManifest.overrideRoot) ?? ".agents-config/agent-overrides";
  const overrideRootAbs = path.resolve(repoRoot, overrideRoot);

  const activeProfileValues = Array.isArray(managedManifest.profiles)
    ? managedManifest.profiles.map((profile) => toNonEmptyString(profile)).filter(Boolean)
    : [];
  const activeProfiles = new Set(
    activeProfileValues.length > 0 ? activeProfileValues : DEFAULT_PROFILES,
  );

  const templateLocalPath =
    toNonEmptyString(templateLocalPathOverride) ??
    toNonEmptyString(managedManifest?.template?.localPath);
  const templateRoot = templateLocalPath
    ? path.resolve(repoRoot, templateLocalPath)
    : null;
  const templateAvailable = Boolean(templateRoot && fs.existsSync(templateRoot));

  const entries = Array.isArray(managedManifest.managed_files)
    ? managedManifest.managed_files
    : [];

  for (const entry of entries) {
    if (!managedEntryIsActive(entry, activeProfiles)) {
      continue;
    }
    if (entry?.allow_override !== true) {
      continue;
    }

    const targetRelativePath = toNonEmptyString(entry?.path);
    if (!targetRelativePath) {
      continue;
    }

    const targetPath = path.resolve(repoRoot, targetRelativePath);
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
      continue;
    }

    const sourceRelativePath = toNonEmptyString(entry?.source_path) ?? targetRelativePath;
    const targetContent = fs.readFileSync(targetPath, "utf8");

    let shouldWriteOverride = true;
    if (templateAvailable) {
      const templateSourcePath = path.resolve(templateRoot, sourceRelativePath);
      if (fs.existsSync(templateSourcePath) && fs.statSync(templateSourcePath).isFile()) {
        const templateContent = fs.readFileSync(templateSourcePath, "utf8");
        shouldWriteOverride = targetContent !== templateContent;
      }
    }

    const overrideRelativePath = resolveManagedOverrideRepoPath({
      entry,
      targetRelativePath,
      overrideRoot,
    });
    if (!overrideRelativePath) {
      continue;
    }
    const overridePath = path.resolve(repoRoot, overrideRelativePath);

    if (!shouldWriteOverride) {
      if (fs.existsSync(overridePath) && fs.statSync(overridePath).isFile()) {
        fs.unlinkSync(overridePath);
      }
      continue;
    }

    ensureDir(path.dirname(overridePath));
    fs.writeFileSync(overridePath, targetContent, "utf8");
  }

  if (toNonEmptyString(overrideRoot)) {
    ensureDir(overrideRootAbs);
  }
}

function runPreflight(repoRoot) {
  const result = spawnSync("npm", ["run", "agent:preflight"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fail("Bootstrap completed file rewrites, but preflight failed.");
  }
}

function main() {
  const repoRoot = resolveRepoRoot();
  const args = parseArgs(process.argv.slice(2));

  validateProjectId(args.projectId);

  writeFileIfMissing(path.resolve(repoRoot, FILES.changelog), DEFAULT_CHANGELOG_TEXT);
  ensureGitignoreEntries(repoRoot);

  const profiles = parseProfiles(args.profiles);
  const explicitAgentsMode = normalizeAgentsMode(args.agentsMode);
  const explicitWorkfilesPath = toNonEmptyString(args.agentsWorkfilesPath);
  let agentsMode = explicitAgentsMode ?? "external";
  let configuredWorkfilesPath = null;
  if (agentsMode === "local") {
    if (explicitWorkfilesPath) {
      fail("Cannot use --agents-mode local with --agents-workfiles-path.");
    }
  } else {
    configuredWorkfilesPath = explicitWorkfilesPath ?? DEFAULT_AGENTS_WORKFILES_PATH;
    if (path.isAbsolute(configuredWorkfilesPath)) {
      fail("--agents-workfiles-path must be a relative path from the target repository root.");
    }
  }

  const projectId = args.projectId;
  const repoOwner = toNonEmptyString(args.repoOwner) ?? "example";
  const repoName = toNonEmptyString(args.repoName) ?? projectId;
  const packageName = toNonEmptyString(args.packageName) ?? projectId;
  const helmChartName = toNonEmptyString(args.helmChartName) ?? repoName;
  const helmReleaseName = toNonEmptyString(args.helmReleaseName) ?? repoName;
  const helmRepoName = repoName;
  const helmRepoUrl = toNonEmptyString(args.helmRepoUrl) ?? `https://${repoOwner}.github.io/${repoName}`;
  const dockerImage = toNonEmptyString(args.dockerImage) ?? `ghcr.io/${repoOwner}/${repoName}`;
  const canonicalWorktreesRootRel = `../${repoName}.worktrees`;
  const templateRepo = toNonEmptyString(args.templateRepo) ?? "BonzTM/agents-template";
  const templateRef = toNonEmptyString(args.templateRef) ?? "main";
  const templateLocalPath = toNonEmptyString(args.templateLocalPath) ?? "../agents-template";

  const agentsRootInfo = resolveCanonicalAgentsRoot({
    repoRoot,
    projectId,
    agentsMode,
    agentsWorkfilesPath: configuredWorkfilesPath,
  });

  const canonicalAgentsRootAbs = agentsRootInfo.canonicalAgentsRootAbs;
  const canonicalAgentsRootRel = agentsRootInfo.canonicalAgentsRootRel;

  const policyPath = path.resolve(repoRoot, FILES.policy);
  const contextIndexPath = path.resolve(repoRoot, FILES.contextIndex);
  const featureIndexPath = path.resolve(repoRoot, FILES.featureIndex);
  const loggingBaselinePath = path.resolve(repoRoot, FILES.loggingBaseline);
  const managedTemplatePath = path.resolve(repoRoot, FILES.managedTemplate);
  const nodeWebEnabled = profiles.includes("node-web");

  const policy = readJson(policyPath);
  const contextIndex = readJson(contextIndexPath);
  const featureIndex = readJsonIfPresent(featureIndexPath);
  const loggingBaseline = readJsonIfPresent(loggingBaselinePath);
  const managedTemplate = readJson(managedTemplatePath);
  const packageJson = readJson(path.resolve(repoRoot, FILES.packageJson));
  const packageLock = readJson(path.resolve(repoRoot, FILES.packageLock));
  const indexConfigPath = path.resolve(repoRoot, FILES.indexConfig);
  const indexConfig = readJsonIfPresent(indexConfigPath);
  if (indexConfig === null) {
    fail(`Missing required file: ${FILES.indexConfig}`);
  }

  if (nodeWebEnabled && featureIndex === null) {
    fail(`Missing required file for node-web profile: ${FILES.featureIndex}`);
  }
  if (nodeWebEnabled && loggingBaseline === null) {
    fail(`Missing required file for node-web profile: ${FILES.loggingBaseline}`);
  }

  const replacements = new Map([
    ["../agents-workfiles/agents-template", canonicalAgentsRootRel],
    ["../agents-workfiles/<project-id>", canonicalAgentsRootRel],
    ["../agent-workfiles/agents-template", canonicalAgentsRootRel],
    ["../agent-workfiles/<project-id>", canonicalAgentsRootRel],
    ["../agents-workfiles/project-template", canonicalAgentsRootRel],
    ["../agent-workfiles/project-template", canonicalAgentsRootRel],
    ["agents-template-agent-governance", `${projectId}-agent-governance`],
    ["agents-template-context-index", `${projectId}-agent-context-index`],
    ["agents-template-feature-index", `${projectId}-feature-index`],
    ["agents-template-logging-compliance-baseline", `${projectId}-logging-compliance-baseline`],
    ["https://example.github.io/project", helmRepoUrl],
    ["project/project", `${helmRepoName}/${helmChartName}`],
    ["charts/project", `charts/${helmChartName}`],
  ]);
  const downstreamDocFileReplacements = new Map([
    [".agents-config/AGENTS_TEMPLATE.md", "AGENTS.md"],
    [".agents-config/templates/CLAUDE.md", "CLAUDE.md"],
  ]);

  const rewrittenPolicy = deepReplaceStrings(
    deepReplaceStrings(policy, replacements),
    downstreamDocFileReplacements,
  );
  rewrittenPolicy.metadata.id = `${projectId}-agent-governance`;
  rewrittenPolicy.contracts.workspaceLayout = {
    ...rewrittenPolicy.contracts.workspaceLayout,
    canonicalRepoRoot: ".",
    canonicalAgentsRoot: canonicalAgentsRootRel,
    worktreesRoot: canonicalWorktreesRootRel,
    localAgentsPath: ".agents",
    requireLocalAgentsSymlink: true,
    requireWorktreeAgentsSymlink: true,
    enforceWorktreeRoot: true,
    requireSemanticMergeForAgents: true,
    requireSemanticMergeOnAgentsEdit: true,
  };
  rewrittenPolicy.contracts.featureIndex.requiredMetadataId = `${projectId}-feature-index`;
  rewrittenPolicy.contracts.releaseNotes = {
    ...rewrittenPolicy.contracts.releaseNotes,
    helmRepoName,
    helmRepoUrl,
    helmChartName,
    helmChartReference: `${helmRepoName}/${helmChartName}`,
    helmReleaseName,
  };
  rewrittenPolicy.contracts.releaseVersion = {
    ...(rewrittenPolicy.contracts.releaseVersion ?? {}),
    packageTargets: [{ label: "root", dir: ".", expectedName: packageName }],
    chartDir: `charts/${helmChartName}`,
    releaseImageSections: rewrittenPolicy.contracts.releaseVersion?.releaseImageSections ?? [
      "app",
    ],
  };
  if (Array.isArray(rewrittenPolicy.checks?.requiredTextSnippets)) {
    for (const entry of rewrittenPolicy.checks.requiredTextSnippets) {
      if (entry?.file !== ".agents-config/docs/RELEASE_NOTES_TEMPLATE.md" || !Array.isArray(entry.snippets)) {
        continue;
      }

      entry.snippets = [
        `# ${repoName} {{VERSION}} Release Notes`,
        `Helm chart repository: \`${helmRepoUrl}\``,
        `Helm chart name: \`${helmChartName}\``,
        `Helm chart reference: \`${helmRepoName}/${helmChartName}\``,
        `helm repo add ${helmRepoName} ${helmRepoUrl}`,
        `helm upgrade --install ${helmReleaseName} ${helmRepoName}/${helmChartName} --version {{VERSION}}`,
      ];
    }
  }

  const rewrittenContextIndex = deepReplaceStrings(
    deepReplaceStrings(contextIndex, replacements),
    downstreamDocFileReplacements,
  );
  rewrittenContextIndex.metadata.id = `${projectId}-agent-context-index`;
  rewrittenContextIndex.sessionArtifacts.workspaceLayout = {
    ...rewrittenContextIndex.sessionArtifacts.workspaceLayout,
    canonicalRepoRoot: ".",
    canonicalAgentsRoot: canonicalAgentsRootRel,
    worktreesRoot: canonicalWorktreesRootRel,
    localAgentsPath: ".agents",
    semanticMergeRequired: true,
    semanticMergeOnAgentsEditRequired: true,
    worktreeAgentsSymlinkRequired: true,
  };

  const rewrittenFeatureIndex =
    featureIndex === null ? null : deepReplaceStrings(featureIndex, replacements);
  if (rewrittenFeatureIndex) {
    rewrittenFeatureIndex.metadata.id = `${projectId}-feature-index`;
  }

  const rewrittenLoggingBaseline =
    loggingBaseline === null ? null : deepReplaceStrings(loggingBaseline, replacements);
  if (rewrittenLoggingBaseline) {
    rewrittenLoggingBaseline.metadata.id = `${projectId}-logging-compliance-baseline`;
  }

  const rewrittenManagedManifest = deepReplaceStrings(managedTemplate, replacements);
  rewrittenManagedManifest.profiles = profiles;
  rewrittenManagedManifest.template = {
    repo: templateRepo,
    ref: templateRef,
    localPath: templateLocalPath,
  };
  rewrittenManagedManifest.agentsMode = agentsMode;
  rewrittenManagedManifest.agentsWorkfilesPath =
    agentsMode === "external" ? configuredWorkfilesPath : null;

  applyProfiles({
    policy: rewrittenPolicy,
    contextIndex: rewrittenContextIndex,
    profiles,
  });

  packageJson.name = packageName;
  packageLock.name = packageName;
  if (packageLock.packages && packageLock.packages[""]) {
    packageLock.packages[""].name = packageName;
  }
  indexConfig.outputDir = ".agents/index/project-v1";

  writeJson(policyPath, rewrittenPolicy);
  writeJson(contextIndexPath, rewrittenContextIndex);
  if (rewrittenFeatureIndex) {
    writeJson(featureIndexPath, rewrittenFeatureIndex);
  }
  if (rewrittenLoggingBaseline) {
    writeJson(loggingBaselinePath, rewrittenLoggingBaseline);
  }
  writeJson(path.resolve(repoRoot, FILES.managedManifest), rewrittenManagedManifest);
  writeJson(path.resolve(repoRoot, FILES.packageJson), packageJson);
  writeJson(path.resolve(repoRoot, FILES.packageLock), packageLock);
  writeJson(indexConfigPath, indexConfig);

  const releaseTemplatePath = path.resolve(repoRoot, FILES.releaseTemplate);
  if (fs.existsSync(releaseTemplatePath)) {
    rewriteReleaseTemplate(releaseTemplatePath, {
      repoName,
      dockerImage,
      helmRepoUrl,
      helmChartName,
      helmChartReference: `${helmRepoName}/${helmChartName}`,
      helmRepoName,
      helmReleaseName,
    });
  }

  const generateReleaseNotesPath = path.resolve(repoRoot, FILES.generateReleaseNotes);
  if (fs.existsSync(generateReleaseNotesPath)) {
    rewriteTextRegex(
      generateReleaseNotesPath,
      /const DEFAULT_REPO_WEB_URL = "https:\/\/github\.com\/[^"]+";/,
      `const DEFAULT_REPO_WEB_URL = "https://github.com/${repoOwner}/${repoName}";`,
    );
  }

  const verifyLoggingCompliancePath = path.resolve(repoRoot, FILES.verifyLoggingCompliance);
  if (fs.existsSync(verifyLoggingCompliancePath)) {
    rewriteTextRegex(
      verifyLoggingCompliancePath,
      /id: "[^"]+-logging-compliance-baseline"/,
      `id: "${projectId}-logging-compliance-baseline"`,
    );
  }

  const agentDocReplacements = [
    ["../agents-workfiles/agents-template", canonicalAgentsRootRel],
    ["../agents-workfiles/<project-id>", canonicalAgentsRootRel],
    ["../agent-workfiles/agents-template", canonicalAgentsRootRel],
    ["../agent-workfiles/<project-id>", canonicalAgentsRootRel],
    ["../agents-workfiles/project-template", canonicalAgentsRootRel],
    ["../agent-workfiles/project-template", canonicalAgentsRootRel],
    [".agents-config/AGENTS_TEMPLATE.md", "AGENTS.md"],
    [".agents-config/templates/CLAUDE.md", "CLAUDE.md"],
  ];
  for (const docPath of [FILES.agentsDoc, FILES.rulesDoc, FILES.contextDoc, FILES.readme]) {
    const absoluteDocPath = path.resolve(repoRoot, docPath);
    if (!fs.existsSync(absoluteDocPath)) {
      continue;
    }
    rewriteTextToken(absoluteDocPath, agentDocReplacements);
  }

  syncAllowlistedManagedOverrides({
    repoRoot,
    managedManifest: rewrittenManagedManifest,
    templateLocalPathOverride: templateLocalPath,
  });

  ensureDir(path.resolve(repoRoot, canonicalWorktreesRootRel));
  ensureAgentsStorage({ repoRoot, canonicalAgentsRootAbs, agentsMode });
  ensureAgentsSeedFiles({ repoRoot, canonicalAgentsRootAbs, agentsMode });

  console.log(`Bootstrapped agent template for project-id: ${projectId}`);
  console.log(`- Canonical agents root: ${canonicalAgentsRootRel}`);
  console.log(`- Agents mode: ${agentsMode}`);
  if (agentsMode === "external") {
    console.log(`- Agents workfiles path: ${configuredWorkfilesPath}`);
  }
  console.log(`- Package name: ${packageName}`);
  console.log(`- Profiles: ${profiles.join(", ")}`);
  console.log(`- Template source: ${templateRepo}@${templateRef} (local fallback: ${templateLocalPath})`);
  console.log(`- Repo URL default: https://github.com/${repoOwner}/${repoName}`);
  console.log(`- Helm repo URL: ${helmRepoUrl}`);

  if (!args.skipPreflight) {
    runPreflight(repoRoot);
  } else {
    console.log("Skipped preflight by request (--skip-preflight).");
  }
}

main();
