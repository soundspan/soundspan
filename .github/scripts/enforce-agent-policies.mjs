#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const configPath = process.argv[2] ?? ".github/policies/agent-governance.json";
const failures = [];
const warnings = [];

function addFailure(message) {
  failures.push(message);
}

function addWarning(message) {
  warnings.push(message);
}

function runCommandSafe(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();

  if (result.error) {
    return {
      ok: false,
      stdout,
      stderr,
      status: result.status,
      error: result.error,
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      stdout,
      stderr,
      status: result.status,
      error: null,
    };
  }

  return {
    ok: true,
    stdout,
    stderr,
    status: result.status,
    error: null,
  };
}

function findRepoRootByGitDir(startDir) {
  let current = path.resolve(startDir);

  while (true) {
    const gitPath = path.join(current, ".git");
    if (fs.existsSync(gitPath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir);
    }

    current = parent;
  }
}

function resolveRepoRoot() {
  const result = runCommandSafe("git", ["rev-parse", "--show-toplevel"]);
  if (result.ok && result.stdout) {
    return result.stdout;
  }

  addWarning(
    "Unable to resolve repo root via git; falling back to nearest directory containing .git.",
  );
  return findRepoRootByGitDir(process.cwd());
}

function isPathWithin(candidatePath, parentPath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveAgentsAwarePath({
  repoRoot,
  canonicalAgentsRoot,
  targetPath,
}) {
  const text = toNonEmptyString(targetPath);
  if (!text) {
    return path.resolve(repoRoot, targetPath ?? "");
  }

  const normalized = text.replace(/\\/g, "/");
  if (normalized === ".agents") {
    return path.resolve(canonicalAgentsRoot);
  }
  if (normalized.startsWith(".agents/")) {
    const suffix = normalized.slice(".agents/".length);
    return path.resolve(canonicalAgentsRoot, suffix);
  }

  return path.resolve(repoRoot, text);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readFileIfPresent(filePath, optional = false) {
  if (!fs.existsSync(filePath)) {
    if (optional) {
      addWarning(`Optional file not present: ${filePath}`);
      return null;
    }

    addFailure(`Required file missing: ${filePath}`);
    return null;
  }

  return fs.readFileSync(filePath, "utf8");
}

function readJsonIfPresent(filePath, optional = false) {
  const content = readFileIfPresent(filePath, optional);
  if (content === null) {
    return null;
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    addFailure(`Invalid JSON in ${filePath}: ${error.message}`);
    return null;
  }
}

function listTrackedFiles() {
  const result = runCommandSafe("git", ["ls-files"]);
  if (!result.ok) {
    addWarning(
      "Unable to enumerate tracked files with git; tracked-file checks are skipped in this runtime.",
    );
    return { files: [], reliable: false };
  }

  return { files: result.stdout ? result.stdout.split("\n") : [], reliable: true };
}

function isLikelyText(content) {
  return !content.includes("\u0000");
}

function checkRequiredTextSnippets(config) {
  const rules = config?.checks?.requiredTextSnippets ?? [];

  for (const rule of rules) {
    const content = readFileIfPresent(rule.file, Boolean(rule.optional));
    if (content === null) {
      continue;
    }

    for (const snippet of rule.snippets ?? []) {
      if (!content.includes(snippet)) {
        addFailure(`Missing required text snippet in ${rule.file}: ${snippet}`);
      }
    }
  }
}

function checkRequiredMarkdownSections(config) {
  const rules = config?.checks?.requiredMarkdownSections ?? [];

  for (const rule of rules) {
    const content = readFileIfPresent(rule.file, Boolean(rule.optional));
    if (content === null) {
      continue;
    }

    for (const section of rule.sections ?? []) {
      if (!content.includes(section)) {
        addFailure(`Missing required markdown section in ${rule.file}: ${section}`);
      }
    }
  }
}

function checkRequiredSequenceSnippets(config) {
  const rules = config?.checks?.requiredSequenceSnippets ?? [];

  for (const rule of rules) {
    const content = readFileIfPresent(rule.file, Boolean(rule.optional));
    if (content === null) {
      continue;
    }

    let cursor = 0;
    for (const snippet of rule.sequence ?? []) {
      const index = content.indexOf(snippet, cursor);
      if (index === -1) {
        if (content.includes(snippet)) {
          addFailure(
            `Required sequence snippet is out of order in ${rule.file}: ${snippet}`,
          );
        } else {
          addFailure(`Missing required sequence snippet in ${rule.file}: ${snippet}`);
        }
        continue;
      }

      cursor = index + snippet.length;
    }
  }
}

function checkContinuityEntryFormat(config) {
  const rule = config?.checks?.continuityEntryFormat;
  if (!rule) {
    return;
  }

  const content = readFileIfPresent(rule.file, Boolean(rule.optional));
  if (content === null) {
    return;
  }

  const entryRegex = new RegExp(rule.entryRegex);
  const sectionHeaders = new Set(rule.sectionHeaders ?? []);
  const lines = content.split(/\r?\n/);

  let activeTrackedSection = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (sectionHeaders.has(trimmed)) {
      activeTrackedSection = trimmed;
      continue;
    }

    if (trimmed.startsWith("## ")) {
      activeTrackedSection = null;
      continue;
    }

    if (!activeTrackedSection || !trimmed.startsWith("- ")) {
      continue;
    }

    if (!entryRegex.test(trimmed)) {
      addFailure(
        `Invalid continuity entry format in ${rule.file}:${i + 1}: ${trimmed}`,
      );
    }
  }
}

function isExcludedPath(filePath, excludePaths = []) {
  return excludePaths.some((exclude) => {
    if (exclude.endsWith("/")) {
      return filePath.startsWith(exclude);
    }

    return filePath === exclude;
  });
}

function checkForbiddenTextPatterns(config, trackedFiles, trackedFilesReliable) {
  if (!trackedFilesReliable) {
    return;
  }

  const rules = config?.checks?.forbiddenTextPatterns ?? [];

  for (const rule of rules) {
    const pattern = new RegExp(rule.pattern);
    const linePattern = new RegExp(rule.pattern);

    for (const filePath of trackedFiles) {
      if (isExcludedPath(filePath, rule.excludePaths ?? [])) {
        continue;
      }

      const content = fs.readFileSync(filePath, "utf8");
      if (!isLikelyText(content)) {
        continue;
      }

      if (!pattern.test(content)) {
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (linePattern.test(lines[i])) {
          addFailure(
            `[${rule.id}] ${rule.message} Match found in ${filePath}:${i + 1}`,
          );
        }
      }
    }
  }
}

function checkDisallowedTrackedPathPrefixes(
  config,
  trackedFiles,
  trackedFilesReliable,
) {
  if (!trackedFilesReliable) {
    return;
  }

  const rules = config?.checks?.disallowedTrackedPathPrefixes ?? [];

  for (const rule of rules) {
    const offenders = trackedFiles.filter((filePath) =>
      filePath.startsWith(rule.prefix),
    );

    if (offenders.length === 0) {
      continue;
    }

    const sample = offenders.slice(0, 5).join(", ");
    addFailure(`${rule.message} Offenders: ${sample}`);
  }
}

function checkPolicyMetadata(config) {
  const metadata = config?.metadata ?? {};

  if (!metadata.id || typeof metadata.id !== "string") {
    addFailure("Policy metadata.id is required and must be a string.");
  }

  if (!metadata.version || typeof metadata.version !== "string") {
    addFailure("Policy metadata.version is required and must be a string.");
  }
}

function checkExactOrderedArray({
  value,
  expected,
  pathName,
  allowPrefix = false,
}) {
  if (!Array.isArray(value)) {
    addFailure(`${pathName} must be an array.`);
    return;
  }

  if (!allowPrefix && value.length !== expected.length) {
    addFailure(
      `${pathName} must contain exactly ${expected.length} items in canonical order.`,
    );
    return;
  }

  if (allowPrefix && value.length < expected.length) {
    addFailure(
      `${pathName} must contain at least ${expected.length} items in canonical prefix order.`,
    );
    return;
  }

  for (let i = 0; i < expected.length; i += 1) {
    if (value[i] !== expected[i]) {
      addFailure(
        `${pathName} item ${i + 1} must be \"${expected[i]}\" (found \"${value[i]}\").`,
      );
    }
  }
}

function checkDocumentationModelContract(config) {
  const contractPath = "contracts.documentationModel";
  const contract = config?.contracts?.documentationModel;
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }

  const requiredStrings = {
    bootstrapFile: "AGENTS.md",
    humanRulesFile: "docs/AGENT_RULES.md",
    humanContextFile: "docs/AGENT_CONTEXT.md",
    contextIndexFile: "docs/CONTEXT_INDEX.json",
    machinePolicyFile: ".github/policies/agent-governance.json",
    enforcementScript: ".github/scripts/enforce-agent-policies.mjs",
    sessionPreflightScript: ".github/scripts/agent-session-preflight.mjs",
    sessionPreflightCommand: "npm run agent:preflight",
  };

  for (const [fieldName, expectedValue] of Object.entries(requiredStrings)) {
    const actualValue = contract[fieldName];
    if (typeof actualValue !== "string") {
      addFailure(`${contractPath}.${fieldName} must be a string.`);
      continue;
    }
    if (actualValue !== expectedValue) {
      addFailure(
        `${contractPath}.${fieldName} must equal \"${expectedValue}\" (found \"${actualValue}\").`,
      );
    }
  }

  checkExactOrderedArray({
    value: contract.startupReadOrder,
    expected: [
      "AGENTS.md",
      "docs/AGENT_RULES.md",
      "docs/CONTEXT_INDEX.json",
      "docs/AGENT_CONTEXT.md",
      ".agents/EXECUTION_QUEUE.json",
      ".agents/CONTINUITY.md",
    ],
    pathName: `${contractPath}.startupReadOrder`,
  });

  checkExactOrderedArray({
    value: contract.precedenceOrder,
    expected: [
      "user_instruction",
      "machine_policy",
      "human_rules",
      "human_context",
    ],
    pathName: `${contractPath}.precedenceOrder`,
  });

  const bootstrapContent = readFileIfPresent(contract.bootstrapFile);
  if (bootstrapContent !== null) {
    for (const filePath of contract.startupReadOrder ?? []) {
      if (!bootstrapContent.includes(filePath)) {
        addFailure(
          `${contract.bootstrapFile} must reference startup file path ${filePath}.`,
        );
      }
    }

    if (
      typeof contract.sessionPreflightCommand === "string" &&
      contract.sessionPreflightCommand.length > 0 &&
      !bootstrapContent.includes(contract.sessionPreflightCommand)
    ) {
      addFailure(
        `${contract.bootstrapFile} must reference session preflight command ${contract.sessionPreflightCommand}.`,
      );
    }
  }

  readFileIfPresent(contract.humanRulesFile);
  readFileIfPresent(contract.humanContextFile);
  readFileIfPresent(contract.contextIndexFile);
  readFileIfPresent(contract.machinePolicyFile);
  readFileIfPresent(contract.enforcementScript);
  readFileIfPresent(contract.sessionPreflightScript);
}

function checkRequiredFieldList({
  fieldName,
  actualFields,
  requiredFields,
  contractPath,
}) {
  if (!Array.isArray(actualFields)) {
    addFailure(`${contractPath}.${fieldName} must be an array.`);
    return;
  }

  const seen = new Set();
  for (const field of actualFields) {
    if (typeof field !== "string" || field.trim() === "") {
      addFailure(`${contractPath}.${fieldName} contains an invalid field value.`);
      continue;
    }

    if (seen.has(field)) {
      addWarning(`${contractPath}.${fieldName} contains duplicate field: ${field}`);
    }
    seen.add(field);
  }

  for (const requiredField of requiredFields) {
    if (!seen.has(requiredField)) {
      addFailure(
        `${contractPath}.${fieldName} is missing required field: ${requiredField}`,
      );
    }
  }
}

function validateStringArray(value, fieldPath) {
  if (!Array.isArray(value)) {
    addFailure(`${fieldPath} must be an array.`);
    return [];
  }

  const output = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      addFailure(`${fieldPath} contains a non-string or empty value.`);
      continue;
    }
    output.push(item);
  }

  return output;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function toNonEmptyString(value) {
  return isNonEmptyString(value) ? value.trim() : null;
}

function isValidIsoDate(value) {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isNullableNonEmptyString(value) {
  return value === null || value === undefined || isNonEmptyString(value);
}

function isNullableIsoDate(value) {
  return value === null || value === undefined || isValidIsoDate(value);
}

function toArchiveFeatureShardName(featureId) {
  const base = toNonEmptyString(featureId) ?? "unassigned";
  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || "unassigned";
}

function readJsonLinesFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const parsed = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    try {
      parsed.push(JSON.parse(line));
    } catch (error) {
      addFailure(`Invalid JSONL entry in ${filePath}:${i + 1}: ${error.message}`);
      return [];
    }
  }

  return parsed;
}

function listFeaturePlanDirectories(rootPath) {
  if (!fs.existsSync(rootPath)) {
    return [];
  }

  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function listMarkdownFilesForPath(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return [];
  }

  const targetStats = fs.statSync(targetPath);
  if (targetStats.isFile()) {
    return targetPath.endsWith(".md") ? [targetPath] : [];
  }
  if (!targetStats.isDirectory()) {
    return [];
  }

  const files = [];
  const stack = [targetPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(entryPath);
      }
    }
  }

  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function normalizePlanReferenceCandidate(rawValue) {
  const raw = toNonEmptyString(rawValue);
  if (!raw) {
    return null;
  }

  let candidate = raw
    .replace(/^[`"'([{<]+/g, "")
    .replace(/[)\]}>.,;:!?`"']+$/g, "");

  if (!candidate.startsWith(".agents/plans/")) {
    return null;
  }
  if (candidate.includes("<") || candidate.includes(">") || candidate.includes("...")) {
    return null;
  }

  return candidate;
}

function scanStalePlanReferences(scanRoots, resolvePath = (value) => value) {
  const findings = [];
  const seen = new Set();
  const pattern = /\.agents\/plans\/(?:current|deferred|archived)\/[^\s`"'()<>{}\[\]]+/g;

  for (const scanRoot of scanRoots) {
    const markdownFiles = listMarkdownFilesForPath(resolvePath(scanRoot));
    for (const filePath of markdownFiles) {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        const matches = line.match(pattern) ?? [];
        for (const match of matches) {
          const normalized = normalizePlanReferenceCandidate(match);
          if (!normalized) {
            continue;
          }
          const target = normalized.split("#")[0];
          if (!target || fs.existsSync(resolvePath(target))) {
            continue;
          }

          const key = `${filePath}:${lineIndex + 1}:${target}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          findings.push({
            file: filePath,
            line: lineIndex + 1,
            reference: normalized,
            target,
          });
        }
      }
    }
  }

  return findings;
}

