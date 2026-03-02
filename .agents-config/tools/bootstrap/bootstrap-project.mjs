#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SUPPORTED_PROFILE_LIST = [
  "base",
  "typescript",
  "typescript-openapi",
  "javascript",
  "python",
];
const SUPPORTED_PROFILES = new Set(SUPPORTED_PROFILE_LIST);
const DEFAULT_PROFILES = ["base"];
const SUPPORTED_BOOTSTRAP_MODES = new Set(["new", "existing"]);
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
const CONTRACT_PROFILE_REQUIREMENTS = {
  featureIndex: ["typescript", "javascript"],
  testMatrix: ["typescript", "javascript"],
  routeMap: ["typescript", "javascript"],
  domainReadmes: ["typescript", "javascript"],
  jsdocCoverage: ["typescript", "javascript"],
  openapiCoverage: ["typescript-openapi"],
  loggingStandards: ["typescript", "javascript"],
};
const PRESERVED_POLICY_TEMPLATE_CONTRACT_KEYS = [
  "workspaceLayout",
  "featureIndex",
  "releaseNotes",
  "releaseVersion",
  "ruleCatalog",
  "contextIndex",
  "managedFilesCanonical",
  "canonicalRules",
];

const FILES = {
  policy: ".agents-config/policies/agent-governance.json",
  contextIndex: ".agents-config/docs/CONTEXT_INDEX.json",
  featureIndex: ".agents-config/docs/FEATURE_INDEX.json",
  loggingBaseline: ".agents-config/policies/logging-compliance-baseline.json",
  toolingConfig: ".agents-config/config/project-tooling.json",
  packageJson: "package.json",
  packageLock: "package-lock.json",
  releaseTemplate: ".agents-config/docs/RELEASE_NOTES_TEMPLATE.md",
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const out = [];
  const seen = new Set();
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

function normalizeProfileKeyedStringArrayMap(value) {
  if (!isPlainObject(value)) {
    return {};
  }
  const out = {};
  for (const [key, entries] of Object.entries(value)) {
    const normalizedEntries = normalizeStringArray(entries);
    if (normalizedEntries.length === 0) {
      continue;
    }
    out[key] = normalizedEntries;
  }
  return out;
}

function mergeProfileKeyedStringArrayMap({ templateMap, existingMap }) {
  const merged = isPlainObject(existingMap) ? cloneJsonValue(existingMap) : {};
  for (const [profile, entries] of Object.entries(templateMap)) {
    merged[profile] = [...entries];
  }
  return merged;
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

  return normalizeProfileDependencies(unique);
}

function normalizeProfileDependencies(profiles) {
  const normalized = [...profiles];
  if (normalized.includes("typescript-openapi") && !normalized.includes("typescript")) {
    normalized.push("typescript");
  }
  return normalized;
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

function normalizeBootstrapMode(rawMode) {
  const mode = toNonEmptyString(rawMode) ?? "new";
  if (!SUPPORTED_BOOTSTRAP_MODES.has(mode)) {
    fail(
      `Unknown --bootstrap-mode "${mode}". Supported: ${[...SUPPORTED_BOOTSTRAP_MODES].join(", ")}`,
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
    bootstrapMode: "new",
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
      case "bootstrap-mode":
        options.bootstrapMode = value.trim();
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

function writeJsonIfChanged(filePath, previousValue, nextValue) {
  if (JSON.stringify(previousValue) === JSON.stringify(nextValue)) {
    return false;
  }
  writeJson(filePath, nextValue);
  return true;
}

function buildManagedEntryIndex(manifest) {
  const index = new Map();
  const managedEntries = Array.isArray(manifest?.managed_files) ? manifest.managed_files : [];
  for (const entry of managedEntries) {
    const entryPath = toNonEmptyString(entry?.path);
    if (!entryPath) {
      continue;
    }
    const normalizedPath = toPosixPath(entryPath);
    const sourcePath = toPosixPath(toNonEmptyString(entry?.source_path) ?? entryPath);
    const authority = toNonEmptyString(entry?.authority) ?? "template";
    index.set(normalizedPath, { sourcePath, authority });
  }
  return index;
}

function shouldPreserveExistingNonTemplateManagedFile({
  bootstrapMode,
  managedEntryIndex,
  repoRoot,
  templateRoot,
  targetRelativePath,
}) {
  if (bootstrapMode !== "existing") {
    return false;
  }

  const normalizedTargetPath = toPosixPath(targetRelativePath);
  const entry = managedEntryIndex.get(normalizedTargetPath);
  if (!entry || entry.authority === "template") {
    return false;
  }

  const targetPath = path.resolve(repoRoot, normalizedTargetPath);
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
    return false;
  }

  if (!templateRoot) {
    return true;
  }

  const templateSourcePath = path.resolve(templateRoot, entry.sourcePath);
  if (!fs.existsSync(templateSourcePath) || !fs.statSync(templateSourcePath).isFile()) {
    return true;
  }

  return fs.readFileSync(targetPath, "utf8") !== fs.readFileSync(templateSourcePath, "utf8");
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
    path.resolve(canonicalAgentsRootAbs, "MEMORY.md"),
    "# MEMORY\n\n## User Directives\n- None recorded.\n\n## Architecture Decisions\n- None recorded.\n\n## Known Gotchas\n- None recorded.\n\n## Submemory Index\n- None recorded.\n",
  );

  writeFileIfMissing(
    path.resolve(canonicalAgentsRootAbs, "SESSION_LOG.md"),
    `# SESSION_LOG\n\n## [ENTRIES]\n- ${now} [TOOL] Session log initialized.\n`,
  );

  ensureDir(path.resolve(canonicalAgentsRootAbs, "archives"));
  ensureDir(path.resolve(canonicalAgentsRootAbs, "memory"));
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

function updateReleaseNotesRequiredTextSnippet(
  policy,
  { repoName, helmRepoUrl, helmChartName, helmRepoName, helmReleaseName },
) {
  if (!Array.isArray(policy?.checks?.requiredTextSnippets)) {
    return;
  }
  for (const entry of policy.checks.requiredTextSnippets) {
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

function resolveTemplatePolicyChecks({
  templateRoot,
  replacements,
  downstreamDocFileReplacements,
}) {
  if (!templateRoot) {
    return null;
  }

  const templatePolicyPath = path.resolve(templateRoot, FILES.policy);
  if (!fs.existsSync(templatePolicyPath) || !fs.statSync(templatePolicyPath).isFile()) {
    return null;
  }

  const templatePolicy = readJson(templatePolicyPath);
  const rewrittenTemplatePolicy = deepReplaceStrings(
    deepReplaceStrings(templatePolicy, replacements),
    downstreamDocFileReplacements,
  );
  if (!isPlainObject(rewrittenTemplatePolicy?.checks)) {
    return null;
  }

  return cloneJsonValue(rewrittenTemplatePolicy.checks);
}

function resolveTemplateProfileContractDefaults({ templateRoot, fallbackPolicy }) {
  let templatePolicy = null;
  if (templateRoot) {
    const templatePolicyPath = path.resolve(templateRoot, FILES.policy);
    if (fs.existsSync(templatePolicyPath) && fs.statSync(templatePolicyPath).isFile()) {
      templatePolicy = readJson(templatePolicyPath);
    }
  }

  const sourcePolicy =
    isPlainObject(templatePolicy?.contracts) || !fallbackPolicy ? templatePolicy : fallbackPolicy;
  const sourceRuleCatalog = isPlainObject(sourcePolicy?.contracts?.ruleCatalog)
    ? sourcePolicy.contracts.ruleCatalog
    : {};
  const sourceContextIndex = isPlainObject(sourcePolicy?.contracts?.contextIndex)
    ? sourcePolicy.contracts.contextIndex
    : {};

  return {
    requiredRuleIds: normalizeStringArray(sourceRuleCatalog.requiredIds),
    requiredIdsByProfile: normalizeProfileKeyedStringArrayMap(sourceRuleCatalog.requiredIdsByProfile),
    requiredCommandKeys: normalizeStringArray(sourceContextIndex.requiredCommandKeys),
    requiredCommandKeysByProfile: normalizeProfileKeyedStringArrayMap(
      sourceContextIndex.requiredCommandKeysByProfile,
    ),
  };
}

function setContractProfileState(policy, profiles, templateProfileContractDefaults) {
  if (!isPlainObject(policy?.contracts)) {
    return;
  }

  const contracts = policy.contracts;
  const existingProfilesContract = isPlainObject(contracts.profiles) ? contracts.profiles : {};
  contracts.profiles = {
    ...existingProfilesContract,
    availableProfiles: [...SUPPORTED_PROFILE_LIST],
    activeProfiles: [...profiles],
  };

  const ruleCatalogContract = isPlainObject(contracts.ruleCatalog) ? contracts.ruleCatalog : {};
  const contextIndexContract = isPlainObject(contracts.contextIndex) ? contracts.contextIndex : {};
  const templateRequiredRuleIds = normalizeStringArray(templateProfileContractDefaults?.requiredRuleIds);
  const templateRequiredCommandKeys = normalizeStringArray(
    templateProfileContractDefaults?.requiredCommandKeys,
  );
  const templateRequiredIdsByProfile = normalizeProfileKeyedStringArrayMap(
    templateProfileContractDefaults?.requiredIdsByProfile,
  );
  const templateRequiredCommandKeysByProfile = normalizeProfileKeyedStringArrayMap(
    templateProfileContractDefaults?.requiredCommandKeysByProfile,
  );
  const existingRequiredIdsByProfile = normalizeProfileKeyedStringArrayMap(
    ruleCatalogContract.requiredIdsByProfile,
  );
  const existingRequiredCommandKeysByProfile = normalizeProfileKeyedStringArrayMap(
    contextIndexContract.requiredCommandKeysByProfile,
  );

  ruleCatalogContract.requiredIds =
    templateRequiredRuleIds.length > 0
      ? [...templateRequiredRuleIds]
      : normalizeStringArray(ruleCatalogContract.requiredIds);
  ruleCatalogContract.requiredIdsByProfile = mergeProfileKeyedStringArrayMap({
    templateMap: templateRequiredIdsByProfile,
    existingMap: existingRequiredIdsByProfile,
  });

  contextIndexContract.requiredCommandKeys =
    templateRequiredCommandKeys.length > 0
      ? [...templateRequiredCommandKeys]
      : normalizeStringArray(contextIndexContract.requiredCommandKeys);
  contextIndexContract.requiredCommandKeysByProfile = mergeProfileKeyedStringArrayMap({
    templateMap: templateRequiredCommandKeysByProfile,
    existingMap: existingRequiredCommandKeysByProfile,
  });

  contracts.ruleCatalog = ruleCatalogContract;
  contracts.contextIndex = contextIndexContract;

  for (const [contractName, contractProfiles] of Object.entries(CONTRACT_PROFILE_REQUIREMENTS)) {
    const contract = contracts[contractName];
    if (!isPlainObject(contract)) {
      continue;
    }
    contract.profiles = [...contractProfiles];
    contract.enabled = contractProfiles.some((profile) => profiles.includes(profile));
  }
}

function setContextIndexProfileState({ contextIndex, profiles }) {
  const existingProfiles = isPlainObject(contextIndex?.profiles) ? contextIndex.profiles : {};

  contextIndex.profiles = {
    ...existingProfiles,
    availableProfiles: [...SUPPORTED_PROFILE_LIST],
    activeProfiles: [...profiles],
  };
}

function syncPreservedPolicyContractsFromTemplate({
  targetPolicy,
  rewrittenTemplatePolicy,
}) {
  if (!isPlainObject(targetPolicy?.contracts) || !isPlainObject(rewrittenTemplatePolicy?.contracts)) {
    return;
  }

  for (const contractKey of PRESERVED_POLICY_TEMPLATE_CONTRACT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(rewrittenTemplatePolicy.contracts, contractKey)) {
      continue;
    }
    targetPolicy.contracts[contractKey] = cloneJsonValue(
      rewrittenTemplatePolicy.contracts[contractKey],
    );
  }
}

function applyProfiles({ policy, contextIndex, profiles, templateProfileContractDefaults }) {
  setContractProfileState(policy, profiles, templateProfileContractDefaults);
  setContextIndexProfileState({ contextIndex, profiles });
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
  const bootstrapMode = normalizeBootstrapMode(args.bootstrapMode);

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
  const templateRootCandidate = path.resolve(repoRoot, templateLocalPath);
  const templateRoot = fs.existsSync(templateRootCandidate) ? templateRootCandidate : null;

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
  const toolingConfigPath = path.resolve(repoRoot, FILES.toolingConfig);
  const managedTemplatePath = path.resolve(repoRoot, FILES.managedTemplate);
  const webDocsProfilesEnabled = profiles.includes("typescript") || profiles.includes("javascript");

  const policy = readJson(policyPath);
  const contextIndex = readJson(contextIndexPath);
  const featureIndex = readJsonIfPresent(featureIndexPath);
  const loggingBaseline = readJsonIfPresent(loggingBaselinePath);
  const toolingConfig = readJsonIfPresent(toolingConfigPath);
  const managedTemplate = readJson(managedTemplatePath);
  const managedEntryIndex = buildManagedEntryIndex(managedTemplate);
  const preservedProjectManagedPaths = new Set();
  const packageJson = readJson(path.resolve(repoRoot, FILES.packageJson));
  const packageLock = readJson(path.resolve(repoRoot, FILES.packageLock));
  const templateProfileContractDefaults = resolveTemplateProfileContractDefaults({
    templateRoot,
    fallbackPolicy: policy,
  });

  if (webDocsProfilesEnabled && featureIndex === null) {
    fail(`Missing required file for typescript/javascript profiles: ${FILES.featureIndex}`);
  }
  if (webDocsProfilesEnabled && loggingBaseline === null) {
    fail(`Missing required file for typescript/javascript profiles: ${FILES.loggingBaseline}`);
  }
  if (toolingConfig === null) {
    fail(`Missing required file for base profile: ${FILES.toolingConfig}`);
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
    ["agents-template-tooling-config", `${projectId}-tooling-config`],
    ["https://example.github.io/project", helmRepoUrl],
    ["project/project", `${helmRepoName}/${helmChartName}`],
    ["charts/project", `charts/${helmChartName}`],
  ]);
  const downstreamDocFileReplacements = new Map([
    [".agents-config/templates/AGENTS.md", "AGENTS.md"],
    [".agents-config/templates/CLAUDE.md", "CLAUDE.md"],
  ]);
  const templatePolicyChecks = resolveTemplatePolicyChecks({
    templateRoot,
    replacements,
    downstreamDocFileReplacements,
  });

  const rewrittenPolicy = deepReplaceStrings(
    deepReplaceStrings(policy, replacements),
    downstreamDocFileReplacements,
  );
  if (templatePolicyChecks) {
    rewrittenPolicy.checks = cloneJsonValue(templatePolicyChecks);
  }
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
  updateReleaseNotesRequiredTextSnippet(rewrittenPolicy, {
    repoName,
    helmRepoUrl,
    helmChartName,
    helmRepoName,
    helmReleaseName,
  });

  const rewrittenContextIndex = deepReplaceStrings(
    deepReplaceStrings(contextIndex, replacements),
    downstreamDocFileReplacements,
  );
  rewrittenContextIndex.metadata.id = `${projectId}-agent-context-index`;

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
  const rewrittenToolingConfig =
    toolingConfig === null ? null : deepReplaceStrings(toolingConfig, replacements);
  if (rewrittenToolingConfig) {
    rewrittenToolingConfig.metadata =
      isPlainObject(rewrittenToolingConfig.metadata) ? rewrittenToolingConfig.metadata : {};
    rewrittenToolingConfig.metadata.id = `${projectId}-tooling-config`;
    rewrittenToolingConfig.releaseNotes = isPlainObject(rewrittenToolingConfig.releaseNotes)
      ? rewrittenToolingConfig.releaseNotes
      : {};
    rewrittenToolingConfig.releaseNotes.defaultRepoWebUrl =
      `https://github.com/${repoOwner}/${repoName}`;
    rewrittenToolingConfig.loggingCompliance = isPlainObject(
      rewrittenToolingConfig.loggingCompliance,
    )
      ? rewrittenToolingConfig.loggingCompliance
      : {};
    rewrittenToolingConfig.loggingCompliance.baselineMetadataId =
      `${projectId}-logging-compliance-baseline`;
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
    templateProfileContractDefaults,
  });

  const preserveNonTemplateManaged = (targetRelativePath) => {
    const shouldPreserve = shouldPreserveExistingNonTemplateManagedFile({
      bootstrapMode,
      managedEntryIndex,
      repoRoot,
      templateRoot,
      targetRelativePath,
    });
    if (shouldPreserve) {
      preservedProjectManagedPaths.add(toPosixPath(targetRelativePath));
    }
    return shouldPreserve;
  };

  packageJson.name = packageName;
  packageLock.name = packageName;
  if (packageLock.packages && packageLock.packages[""]) {
    packageLock.packages[""].name = packageName;
  }

  const preservePolicy = preserveNonTemplateManaged(FILES.policy);
  const preserveContextIndex = preserveNonTemplateManaged(FILES.contextIndex);

  const policyToWrite = preservePolicy ? cloneJsonValue(policy) : rewrittenPolicy;
  if (preservePolicy) {
    if (isPlainObject(rewrittenPolicy?.metadata)) {
      policyToWrite.metadata = {
        ...(isPlainObject(policyToWrite?.metadata) ? policyToWrite.metadata : {}),
        ...cloneJsonValue(rewrittenPolicy.metadata),
      };
    }
    if (templatePolicyChecks) {
      policyToWrite.checks = cloneJsonValue(templatePolicyChecks);
    }
    syncPreservedPolicyContractsFromTemplate({
      targetPolicy: policyToWrite,
      rewrittenTemplatePolicy: rewrittenPolicy,
    });
    setContractProfileState(policyToWrite, profiles, templateProfileContractDefaults);
    updateReleaseNotesRequiredTextSnippet(policyToWrite, {
      repoName,
      helmRepoUrl,
      helmChartName,
      helmRepoName,
      helmReleaseName,
    });
  }

  const contextIndexToWrite = preserveContextIndex
    ? cloneJsonValue(contextIndex)
    : rewrittenContextIndex;
  if (preserveContextIndex) {
    setContextIndexProfileState({
      contextIndex: contextIndexToWrite,
      policy: policyToWrite,
      profiles,
    });
  }

  if (preservePolicy) {
    writeJsonIfChanged(policyPath, policy, policyToWrite);
  } else {
    writeJson(policyPath, policyToWrite);
  }
  if (preserveContextIndex) {
    writeJsonIfChanged(contextIndexPath, contextIndex, contextIndexToWrite);
  } else {
    writeJson(contextIndexPath, contextIndexToWrite);
  }
  if (rewrittenFeatureIndex && !preserveNonTemplateManaged(FILES.featureIndex)) {
    writeJson(featureIndexPath, rewrittenFeatureIndex);
  }
  if (rewrittenLoggingBaseline && !preserveNonTemplateManaged(FILES.loggingBaseline)) {
    writeJson(loggingBaselinePath, rewrittenLoggingBaseline);
  }
  if (rewrittenToolingConfig && !preserveNonTemplateManaged(FILES.toolingConfig)) {
    writeJson(toolingConfigPath, rewrittenToolingConfig);
  }
  writeJson(path.resolve(repoRoot, FILES.managedManifest), rewrittenManagedManifest);
  writeJson(path.resolve(repoRoot, FILES.packageJson), packageJson);
  writeJson(path.resolve(repoRoot, FILES.packageLock), packageLock);

  const releaseTemplatePath = path.resolve(repoRoot, FILES.releaseTemplate);
  if (fs.existsSync(releaseTemplatePath) && !preserveNonTemplateManaged(FILES.releaseTemplate)) {
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

  const agentDocReplacements = [
    ["../agents-workfiles/agents-template", canonicalAgentsRootRel],
    ["../agents-workfiles/<project-id>", canonicalAgentsRootRel],
    ["../agent-workfiles/agents-template", canonicalAgentsRootRel],
    ["../agent-workfiles/<project-id>", canonicalAgentsRootRel],
    ["../agents-workfiles/project-template", canonicalAgentsRootRel],
    ["../agent-workfiles/project-template", canonicalAgentsRootRel],
    [".agents-config/templates/AGENTS.md", "AGENTS.md"],
    [".agents-config/templates/CLAUDE.md", "CLAUDE.md"],
  ];
  for (const docPath of [FILES.agentsDoc, FILES.rulesDoc, FILES.contextDoc, FILES.readme]) {
    const absoluteDocPath = path.resolve(repoRoot, docPath);
    if (!fs.existsSync(absoluteDocPath)) {
      continue;
    }
    if (preserveNonTemplateManaged(docPath)) {
      continue;
    }
    rewriteTextToken(absoluteDocPath, agentDocReplacements);
  }

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
  if (preservedProjectManagedPaths.size > 0) {
    console.log(`- preserved existing project-managed files: ${preservedProjectManagedPaths.size}`);
  }

  if (!args.skipPreflight) {
    runPreflight(repoRoot);
  } else {
    console.log("Skipped preflight by request (--skip-preflight).");
  }
}

main();