function checkWorkspaceLayoutContract(config, runtimeRepoRoot) {
  const contractPath = "contracts.workspaceLayout";
  const contract = config?.contracts?.workspaceLayout;
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }

  const requiredStrings = {
    canonicalRepoRoot: "/home/joshd/git/soundspan",
    canonicalAgentsRoot: "/home/joshd/git/soundspan/.agents",
    worktreesRoot: "/home/joshd/git/soundspan/.worktrees",
  };

  for (const [fieldName, expectedValue] of Object.entries(requiredStrings)) {
    const actualValue = toNonEmptyString(contract[fieldName]);
    if (!actualValue) {
      addFailure(`${contractPath}.${fieldName} must be a non-empty string.`);
      continue;
    }
    if (actualValue !== expectedValue) {
      addFailure(
        `${contractPath}.${fieldName} must equal "${expectedValue}" (found "${actualValue}").`,
      );
    }
  }

  if (contract.enforceWorktreeRoot !== true) {
    addFailure(`${contractPath}.enforceWorktreeRoot must equal true.`);
  }
  if (contract.requireSemanticMergeForAgents !== true) {
    addFailure(`${contractPath}.requireSemanticMergeForAgents must equal true.`);
  }
  if (contract.requireSemanticMergeOnAgentsEdit !== true) {
    addFailure(`${contractPath}.requireSemanticMergeOnAgentsEdit must equal true.`);
  }
  if (contract.requireWorktreeAgentsSymlink !== true) {
    addFailure(`${contractPath}.requireWorktreeAgentsSymlink must equal true.`);
  }

  const canonicalRepoRoot = toNonEmptyString(contract.canonicalRepoRoot);
  const canonicalAgentsRoot = toNonEmptyString(contract.canonicalAgentsRoot);
  const worktreesRoot = toNonEmptyString(contract.worktreesRoot);
  if (!canonicalRepoRoot || !canonicalAgentsRoot || !worktreesRoot) {
    return;
  }

  const canonicalRepoRootResolved = path.resolve(canonicalRepoRoot);
  const canonicalAgentsRootResolved = path.resolve(canonicalAgentsRoot);
  const worktreesRootResolved = path.resolve(worktreesRoot);
  const runtimeRepoRootResolved = path.resolve(runtimeRepoRoot);

  if (canonicalAgentsRootResolved !== path.resolve(canonicalRepoRootResolved, ".agents")) {
    addFailure(
      `${contractPath}.canonicalAgentsRoot must equal ${canonicalRepoRootResolved}/.agents.`,
    );
  }
  if (worktreesRootResolved !== path.resolve(canonicalRepoRootResolved, ".worktrees")) {
    addFailure(
      `${contractPath}.worktreesRoot must equal ${canonicalRepoRootResolved}/.worktrees.`,
    );
  }

  const inCanonicalRoot = runtimeRepoRootResolved === canonicalRepoRootResolved;
  const inConfiguredWorktreeRoot = isPathWithin(runtimeRepoRootResolved, worktreesRootResolved);
  if (!inCanonicalRoot && !inConfiguredWorktreeRoot) {
    addFailure(
      `Current repo root ${runtimeRepoRootResolved} must be canonical root ${canonicalRepoRootResolved} or inside ${worktreesRootResolved}.`,
    );
  }

  if (inConfiguredWorktreeRoot) {
    const worktreeAgentsPath = path.join(runtimeRepoRootResolved, ".agents");
    if (!fs.existsSync(worktreeAgentsPath)) {
      addFailure(
        `${worktreeAgentsPath} must exist as a symlink to canonical agents root ${canonicalAgentsRootResolved}.`,
      );
    } else {
      const stats = fs.lstatSync(worktreeAgentsPath);
      if (!stats.isSymbolicLink()) {
        addFailure(
          `${worktreeAgentsPath} must be a symlink to canonical agents root ${canonicalAgentsRootResolved}.`,
        );
      } else {
        const targetResolved = path.resolve(fs.realpathSync(worktreeAgentsPath));
        if (targetResolved !== canonicalAgentsRootResolved) {
          addFailure(
            `${worktreeAgentsPath} must resolve to ${canonicalAgentsRootResolved} (found ${targetResolved}).`,
          );
        }
      }
    }
  }

  const gitignoreContent = readFileIfPresent(".gitignore");
  if (gitignoreContent !== null) {
    for (const snippet of [".agents/**", ".worktrees/"]) {
      if (!gitignoreContent.includes(snippet)) {
        addFailure(`.gitignore must include ${snippet} for local-context hygiene.`);
      }
    }
  }

  const worktreeListResult = runCommandSafe("git", ["worktree", "list", "--porcelain"]);
  if (!worktreeListResult.ok) {
    addWarning("Unable to inspect git worktree list; worktree-root contract check skipped.");
    return;
  }

  const discoveredWorktrees = worktreeListResult.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length).trim()))
    .filter((line) => line.length > 0);

  if (!discoveredWorktrees.includes(canonicalRepoRootResolved)) {
    addFailure(
      `git worktree list must include canonical repo root ${canonicalRepoRootResolved}.`,
    );
  }

  for (const worktreePath of discoveredWorktrees) {
    if (worktreePath === canonicalRepoRootResolved) {
      continue;
    }
    if (!isPathWithin(worktreePath, worktreesRootResolved)) {
      addFailure(
        `Worktree ${worktreePath} must live under configured worktrees root ${worktreesRootResolved}.`,
      );
    }
    if (contract.requireWorktreeAgentsSymlink === true) {
      const agentsPath = path.join(worktreePath, ".agents");
      if (!fs.existsSync(agentsPath)) {
        addFailure(`${agentsPath} must exist as a symlink to ${canonicalAgentsRootResolved}.`);
        continue;
      }
      const agentsStats = fs.lstatSync(agentsPath);
      if (!agentsStats.isSymbolicLink()) {
        addFailure(`${agentsPath} must be a symlink to ${canonicalAgentsRootResolved}.`);
        continue;
      }
      const targetResolved = path.resolve(fs.realpathSync(agentsPath));
      if (targetResolved !== canonicalAgentsRootResolved) {
        addFailure(
          `${agentsPath} must resolve to ${canonicalAgentsRootResolved} (found ${targetResolved}).`,
        );
      }
    }
  }
}

function checkContextIndexContract(config) {
  const contractPath = "contracts.contextIndex";
  const contract = config?.contracts?.contextIndex;
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }

  if (contract.indexFile !== "docs/CONTEXT_INDEX.json") {
    addFailure(
      `${contractPath}.indexFile must equal \"docs/CONTEXT_INDEX.json\".`,
    );
    return;
  }

  const index = readJsonIfPresent(contract.indexFile);
  if (index === null) {
    return;
  }

  const documentationModel = config?.contracts?.documentationModel ?? {};
  if (!index.primaryContracts || typeof index.primaryContracts !== "object") {
    addFailure(`${contract.indexFile}.primaryContracts must be an object.`);
  } else {
    const expectedPrimaryContracts = {
      bootstrapFile:
        toNonEmptyString(documentationModel.bootstrapFile) ?? "AGENTS.md",
      rulesFile:
        toNonEmptyString(documentationModel.humanRulesFile) ??
        "docs/AGENT_RULES.md",
      contextFile:
        toNonEmptyString(documentationModel.humanContextFile) ??
        "docs/AGENT_CONTEXT.md",
      policyFile:
        toNonEmptyString(documentationModel.machinePolicyFile) ??
        ".github/policies/agent-governance.json",
      enforcerFile:
        toNonEmptyString(documentationModel.enforcementScript) ??
        ".github/scripts/enforce-agent-policies.mjs",
      preflightFile:
        toNonEmptyString(documentationModel.sessionPreflightScript) ??
        ".github/scripts/agent-session-preflight.mjs",
    };

    for (const [fieldName, expectedValue] of Object.entries(
      expectedPrimaryContracts,
    )) {
      const actualValue = toNonEmptyString(index.primaryContracts[fieldName]);
      if (actualValue !== expectedValue) {
        addFailure(
          `${contract.indexFile}.primaryContracts.${fieldName} must equal ${expectedValue}.`,
        );
      }
    }
  }

  const requiredTopLevelKeys = validateStringArray(
    contract.requiredTopLevelKeys,
    `${contractPath}.requiredTopLevelKeys`,
  );
  for (const key of requiredTopLevelKeys) {
    if (!(key in index)) {
      addFailure(`${contract.indexFile} is missing required top-level key: ${key}`);
    }
  }

  checkExactOrderedArray({
    value: contract.requiredStartupReadOrder,
    expected: [
      "AGENTS.md",
      "docs/AGENT_RULES.md",
      "docs/CONTEXT_INDEX.json",
      "docs/AGENT_CONTEXT.md",
      ".agents/EXECUTION_QUEUE.json",
      ".agents/CONTINUITY.md",
    ],
    pathName: `${contractPath}.requiredStartupReadOrder`,
  });

  checkExactOrderedArray({
    value: index.startupReadOrder,
    expected: contract.requiredStartupReadOrder ?? [],
    pathName: `${contract.indexFile}.startupReadOrder`,
  });

  const requiredCommandKeys = validateStringArray(
    contract.requiredCommandKeys,
    `${contractPath}.requiredCommandKeys`,
  );

  if (!index.commands || typeof index.commands !== "object") {
    addFailure(`${contract.indexFile}.commands must be an object.`);
  } else {
    for (const key of requiredCommandKeys) {
      const command = index.commands[key];
      if (typeof command !== "string" || command.trim() === "") {
        addFailure(`${contract.indexFile}.commands.${key} must be a non-empty string.`);
      }
    }
  }

  if (!index.sessionArtifacts || typeof index.sessionArtifacts !== "object") {
    addFailure(`${contract.indexFile}.sessionArtifacts must be an object.`);
  } else {
    const sessionArtifactsContract = config?.contracts?.sessionArtifacts ?? {};
    const expectedSessionArtifactStrings = {
      executionQueueFile:
        toNonEmptyString(sessionArtifactsContract.executionQueueFile) ??
        ".agents/EXECUTION_QUEUE.json",
      continuityFile:
        toNonEmptyString(sessionArtifactsContract.continuityFile) ??
        ".agents/CONTINUITY.md",
      sessionBriefJsonFile:
        toNonEmptyString(sessionArtifactsContract.sessionBriefJsonFile) ??
        ".agents/SESSION_BRIEF.json",
      archiveRoot:
        toNonEmptyString(sessionArtifactsContract.archiveRoot) ??
        ".agents/archives",
      archiveIndexFile:
        toNonEmptyString(sessionArtifactsContract.archiveIndexFile) ??
        ".agents/EXECUTION_ARCHIVE_INDEX.json",
      archiveShardBy:
        toNonEmptyString(sessionArtifactsContract.archiveShardBy) ?? "feature_id",
      archiveFormat:
        toNonEmptyString(sessionArtifactsContract.archiveFormat) ?? "jsonl",
      plansRoot:
        toNonEmptyString(sessionArtifactsContract.plansRoot) ?? ".agents/plans",
    };

    for (const [fieldName, expectedValue] of Object.entries(
      expectedSessionArtifactStrings,
    )) {
      const actualValue = toNonEmptyString(index.sessionArtifacts[fieldName]);
      if (actualValue !== expectedValue) {
        addFailure(
          `${contract.indexFile}.sessionArtifacts.${fieldName} must equal ${expectedValue}.`,
        );
      }
    }

    const requiredSessionArtifactFields = [
      "executionQueueFile",
      "continuityFile",
      "sessionBriefJsonFile",
      "archiveRoot",
      "archiveIndexFile",
      "archiveShardBy",
      "archiveFormat",
      "archiveReadPolicy",
      "queueScopedRead",
      "archiveOnComplete",
      "plansRoot",
      "planRoots",
      "planQueueSync",
      "archivedPlanSync",
      "stalePlanReferenceCheck",
      "workspaceLayout",
      "sessionBriefContract",
      "repositoryIndexPreflight",
    ];

    for (const fieldName of requiredSessionArtifactFields) {
      if (!(fieldName in index.sessionArtifacts)) {
        addFailure(
          `${contract.indexFile}.sessionArtifacts is missing required field ${fieldName}.`,
        );
      }
    }

    if (
      index.sessionArtifacts.queueScopedRead &&
      typeof index.sessionArtifacts.queueScopedRead === "object"
    ) {
      const queueScopedRead = index.sessionArtifacts.queueScopedRead;
      for (const fieldName of [
        "requiredTopLevelFields",
        "itemSelectorFields",
        "maxItemsPerRead",
      ]) {
        if (!(fieldName in queueScopedRead)) {
          addFailure(
            `${contract.indexFile}.sessionArtifacts.queueScopedRead is missing required field ${fieldName}.`,
          );
        }
      }
    } else {
      addFailure(
        `${contract.indexFile}.sessionArtifacts.queueScopedRead must be an object.`,
      );
    }

    if (
      index.sessionArtifacts.archiveOnComplete &&
      typeof index.sessionArtifacts.archiveOnComplete === "object"
    ) {
      const archiveOnComplete = index.sessionArtifacts.archiveOnComplete;
      for (const fieldName of ["itemStates", "queueStates", "forbidCompleteInHotQueue"]) {
        if (!(fieldName in archiveOnComplete)) {
          addFailure(
            `${contract.indexFile}.sessionArtifacts.archiveOnComplete is missing required field ${fieldName}.`,
          );
        }
      }
    } else {
      addFailure(
        `${contract.indexFile}.sessionArtifacts.archiveOnComplete must be an object.`,
      );
    }

    if (
      index.sessionArtifacts.planQueueSync &&
      typeof index.sessionArtifacts.planQueueSync === "object"
    ) {
      const planQueueSync = index.sessionArtifacts.planQueueSync;
      for (const fieldName of ["enabled", "planFileName", "roots", "stateByRoot"]) {
        if (!(fieldName in planQueueSync)) {
          addFailure(
            `${contract.indexFile}.sessionArtifacts.planQueueSync is missing required field ${fieldName}.`,
          );
        }
      }
    } else {
      addFailure(
        `${contract.indexFile}.sessionArtifacts.planQueueSync must be an object.`,
      );
    }

    if (
      index.sessionArtifacts.archivedPlanSync &&
      typeof index.sessionArtifacts.archivedPlanSync === "object"
    ) {
      const archivedPlanSync = index.sessionArtifacts.archivedPlanSync;
      for (const fieldName of [
        "enabled",
        "root",
        "planFileName",
        "archiveKeyPrefix",
        "indexKind",
      ]) {
        if (!(fieldName in archivedPlanSync)) {
          addFailure(
            `${contract.indexFile}.sessionArtifacts.archivedPlanSync is missing required field ${fieldName}.`,
          );
        }
      }
    } else {
      addFailure(
        `${contract.indexFile}.sessionArtifacts.archivedPlanSync must be an object.`,
      );
    }

    if (
      index.sessionArtifacts.stalePlanReferenceCheck &&
      typeof index.sessionArtifacts.stalePlanReferenceCheck === "object"
    ) {
      const stalePlanReferenceCheck = index.sessionArtifacts.stalePlanReferenceCheck;
      for (const fieldName of ["enabled", "failureMode", "scanRoots"]) {
        if (!(fieldName in stalePlanReferenceCheck)) {
          addFailure(
            `${contract.indexFile}.sessionArtifacts.stalePlanReferenceCheck is missing required field ${fieldName}.`,
          );
        }
      }
      const failureMode = toNonEmptyString(stalePlanReferenceCheck.failureMode);
      if (!failureMode || !["warn", "fail"].includes(failureMode)) {
        addFailure(
          `${contract.indexFile}.sessionArtifacts.stalePlanReferenceCheck.failureMode must be either "warn" or "fail".`,
        );
      } else if (failureMode !== "fail") {
        addFailure(
          `${contract.indexFile}.sessionArtifacts.stalePlanReferenceCheck.failureMode must equal "fail".`,
        );
      }
    } else {
      addFailure(
        `${contract.indexFile}.sessionArtifacts.stalePlanReferenceCheck must be an object.`,
      );
    }

    if (
      index.sessionArtifacts.sessionBriefContract &&
      typeof index.sessionArtifacts.sessionBriefContract === "object"
    ) {
      const sessionBriefContract = index.sessionArtifacts.sessionBriefContract;
      for (const fieldName of ["requiredFields", "freshnessHoursWarning", "freshnessFailureMode"]) {
        if (!(fieldName in sessionBriefContract)) {
          addFailure(
            `${contract.indexFile}.sessionArtifacts.sessionBriefContract is missing required field ${fieldName}.`,
          );
        }
      }
      const freshnessFailureMode = toNonEmptyString(
        sessionBriefContract.freshnessFailureMode,
      );
      if (!freshnessFailureMode || !["warn", "fail"].includes(freshnessFailureMode)) {
        addFailure(
          `${contract.indexFile}.sessionArtifacts.sessionBriefContract.freshnessFailureMode must be either "warn" or "fail".`,
        );
      } else if (freshnessFailureMode !== "fail") {
        addFailure(
          `${contract.indexFile}.sessionArtifacts.sessionBriefContract.freshnessFailureMode must equal "fail".`,
        );
      }

      const sessionBriefRequiredFields = validateStringArray(
        sessionBriefContract.requiredFields,
        `${contract.indexFile}.sessionArtifacts.sessionBriefContract.requiredFields`,
      );
      const expectedSessionBriefRequiredFields = Array.isArray(
        config?.contracts?.sessionArtifacts?.sessionBriefRequiredFields,
      )
        ? config.contracts.sessionArtifacts.sessionBriefRequiredFields
            .filter((fieldName) => typeof fieldName === "string")
            .map((fieldName) => fieldName.trim())
            .filter((fieldName) => fieldName.length > 0)
        : [];
      for (const expectedFieldName of expectedSessionBriefRequiredFields) {
        if (!sessionBriefRequiredFields.includes(expectedFieldName)) {
          addFailure(
            `${contract.indexFile}.sessionArtifacts.sessionBriefContract.requiredFields is missing ${expectedFieldName}.`,
          );
        }
      }
    } else {
      addFailure(
        `${contract.indexFile}.sessionArtifacts.sessionBriefContract must be an object.`,
      );
    }

    if (
      index.sessionArtifacts.repositoryIndexPreflight &&
      typeof index.sessionArtifacts.repositoryIndexPreflight === "object"
    ) {
      const repositoryIndexPreflight =
        index.sessionArtifacts.repositoryIndexPreflight;
      for (const fieldName of [
        "enabled",
        "buildIfMissing",
        "reindexBeforeVerify",
        "verifyStrict",
        "failureMode",
        "closeoutVerifyIfPossible",
      ]) {
        if (!(fieldName in repositoryIndexPreflight)) {
          addFailure(
            `${contract.indexFile}.sessionArtifacts.repositoryIndexPreflight is missing required field ${fieldName}.`,
          );
        }
      }

      if (typeof repositoryIndexPreflight.enabled !== "boolean") {
        addFailure(
          `${contract.indexFile}.sessionArtifacts.repositoryIndexPreflight.enabled must be a boolean.`,
        );
      }
      if (typeof repositoryIndexPreflight.buildIfMissing !== "boolean") {
        addFailure(
          `${contract.indexFile}.sessionArtifacts.repositoryIndexPreflight.buildIfMissing must be a boolean.`,
        );
      }
      if (typeof repositoryIndexPreflight.reindexBeforeVerify !== "boolean") {
        addFailure(
          `${contract.indexFile}.sessionArtifacts.repositoryIndexPreflight.reindexBeforeVerify must be a boolean.`,
        );
      }
      if (typeof repositoryIndexPreflight.verifyStrict !== "boolean") {
        addFailure(
          `${contract.indexFile}.sessionArtifacts.repositoryIndexPreflight.verifyStrict must be a boolean.`,
        );
      }
      if (
        typeof repositoryIndexPreflight.closeoutVerifyIfPossible !== "boolean"
      ) {
        addFailure(
          `${contract.indexFile}.sessionArtifacts.repositoryIndexPreflight.closeoutVerifyIfPossible must be a boolean.`,
        );
      }

      const repositoryIndexFailureMode = toNonEmptyString(
        repositoryIndexPreflight.failureMode,
      );
      if (
        !repositoryIndexFailureMode ||
        !["warn", "fail"].includes(repositoryIndexFailureMode)
      ) {
        addFailure(
          `${contract.indexFile}.sessionArtifacts.repositoryIndexPreflight.failureMode must be either "warn" or "fail".`,
        );
      }

      const contractRepositoryIndexPreflight =
        sessionArtifactsContract &&
        typeof sessionArtifactsContract === "object" &&
        sessionArtifactsContract.repositoryIndexPreflight &&
        typeof sessionArtifactsContract.repositoryIndexPreflight === "object"
          ? sessionArtifactsContract.repositoryIndexPreflight
          : null;
      if (contractRepositoryIndexPreflight) {
        for (const fieldName of [
          "enabled",
          "buildIfMissing",
          "reindexBeforeVerify",
          "verifyStrict",
          "failureMode",
          "closeoutVerifyIfPossible",
        ]) {
          if (
            repositoryIndexPreflight[fieldName] !==
            contractRepositoryIndexPreflight[fieldName]
          ) {
            addFailure(
              `${contract.indexFile}.sessionArtifacts.repositoryIndexPreflight.${fieldName} must equal contracts.sessionArtifacts.repositoryIndexPreflight.${fieldName}.`,
            );
          }
        }
      }
    } else {
      addFailure(
        `${contract.indexFile}.sessionArtifacts.repositoryIndexPreflight must be an object.`,
      );
    }

    if (
      index.sessionArtifacts.workspaceLayout &&
      typeof index.sessionArtifacts.workspaceLayout === "object"
    ) {
      const indexWorkspaceLayout = index.sessionArtifacts.workspaceLayout;
      const contractWorkspaceLayout =
        config?.contracts?.workspaceLayout && typeof config.contracts.workspaceLayout === "object"
          ? config.contracts.workspaceLayout
          : null;
      for (const fieldName of [
        "canonicalRepoRoot",
        "canonicalAgentsRoot",
        "worktreesRoot",
      ]) {
        if (!(fieldName in indexWorkspaceLayout)) {
          addFailure(
            `${contract.indexFile}.sessionArtifacts.workspaceLayout is missing required field ${fieldName}.`,
          );
        }
      }
      if (contractWorkspaceLayout) {
        const expectedBooleanByField = {
          semanticMergeRequired: contractWorkspaceLayout.requireSemanticMergeForAgents,
          semanticMergeOnAgentsEditRequired:
            contractWorkspaceLayout.requireSemanticMergeOnAgentsEdit,
          worktreeAgentsSymlinkRequired:
            contractWorkspaceLayout.requireWorktreeAgentsSymlink,
        };
        for (const fieldName of [
          "canonicalRepoRoot",
          "canonicalAgentsRoot",
          "worktreesRoot",
        ]) {
          if (indexWorkspaceLayout[fieldName] !== contractWorkspaceLayout[fieldName]) {
            addFailure(
              `${contract.indexFile}.sessionArtifacts.workspaceLayout.${fieldName} must equal contracts.workspaceLayout.${fieldName}.`,
            );
          }
        }
        for (const [fieldName, expectedValue] of Object.entries(
          expectedBooleanByField,
        )) {
          if (indexWorkspaceLayout[fieldName] !== expectedValue) {
            addFailure(
              `${contract.indexFile}.sessionArtifacts.workspaceLayout.${fieldName} must equal ${expectedValue}.`,
            );
          }
        }
      }
    } else {
      addFailure(
        `${contract.indexFile}.sessionArtifacts.workspaceLayout must be an object.`,
      );
    }
  }

  if (!Array.isArray(index.rulesSections)) {
    addFailure(`${contract.indexFile}.rulesSections must be an array.`);
  } else {
    for (const section of index.rulesSections) {
      if (!section || typeof section !== "object") {
        addFailure(`${contract.indexFile}.rulesSections contains non-object entry.`);
        continue;
      }
      if (typeof section.file !== "string" || typeof section.heading !== "string") {
        addFailure(
          `${contract.indexFile}.rulesSections entries must include string file and heading.`,
        );
        continue;
      }
      const content = readFileIfPresent(section.file);
      if (content !== null && !content.includes(section.heading)) {
        addFailure(
          `${contract.indexFile} references missing heading ${section.heading} in ${section.file}.`,
        );
      }
    }
  }

  if (!Array.isArray(index.contextSections)) {
    addFailure(`${contract.indexFile}.contextSections must be an array.`);
  } else {
    for (const section of index.contextSections) {
      if (!section || typeof section !== "object") {
        addFailure(`${contract.indexFile}.contextSections contains non-object entry.`);
        continue;
      }
      if (typeof section.file !== "string" || typeof section.heading !== "string") {
        addFailure(
          `${contract.indexFile}.contextSections entries must include string file and heading.`,
        );
        continue;
      }
      const content = readFileIfPresent(section.file);
      if (content !== null && !content.includes(section.heading)) {
        addFailure(
          `${contract.indexFile} references missing heading ${section.heading} in ${section.file}.`,
        );
      }
    }
  }
}

function checkReleaseNotesContract(config) {
  const contractPath = "contracts.releaseNotes";
  const contract = config?.contracts?.releaseNotes;
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }

  const requiredStrings = {
    sourceOfTruthFile: "CHANGELOG.md",
    unreleasedSectionHeading: "## [Unreleased]",
    templateFile: "docs/RELEASE_NOTES_TEMPLATE.md",
    generatorScript: ".github/scripts/generate-release-notes.mjs",
    prepareScript: ".github/scripts/release-version-sync.mjs",
    prepareNpmScriptName: "release:prepare",
    prepareNpmScriptCommand: "node .github/scripts/release-version-sync.mjs --write",
    prepareCommandExample: "npm run release:prepare -- --version <X.Y.Z>",
    npmScriptName: "release:notes",
    npmScriptCommand: "node .github/scripts/generate-release-notes.mjs",
    commandExample:
      "npm run release:notes -- --version <X.Y.Z> --from <tag> [--to <ref>] [--output <path>]",
    helmRepoName: "soundspan",
    helmRepoUrl: "https://soundspan.github.io/soundspan",
    helmChartName: "soundspan",
    helmChartReference: "soundspan/soundspan",
  };

  for (const [fieldName, expectedValue] of Object.entries(requiredStrings)) {
    const actualValue = toNonEmptyString(contract[fieldName]);
    if (!actualValue) {
      addFailure(`${contractPath}.${fieldName} must be a non-empty string.`);
      continue;
    }
    if (actualValue !== expectedValue) {
      addFailure(
        `${contractPath}.${fieldName} must equal "${expectedValue}" (found "${actualValue}").`,
      );
    }
  }

  if (contract.plainEnglishSummariesRequired !== true) {
    addFailure(`${contractPath}.plainEnglishSummariesRequired must be true.`);
  }
  if (contract.prepareRotatesUnreleased !== true) {
    addFailure(`${contractPath}.prepareRotatesUnreleased must be true.`);
  }

  checkExactOrderedArray({
    value: contract.requiredSections,
    expected: [
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
    ],
    pathName: `${contractPath}.requiredSections`,
  });

  checkExactOrderedArray({
    value: contract.requiredTemplateTokens,
    expected: [
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
    ],
    pathName: `${contractPath}.requiredTemplateTokens`,
  });

  checkExactOrderedArray({
    value: contract.requiredChangelogSubsections,
    expected: ["### Added", "### Changed", "### Fixed"],
    pathName: `${contractPath}.requiredChangelogSubsections`,
  });

  const templateFile = toNonEmptyString(contract.templateFile);
  const templateContent = templateFile ? readFileIfPresent(templateFile) : null;
  if (templateContent !== null) {
    let cursor = 0;
    for (const section of contract.requiredSections ?? []) {
      const index = templateContent.indexOf(section, cursor);
      if (index === -1) {
        if (templateContent.includes(section)) {
          addFailure(
            `${templateFile} contains section out of order relative to ${contractPath}.requiredSections: ${section}`,
          );
        } else {
          addFailure(`${templateFile} is missing required section: ${section}`);
        }
        continue;
      }
      cursor = index + section.length;
    }

    for (const token of contract.requiredTemplateTokens ?? []) {
      if (!templateContent.includes(token)) {
        addFailure(`${templateFile} is missing required template token: ${token}`);
      }
    }

    const requiredTemplateSnippets = [
      `Helm chart repository: \`${contract.helmRepoUrl}\``,
      `Helm chart name: \`${contract.helmChartName}\``,
      `Helm chart reference: \`${contract.helmChartReference}\``,
      `helm repo add ${contract.helmRepoName} ${contract.helmRepoUrl}`,
      `helm upgrade --install soundspan ${contract.helmChartReference} --version {{VERSION}}`,
    ];
    for (const snippet of requiredTemplateSnippets) {
      if (!templateContent.includes(snippet)) {
        addFailure(`${templateFile} is missing required Helm release snippet: ${snippet}`);
      }
    }
  }

  const generatorScript = toNonEmptyString(contract.generatorScript);
  const sourceOfTruthFile = toNonEmptyString(contract.sourceOfTruthFile);
  const sourceOfTruthHeading = toNonEmptyString(contract.unreleasedSectionHeading);
  const prepareScript = toNonEmptyString(contract.prepareScript);
  if (generatorScript) {
    const generatorContent = readFileIfPresent(generatorScript);
    if (generatorContent !== null) {
      if (sourceOfTruthFile && !generatorContent.includes(sourceOfTruthFile)) {
        if (!generatorContent.includes("CHANGELOG_PATH")) {
          addFailure(
            `${generatorScript} must reference ${sourceOfTruthFile} (or CHANGELOG_PATH) as release-note source of truth.`,
          );
        }
      }
      if (
        !generatorContent.includes("Missing CHANGELOG") &&
        !generatorContent.includes("Missing ${CHANGELOG_PATH}")
      ) {
        addFailure(
          `${generatorScript} must fail clearly when the requested CHANGELOG release section is missing.`,
        );
      }
    }
  }

  if (prepareScript) {
    const prepareContent = readFileIfPresent(prepareScript);
    if (prepareContent !== null) {
      if (sourceOfTruthFile && !prepareContent.includes(sourceOfTruthFile)) {
        if (!prepareContent.includes("CHANGELOG_PATH")) {
          addFailure(
            `${prepareScript} must reference ${sourceOfTruthFile} (or CHANGELOG_PATH) for release rotation updates.`,
          );
        }
      }
      if (!prepareContent.includes("prepareChangelogForRelease")) {
        addFailure(
          `${prepareScript} must call changelog rotation during release preparation.`,
        );
      }
    }
  }

  if (sourceOfTruthFile) {
    const changelogContent = readFileIfPresent(sourceOfTruthFile);
    if (changelogContent !== null) {
      if (sourceOfTruthHeading && !changelogContent.includes(sourceOfTruthHeading)) {
        addFailure(`${sourceOfTruthFile} is missing required section heading ${sourceOfTruthHeading}.`);
      }
      for (const subsection of contract.requiredChangelogSubsections ?? []) {
        if (!changelogContent.includes(subsection)) {
          addFailure(`${sourceOfTruthFile} is missing required changelog subsection ${subsection}.`);
        }
      }
    }
  }

  const packageJson = readJsonIfPresent("package.json");
  if (packageJson && typeof packageJson === "object") {
    const scriptName = toNonEmptyString(contract.npmScriptName);
    const scriptCommand = toNonEmptyString(contract.npmScriptCommand);
    const prepareScriptName = toNonEmptyString(contract.prepareNpmScriptName);
    const prepareScriptCommand = toNonEmptyString(contract.prepareNpmScriptCommand);
    const scripts =
      packageJson.scripts && typeof packageJson.scripts === "object"
        ? packageJson.scripts
        : null;

    if (!scripts) {
      addFailure("package.json scripts block is required for release-notes generator wiring.");
    } else if (scriptName && scriptCommand) {
      const configuredCommand = toNonEmptyString(scripts[scriptName]);
      if (!configuredCommand) {
        addFailure(`package.json scripts must define "${scriptName}".`);
      } else if (configuredCommand !== scriptCommand) {
        addFailure(
          `package.json scripts["${scriptName}"] must equal "${scriptCommand}" (found "${configuredCommand}").`,
        );
      }
    }

    if (prepareScriptName && prepareScriptCommand) {
      const configuredPrepareCommand = toNonEmptyString(scripts[prepareScriptName]);
      if (!configuredPrepareCommand) {
        addFailure(`package.json scripts must define "${prepareScriptName}".`);
      } else if (configuredPrepareCommand !== prepareScriptCommand) {
        addFailure(
          `package.json scripts["${prepareScriptName}"] must equal "${prepareScriptCommand}" (found "${configuredPrepareCommand}").`,
        );
      }
    }
  }

  const contextIndex = readJsonIfPresent("docs/CONTEXT_INDEX.json");
  if (contextIndex && typeof contextIndex === "object") {
    const commandExample = toNonEmptyString(contract.commandExample);
    const prepareCommandExample = toNonEmptyString(contract.prepareCommandExample);
    const commands =
      contextIndex.commands && typeof contextIndex.commands === "object"
        ? contextIndex.commands
        : null;

    if (!commands) {
      addFailure("docs/CONTEXT_INDEX.json commands block is required.");
    } else if (commandExample) {
      const releaseNotesCommand = toNonEmptyString(commands.releaseNotes);
      if (!releaseNotesCommand) {
        addFailure("docs/CONTEXT_INDEX.json.commands.releaseNotes must be present.");
      } else if (releaseNotesCommand !== commandExample) {
        addFailure(
          `docs/CONTEXT_INDEX.json.commands.releaseNotes must equal contracts.releaseNotes.commandExample.`,
        );
      }
    }

    if (prepareCommandExample) {
      const releasePrepareCommand = toNonEmptyString(commands?.releasePrepare);
      if (!releasePrepareCommand) {
        addFailure("docs/CONTEXT_INDEX.json.commands.releasePrepare must be present.");
      } else if (releasePrepareCommand !== prepareCommandExample) {
        addFailure(
          "docs/CONTEXT_INDEX.json.commands.releasePrepare must equal contracts.releaseNotes.prepareCommandExample.",
        );
      }
    }
  }
}

function checkFeatureIndexContract(config) {
  const contractPath = "contracts.featureIndex";
  const contract = config?.contracts?.featureIndex;
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }

  const featureIndexFile = toNonEmptyString(contract.file);
  if (!featureIndexFile) {
    addFailure(`${contractPath}.file must be a non-empty string.`);
    return;
  }

  const featureIndexVerifyScript = "tools/docs/feature-index-check.mjs";
  const featureIndexVerifyCommand = "node tools/docs/feature-index-check.mjs --strict";
  readFileIfPresent(featureIndexVerifyScript);

  const featureIndex = readJsonIfPresent(featureIndexFile);
  if (featureIndex === null) {
    return;
  }

  const requiredTopLevelKeys = validateStringArray(
    contract.requiredTopLevelKeys,
    `${contractPath}.requiredTopLevelKeys`,
  );
  for (const key of requiredTopLevelKeys) {
    if (!(key in featureIndex)) {
      addFailure(`${featureIndexFile} is missing required top-level key: ${key}`);
    }
  }

  const metadata = featureIndex.metadata;
  if (!metadata || typeof metadata !== "object") {
    addFailure(`${featureIndexFile}.metadata must be an object.`);
  } else {
    const requiredMetadataKeys = validateStringArray(
      contract.requiredMetadataKeys,
      `${contractPath}.requiredMetadataKeys`,
    );
    for (const key of requiredMetadataKeys) {
      if (!(key in metadata)) {
        addFailure(`${featureIndexFile}.metadata is missing required field: ${key}`);
      }
    }

    const requiredMetadataId = toNonEmptyString(contract.requiredMetadataId);
    if (requiredMetadataId) {
      const actualId = toNonEmptyString(metadata.id);
      if (actualId !== requiredMetadataId) {
        addFailure(
          `${featureIndexFile}.metadata.id must equal ${requiredMetadataId}.`,
        );
      }
    }

    if (!isValidIsoDate(metadata.last_updated)) {
      addFailure(`${featureIndexFile}.metadata.last_updated must be a valid ISO timestamp.`);
    }
  }

  const coverage = featureIndex.coverage;
  if (!coverage || typeof coverage !== "object") {
    addFailure(`${featureIndexFile}.coverage must be an object.`);
  } else {
    const requiredCoverageKeys = validateStringArray(
      contract.requiredCoverageKeys,
      `${contractPath}.requiredCoverageKeys`,
    );
    for (const key of requiredCoverageKeys) {
      if (!(key in coverage)) {
        addFailure(`${featureIndexFile}.coverage is missing required field: ${key}`);
      }
    }
  }

  if (!Array.isArray(featureIndex.features)) {
    addFailure(`${featureIndexFile}.features must be an array.`);
    return;
  }

  const requiredFeatureFields = validateStringArray(
    contract.requiredFeatureFields,
    `${contractPath}.requiredFeatureFields`,
  );
  const requiredFrontendFields = validateStringArray(
    contract.requiredFrontendFields,
    `${contractPath}.requiredFrontendFields`,
  );
  const requiredBackendFields = validateStringArray(
    contract.requiredBackendFields,
    `${contractPath}.requiredBackendFields`,
  );
  const requiredTestsFields = validateStringArray(
    contract.requiredTestsFields,
    `${contractPath}.requiredTestsFields`,
  );

  const coveredFrontendDirs = new Set();

  for (const [index, feature] of featureIndex.features.entries()) {
    if (!feature || typeof feature !== "object") {
      addFailure(`${featureIndexFile}.features[${index}] must be an object.`);
      continue;
    }

    for (const fieldName of requiredFeatureFields) {
      if (!(fieldName in feature)) {
        addFailure(
          `${featureIndexFile}.features[${index}] is missing required field ${fieldName}.`,
        );
      }
    }

    if (!isNonEmptyString(feature.id)) {
      addFailure(`${featureIndexFile}.features[${index}].id must be a non-empty string.`);
    }

    const frontend = feature.frontend;
    if (!frontend || typeof frontend !== "object") {
      addFailure(`${featureIndexFile}.features[${index}].frontend must be an object.`);
    } else {
      for (const fieldName of requiredFrontendFields) {
        if (!(fieldName in frontend)) {
          addFailure(
            `${featureIndexFile}.features[${index}].frontend is missing field ${fieldName}.`,
          );
        }
      }

      const featureDirs = validateStringArray(
        frontend.feature_dirs ?? [],
        `${featureIndexFile}.features[${index}].frontend.feature_dirs`,
      );
      for (const dirName of featureDirs) {
        coveredFrontendDirs.add(dirName);
      }

      validateStringArray(
        frontend.routes ?? [],
        `${featureIndexFile}.features[${index}].frontend.routes`,
      );
      validateStringArray(
        frontend.primary_files ?? [],
        `${featureIndexFile}.features[${index}].frontend.primary_files`,
      );
    }

    const backend = feature.backend;
    if (!backend || typeof backend !== "object") {
      addFailure(`${featureIndexFile}.features[${index}].backend must be an object.`);
    } else {
      for (const fieldName of requiredBackendFields) {
        if (!(fieldName in backend)) {
          addFailure(
            `${featureIndexFile}.features[${index}].backend is missing field ${fieldName}.`,
          );
        }
      }
      validateStringArray(
        backend.routes ?? [],
        `${featureIndexFile}.features[${index}].backend.routes`,
      );
      validateStringArray(
        backend.services ?? [],
        `${featureIndexFile}.features[${index}].backend.services`,
      );
    }

    const tests = feature.tests;
    if (!tests || typeof tests !== "object") {
      addFailure(`${featureIndexFile}.features[${index}].tests must be an object.`);
    } else {
      for (const fieldName of requiredTestsFields) {
        if (!(fieldName in tests)) {
          addFailure(
            `${featureIndexFile}.features[${index}].tests is missing field ${fieldName}.`,
          );
        }
      }
      validateStringArray(
        tests.targeted_commands ?? [],
        `${featureIndexFile}.features[${index}].tests.targeted_commands`,
      );
      validateStringArray(
        tests.primary_specs ?? [],
        `${featureIndexFile}.features[${index}].tests.primary_specs`,
      );
    }

    validateStringArray(
      feature.docs ?? [],
      `${featureIndexFile}.features[${index}].docs`,
    );
  }

  if (contract.enforceFrontendFeatureCoverage === true) {
    const coverage = featureIndex.coverage ?? {};
    const listedFeatureDirs = validateStringArray(
      coverage.frontend_feature_dirs ?? [],
      `${featureIndexFile}.coverage.frontend_feature_dirs`,
    );
    const listedFeatureDirSet = new Set(listedFeatureDirs);

    const frontendFeatureRoot = toNonEmptyString(contract.frontendFeatureRoot);
    if (!frontendFeatureRoot) {
      addFailure(`${contractPath}.frontendFeatureRoot must be a non-empty string.`);
    } else if (!fs.existsSync(frontendFeatureRoot)) {
      addFailure(`${contractPath}.frontendFeatureRoot does not exist: ${frontendFeatureRoot}`);
    } else {
      const actualDirs = fs
        .readdirSync(frontendFeatureRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));

      for (const dirName of actualDirs) {
        if (!listedFeatureDirSet.has(dirName)) {
          addFailure(
            `${featureIndexFile}.coverage.frontend_feature_dirs is missing frontend/features directory: ${dirName}`,
          );
        }
      }

      for (const dirName of listedFeatureDirs) {
        if (!actualDirs.includes(dirName)) {
          addFailure(
            `${featureIndexFile}.coverage.frontend_feature_dirs includes unknown frontend/features directory: ${dirName}`,
          );
        }
      }
    }

    for (const dirName of listedFeatureDirs) {
      if (!coveredFrontendDirs.has(dirName)) {
        addFailure(
          `${featureIndexFile}.coverage.frontend_feature_dirs entry ${dirName} is not referenced by any features[].frontend.feature_dirs entry.`,
        );
      }
    }
  }

  const packageJson = readJsonIfPresent("package.json");
  if (packageJson && typeof packageJson === "object") {
    const scripts =
      packageJson.scripts && typeof packageJson.scripts === "object"
        ? packageJson.scripts
        : null;
    if (!scripts) {
      addFailure("package.json scripts block is required for feature-index verification wiring.");
    } else {
      const configuredVerify = toNonEmptyString(scripts["feature-index:verify"]);
      if (!configuredVerify) {
        addFailure('package.json scripts must define "feature-index:verify".');
      } else if (configuredVerify !== featureIndexVerifyCommand) {
        addFailure(
          `package.json scripts["feature-index:verify"] must equal "${featureIndexVerifyCommand}" (found "${configuredVerify}").`,
        );
      }
    }
  }

  const verifyResult = runCommandSafe("node", [featureIndexVerifyScript, "--strict"]);
  if (!verifyResult.ok) {
    const details = verifyResult.stderr || verifyResult.stdout || "unknown failure";
    addFailure(
      `Feature index drift check failed. Run npm run feature-index:verify and update ${featureIndexFile}. Details: ${details}`,
    );
  }
}

function checkTestMatrixContract(config) {
  const contractPath = "contracts.testMatrix";
  const contract = config?.contracts?.testMatrix;
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }

  const testMatrixFile = toNonEmptyString(contract.file);
  if (!testMatrixFile) {
    addFailure(`${contractPath}.file must be a non-empty string.`);
    return;
  }

  const content = readFileIfPresent(testMatrixFile);
  if (content === null) {
    return;
  }

  const requiredSections = validateStringArray(
    contract.requiredSections,
    `${contractPath}.requiredSections`,
  );
  let cursor = 0;
  for (const section of requiredSections) {
    const index = content.indexOf(section, cursor);
    if (index === -1) {
      if (content.includes(section)) {
        addFailure(
          `${testMatrixFile} contains section out of order relative to ${contractPath}.requiredSections: ${section}`,
        );
      } else {
        addFailure(`${testMatrixFile} is missing required section: ${section}`);
      }
      continue;
    }
    cursor = index + section.length;
  }

  const featureIndexFile = toNonEmptyString(config?.contracts?.featureIndex?.file);
  if (!featureIndexFile) {
    return;
  }
  const featureIndex = readJsonIfPresent(featureIndexFile);
  if (!featureIndex || !Array.isArray(featureIndex.features)) {
    return;
  }

  for (const [index, feature] of featureIndex.features.entries()) {
    const featureId = toNonEmptyString(feature?.id);
    if (!featureId) {
      continue;
    }

    if (!content.includes(`\`${featureId}\``) && !content.includes(featureId)) {
      addFailure(
        `${testMatrixFile} must reference feature id ${featureId} from ${featureIndexFile}.features[${index}].`,
      );
    }

    const targetedCommands = validateStringArray(
      feature?.tests?.targeted_commands ?? [],
      `${featureIndexFile}.features[${index}].tests.targeted_commands`,
    );
    for (const command of targetedCommands) {
      if (!content.includes(command)) {
        addFailure(
          `${testMatrixFile} is missing targeted command for feature ${featureId}: ${command}`,
        );
      }
    }

    const primarySpecs = validateStringArray(
      feature?.tests?.primary_specs ?? [],
      `${featureIndexFile}.features[${index}].tests.primary_specs`,
    );
    for (const specPath of primarySpecs) {
      if (!content.includes(specPath)) {
        addFailure(
          `${testMatrixFile} is missing primary spec for feature ${featureId}: ${specPath}`,
        );
      }
    }
  }
}

function checkJSDocCoverageContract(config) {
  const contractPath = "contracts.jsdocCoverage";
  const contract = config?.contracts?.jsdocCoverage;
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }

  const requiredStrings = {
    file: "docs/JSDOC_COVERAGE.md",
    generatorScript: "tools/docs/generate-jsdoc-coverage.mjs",
    npmGenerateScriptName: "jsdoc-coverage:generate",
    npmGenerateScriptCommand: "node tools/docs/generate-jsdoc-coverage.mjs --write",
    npmVerifyScriptName: "jsdoc-coverage:verify",
    npmVerifyScriptCommand: "node tools/docs/generate-jsdoc-coverage.mjs --check",
  };

  for (const [fieldName, expectedValue] of Object.entries(requiredStrings)) {
    const actualValue = toNonEmptyString(contract[fieldName]);
    if (!actualValue) {
      addFailure(`${contractPath}.${fieldName} must be a non-empty string.`);
      continue;
    }
    if (actualValue !== expectedValue) {
      addFailure(
        `${contractPath}.${fieldName} must equal "${expectedValue}" (found "${actualValue}").`,
      );
    }
  }

  const jsdocCoverageFile = toNonEmptyString(contract.file);
  const jsdocContent = jsdocCoverageFile ? readFileIfPresent(jsdocCoverageFile) : null;
  if (jsdocContent !== null) {
    const requiredSections = validateStringArray(
      contract.requiredSections,
      `${contractPath}.requiredSections`,
    );
    let cursor = 0;
    for (const section of requiredSections) {
      const index = jsdocContent.indexOf(section, cursor);
      if (index === -1) {
        if (jsdocContent.includes(section)) {
          addFailure(
            `${jsdocCoverageFile} contains section out of order relative to ${contractPath}.requiredSections: ${section}`,
          );
        } else {
          addFailure(`${jsdocCoverageFile} is missing required section: ${section}`);
        }
        continue;
      }
      cursor = index + section.length;
    }
  }

  const generatorScript = toNonEmptyString(contract.generatorScript);
  if (generatorScript) {
    readFileIfPresent(generatorScript);
    const verifyResult = runCommandSafe("node", [generatorScript, "--check"]);
    if (!verifyResult.ok) {
      const details = verifyResult.stderr || verifyResult.stdout || "unknown failure";
      addFailure(
        `${contractPath} generator check failed. Run npm run jsdoc-coverage:generate. Details: ${details}`,
      );
    }
  }

  const packageJson = readJsonIfPresent("package.json");
  if (!packageJson || typeof packageJson !== "object") {
    return;
  }

  const scripts =
    packageJson.scripts && typeof packageJson.scripts === "object"
      ? packageJson.scripts
      : null;
  if (!scripts) {
    addFailure("package.json scripts block is required for jsdoc-coverage wiring.");
    return;
  }

  const generateScriptName = toNonEmptyString(contract.npmGenerateScriptName);
  const generateScriptCommand = toNonEmptyString(contract.npmGenerateScriptCommand);
  const verifyScriptName = toNonEmptyString(contract.npmVerifyScriptName);
  const verifyScriptCommand = toNonEmptyString(contract.npmVerifyScriptCommand);

  if (generateScriptName && generateScriptCommand) {
    const configuredGenerate = toNonEmptyString(scripts[generateScriptName]);
    if (!configuredGenerate) {
      addFailure(`package.json scripts must define "${generateScriptName}".`);
    } else if (configuredGenerate !== generateScriptCommand) {
      addFailure(
        `package.json scripts["${generateScriptName}"] must equal "${generateScriptCommand}" (found "${configuredGenerate}").`,
      );
    }
  }

  if (verifyScriptName && verifyScriptCommand) {
    const configuredVerify = toNonEmptyString(scripts[verifyScriptName]);
    if (!configuredVerify) {
      addFailure(`package.json scripts must define "${verifyScriptName}".`);
    } else if (configuredVerify !== verifyScriptCommand) {
      addFailure(
        `package.json scripts["${verifyScriptName}"] must equal "${verifyScriptCommand}" (found "${configuredVerify}").`,
      );
    }
  }

  const contextIndex = readJsonIfPresent("docs/CONTEXT_INDEX.json");
  if (contextIndex && typeof contextIndex === "object") {
    const commands =
      contextIndex.commands && typeof contextIndex.commands === "object"
        ? contextIndex.commands
        : null;
    if (!commands) {
      addFailure("docs/CONTEXT_INDEX.json commands block is required.");
      return;
    }

    const generateCommand = toNonEmptyString(commands.jsdocCoverageGenerate);
    if (generateCommand !== "npm run jsdoc-coverage:generate") {
      addFailure(
        'docs/CONTEXT_INDEX.json.commands.jsdocCoverageGenerate must equal "npm run jsdoc-coverage:generate".',
      );
    }

    const verifyCommand = toNonEmptyString(commands.jsdocCoverageVerify);
    if (verifyCommand !== "npm run jsdoc-coverage:verify") {
      addFailure(
        'docs/CONTEXT_INDEX.json.commands.jsdocCoverageVerify must equal "npm run jsdoc-coverage:verify".',
      );
    }

    const jsdocCoverageFileCommand = toNonEmptyString(commands.jsdocCoverageFile);
    if (jsdocCoverageFileCommand !== "cat docs/JSDOC_COVERAGE.md") {
      addFailure(
        'docs/CONTEXT_INDEX.json.commands.jsdocCoverageFile must equal "cat docs/JSDOC_COVERAGE.md".',
      );
    }
  }
}

function checkRouteMapContract(config) {
  const contractPath = "contracts.routeMap";
  const contract = config?.contracts?.routeMap;
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }

  const requiredStrings = {
    file: "docs/ROUTE_MAP.md",
    generatorScript: "tools/docs/generate-route-map.mjs",
    npmGenerateScriptName: "route-map:generate",
    npmGenerateScriptCommand: "node tools/docs/generate-route-map.mjs --write",
    npmVerifyScriptName: "route-map:verify",
    npmVerifyScriptCommand: "node tools/docs/generate-route-map.mjs --check",
  };

  for (const [fieldName, expectedValue] of Object.entries(requiredStrings)) {
    const actualValue = toNonEmptyString(contract[fieldName]);
    if (!actualValue) {
      addFailure(`${contractPath}.${fieldName} must be a non-empty string.`);
      continue;
    }
    if (actualValue !== expectedValue) {
      addFailure(
        `${contractPath}.${fieldName} must equal "${expectedValue}" (found "${actualValue}").`,
      );
    }
  }

  const routeMapFile = toNonEmptyString(contract.file);
  const content = routeMapFile ? readFileIfPresent(routeMapFile) : null;

  if (content !== null) {
    const requiredSections = validateStringArray(
      contract.requiredSections,
      `${contractPath}.requiredSections`,
    );
    let cursor = 0;
    for (const section of requiredSections) {
      const index = content.indexOf(section, cursor);
      if (index === -1) {
        if (content.includes(section)) {
          addFailure(
            `${routeMapFile} contains section out of order relative to ${contractPath}.requiredSections: ${section}`,
          );
        } else {
          addFailure(`${routeMapFile} is missing required section: ${section}`);
        }
        continue;
      }
      cursor = index + section.length;
    }
  }

  const generatorScript = toNonEmptyString(contract.generatorScript);
  if (generatorScript) {
    readFileIfPresent(generatorScript);
    const verifyResult = runCommandSafe("node", [generatorScript, "--check"]);
    if (!verifyResult.ok) {
      const details = verifyResult.stderr || verifyResult.stdout || "unknown failure";
      addFailure(
        `${contractPath} generator check failed. Run npm run route-map:generate. Details: ${details}`,
      );
    }
  }

  const packageJson = readJsonIfPresent("package.json");
  if (!packageJson || typeof packageJson !== "object") {
    return;
  }

  const scripts =
    packageJson.scripts && typeof packageJson.scripts === "object"
      ? packageJson.scripts
      : null;
  if (!scripts) {
    addFailure("package.json scripts block is required for route-map wiring.");
    return;
  }

  const generateScriptName = toNonEmptyString(contract.npmGenerateScriptName);
  const generateScriptCommand = toNonEmptyString(contract.npmGenerateScriptCommand);
  const verifyScriptName = toNonEmptyString(contract.npmVerifyScriptName);
  const verifyScriptCommand = toNonEmptyString(contract.npmVerifyScriptCommand);

  if (generateScriptName && generateScriptCommand) {
    const configuredGenerate = toNonEmptyString(scripts[generateScriptName]);
    if (!configuredGenerate) {
      addFailure(`package.json scripts must define "${generateScriptName}".`);
    } else if (configuredGenerate !== generateScriptCommand) {
      addFailure(
        `package.json scripts["${generateScriptName}"] must equal "${generateScriptCommand}" (found "${configuredGenerate}").`,
      );
    }
  }

  if (verifyScriptName && verifyScriptCommand) {
    const configuredVerify = toNonEmptyString(scripts[verifyScriptName]);
    if (!configuredVerify) {
      addFailure(`package.json scripts must define "${verifyScriptName}".`);
    } else if (configuredVerify !== verifyScriptCommand) {
      addFailure(
        `package.json scripts["${verifyScriptName}"] must equal "${verifyScriptCommand}" (found "${configuredVerify}").`,
      );
    }
  }
}

function checkDomainReadmesContract(config) {
  const contractPath = "contracts.domainReadmes";
  const contract = config?.contracts?.domainReadmes;
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }

  const requiredStrings = {
    generatorScript: "tools/docs/generate-domain-readmes.mjs",
    npmGenerateScriptName: "domain-readmes:generate",
    npmGenerateScriptCommand: "node tools/docs/generate-domain-readmes.mjs --write",
    npmVerifyScriptName: "domain-readmes:verify",
    npmVerifyScriptCommand: "node tools/docs/generate-domain-readmes.mjs --check",
    requiredSection: "## Start Here",
    frontendFeatureRoot: "frontend/features",
  };

  for (const [fieldName, expectedValue] of Object.entries(requiredStrings)) {
    const actualValue = toNonEmptyString(contract[fieldName]);
    if (!actualValue) {
      addFailure(`${contractPath}.${fieldName} must be a non-empty string.`);
      continue;
    }
    if (actualValue !== expectedValue) {
      addFailure(
        `${contractPath}.${fieldName} must equal "${expectedValue}" (found "${actualValue}").`,
      );
    }
  }

  const requiredFiles = validateStringArray(
    contract.requiredFiles,
    `${contractPath}.requiredFiles`,
  );
  const requiredSection = toNonEmptyString(contract.requiredSection);

  for (const filePath of requiredFiles) {
    const content = readFileIfPresent(filePath);
    if (content === null || !requiredSection) {
      continue;
    }
    if (!content.includes(requiredSection)) {
      addFailure(`${filePath} is missing required section: ${requiredSection}`);
    }
  }

  const frontendFeatureRoot = toNonEmptyString(contract.frontendFeatureRoot);
  if (frontendFeatureRoot) {
    if (!fs.existsSync(frontendFeatureRoot)) {
      addFailure(`${contractPath}.frontendFeatureRoot does not exist: ${frontendFeatureRoot}`);
    } else {
      const featureDirs = fs
        .readdirSync(frontendFeatureRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));

      for (const dirName of featureDirs) {
        const readmeFile = path.join(frontendFeatureRoot, dirName, "README.md");
        const content = readFileIfPresent(readmeFile);
        if (content === null || !requiredSection) {
          continue;
        }
        if (!content.includes(requiredSection)) {
          addFailure(`${readmeFile} is missing required section: ${requiredSection}`);
        }
      }
    }
  }

  const generatorScript = toNonEmptyString(contract.generatorScript);
  if (generatorScript) {
    readFileIfPresent(generatorScript);
    const verifyResult = runCommandSafe("node", [generatorScript, "--check"]);
    if (!verifyResult.ok) {
      const details = verifyResult.stderr || verifyResult.stdout || "unknown failure";
      addFailure(
        `${contractPath} generator check failed. Run npm run domain-readmes:generate. Details: ${details}`,
      );
    }
  }

  const packageJson = readJsonIfPresent("package.json");
  if (!packageJson || typeof packageJson !== "object") {
    return;
  }

  const scripts =
    packageJson.scripts && typeof packageJson.scripts === "object"
      ? packageJson.scripts
      : null;
  if (!scripts) {
    addFailure("package.json scripts block is required for domain-readmes wiring.");
    return;
  }

  const generateScriptName = toNonEmptyString(contract.npmGenerateScriptName);
  const generateScriptCommand = toNonEmptyString(contract.npmGenerateScriptCommand);
  const verifyScriptName = toNonEmptyString(contract.npmVerifyScriptName);
  const verifyScriptCommand = toNonEmptyString(contract.npmVerifyScriptCommand);

  if (generateScriptName && generateScriptCommand) {
    const configuredGenerate = toNonEmptyString(scripts[generateScriptName]);
    if (!configuredGenerate) {
      addFailure(`package.json scripts must define "${generateScriptName}".`);
    } else if (configuredGenerate !== generateScriptCommand) {
      addFailure(
        `package.json scripts["${generateScriptName}"] must equal "${generateScriptCommand}" (found "${configuredGenerate}").`,
      );
    }
  }

  if (verifyScriptName && verifyScriptCommand) {
    const configuredVerify = toNonEmptyString(scripts[verifyScriptName]);
    if (!configuredVerify) {
      addFailure(`package.json scripts must define "${verifyScriptName}".`);
    } else if (configuredVerify !== verifyScriptCommand) {
      addFailure(
        `package.json scripts["${verifyScriptName}"] must equal "${verifyScriptCommand}" (found "${configuredVerify}").`,
      );
    }
  }
}

function checkSessionArtifactsContract(config) {
  const contractPath = "contracts.sessionArtifacts";
  const contract = config?.contracts?.sessionArtifacts;
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }

  const requiredStrings = {
    executionQueueFile: ".agents/EXECUTION_QUEUE.json",
    sessionBriefJsonFile: ".agents/SESSION_BRIEF.json",
    continuityFile: ".agents/CONTINUITY.md",
    archiveRoot: ".agents/archives",
    archiveIndexFile: ".agents/EXECUTION_ARCHIVE_INDEX.json",
    archiveShardBy: "feature_id",
    archiveFormat: "jsonl",
    archiveReadPolicy: "cold_lookup_only",
    plansRoot: ".agents/plans",
  };

  for (const [fieldName, expectedValue] of Object.entries(requiredStrings)) {
    const actualValue = contract[fieldName];
    if (typeof actualValue !== "string") {
      addFailure(`${contractPath}.${fieldName} must be a string.`);
      continue;
    }
    if (actualValue !== expectedValue) {
      addFailure(
        `${contractPath}.${fieldName} must equal \"${expectedValue}\" (found \"${actualValue}\").`,
      );
    }
  }

  const repositoryIndexPreflight = contract.repositoryIndexPreflight;
  if (!repositoryIndexPreflight || typeof repositoryIndexPreflight !== "object") {
    addFailure(`${contractPath}.repositoryIndexPreflight must be an object.`);
  } else {
    for (const fieldName of [
      "enabled",
      "buildIfMissing",
      "reindexBeforeVerify",
      "verifyStrict",
      "failureMode",
      "closeoutVerifyIfPossible",
    ]) {
      if (!(fieldName in repositoryIndexPreflight)) {
        addFailure(
          `${contractPath}.repositoryIndexPreflight is missing field ${fieldName}.`,
        );
      }
    }

    if (typeof repositoryIndexPreflight.enabled !== "boolean") {
      addFailure(`${contractPath}.repositoryIndexPreflight.enabled must be a boolean.`);
    }
    if (typeof repositoryIndexPreflight.buildIfMissing !== "boolean") {
      addFailure(
        `${contractPath}.repositoryIndexPreflight.buildIfMissing must be a boolean.`,
      );
    }
    if (typeof repositoryIndexPreflight.reindexBeforeVerify !== "boolean") {
      addFailure(
        `${contractPath}.repositoryIndexPreflight.reindexBeforeVerify must be a boolean.`,
      );
    } else if (repositoryIndexPreflight.reindexBeforeVerify !== true) {
      addFailure(
        `${contractPath}.repositoryIndexPreflight.reindexBeforeVerify must equal true.`,
      );
    }
    if (typeof repositoryIndexPreflight.verifyStrict !== "boolean") {
      addFailure(
        `${contractPath}.repositoryIndexPreflight.verifyStrict must be a boolean.`,
      );
    }
    if (typeof repositoryIndexPreflight.closeoutVerifyIfPossible !== "boolean") {
      addFailure(
        `${contractPath}.repositoryIndexPreflight.closeoutVerifyIfPossible must be a boolean.`,
      );
    }

    const repositoryIndexFailureMode = toNonEmptyString(
      repositoryIndexPreflight.failureMode,
    );
    if (
      !repositoryIndexFailureMode ||
      !["warn", "fail"].includes(repositoryIndexFailureMode)
    ) {
      addFailure(
        `${contractPath}.repositoryIndexPreflight.failureMode must be either "warn" or "fail".`,
      );
    } else if (repositoryIndexFailureMode !== "fail") {
      addFailure(
        `${contractPath}.repositoryIndexPreflight.failureMode must equal "fail".`,
      );
    }
  }

  const retiredArtifacts = validateStringArray(
    contract.retiredArtifacts,
    `${contractPath}.retiredArtifacts`,
  );
  for (const retiredArtifact of retiredArtifacts) {
    if (fs.existsSync(retiredArtifact)) {
      addWarning(
        `${retiredArtifact} is a retired queue/scope artifact and should be removed.`,
      );
    }
  }

  checkExactOrderedArray({
    value: contract.planRoots,
    expected: [
      ".agents/plans/current",
      ".agents/plans/deferred",
      ".agents/plans/archived",
    ],
    pathName: `${contractPath}.planRoots`,
  });

  if (typeof contract.planQueueSyncEnabled !== "boolean") {
    addFailure(`${contractPath}.planQueueSyncEnabled must be a boolean.`);
  }

  if (!isNonEmptyString(contract.planQueueSyncPlanFileName)) {
    addFailure(`${contractPath}.planQueueSyncPlanFileName must be a non-empty string.`);
  } else if (contract.planQueueSyncPlanFileName !== "PLAN.md") {
    addFailure(`${contractPath}.planQueueSyncPlanFileName must equal "PLAN.md".`);
  }

  const planQueueSyncRoots = validateStringArray(
    contract.planQueueSyncRoots,
    `${contractPath}.planQueueSyncRoots`,
  );
  checkRequiredFieldList({
    fieldName: "planQueueSyncRoots",
    actualFields: contract.planQueueSyncRoots,
    requiredFields: [
      ".agents/plans/current",
      ".agents/plans/deferred",
    ],
    contractPath,
  });

  const planQueueSyncStateByRoot = contract.planQueueSyncStateByRoot;
  if (!planQueueSyncStateByRoot || typeof planQueueSyncStateByRoot !== "object") {
    addFailure(`${contractPath}.planQueueSyncStateByRoot must be an object.`);
  }

  if (!isNonEmptyString(contract.planQueueSyncDefaultOwner)) {
    addFailure(`${contractPath}.planQueueSyncDefaultOwner must be a non-empty string.`);
  }

  if (!isNonEmptyString(contract.planQueueSyncDefaultItemType)) {
    addFailure(`${contractPath}.planQueueSyncDefaultItemType must be a non-empty string.`);
  }

  if (!isNullableNonEmptyString(contract.planQueueSyncDefaultSubscope)) {
    addFailure(`${contractPath}.planQueueSyncDefaultSubscope must be null or a non-empty string.`);
  }

  if (typeof contract.archivedPlanSyncEnabled !== "boolean") {
    addFailure(`${contractPath}.archivedPlanSyncEnabled must be a boolean.`);
  }

  if (!isNonEmptyString(contract.archivedPlanRoot)) {
    addFailure(`${contractPath}.archivedPlanRoot must be a non-empty string.`);
  }

  if (!isNonEmptyString(contract.archivedPlanFileName)) {
    addFailure(`${contractPath}.archivedPlanFileName must be a non-empty string.`);
  }

  if (!isNonEmptyString(contract.archivedPlanCanonicalHandoffFileName)) {
    addFailure(
      `${contractPath}.archivedPlanCanonicalHandoffFileName must be a non-empty string.`,
    );
  }

  const archivedPlanLegacyHandoffFileNames = validateStringArray(
    contract.archivedPlanLegacyHandoffFileNames,
    `${contractPath}.archivedPlanLegacyHandoffFileNames`,
  );

  if (!isNonEmptyString(contract.archivedPlanArchiveKeyPrefix)) {
    addFailure(`${contractPath}.archivedPlanArchiveKeyPrefix must be a non-empty string.`);
  }

  if (!isNonEmptyString(contract.archivedPlanIndexKind)) {
    addFailure(`${contractPath}.archivedPlanIndexKind must be a non-empty string.`);
  }

  if (typeof contract.stalePlanReferenceCheckEnabled !== "boolean") {
    addFailure(`${contractPath}.stalePlanReferenceCheckEnabled must be a boolean.`);
  }

  const stalePlanReferenceFailureMode = toNonEmptyString(
    contract.stalePlanReferenceFailureMode,
  );
  if (!stalePlanReferenceFailureMode || !["warn", "fail"].includes(stalePlanReferenceFailureMode)) {
    addFailure(`${contractPath}.stalePlanReferenceFailureMode must be either "warn" or "fail".`);
  } else if (stalePlanReferenceFailureMode !== "fail") {
    addFailure(`${contractPath}.stalePlanReferenceFailureMode must equal "fail".`);
  }

  const stalePlanReferenceScanRoots = validateStringArray(
    contract.stalePlanReferenceScanRoots,
    `${contractPath}.stalePlanReferenceScanRoots`,
  );

  const sessionBriefRequiredFields = validateStringArray(
    contract.sessionBriefRequiredFields,
    `${contractPath}.sessionBriefRequiredFields`,
  );
  if (
    !Number.isInteger(contract.sessionBriefFreshnessHoursWarning) ||
    contract.sessionBriefFreshnessHoursWarning < 1
  ) {
    addFailure(
      `${contractPath}.sessionBriefFreshnessHoursWarning must be an integer greater than 0.`,
    );
  }
  const sessionBriefFreshnessFailureMode = toNonEmptyString(
    contract.sessionBriefFreshnessFailureMode,
  );
  if (
    !sessionBriefFreshnessFailureMode ||
    !["warn", "fail"].includes(sessionBriefFreshnessFailureMode)
  ) {
    addFailure(
      `${contractPath}.sessionBriefFreshnessFailureMode must be either "warn" or "fail".`,
    );
  } else if (sessionBriefFreshnessFailureMode !== "fail") {
    addFailure(`${contractPath}.sessionBriefFreshnessFailureMode must equal "fail".`);
  }

  const archivedPlanRoot = toNonEmptyString(contract.archivedPlanRoot) ?? ".agents/plans/archived";
  const archivedPlanFileName = toNonEmptyString(contract.archivedPlanFileName) ?? "PLAN.md";
  const archivedPlanCanonicalHandoffFileName =
    toNonEmptyString(contract.archivedPlanCanonicalHandoffFileName) ?? "HANDOFF.md";
  const archivedPlanArchiveKeyPrefix =
    toNonEmptyString(contract.archivedPlanArchiveKeyPrefix) ?? "feature-plan:";
  const archivedPlanIndexKind =
    toNonEmptyString(contract.archivedPlanIndexKind) ?? "feature";

  const requiredQueueFields = validateStringArray(
    contract.requiredExecutionQueueFields,
    `${contractPath}.requiredExecutionQueueFields`,
  );
  const requiredQueueItemFields = validateStringArray(
    contract.requiredQueueItemFields,
    `${contractPath}.requiredQueueItemFields`,
  );
  const allowedQueueTypes = new Set(
    validateStringArray(
      contract.allowedQueueItemTypes,
      `${contractPath}.allowedQueueItemTypes`,
    ),
  );
  const allowedQueueStates = new Set(
    validateStringArray(
      contract.allowedQueueStates,
      `${contractPath}.allowedQueueStates`,
    ),
  );

  if (isNonEmptyString(contract.planQueueSyncDefaultItemType)) {
    if (!allowedQueueTypes.has(contract.planQueueSyncDefaultItemType)) {
      addFailure(
        `${contractPath}.planQueueSyncDefaultItemType must be one of allowedQueueItemTypes.`,
      );
    }
  }

  if (planQueueSyncStateByRoot && typeof planQueueSyncStateByRoot === "object") {
    for (const rootPath of planQueueSyncRoots) {
      const mappedState = toNonEmptyString(planQueueSyncStateByRoot[rootPath]);
      if (!mappedState) {
        addFailure(
          `${contractPath}.planQueueSyncStateByRoot is missing non-empty mapping for ${rootPath}.`,
        );
        continue;
      }
      if (!allowedQueueStates.has(mappedState)) {
        addFailure(
          `${contractPath}.planQueueSyncStateByRoot[${rootPath}] must be one of allowedQueueStates.`,
        );
      }
    }
  }
  const statesRequiringExecutionStart = new Set(
    validateStringArray(
      contract.statesRequiringExecutionStart,
      `${contractPath}.statesRequiringExecutionStart`,
    ),
  );
  const statesRequiringCompletionTime = new Set(
    validateStringArray(
      contract.statesRequiringCompletionTime,
      `${contractPath}.statesRequiringCompletionTime`,
    ),
  );
  const queueScopeRequiredWhenObjectiveSet = validateStringArray(
    contract.queueScopeRequiredWhenObjectiveSet,
    `${contractPath}.queueScopeRequiredWhenObjectiveSet`,
  );
  const statesRequiringClaimLease = new Set(
    validateStringArray(
      contract.statesRequiringClaimLease,
      `${contractPath}.statesRequiringClaimLease`,
    ),
  );
  const claimLeaseRequiredFields = validateStringArray(
    contract.claimLeaseRequiredFields,
    `${contractPath}.claimLeaseRequiredFields`,
  );
  const statesRequiringCompletionEvidence = new Set(
    validateStringArray(
      contract.statesRequiringCompletionEvidence,
      `${contractPath}.statesRequiringCompletionEvidence`,
    ),
  );
  const completionEvidenceRequiredFields = validateStringArray(
    contract.completionEvidenceRequiredFields,
    `${contractPath}.completionEvidenceRequiredFields`,
  );
  const archiveOnItemStates = new Set(
    validateStringArray(
      contract.archiveOnItemStates,
      `${contractPath}.archiveOnItemStates`,
    ),
  );
  const archiveQueueStatesTriggeringFeatureArchive = new Set(
    validateStringArray(
      contract.archiveQueueStatesTriggeringFeatureArchive,
      `${contractPath}.archiveQueueStatesTriggeringFeatureArchive`,
    ),
  );
  const archiveIndexRequiredFields = validateStringArray(
    contract.archiveIndexRequiredFields,
    `${contractPath}.archiveIndexRequiredFields`,
  );
  const archiveIndexRequiredItemFields = validateStringArray(
    contract.archiveIndexRequiredItemFields,
    `${contractPath}.archiveIndexRequiredItemFields`,
  );
  const scopeReadRequiredTopLevelFields = validateStringArray(
    contract.scopeReadRequiredTopLevelFields,
    `${contractPath}.scopeReadRequiredTopLevelFields`,
  );
  const scopeReadItemSelectorFields = validateStringArray(
    contract.scopeReadItemSelectorFields,
    `${contractPath}.scopeReadItemSelectorFields`,
  );

  if (
    !Number.isInteger(contract.maxScopedItemsPerRead) ||
    contract.maxScopedItemsPerRead < 1
  ) {
    addFailure(
      `${contractPath}.maxScopedItemsPerRead must be an integer greater than 0.`,
    );
  }

  if (typeof contract.forbidArchivedStatesInHotQueue !== "boolean") {
    addFailure(`${contractPath}.forbidArchivedStatesInHotQueue must be a boolean.`);
  }

  checkRequiredFieldList({
    fieldName: "archiveIndexRequiredFields",
    actualFields: contract.archiveIndexRequiredFields,
    requiredFields: ["version", "last_updated", "items"],
    contractPath,
  });

  checkRequiredFieldList({
    fieldName: "archiveIndexRequiredItemFields",
    actualFields: contract.archiveIndexRequiredItemFields,
    requiredFields: [
      "archive_key",
      "kind",
      "feature_id",
      "archived_at",
      "archive_ref",
    ],
    contractPath,
  });

  checkRequiredFieldList({
    fieldName: "sessionBriefRequiredFields",
    actualFields: contract.sessionBriefRequiredFields,
    requiredFields: [
      "generated_at",
      "policy",
      "scope",
      "queue_file",
      "archive_index_file",
      "index_readiness",
      "queue_read_contract",
      "queue_overview",
      "next_actions",
    ],
    contractPath,
  });

  for (const state of archiveOnItemStates) {
    if (!allowedQueueStates.has(state)) {
      addFailure(
        `${contractPath}.archiveOnItemStates contains unknown state ${state}.`,
      );
    }
  }

  for (const state of archiveQueueStatesTriggeringFeatureArchive) {
    if (!allowedQueueStates.has(state)) {
      addFailure(
        `${contractPath}.archiveQueueStatesTriggeringFeatureArchive contains unknown state ${state}.`,
      );
    }
  }

  for (const fieldName of scopeReadRequiredTopLevelFields) {
    if (!requiredQueueFields.includes(fieldName)) {
      addFailure(
        `${contractPath}.scopeReadRequiredTopLevelFields contains ${fieldName}, which is not listed in requiredExecutionQueueFields.`,
      );
    }
  }

  for (const fieldName of scopeReadItemSelectorFields) {
    if (!requiredQueueItemFields.includes(fieldName)) {
      addFailure(
        `${contractPath}.scopeReadItemSelectorFields contains ${fieldName}, which is not listed in requiredQueueItemFields.`,
      );
    }
  }

  for (const fieldName of queueScopeRequiredWhenObjectiveSet) {
    if (!requiredQueueFields.includes(fieldName)) {
      addFailure(
        `${contractPath}.queueScopeRequiredWhenObjectiveSet contains ${fieldName}, which is not listed in requiredExecutionQueueFields.`,
      );
    }
  }

  for (const fieldName of claimLeaseRequiredFields) {
    if (!requiredQueueItemFields.includes(fieldName)) {
      addFailure(
        `${contractPath}.claimLeaseRequiredFields contains ${fieldName}, which is not listed in requiredQueueItemFields.`,
      );
    }
  }

  for (const fieldName of completionEvidenceRequiredFields) {
    if (!requiredQueueItemFields.includes(fieldName)) {
      addFailure(
        `${contractPath}.completionEvidenceRequiredFields contains ${fieldName}, which is not listed in requiredQueueItemFields.`,
      );
    }
  }

  const topLevelArrayFields = [
    "in_scope",
    "out_of_scope",
    "acceptance_criteria",
    "constraints",
    "references",
    "open_questions",
  ];

  const archivedPlanDirectories = listFeaturePlanDirectories(archivedPlanRoot);
  const archivedPlanExpectations = [];
  for (const featureDir of archivedPlanDirectories) {
    const featureDirPath = `${archivedPlanRoot}/${featureDir}`;
    const canonicalPlanRef = `${featureDirPath}/${archivedPlanFileName}`;
    const canonicalHandoffRef = `${featureDirPath}/${archivedPlanCanonicalHandoffFileName}`;
    const canonicalPlanExists = fs.existsSync(canonicalPlanRef);
    if (!canonicalPlanExists) {
      addFailure(
        `${canonicalPlanRef} is required for archived plan directory ${featureDirPath}.`,
      );
    }

    const hasLegacyHandoff = archivedPlanLegacyHandoffFileNames.some((legacyFileName) =>
      fs.existsSync(`${featureDirPath}/${legacyFileName}`),
    );
    const hasCanonicalHandoff = fs.existsSync(canonicalHandoffRef);
    if (hasLegacyHandoff && !hasCanonicalHandoff) {
      addWarning(
        `${featureDirPath} contains legacy handoff naming but is missing canonical ${archivedPlanCanonicalHandoffFileName}.`,
      );
    }

    archivedPlanExpectations.push({
      featureId: featureDir,
      archiveKey: `${archivedPlanArchiveKeyPrefix}${featureDir}`,
      planRef: canonicalPlanRef,
      archiveRef: `${contract.archiveRoot}/${toArchiveFeatureShardName(featureDir)}.${contract.archiveFormat}`,
      planExists: canonicalPlanExists,
    });
  }

  if (contract.stalePlanReferenceCheckEnabled === true) {
    const staleReferenceFindings = scanStalePlanReferences(stalePlanReferenceScanRoots);
    if (staleReferenceFindings.length > 0) {
      const sample = staleReferenceFindings
        .slice(0, 10)
        .map((finding) => `${finding.file}:${finding.line} -> ${finding.target}`)
        .join(", ");
      const message = `Stale .agents/plans references detected (${staleReferenceFindings.length}). Sample: ${sample}`;
      if (stalePlanReferenceFailureMode === "fail") {
        addFailure(message);
      } else {
        addWarning(message);
      }
    }
  }

  const executionQueue = readJsonIfPresent(contract.executionQueueFile, true);
  if (executionQueue !== null) {
    const queueState = isNonEmptyString(executionQueue.state)
      ? executionQueue.state
      : "";
    if (queueState.length > 0 && !allowedQueueStates.has(queueState)) {
      addFailure(
        `${contract.executionQueueFile}.state must be one of: ${[...allowedQueueStates].join(", ")}`,
      );
    }

    if (!isValidIsoDate(executionQueue.created_at)) {
      addFailure(`${contract.executionQueueFile}.created_at must be a valid ISO timestamp.`);
    }
    if (!isValidIsoDate(executionQueue.updated_at)) {
      addFailure(`${contract.executionQueueFile}.updated_at must be a valid ISO timestamp.`);
    }
    if (!isValidIsoDate(executionQueue.last_updated)) {
      addFailure(`${contract.executionQueueFile}.last_updated must be a valid ISO timestamp.`);
    }

    if (
      isValidIsoDate(executionQueue.created_at) &&
      isValidIsoDate(executionQueue.updated_at) &&
      Date.parse(executionQueue.updated_at) < Date.parse(executionQueue.created_at)
    ) {
      addFailure(`${contract.executionQueueFile}.updated_at must be >= created_at.`);
    }

    if (
      isValidIsoDate(executionQueue.updated_at) &&
      isValidIsoDate(executionQueue.last_updated) &&
      Date.parse(executionQueue.last_updated) < Date.parse(executionQueue.updated_at)
    ) {
      addFailure(`${contract.executionQueueFile}.last_updated must be >= updated_at.`);
    }

    if (!isNullableNonEmptyString(executionQueue.deferred_reason)) {
      addFailure(`${contract.executionQueueFile}.deferred_reason must be null or a non-empty string.`);
    }

    if (!isNullableNonEmptyString(executionQueue.cancel_reason)) {
      addFailure(`${contract.executionQueueFile}.cancel_reason must be null or a non-empty string.`);
    }

    if (queueState === "deferred" && !isNonEmptyString(executionQueue.deferred_reason)) {
      addFailure(`${contract.executionQueueFile}.deferred_reason is required when state is deferred.`);
    }

    if (
      contract.forbidArchivedStatesInHotQueue &&
      archiveQueueStatesTriggeringFeatureArchive.has(queueState)
    ) {
      addFailure(
        `${contract.executionQueueFile}.state=${queueState} must be archived to ${contract.archiveRoot} and reset from hot queue.`,
      );
    }

    for (const fieldName of topLevelArrayFields) {
      const fieldValue = executionQueue[fieldName];
      if (!Array.isArray(fieldValue)) {
        addFailure(`${contract.executionQueueFile}.${fieldName} must be an array.`);
        continue;
      }
      for (const [fieldIndex, entry] of fieldValue.entries()) {
        if (!isNonEmptyString(entry)) {
          addFailure(
            `${contract.executionQueueFile}.${fieldName}[${fieldIndex}] must be a non-empty string.`,
          );
        }
      }
    }

    if (!isNonEmptyString(executionQueue.feature_id)) {
      addFailure(`${contract.executionQueueFile}.feature_id must be a non-empty string.`);
    }

    const hasQueueObjectiveContext =
      isNonEmptyString(executionQueue.task_id) ||
      isNonEmptyString(executionQueue.objective);

    if (hasQueueObjectiveContext) {
      for (const fieldName of queueScopeRequiredWhenObjectiveSet) {
        const fieldValue = executionQueue[fieldName];
        if (!Array.isArray(fieldValue) || fieldValue.length === 0) {
          addFailure(
            `${contract.executionQueueFile}.${fieldName} must be a non-empty array when task_id/objective is set.`,
          );
        }
      }
    }

    for (const requiredField of requiredQueueFields) {
      if (!(requiredField in executionQueue)) {
        addFailure(
          `${contract.executionQueueFile} is missing required field: ${requiredField}`,
        );
      }
    }

    if (!Array.isArray(executionQueue.items)) {
      addFailure(`${contract.executionQueueFile}.items must be an array.`);
    } else {
      const itemIds = new Set();
      const duplicateItemIds = new Set();
      for (const item of executionQueue.items) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const itemId = toNonEmptyString(item.id);
        if (!itemId) {
          continue;
        }
        if (itemIds.has(itemId)) {
          duplicateItemIds.add(itemId);
          continue;
        }
        itemIds.add(itemId);
      }
      if (duplicateItemIds.size > 0) {
        addFailure(
          `${contract.executionQueueFile}.items contains duplicate id values: ${[...duplicateItemIds].join(", ")}`,
        );
      }

      const idempotencyKeys = new Set();
      const duplicateIdempotencyKeys = new Set();
      for (const [index, item] of executionQueue.items.entries()) {
        if (!item || typeof item !== "object") {
          addFailure(
            `${contract.executionQueueFile}.items[${index}] must be an object.`,
          );
          continue;
        }

        for (const requiredField of requiredQueueItemFields) {
          if (!(requiredField in item)) {
            addFailure(
              `${contract.executionQueueFile}.items[${index}] is missing field ${requiredField}.`,
            );
          }
        }

        if (!isNonEmptyString(item.id)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].id must be a non-empty string.`,
          );
        }

        if (!isNonEmptyString(item.title)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].title must be a non-empty string.`,
          );
        }

        if (!isNonEmptyString(item.owner)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].owner must be a non-empty string.`,
          );
        }

        if (isNonEmptyString(item.type) && !allowedQueueTypes.has(item.type)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].type must be one of: ${[...allowedQueueTypes].join(", ")}`,
          );
        }

        const state = isNonEmptyString(item.state) ? item.state : "";
        if (state.length > 0 && !allowedQueueStates.has(state)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].state must be one of: ${[...allowedQueueStates].join(", ")}`,
          );
        }

        if (
          contract.forbidArchivedStatesInHotQueue &&
          archiveOnItemStates.has(state)
        ) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].state=${state} must be moved to archive shard under ${contract.archiveRoot}.`,
          );
        }

        if (!isNonEmptyString(item.feature_id)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].feature_id must be a non-empty string.`,
          );
        }

        if (!isNullableNonEmptyString(item.subscope)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].subscope must be null or a non-empty string.`,
          );
        }

        if (!isValidIsoDate(item.created_at)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].created_at must be a valid ISO timestamp.`,
          );
        }

        if (!isValidIsoDate(item.updated_at)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].updated_at must be a valid ISO timestamp.`,
          );
        }

        if (!isValidIsoDate(item.planned_at)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].planned_at must be a valid ISO timestamp.`,
          );
        }

        if (!isNullableIsoDate(item.execution_started_at)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].execution_started_at must be null or a valid ISO timestamp.`,
          );
        }

        if (!isNullableIsoDate(item.completed_at)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].completed_at must be null or a valid ISO timestamp.`,
          );
        }

        if (
          isValidIsoDate(item.created_at) &&
          isValidIsoDate(item.updated_at) &&
          Date.parse(item.updated_at) < Date.parse(item.created_at)
        ) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].updated_at must be >= created_at.`,
          );
        }

        if (
          isValidIsoDate(item.created_at) &&
          isValidIsoDate(item.planned_at) &&
          Date.parse(item.planned_at) < Date.parse(item.created_at)
        ) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].planned_at must be >= created_at.`,
          );
        }

        if (!Number.isInteger(item.attempt_count) || item.attempt_count < 0) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].attempt_count must be an integer >= 0.`,
          );
        }

        if (!isNullableIsoDate(item.last_attempt_at)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].last_attempt_at must be null or a valid ISO timestamp.`,
          );
        }

        if (!isNullableIsoDate(item.retry_after)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].retry_after must be null or a valid ISO timestamp.`,
          );
        }

        if (!isNullableNonEmptyString(item.last_error)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].last_error must be null or a non-empty string.`,
          );
        }

        if (
          Number.isInteger(item.attempt_count) &&
          item.attempt_count > 0 &&
          !isValidIsoDate(item.last_attempt_at)
        ) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].last_attempt_at is required when attempt_count > 0.`,
          );
        }

        if (!isNullableNonEmptyString(item.deferred_reason)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].deferred_reason must be null or a non-empty string.`,
          );
        }

        if (!isNullableNonEmptyString(item.cancel_reason)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].cancel_reason must be null or a non-empty string.`,
          );
        }

        if (state === "deferred" && !isNonEmptyString(item.deferred_reason)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].deferred_reason is required when state is deferred.`,
          );
        }

        for (const fieldName of [
          "acceptance_criteria",
          "constraints",
          "references",
          "outputs",
          "evidence",
        ]) {
          const fieldValue = item[fieldName];
          if (!Array.isArray(fieldValue)) {
            addFailure(
              `${contract.executionQueueFile}.items[${index}].${fieldName} must be an array.`,
            );
            continue;
          }
          if (fieldName === "acceptance_criteria" && item.type === "task" && fieldValue.length === 0) {
            addFailure(
              `${contract.executionQueueFile}.items[${index}].acceptance_criteria must not be empty for task items.`,
            );
          }
          for (const [fieldIndex, entry] of fieldValue.entries()) {
            if (!isNonEmptyString(entry)) {
              addFailure(
                `${contract.executionQueueFile}.items[${index}].${fieldName}[${fieldIndex}] must be a non-empty string.`,
              );
            }
          }
        }

        if (!isNullableNonEmptyString(item.resolution_summary)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].resolution_summary must be null or a non-empty string.`,
          );
        }

        if (!Array.isArray(item.depends_on)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].depends_on must be an array.`,
          );
        } else {
          for (const dependencyId of item.depends_on) {
            if (!isNonEmptyString(dependencyId)) {
              addFailure(
                `${contract.executionQueueFile}.items[${index}].depends_on contains an invalid dependency id.`,
              );
            }
          }

          for (const dependencyId of item.depends_on) {
            if (!isNonEmptyString(dependencyId)) {
              continue;
            }
            if (!itemIds.has(dependencyId)) {
              addFailure(
                `${contract.executionQueueFile}.items[${index}].depends_on references unknown id ${dependencyId}.`,
              );
            }
          }
        }

        if (!isNonEmptyString(item.plan_ref)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].plan_ref must be a non-empty reference.`,
          );
        }

        const idempotencyKey = toNonEmptyString(item.idempotency_key);
        if (!idempotencyKey) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].idempotency_key must be a non-empty string.`,
          );
        } else if (idempotencyKeys.has(idempotencyKey)) {
          duplicateIdempotencyKeys.add(idempotencyKey);
        } else {
          idempotencyKeys.add(idempotencyKey);
        }

        for (const claimField of claimLeaseRequiredFields) {
          if (!(claimField in item)) {
            addFailure(
              `${contract.executionQueueFile}.items[${index}] is missing claim field ${claimField}.`,
            );
          }
        }

        const claimedBy = toNonEmptyString(item.claimed_by);
        const claimedAtValid = isValidIsoDate(item.claimed_at);
        const leaseExpiresValid = isValidIsoDate(item.lease_expires_at);
        const hasClaimedByValue = item.claimed_by !== null && item.claimed_by !== undefined;
        const hasClaimedAtValue = item.claimed_at !== null && item.claimed_at !== undefined;
        const hasLeaseExpiresValue =
          item.lease_expires_at !== null && item.lease_expires_at !== undefined;
        const hasAnyClaim =
          claimedBy !== null ||
          claimedAtValid ||
          leaseExpiresValid ||
          hasClaimedByValue ||
          hasClaimedAtValue ||
          hasLeaseExpiresValue;

        if (!isNullableNonEmptyString(item.claimed_by)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].claimed_by must be null or a non-empty string.`,
          );
        }
        if (!isNullableIsoDate(item.claimed_at)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].claimed_at must be null or a valid ISO timestamp.`,
          );
        }
        if (!isNullableIsoDate(item.lease_expires_at)) {
          addFailure(
            `${contract.executionQueueFile}.items[${index}].lease_expires_at must be null or a valid ISO timestamp.`,
          );
        }

        if (hasAnyClaim) {
          if (!claimedBy || !claimedAtValid || !leaseExpiresValid) {
            addFailure(
              `${contract.executionQueueFile}.items[${index}] must provide claimed_by, claimed_at, and lease_expires_at together.`,
            );
          } else if (
            Date.parse(item.lease_expires_at) <= Date.parse(item.claimed_at)
          ) {
            addFailure(
              `${contract.executionQueueFile}.items[${index}].lease_expires_at must be > claimed_at.`,
            );
          }
        }

        if (statesRequiringClaimLease.has(state)) {
          if (!claimedBy || !claimedAtValid || !leaseExpiresValid) {
            addFailure(
              `${contract.executionQueueFile}.items[${index}] requires active claim lease fields for state ${state}.`,
            );
          }
        }

        if (statesRequiringCompletionEvidence.has(state)) {
          for (const fieldName of completionEvidenceRequiredFields) {
            const fieldValue = item[fieldName];
            if (Array.isArray(fieldValue) && fieldValue.length === 0) {
              addFailure(
                `${contract.executionQueueFile}.items[${index}].${fieldName} must be non-empty for state ${state}.`,
              );
            }
            if (fieldName === "resolution_summary" && !isNonEmptyString(item.resolution_summary)) {
              addFailure(
                `${contract.executionQueueFile}.items[${index}].resolution_summary must be non-empty for state ${state}.`,
              );
            }
          }
        }

        const plannedAtMillis = Date.parse(item.planned_at);

        if (statesRequiringExecutionStart.has(state)) {
          if (!isValidIsoDate(item.execution_started_at)) {
            addFailure(
              `${contract.executionQueueFile}.items[${index}].execution_started_at is required and must be valid ISO for state ${state}.`,
            );
          } else if (Number.isFinite(plannedAtMillis)) {
            const executionStartedMillis = Date.parse(item.execution_started_at);
            if (executionStartedMillis < plannedAtMillis) {
              addFailure(
                `${contract.executionQueueFile}.items[${index}] violates planning gate: execution_started_at must be >= planned_at.`,
              );
            }
          }
        }

        if (statesRequiringCompletionTime.has(state)) {
          if (!isValidIsoDate(item.completed_at)) {
            addFailure(
              `${contract.executionQueueFile}.items[${index}].completed_at is required and must be valid ISO for state ${state}.`,
            );
          } else if (isValidIsoDate(item.execution_started_at)) {
            const completedAtMillis = Date.parse(item.completed_at);
            const executionStartedMillis = Date.parse(item.execution_started_at);
            if (completedAtMillis < executionStartedMillis) {
              addFailure(
                `${contract.executionQueueFile}.items[${index}].completed_at must be >= execution_started_at.`,
              );
            }
          }
        }
      }

      if (duplicateIdempotencyKeys.size > 0) {
        addFailure(
          `${contract.executionQueueFile}.items contains duplicate idempotency_key values: ${[...duplicateIdempotencyKeys].join(", ")}`,
        );
      }

      if (contract.planQueueSyncEnabled === true) {
        const planRefToItems = new Map();
        for (const item of executionQueue.items) {
          if (!item || typeof item !== "object") {
            continue;
          }
          const planRef = toNonEmptyString(item.plan_ref);
          if (!planRef) {
            continue;
          }
          if (!planRefToItems.has(planRef)) {
            planRefToItems.set(planRef, []);
          }
          planRefToItems.get(planRef).push(item);
        }

        for (const rootPath of planQueueSyncRoots) {
          if (!fs.existsSync(rootPath)) {
            addFailure(
              `${rootPath} must exist when ${contractPath}.planQueueSyncEnabled is true.`,
            );
            continue;
          }
          const expectedState = toNonEmptyString(planQueueSyncStateByRoot?.[rootPath]);
          const featureDirs = listFeaturePlanDirectories(rootPath);

          for (const featureDir of featureDirs) {
            const planRef = `${rootPath}/${featureDir}/${contract.planQueueSyncPlanFileName}`;
            const planAbs = path.resolve(planRef);
            if (!fs.existsSync(planAbs)) {
              addFailure(`${planRef} is required for plan directory ${rootPath}/${featureDir}.`);
              continue;
            }

            const matchedItems = planRefToItems.get(planRef) ?? [];
            if (matchedItems.length === 0) {
              addFailure(
                `${contract.executionQueueFile} must include at least one queue item with plan_ref ${planRef}.`,
              );
              continue;
            }

            if (expectedState === "deferred") {
              const hasDeferredItem = matchedItems.some(
                (item) => toNonEmptyString(item?.state) === "deferred",
              );
              if (!hasDeferredItem) {
                addFailure(
                  `${contract.executionQueueFile} plan_ref ${planRef} must have at least one item in deferred state.`,
                );
              }
            }
          }
        }
      }
    }
  }

  if (fs.existsSync(contract.archiveRoot)) {
    const archiveRootStats = fs.statSync(contract.archiveRoot);
    if (!archiveRootStats.isDirectory()) {
      addFailure(`${contract.archiveRoot} must be a directory when present.`);
    }
  }

  const archiveIndex = readJsonIfPresent(contract.archiveIndexFile, true);
  const archiveShardCache = new Map();
  if (archiveIndex !== null) {
    for (const requiredField of archiveIndexRequiredFields) {
      if (!(requiredField in archiveIndex)) {
        addFailure(
          `${contract.archiveIndexFile} is missing required field: ${requiredField}`,
        );
      }
    }

    if (!isValidIsoDate(archiveIndex.last_updated)) {
      addFailure(`${contract.archiveIndexFile}.last_updated must be a valid ISO timestamp.`);
    }

    if (!Array.isArray(archiveIndex.items)) {
      addFailure(`${contract.archiveIndexFile}.items must be an array.`);
    } else {
      const archiveKeys = new Set();
      const archiveEntryByKey = new Map();
      for (const [index, entry] of archiveIndex.items.entries()) {
        if (!entry || typeof entry !== "object") {
          addFailure(`${contract.archiveIndexFile}.items[${index}] must be an object.`);
          continue;
        }

        for (const requiredField of archiveIndexRequiredItemFields) {
          if (!(requiredField in entry)) {
            addFailure(
              `${contract.archiveIndexFile}.items[${index}] is missing field ${requiredField}.`,
            );
          }
        }

        const archiveKey = toNonEmptyString(entry.archive_key);
        if (!archiveKey) {
          addFailure(
            `${contract.archiveIndexFile}.items[${index}].archive_key must be a non-empty string.`,
          );
        } else if (archiveKeys.has(archiveKey)) {
          addFailure(
            `${contract.archiveIndexFile}.items contains duplicate archive_key: ${archiveKey}.`,
          );
        } else {
          archiveKeys.add(archiveKey);
          archiveEntryByKey.set(archiveKey, entry);
        }

        const kind = toNonEmptyString(entry.kind);
        if (!kind || !["item", "feature"].includes(kind)) {
          addFailure(
            `${contract.archiveIndexFile}.items[${index}].kind must be either "item" or "feature".`,
          );
        }

        const featureId = toNonEmptyString(entry.feature_id);
        if (!featureId) {
          addFailure(
            `${contract.archiveIndexFile}.items[${index}].feature_id must be a non-empty string.`,
          );
        }

        if (!isValidIsoDate(entry.archived_at)) {
          addFailure(
            `${contract.archiveIndexFile}.items[${index}].archived_at must be a valid ISO timestamp.`,
          );
        }

        const archiveRef = toNonEmptyString(entry.archive_ref);
        if (!archiveRef) {
          addFailure(
            `${contract.archiveIndexFile}.items[${index}].archive_ref must be a non-empty string.`,
          );
          continue;
        }

        if (!archiveRef.startsWith(`${contract.archiveRoot}/`)) {
          addFailure(
            `${contract.archiveIndexFile}.items[${index}].archive_ref must start with ${contract.archiveRoot}/.`,
          );
        }

        if (featureId) {
          const expectedSuffix = `${toArchiveFeatureShardName(featureId)}.${contract.archiveFormat}`;
          if (!archiveRef.endsWith(expectedSuffix)) {
            addFailure(
              `${contract.archiveIndexFile}.items[${index}].archive_ref must end with ${expectedSuffix}.`,
            );
          }
        }

        if (!fs.existsSync(archiveRef)) {
          addFailure(
            `${contract.archiveIndexFile}.items[${index}].archive_ref points to missing file ${archiveRef}.`,
          );
          continue;
        }

        if (!archiveShardCache.has(archiveRef)) {
          archiveShardCache.set(archiveRef, readJsonLinesFile(archiveRef));
        }
        const shardEntries = archiveShardCache.get(archiveRef);
        if (!Array.isArray(shardEntries)) {
          continue;
        }

        if (archiveKey) {
          const hasMatchingArchiveKey = shardEntries.some(
            (shardEntry) =>
              shardEntry &&
              typeof shardEntry === "object" &&
              toNonEmptyString(shardEntry.archive_key) === archiveKey,
          );

          if (!hasMatchingArchiveKey) {
            addFailure(
              `${contract.archiveIndexFile}.items[${index}] archive_key ${archiveKey} is not present in ${archiveRef}.`,
            );
          }
        }
      }

      if (contract.archivedPlanSyncEnabled === true) {
        for (const expected of archivedPlanExpectations) {
          if (!expected.planExists) {
            continue;
          }
          const matchedEntry = archiveEntryByKey.get(expected.archiveKey);
          if (!matchedEntry) {
            addFailure(
              `${contract.archiveIndexFile} is missing archived-plan entry for ${expected.planRef} (expected archive_key ${expected.archiveKey}).`,
            );
            continue;
          }

          if (toNonEmptyString(matchedEntry.kind) !== archivedPlanIndexKind) {
            addFailure(
              `${contract.archiveIndexFile} entry ${expected.archiveKey} must use kind ${archivedPlanIndexKind}.`,
            );
          }
          if (toNonEmptyString(matchedEntry.feature_id) !== expected.featureId) {
            addFailure(
              `${contract.archiveIndexFile} entry ${expected.archiveKey} must use feature_id ${expected.featureId}.`,
            );
          }
          if (toNonEmptyString(matchedEntry.archive_ref) !== expected.archiveRef) {
            addFailure(
              `${contract.archiveIndexFile} entry ${expected.archiveKey} must reference archive_ref ${expected.archiveRef}.`,
            );
          }
          if (toNonEmptyString(matchedEntry.plan_ref) !== expected.planRef) {
            addFailure(
              `${contract.archiveIndexFile} entry ${expected.archiveKey} must reference plan_ref ${expected.planRef}.`,
            );
          }
        }
      }
    }
  }

  if (
    contract.archivedPlanSyncEnabled === true &&
    archivedPlanExpectations.length > 0 &&
    archiveIndex === null
  ) {
    addFailure(
      `${contract.archiveIndexFile} is required when archived plan directories exist under ${archivedPlanRoot}.`,
    );
  }

  const sessionBrief = readJsonIfPresent(contract.sessionBriefJsonFile, true);
  if (sessionBrief !== null) {
    for (const fieldName of sessionBriefRequiredFields) {
      if (!(fieldName in sessionBrief)) {
        addFailure(
          `${contract.sessionBriefJsonFile} is missing required field: ${fieldName}.`,
        );
      }
    }

    if (!isValidIsoDate(sessionBrief.generated_at)) {
      addFailure(`${contract.sessionBriefJsonFile}.generated_at must be a valid ISO timestamp.`);
    } else {
      const generatedAtMs = Date.parse(sessionBrief.generated_at);
      const warningWindowMs = contract.sessionBriefFreshnessHoursWarning * 60 * 60 * 1000;
      if (Date.now() - generatedAtMs > warningWindowMs) {
        if (sessionBriefFreshnessFailureMode === "warn") {
          addWarning(
            `${contract.sessionBriefJsonFile} is older than ${contract.sessionBriefFreshnessHoursWarning}h; run npm run agent:preflight.`,
          );
        } else {
          addFailure(
            `${contract.sessionBriefJsonFile} is older than ${contract.sessionBriefFreshnessHoursWarning}h; run npm run agent:preflight.`,
          );
        }
      }

      if (
        executionQueue !== null &&
        isValidIsoDate(executionQueue.last_updated) &&
        generatedAtMs < Date.parse(executionQueue.last_updated)
      ) {
        addWarning(
          `${contract.sessionBriefJsonFile}.generated_at predates ${contract.executionQueueFile}.last_updated.`,
        );
      }
      if (
        archiveIndex !== null &&
        isValidIsoDate(archiveIndex.last_updated) &&
        generatedAtMs < Date.parse(archiveIndex.last_updated)
      ) {
        addWarning(
          `${contract.sessionBriefJsonFile}.generated_at predates ${contract.archiveIndexFile}.last_updated.`,
        );
      }
    }

    if (toNonEmptyString(sessionBrief.queue_file) !== contract.executionQueueFile) {
      addFailure(
        `${contract.sessionBriefJsonFile}.queue_file must equal ${contract.executionQueueFile}.`,
      );
    }
    if (toNonEmptyString(sessionBrief.archive_index_file) !== contract.archiveIndexFile) {
      addFailure(
        `${contract.sessionBriefJsonFile}.archive_index_file must equal ${contract.archiveIndexFile}.`,
      );
    }

    if (
      !sessionBrief.queue_read_contract ||
      typeof sessionBrief.queue_read_contract !== "object"
    ) {
      addFailure(`${contract.sessionBriefJsonFile}.queue_read_contract must be an object.`);
    } else {
      for (const fieldName of [
        "required_top_level_fields",
        "item_selector_fields",
        "max_items_per_read",
      ]) {
        if (!(fieldName in sessionBrief.queue_read_contract)) {
          addFailure(
            `${contract.sessionBriefJsonFile}.queue_read_contract is missing field ${fieldName}.`,
          );
        }
      }
    }
  }

  readFileIfPresent(contract.continuityFile, false);
}

function checkRuleCatalogContract(config) {
  const contractPath = "contracts.ruleCatalog";
  const contract = config?.contracts?.ruleCatalog;
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }

  if (contract.file !== "docs/AGENT_RULES.md") {
    addFailure(`${contractPath}.file must equal \"docs/AGENT_RULES.md\".`);
    return;
  }

  const requiredIds = validateStringArray(
    contract.requiredIds,
    `${contractPath}.requiredIds`,
  );

  const rulesContent = readFileIfPresent(contract.file);
  if (rulesContent === null) {
    return;
  }

  for (const id of requiredIds) {
    const snippet = `\`${id}\``;
    if (!rulesContent.includes(snippet)) {
      addFailure(`${contract.file} must reference rule id ${snippet}.`);
    }
  }
}

function checkOrchestratorSubagentContracts(config) {
  const contractPath = "contracts.orchestratorSubagent";
  const contract = config?.contracts?.orchestratorSubagent;
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }

  checkRequiredFieldList({
    fieldName: "machinePayloadRequiredFields",
    actualFields: contract.machinePayloadRequiredFields,
    requiredFields: [
      "task_id",
      "objective",
      "inputs",
      "constraints",
      "acceptance_criteria",
      "deliverables",
      "verification",
      "atomic_scope",
    ],
    contractPath,
  });

  checkRequiredFieldList({
    fieldName: "resultEnvelopeRequiredFields",
    actualFields: contract.resultEnvelopeRequiredFields,
    requiredFields: ["status", "outputs", "evidence", "unresolved_questions"],
    contractPath,
  });

  if (
    !contract.defaultCliRouting ||
    typeof contract.defaultCliRouting !== "object"
  ) {
    addFailure(`${contractPath}.defaultCliRouting must be an object.`);
  } else {
    const codexCli = contract.defaultCliRouting.codex;
    const claudeCli = contract.defaultCliRouting.claude;
    if (codexCli !== "codex") {
      addFailure(`${contractPath}.defaultCliRouting.codex must equal "codex".`);
    }
    if (claudeCli !== "claude") {
      addFailure(`${contractPath}.defaultCliRouting.claude must equal "claude".`);
    }
  }

  if (
    !contract.defaultModelRouting ||
    typeof contract.defaultModelRouting !== "object"
  ) {
    addFailure(`${contractPath}.defaultModelRouting must be an object.`);
  } else {
    const codexModel = contract.defaultModelRouting.codex;
    if (codexModel !== "gpt-5.3-codex-spark") {
      addFailure(
        `${contractPath}.defaultModelRouting.codex must equal "gpt-5.3-codex-spark".`,
      );
    }
  }

  const rules = contract.rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    addFailure(`${contractPath}.rules must be a non-empty array.`);
    return;
  }

  const requiredRuleIds = [
    "orch_hybrid_instruction_contract",
    "orch_scope_tightness",
    "orch_machine_payload_authoritative",
    "orch_delegate_substantive_work",
    "orch_human_nuance_addendum",
    "orch_atomic_task_delegation",
    "orch_dual_channel_result_envelope",
    "orch_orchestrator_coordination_only",
    "orch_default_cli_routing",
    "orch_unconfirmed_unknowns",
    "orch_atomic_single_objective_scope",
    "orch_codex_model_default",
  ];

  const seenRuleIds = new Set();
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") {
      addFailure(`${contractPath}.rules contains a non-object rule.`);
      continue;
    }

    if (typeof rule.id !== "string" || rule.id.trim() === "") {
      addFailure(`${contractPath}.rules contains a rule without a valid id.`);
      continue;
    }

    if (!/^[a-z0-9_]+$/.test(rule.id)) {
      addFailure(
        `${contractPath}.rules id must use lowercase snake_case: ${rule.id}`,
      );
    }

    if (seenRuleIds.has(rule.id)) {
      addFailure(`${contractPath}.rules contains duplicate id: ${rule.id}`);
    }
    seenRuleIds.add(rule.id);

    if (typeof rule.statement !== "string" || rule.statement.trim() === "") {
      addFailure(
        `${contractPath}.rules[${rule.id}] is missing a non-empty statement.`,
      );
    }
  }

  for (const requiredRuleId of requiredRuleIds) {
    if (!seenRuleIds.has(requiredRuleId)) {
      addFailure(`${contractPath}.rules is missing required id: ${requiredRuleId}`);
    }
  }

  const agentsContent = readFileIfPresent("AGENTS.md");
  if (agentsContent !== null) {
    for (const requiredRuleId of requiredRuleIds) {
      const idSnippet = `\`${requiredRuleId}\``;
      if (!agentsContent.includes(idSnippet)) {
        addFailure(`AGENTS.md must reference contract id ${idSnippet}.`);
      }
    }
  }

  const rulesContent = readFileIfPresent("docs/AGENT_RULES.md");
  if (rulesContent !== null) {
    for (const requiredRuleId of requiredRuleIds) {
      const idSnippet = `\`${requiredRuleId}\``;
      if (!rulesContent.includes(idSnippet)) {
        addFailure(`docs/AGENT_RULES.md must reference contract id ${idSnippet}.`);
      }
    }
  }
}

function checkPolicyRuleQuality(config) {
  const rules = config?.checks?.requiredTextSnippets ?? [];

  for (const rule of rules) {
    const snippets = rule.snippets ?? [];
    if (snippets.length === 0) {
      addWarning(`requiredTextSnippets rule for ${rule.file} has no snippets.`);
      continue;
    }

    const seen = new Set();
    for (const snippet of snippets) {
      if (seen.has(snippet)) {
        addWarning(
          `Duplicate required text snippet in policy config for ${rule.file}: ${snippet}`,
        );
      }
      seen.add(snippet);
    }
  }

  const markdownRules = config?.checks?.requiredMarkdownSections ?? [];
  for (const rule of markdownRules) {
    const sections = rule.sections ?? [];
    if (sections.length === 0) {
      addWarning(`requiredMarkdownSections rule for ${rule.file} has no sections.`);
      continue;
    }

    const seen = new Set();
    for (const section of sections) {
      if (seen.has(section)) {
        addWarning(
          `Duplicate markdown section requirement in policy config for ${rule.file}: ${section}`,
        );
      }
      seen.add(section);
    }
  }

  const sequenceRules = config?.checks?.requiredSequenceSnippets ?? [];
  for (const rule of sequenceRules) {
    const sequence = rule.sequence ?? [];
    if (sequence.length === 0) {
      addWarning(`requiredSequenceSnippets rule for ${rule.file} has no sequence.`);
      continue;
    }

    const seen = new Set();
    for (const snippet of sequence) {
      if (seen.has(snippet)) {
        addWarning(
          `Duplicate sequence snippet requirement in policy config for ${rule.file}: ${snippet}`,
        );
      }
      seen.add(snippet);
    }
  }
}

function runPolicyChecks(activeConfigPath = configPath) {
  const repoRoot = resolveRepoRoot();
  process.chdir(repoRoot);

  failures.length = 0;
  warnings.length = 0;

  const absoluteConfigPath = path.resolve(repoRoot, activeConfigPath);
  const config = readJson(absoluteConfigPath);
  const { files: trackedFiles, reliable: trackedFilesReliable } = listTrackedFiles();

  checkPolicyMetadata(config);
  checkWorkspaceLayoutContract(config, repoRoot);
  checkDocumentationModelContract(config);
  checkContextIndexContract(config);
  checkReleaseNotesContract(config);
  checkFeatureIndexContract(config);
  checkTestMatrixContract(config);
  checkRouteMapContract(config);
  checkDomainReadmesContract(config);
  checkJSDocCoverageContract(config);
  checkSessionArtifactsContract(config);
  checkRuleCatalogContract(config);
  checkOrchestratorSubagentContracts(config);
  checkPolicyRuleQuality(config);
  checkRequiredTextSnippets(config);
  checkRequiredMarkdownSections(config);
  checkRequiredSequenceSnippets(config);
  checkContinuityEntryFormat(config);
  checkForbiddenTextPatterns(config, trackedFiles, trackedFilesReliable);
  checkDisallowedTrackedPathPrefixes(config, trackedFiles, trackedFilesReliable);

  return {
    config,
    warnings: [...warnings],
    failures: [...failures],
  };
}

function main() {
  const { config, warnings: runWarnings, failures: runFailures } = runPolicyChecks();

  if (runWarnings.length > 0) {
    console.log("Policy warnings:");
    for (const warning of runWarnings) {
      console.log(`- ${warning}`);
    }
  }

  if (runFailures.length > 0) {
    console.error("Policy check failures:");
    for (const failure of runFailures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log(
    `Policy checks passed (${config.metadata?.id ?? "unknown"} ${config.metadata?.version ?? "n/a"}).`,
  );
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main();
}

export { runPolicyChecks };
