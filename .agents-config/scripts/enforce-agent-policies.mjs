#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyCanonicalRuleset } from "../tools/rules/verify-canonical-ruleset.mjs";

const DEFAULT_CONFIG_PATH = ".agents-config/policies/agent-governance.json";

function parseCliArgs(argv) {
  const parsed = {
    configPath: DEFAULT_CONFIG_PATH,
    ci: false,
  };
  const positional = [];

  for (const token of argv) {
    if (token === "--ci") {
      parsed.ci = true;
      continue;
    }

    if (token.startsWith("--")) {
      console.error(`Unknown option: ${token}`);
      process.exit(1);
    }

    positional.push(token);
  }

  if (positional.length > 1) {
    console.error(
      `Unexpected positional args: ${positional.join(" ")}. Expected at most one config path.`,
    );
    process.exit(1);
  }

  if (positional.length === 1) {
    parsed.configPath = positional[0];
  }

  return parsed;
}

const cliArgs = parseCliArgs(process.argv.slice(2));
const configPath = cliArgs.configPath;
const failures = [];
const warnings = [];
let agentsAwareReadResolver = (value) => value;
let activeRunOptions = { ci: cliArgs.ci };

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

function resolveGitCommonDir(repoRoot) {
  const result = runCommandSafe("git", ["rev-parse", "--git-common-dir"]);
  if (!result.ok || !result.stdout) {
    return null;
  }

  if (path.isAbsolute(result.stdout)) {
    return path.resolve(result.stdout);
  }
  return path.resolve(repoRoot, result.stdout);
}

function derivePrimaryRepoRootFromCommonDir(commonDir) {
  if (!commonDir) {
    return null;
  }

  let cursor = path.resolve(commonDir);
  while (true) {
    if (path.basename(cursor) === ".git") {
      return path.resolve(cursor, "..");
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return null;
    }
    cursor = parent;
  }
}

function resolvePrimaryRepoRoot(repoRoot) {
  const commonDir = resolveGitCommonDir(repoRoot);
  const primaryRepoRoot = derivePrimaryRepoRootFromCommonDir(commonDir);
  if (primaryRepoRoot) {
    return primaryRepoRoot;
  }
  return path.resolve(repoRoot);
}

function resolvePathFromBase(targetPath, basePath) {
  const normalized = toNonEmptyString(targetPath);
  if (!normalized) {
    return path.resolve(basePath);
  }
  if (path.isAbsolute(normalized)) {
    return path.resolve(normalized);
  }
  return path.resolve(basePath, normalized);
}

function isPathWithin(candidatePath, parentPath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveCanonicalWorktreesRoot(canonicalRepoRoot) {
  const canonicalRepoRootResolved = path.resolve(canonicalRepoRoot);
  const repoName = path.basename(canonicalRepoRootResolved);
  return path.resolve(canonicalRepoRootResolved, "..", `${repoName}.worktrees`);
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
  const requestedPath = toNonEmptyString(filePath) ?? String(filePath ?? "");
  const resolvedPath = agentsAwareReadResolver(requestedPath);
  const preferredPath =
    fs.existsSync(requestedPath) ||
    !resolvedPath ||
    resolvedPath === requestedPath ||
    !fs.existsSync(resolvedPath)
      ? requestedPath
      : resolvedPath;

  if (!fs.existsSync(preferredPath)) {
    if (optional) {
      addWarning(`Optional file not present: ${requestedPath}`);
      return null;
    }

    addFailure(`Required file missing: ${requestedPath}`);
    return null;
  }

  return fs.readFileSync(preferredPath, "utf8");
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
  const activeProfiles = getActiveProfiles(config);

  for (const rule of rules) {
    if (!profileScopeIsActive(activeProfiles, rule?.profiles)) {
      continue;
    }
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
  const activeProfiles = getActiveProfiles(config);

  for (const rule of rules) {
    if (!profileScopeIsActive(activeProfiles, rule?.profiles)) {
      continue;
    }
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
  const activeProfiles = getActiveProfiles(config);

  for (const rule of rules) {
    if (!profileScopeIsActive(activeProfiles, rule?.profiles)) {
      continue;
    }
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

function checkPlaceholderMarkers(config) {
  const rules = config?.checks?.placeholderMarkers ?? [];
  const activeProfiles = getActiveProfiles(config);
  const activeBootstrapFile = toNonEmptyString(
    config?.contracts?.documentationModel?.bootstrapFile,
  );

  for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
    const rule = rules[ruleIndex];
    if (!profileScopeIsActive(activeProfiles, rule?.profiles)) {
      continue;
    }

    const skipBootstrapFiles = normalizeStringArray(rule?.skipWhenBootstrapFileIs);
    if (
      activeBootstrapFile &&
      skipBootstrapFiles.length > 0 &&
      skipBootstrapFiles.includes(activeBootstrapFile)
    ) {
      continue;
    }

    const content = readFileIfPresent(rule?.file, Boolean(rule?.optional));
    if (content === null) {
      continue;
    }

    const literalPatterns = normalizeStringArray(rule?.patterns);
    const regexPatternTexts = normalizeStringArray(rule?.regexPatterns);
    const compiledRegexPatterns = compileRegexPatternList(
      regexPatternTexts,
      `checks.placeholderMarkers[${ruleIndex}].regexPatterns`,
    );

    if (literalPatterns.length === 0 && compiledRegexPatterns.length === 0) {
      addWarning(
        `placeholderMarkers rule for ${rule?.file ?? "<unknown>"} has no patterns.`,
      );
      continue;
    }

    const sectionHeadingRegexPattern =
      toNonEmptyString(rule?.sectionHeadingRegex) ?? "^##\\s+.+$";
    let sectionHeadingRegex = null;
    try {
      sectionHeadingRegex = new RegExp(sectionHeadingRegexPattern);
    } catch (error) {
      addFailure(
        `checks.placeholderMarkers[${ruleIndex}].sectionHeadingRegex is invalid: ${error.message}`,
      );
      continue;
    }

    const failureMode = toNonEmptyString(rule?.failureMode) ?? "warn";
    if (!["warn", "fail"].includes(failureMode)) {
      addFailure(
        `checks.placeholderMarkers[${ruleIndex}].failureMode must be either "warn" or "fail".`,
      );
      continue;
    }

    const lines = content.split(/\r?\n/);
    const matches = [];
    let activeSection = "(top-level)";

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      const trimmed = line.trim();
      if (sectionHeadingRegex.test(trimmed)) {
        activeSection = trimmed;
      }

      const literalMatch = literalPatterns.find((pattern) => line.includes(pattern));
      let regexMatch = null;
      if (!literalMatch) {
        regexMatch = compiledRegexPatterns.find((pattern) => pattern.test(line)) ?? null;
      }

      if (!literalMatch && !regexMatch) {
        continue;
      }

      matches.push({
        section: activeSection,
        line: lineIndex + 1,
        matchedPattern: literalMatch ?? regexMatch.toString(),
      });
    }

    if (matches.length === 0) {
      continue;
    }

    const sectionSummary = [...new Set(matches.map((entry) => entry.section))]
      .slice(0, 8)
      .join(", ");
    const matchSummary = matches
      .slice(0, 5)
      .map(
        (entry) =>
          `${entry.section} (line ${entry.line}, pattern ${entry.matchedPattern})`,
      )
      .join("; ");
    const baseMessage =
      toNonEmptyString(rule?.message) ??
      `Placeholder marker detected in ${rule?.file ?? "<unknown>"}.`;
    const combinedMessage = `${baseMessage} Sections: ${sectionSummary}. Sample matches: ${matchSummary}.`;

    if (failureMode === "fail") {
      addFailure(combinedMessage);
    } else {
      addWarning(combinedMessage);
    }
  }
}

function checkSessionLogEntryFormat(config) {
  const rule = config?.checks?.sessionLogEntryFormat;
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
        `Invalid session log entry format in ${rule.file}:${i + 1}: ${trimmed}`,
      );
    }
  }
}

function checkMemoryIndexContract(config) {
  const rule = config?.checks?.memoryIndexContract;
  if (!rule) {
    return;
  }

  const memoryContent = readFileIfPresent(rule.file, Boolean(rule.optional));
  if (memoryContent === null) {
    return;
  }

  const sectionHeader = toNonEmptyString(rule.sectionHeader);
  if (!sectionHeader) {
    addFailure("checks.memoryIndexContract.sectionHeader must be a non-empty string.");
    return;
  }
  const noneEntry = toNonEmptyString(rule.noneEntry) ?? "- None recorded.";
  const entryRegexText = toNonEmptyString(rule.entryRegex);
  if (!entryRegexText) {
    addFailure("checks.memoryIndexContract.entryRegex must be a non-empty regex string.");
    return;
  }
  const directoryRoot = toNonEmptyString(rule.directoryRoot) ?? ".agents/memory";
  const directoryNameRegexText =
    toNonEmptyString(rule.directoryNameRegex) ?? "^m[0-9]{3}$";
  const submemoryFileName = toNonEmptyString(rule.submemoryFileName) ?? "_submemory.md";
  const descriptionMinLength =
    Number.isInteger(rule.descriptionMinLength) && rule.descriptionMinLength >= 1
      ? rule.descriptionMinLength
      : 12;

  let entryRegex;
  let directoryNameRegex;
  try {
    entryRegex = new RegExp(entryRegexText);
  } catch (error) {
    addFailure(
      `checks.memoryIndexContract.entryRegex is invalid: ${error.message}`,
    );
    return;
  }
  try {
    directoryNameRegex = new RegExp(directoryNameRegexText);
  } catch (error) {
    addFailure(
      `checks.memoryIndexContract.directoryNameRegex is invalid: ${error.message}`,
    );
    return;
  }

  const lines = memoryContent.split(/\r?\n/);
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === sectionHeader) {
      sectionStart = i + 1;
      break;
    }
  }
  if (sectionStart === -1) {
    addFailure(`${rule.file} is missing required section header: ${sectionHeader}`);
    return;
  }

  const indexEntries = [];
  for (let i = sectionStart; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("## ")) {
      break;
    }
    if (!trimmed.startsWith("- ")) {
      continue;
    }
    indexEntries.push({ line: i + 1, text: trimmed });
  }

  if (indexEntries.length === 0) {
    addFailure(
      `${rule.file} ${sectionHeader} must contain at least one bullet entry (or ${noneEntry}).`,
    );
    return;
  }

  const directoryRootResolved = agentsAwareReadResolver(directoryRoot);
  if (!fs.existsSync(directoryRootResolved)) {
    addFailure(`${directoryRoot} must exist.`);
    return;
  }
  if (!fs.statSync(directoryRootResolved).isDirectory()) {
    addFailure(`${directoryRoot} must be a directory.`);
    return;
  }

  const submemoryDirectories = fs
    .readdirSync(directoryRootResolved, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const directoryName of submemoryDirectories) {
    if (!directoryNameRegex.test(directoryName)) {
      addFailure(
        `Invalid submemory directory name under ${directoryRoot}: ${directoryName} (expected ${directoryNameRegexText}).`,
      );
    }

    const directoryPath = path.resolve(directoryRootResolved, directoryName);
    const files = fs
      .readdirSync(directoryPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);

    if (!files.includes(submemoryFileName)) {
      addFailure(
        `${directoryRoot}/${directoryName} must contain ${submemoryFileName}.`,
      );
    }

    for (const fileName of files) {
      if (fileName !== submemoryFileName) {
        addFailure(
          `${directoryRoot}/${directoryName} has invalid file "${fileName}"; submemory files must be named ${submemoryFileName}.`,
        );
      }
    }
  }

  const isNoneRecordedEntry =
    indexEntries.length === 1 && indexEntries[0].text === noneEntry;
  if (isNoneRecordedEntry) {
    if (submemoryDirectories.length > 0) {
      addFailure(
        `${rule.file} uses ${noneEntry} but ${directoryRoot} contains submemory directories.`,
      );
    }
    return;
  }

  const indexedIds = new Set();
  for (const entry of indexEntries) {
    const match = entry.text.match(entryRegex);
    if (!match) {
      addFailure(
        `Invalid submemory index entry format in ${rule.file}:${entry.line}: ${entry.text}`,
      );
      continue;
    }

    const id = toNonEmptyString(match.groups?.id);
    const indexedPath = toNonEmptyString(match.groups?.path);
    const description = toNonEmptyString(match.groups?.description);
    if (!id || !indexedPath || !description) {
      addFailure(
        `Submemory index entry in ${rule.file}:${entry.line} must include id/path/description.`,
      );
      continue;
    }

    if (description.length < descriptionMinLength) {
      addFailure(
        `Submemory index entry description too short in ${rule.file}:${entry.line}; expected at least ${descriptionMinLength} characters.`,
      );
    }

    if (!directoryNameRegex.test(id)) {
      addFailure(
        `Submemory index id in ${rule.file}:${entry.line} must match ${directoryNameRegexText} (found ${id}).`,
      );
    }

    if (indexedIds.has(id)) {
      addFailure(`Duplicate submemory index id in ${rule.file}: ${id}`);
      continue;
    }
    indexedIds.add(id);

    const expectedPath = `${directoryRoot}/${id}/${submemoryFileName}`;
    if (indexedPath !== expectedPath) {
      addFailure(
        `Submemory index path mismatch in ${rule.file}:${entry.line}; expected ${expectedPath} (found ${indexedPath}).`,
      );
    }

    const resolvedIndexedPath = agentsAwareReadResolver(indexedPath);
    if (!fs.existsSync(resolvedIndexedPath)) {
      addFailure(
        `Submemory path referenced in ${rule.file}:${entry.line} is missing: ${indexedPath}`,
      );
      continue;
    }
    if (!fs.statSync(resolvedIndexedPath).isFile()) {
      addFailure(
        `Submemory path referenced in ${rule.file}:${entry.line} must be a file: ${indexedPath}`,
      );
    }

    const directoryPath = path.dirname(resolvedIndexedPath);
    const directoryName = path.basename(directoryPath);
    if (directoryName !== id) {
      addFailure(
        `Submemory path/id mismatch in ${rule.file}:${entry.line}; expected parent dir ${id} (found ${directoryName}).`,
      );
    }

    const relativeToRoot = toPosixPath(path.relative(directoryRootResolved, directoryPath));
    if (relativeToRoot !== id) {
      addFailure(
        `Submemory path in ${rule.file}:${entry.line} must be directly under ${directoryRoot}.`,
      );
    }
  }

  for (const directoryName of submemoryDirectories) {
    if (!indexedIds.has(directoryName)) {
      addFailure(
        `Missing submemory index entry in ${rule.file} for directory ${directoryRoot}/${directoryName}.`,
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

      if (!fs.existsSync(filePath)) {
        addWarning(`Tracked file missing during forbidden-text scan: ${filePath}`);
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

  const bootstrapFile = toNonEmptyString(contract.bootstrapFile);
  if (!bootstrapFile) {
    addFailure(`${contractPath}.bootstrapFile must be a non-empty string.`);
  } else if (!bootstrapFile.endsWith(".md")) {
    addFailure(`${contractPath}.bootstrapFile must reference a markdown file.`);
  }

  const requiredStrings = {
    humanRulesFile: ".agents-config/docs/AGENT_RULES.md",
    humanContextFile: ".agents-config/docs/AGENT_CONTEXT.md",
    contextIndexFile: ".agents-config/docs/CONTEXT_INDEX.json",
    machinePolicyFile: ".agents-config/policies/agent-governance.json",
    enforcementScript: ".agents-config/scripts/enforce-agent-policies.mjs",
    sessionPreflightScript: ".agents-config/scripts/agent-session-preflight.mjs",
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

  const expectedStartupReadOrder = [
    bootstrapFile ?? "AGENTS.md",
    ".agents-config/docs/AGENT_RULES.md",
    ".agents-config/docs/CONTEXT_INDEX.json",
    ".agents-config/docs/AGENT_CONTEXT.md",
    ".agents/EXECUTION_QUEUE.json",
    ".agents/MEMORY.md",
  ];

  checkExactOrderedArray({
    value: contract.startupReadOrder,
    expected: expectedStartupReadOrder,
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

function toPosixPath(value) {
  return String(value).split(path.sep).join("/");
}

function getActiveProfiles(config) {
  const profilesContract = config?.contracts?.profiles;
  const configuredProfiles = normalizeStringArray(
    profilesContract?.activeProfiles,
  );
  if (configuredProfiles.length > 0) {
    return new Set(configuredProfiles);
  }
  return new Set([
    "base",
    "typescript",
    "typescript-openapi",
    "javascript",
    "python",
  ]);
}

function getAvailableProfiles(config) {
  const profilesContract = config?.contracts?.profiles;
  const configuredProfiles = normalizeStringArray(
    profilesContract?.availableProfiles,
  );
  if (configuredProfiles.length > 0) {
    return configuredProfiles;
  }
  return [
    "base",
    "typescript",
    "typescript-openapi",
    "javascript",
    "python",
  ];
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

function compileRegexPatternList(patterns, fieldPath) {
  const compiled = [];
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(pattern, "i"));
    } catch (error) {
      addFailure(`${fieldPath} contains invalid regex pattern "${pattern}": ${error.message}`);
    }
  }
  return compiled;
}

function matchesAnyRegexPattern(value, regexes) {
  const text = toNonEmptyString(value);
  if (!text || !Array.isArray(regexes) || regexes.length === 0) {
    return false;
  }
  return regexes.some((regex) => regex.test(text));
}

function profileScopeIsActive(activeProfiles, requiredProfiles) {
  const required = normalizeStringArray(requiredProfiles);
  if (required.length === 0) {
    return true;
  }
  return required.some((profile) => activeProfiles.has(profile));
}

function resolveProfileScopedRequiredStrings({
  config,
  baseValues,
  baseFieldPath,
  byProfileValues,
  byProfileFieldPath,
}) {
  const requiredBaseValues = validateStringArray(baseValues, baseFieldPath);
  const activeProfiles = getActiveProfiles(config);
  const availableProfiles = new Set(getAvailableProfiles(config));
  const requiredProfileValuesByProfile = new Map();

  if (byProfileValues !== undefined) {
    if (!isPlainObject(byProfileValues)) {
      addFailure(`${byProfileFieldPath} must be an object when provided.`);
    } else {
      for (const [profile, values] of Object.entries(byProfileValues)) {
        if (!availableProfiles.has(profile)) {
          addFailure(
            `${byProfileFieldPath} contains unknown profile "${profile}".`,
          );
          continue;
        }
        const normalizedValues = validateStringArray(
          values,
          `${byProfileFieldPath}.${profile}`,
        );
        requiredProfileValuesByProfile.set(profile, normalizedValues);
      }
    }
  }

  const combinedValues = [];
  const seenValues = new Set();
  const appendUnique = (value) => {
    if (seenValues.has(value)) {
      return;
    }
    seenValues.add(value);
    combinedValues.push(value);
  };

  for (const value of requiredBaseValues) {
    appendUnique(value);
  }

  for (const profile of activeProfiles) {
    for (const value of requiredProfileValuesByProfile.get(profile) ?? []) {
      appendUnique(value);
    }
  }

  return {
    requiredBaseValues,
    requiredProfileValuesByProfile,
    requiredValues: combinedValues,
  };
}

function isContractEnabled(config, contract) {
  if (!contract || typeof contract !== "object") {
    return true;
  }
  if (contract.enabled === false) {
    return false;
  }
  const activeProfiles = getActiveProfiles(config);
  return profileScopeIsActive(activeProfiles, contract.profiles);
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePlanMachineAllowedStatusByRoot({
  rawAllowedStatusByRoot,
  roots,
  contractPath,
}) {
  const allowedStatusByRoot = {};
  for (const rootPath of roots) {
    const candidate = isPlainObject(rawAllowedStatusByRoot)
      ? rawAllowedStatusByRoot[rootPath]
      : undefined;
    const normalizedStates = normalizeStringArray(candidate);
    if (normalizedStates.length === 0) {
      addFailure(
        `${contractPath}.planMachineAllowedStatusByRoot is missing non-empty status list for ${rootPath}.`,
      );
      allowedStatusByRoot[rootPath] = [];
      continue;
    }
    allowedStatusByRoot[rootPath] = normalizedStates;
  }
  return allowedStatusByRoot;
}

function validatePlanMachineDocument({
  planMachineRef,
  planMachineAbs,
  expectedFeatureId,
  expectedPlanRef,
  expectedRoot,
  expectedSchemaVersion,
  requiredTopLevelFields,
  requiredPlanningStages,
  requiredNarrativeFields,
  preSpecOutlineRequiredFields,
  statusesRequiringNonEmptyPreSpecNonGoals,
  statusesRequiringNarrativeContent,
  narrativeMinLength,
  preSpecOutlineMinLength,
  narrativeMinSteps,
  specOutlineListFieldName,
  refinedSpecListFieldName,
  specOutlineEntryRequiredFields,
  refinedSpecEntryRequiredFields,
  statusesRequiringSpecOutlineEntries,
  statusesRequiringRefinedSpecEntries,
  specOutlineMinEntries,
  refinedSpecMinEntries,
  implementationStepsFieldName,
  allowedNarrativeStepStatuses,
  narrativeStepRequiredFields,
  narrativeStepOptionalFields,
  implementationStepDeliverableDenyPatternRegexes,
  implementationStepAcceptanceCriteriaMinCount,
  stepStatusesRequiringAcceptanceCriteria,
  stepStatusesRequiringNonEmptyCompletionSummary,
  implementationCompletionSummaryRequiredFields,
  statusCoherence,
  allowedPlanningStageStates,
  allowedSubagentRequirements,
  requiredSubagentFields,
  statusesRequiringLastExecutor,
  allowedStatusByRoot,
}) {
  if (!fs.existsSync(planMachineAbs)) {
    addFailure(`${planMachineRef} is required for plan directory ${expectedRoot}/${expectedFeatureId}.`);
    return;
  }

  const planMachine = readJsonIfPresent(planMachineRef, false);
  if (!planMachine || !isPlainObject(planMachine)) {
    addFailure(`${planMachineRef} must contain a top-level JSON object.`);
    return;
  }

  for (const fieldName of requiredTopLevelFields) {
    if (!(fieldName in planMachine)) {
      addFailure(`${planMachineRef} is missing required field ${fieldName}.`);
    }
  }

  if (toNonEmptyString(planMachine.schema_version) !== expectedSchemaVersion) {
    addFailure(
      `${planMachineRef}.schema_version must equal ${expectedSchemaVersion}.`,
    );
  }
  if (toNonEmptyString(planMachine.feature_id) !== expectedFeatureId) {
    addFailure(`${planMachineRef}.feature_id must equal ${expectedFeatureId}.`);
  }
  if (toNonEmptyString(planMachine.plan_ref) !== expectedPlanRef) {
    addFailure(`${planMachineRef}.plan_ref must equal ${expectedPlanRef}.`);
  }
  if (!isNonEmptyString(planMachine.feature_title)) {
    addFailure(`${planMachineRef}.feature_title must be a non-empty string.`);
  }
  if (!isValidIsoDate(planMachine.updated_at)) {
    addFailure(`${planMachineRef}.updated_at must be a valid ISO timestamp.`);
  }

  const rootAllowedStatuses = allowedStatusByRoot[expectedRoot] ?? [];
  const status = toNonEmptyString(planMachine.status);
  if (!status || !rootAllowedStatuses.includes(status)) {
    addFailure(
      `${planMachineRef}.status must be one of: ${rootAllowedStatuses.join(", ")}.`,
    );
  }

  const planningStages = planMachine.planning_stages;
  if (!isPlainObject(planningStages)) {
    addFailure(`${planMachineRef}.planning_stages must be an object.`);
  } else {
    for (const stageName of requiredPlanningStages) {
      const stageValue = toNonEmptyString(planningStages[stageName]);
      if (!stageValue || !allowedPlanningStageStates.includes(stageValue)) {
        addFailure(
          `${planMachineRef}.planning_stages.${stageName} must be one of: ${allowedPlanningStageStates.join(", ")}.`,
        );
      }
    }
  }

  const narrative = planMachine.narrative;
  if (!isPlainObject(narrative)) {
    addFailure(`${planMachineRef}.narrative must be an object.`);
  } else {
    const specOutlineListField = toNonEmptyString(specOutlineListFieldName) ?? "full_spec_outline";
    const refinedSpecListField = toNonEmptyString(refinedSpecListFieldName) ?? "full_refined_spec";
    const implementationStepsField =
      toNonEmptyString(implementationStepsFieldName) ?? "steps";
    const normalizedSpecOutlineEntryRequiredFields = normalizeStringArray(
      specOutlineEntryRequiredFields,
    );
    const normalizedRefinedSpecEntryRequiredFields = normalizeStringArray(
      refinedSpecEntryRequiredFields,
    );
    const requiredStepFieldSet = new Set(narrativeStepRequiredFields);
    const optionalStepFieldSet = new Set(narrativeStepOptionalFields);
    const completionSummaryRequiredFieldSet = new Set(
      implementationCompletionSummaryRequiredFields,
    );
    const acceptanceCriteriaMinCount =
      Number.isInteger(implementationStepAcceptanceCriteriaMinCount) &&
      implementationStepAcceptanceCriteriaMinCount >= 1
        ? implementationStepAcceptanceCriteriaMinCount
        : 1;
    const stepStatusesRequiringAcceptanceCriteriaSet = new Set(
      normalizeStringArray(stepStatusesRequiringAcceptanceCriteria),
    );
    const stepStatusesRequiringNonEmptyCompletionSummarySet = new Set(
      normalizeStringArray(stepStatusesRequiringNonEmptyCompletionSummary),
    );
    const implementationStepStatusSummary = {
      hasAny: false,
      hasInProgress: false,
      allComplete: true,
    };
    const validateStructuredNarrativeEntryList = ({
      listValue,
      listPath,
      requiredFields,
    }) => {
      for (const [entryIndex, entry] of listValue.entries()) {
        if (!isPlainObject(entry)) {
          addFailure(`${listPath}[${entryIndex}] must be an object.`);
          continue;
        }
        const entryPath = `${listPath}[${entryIndex}]`;
        for (const fieldName of requiredFields) {
          if (!(fieldName in entry)) {
            addFailure(`${entryPath}.${fieldName} is required.`);
            continue;
          }
          if (fieldName === "acceptance_criteria" || fieldName === "references") {
            const fieldValue = entry[fieldName];
            if (!Array.isArray(fieldValue)) {
              addFailure(`${entryPath}.${fieldName} must be an array.`);
              continue;
            }
            const normalizedValues = fieldValue.filter((value) => isNonEmptyString(value));
            if (normalizedValues.length !== fieldValue.length) {
              addFailure(`${entryPath}.${fieldName} must contain non-empty string values.`);
            }
            if (normalizedValues.length < 1) {
              addFailure(`${entryPath}.${fieldName} must contain at least 1 entry.`);
            }
            continue;
          }
          if (!isNonEmptyString(entry[fieldName])) {
            addFailure(`${entryPath}.${fieldName} must be a non-empty string.`);
          }
        }
      }
    };

    const validateCompletionSummary = (completionSummary, stepPath, stepStatus) => {
      if (!isPlainObject(completionSummary)) {
        addFailure(`${stepPath}.completion_summary must be an object.`);
        return;
      }

      for (const fieldName of completionSummaryRequiredFieldSet) {
        const fieldValue = completionSummary[fieldName];
        if (!Array.isArray(fieldValue)) {
          addFailure(`${stepPath}.completion_summary.${fieldName} must be an array.`);
          continue;
        }
        const normalizedValues = fieldValue.filter((entry) => isNonEmptyString(entry));
        if (normalizedValues.length !== fieldValue.length) {
          addFailure(
            `${stepPath}.completion_summary.${fieldName} must contain non-empty string values.`,
          );
        }
        if (
          stepStatus &&
          stepStatusesRequiringNonEmptyCompletionSummarySet.has(stepStatus) &&
          normalizedValues.length === 0
        ) {
          addFailure(
            `${stepPath}.completion_summary.${fieldName} must be non-empty when status is ${stepStatus}.`,
          );
        }
      }
    };
    const validateAcceptanceCriteria = (acceptanceCriteria, stepPath, stepStatus) => {
      if (!Array.isArray(acceptanceCriteria)) {
        addFailure(`${stepPath}.acceptance_criteria must be an array.`);
        return;
      }
      const normalizedValues = acceptanceCriteria.filter((entry) => isNonEmptyString(entry));
      if (normalizedValues.length !== acceptanceCriteria.length) {
        addFailure(`${stepPath}.acceptance_criteria must contain non-empty string values.`);
      }
      if (
        stepStatus &&
        stepStatusesRequiringAcceptanceCriteriaSet.has(stepStatus) &&
        normalizedValues.length < acceptanceCriteriaMinCount
      ) {
        addFailure(
          `${stepPath}.acceptance_criteria must include at least ${acceptanceCriteriaMinCount} non-empty entr${acceptanceCriteriaMinCount === 1 ? "y" : "ies"} when status is ${stepStatus}.`,
        );
      }
    };

    for (const fieldName of requiredNarrativeFields) {
      if (!(fieldName in narrative)) {
        addFailure(`${planMachineRef}.narrative is missing required field ${fieldName}.`);
        continue;
      }
      if (!isPlainObject(narrative[fieldName])) {
        addFailure(`${planMachineRef}.narrative.${fieldName} must be an object.`);
        continue;
      }

      const section = narrative[fieldName];
      if (typeof section.summary !== "string") {
        addFailure(`${planMachineRef}.narrative.${fieldName}.summary must be a string.`);
      }

      if (fieldName === "spec_outline") {
        const listValue = section[specOutlineListField];
        if (!Array.isArray(listValue)) {
          addFailure(
            `${planMachineRef}.narrative.${fieldName}.${specOutlineListField} must be an array.`,
          );
          continue;
        }
        validateStructuredNarrativeEntryList({
          listValue,
          listPath: `${planMachineRef}.narrative.${fieldName}.${specOutlineListField}`,
          requiredFields: normalizedSpecOutlineEntryRequiredFields,
        });
        continue;
      }

      if (fieldName === "refined_spec") {
        const listValue = section[refinedSpecListField];
        if (!Array.isArray(listValue)) {
          addFailure(
            `${planMachineRef}.narrative.${fieldName}.${refinedSpecListField} must be an array.`,
          );
          continue;
        }
        validateStructuredNarrativeEntryList({
          listValue,
          listPath: `${planMachineRef}.narrative.${fieldName}.${refinedSpecListField}`,
          requiredFields: normalizedRefinedSpecEntryRequiredFields,
        });
        continue;
      }

      const implementationSteps = section[implementationStepsField];
      if (!Array.isArray(implementationSteps)) {
        addFailure(
          `${planMachineRef}.narrative.${fieldName}.${implementationStepsField} must be an array.`,
        );
        continue;
      }

      for (const [stepIndex, step] of implementationSteps.entries()) {
        if (!isPlainObject(step)) {
          addFailure(
            `${planMachineRef}.narrative.${fieldName}.${implementationStepsField}[${stepIndex}] must be an object.`,
          );
          continue;
        }

        const stepPath = `${planMachineRef}.narrative.${fieldName}.${implementationStepsField}[${stepIndex}]`;
        const stepStatus = toNonEmptyString(step.status);
        implementationStepStatusSummary.hasAny = true;
        if (stepStatus === "in_progress") {
          implementationStepStatusSummary.hasInProgress = true;
        }
        if (stepStatus !== "complete") {
          implementationStepStatusSummary.allComplete = false;
        }

        for (const stepField of requiredStepFieldSet) {
          if (!(stepField in step)) {
            addFailure(`${stepPath}.${stepField} is required.`);
            continue;
          }
          if (stepField === "acceptance_criteria") {
            validateAcceptanceCriteria(step.acceptance_criteria, stepPath, stepStatus);
            continue;
          }
          if (stepField === "references") {
            if (!Array.isArray(step.references)) {
              addFailure(`${stepPath}.references must be an array.`);
              continue;
            }
            const invalidReference = step.references.find((entry) => !isNonEmptyString(entry));
            if (invalidReference !== undefined) {
              addFailure(`${stepPath}.references must contain non-empty string values.`);
            }
            if (step.references.length === 0) {
              addFailure(`${stepPath}.references must include at least one entry.`);
            }
            continue;
          }
          if (stepField === "completion_summary") {
            validateCompletionSummary(step.completion_summary, stepPath, stepStatus);
            continue;
          }
          if (!isNonEmptyString(step[stepField])) {
            addFailure(
              `${stepPath}.${stepField} must be a non-empty string.`,
            );
            continue;
          }
          if (
            stepField === "deliverable" &&
            matchesAnyRegexPattern(
              step[stepField],
              implementationStepDeliverableDenyPatternRegexes,
            )
          ) {
            addFailure(`${stepPath}.deliverable must not match placeholder deny patterns.`);
          }
        }

        if (requiredStepFieldSet.has("status") || "status" in step) {
          if (!stepStatus || !allowedNarrativeStepStatuses.includes(stepStatus)) {
            addFailure(
              `${stepPath}.status must be one of: ${allowedNarrativeStepStatuses.join(", ")}.`,
            );
          }
        }

        if ("references" in step && !requiredStepFieldSet.has("references")) {
          if (!Array.isArray(step.references)) {
            addFailure(`${stepPath}.references must be an array when present.`);
          } else {
            const invalidReference = step.references.find((entry) => !isNonEmptyString(entry));
            if (invalidReference !== undefined) {
              addFailure(`${stepPath}.references must contain non-empty string values.`);
            }
            if (step.references.length === 0) {
              addFailure(`${stepPath}.references must include at least one entry when present.`);
            }
          }
        }
        if ("completion_summary" in step && !requiredStepFieldSet.has("completion_summary")) {
          validateCompletionSummary(step.completion_summary, stepPath, stepStatus);
        }
        if ("acceptance_criteria" in step && !requiredStepFieldSet.has("acceptance_criteria")) {
          validateAcceptanceCriteria(step.acceptance_criteria, stepPath, stepStatus);
        }

        for (const optionalField of optionalStepFieldSet) {
          if (!(optionalField in step)) {
            continue;
          }
          if (optionalField === "acceptance_criteria") {
            validateAcceptanceCriteria(step.acceptance_criteria, stepPath, stepStatus);
            continue;
          }
          if (optionalField === "references") {
            if (!Array.isArray(step.references)) {
              addFailure(`${stepPath}.references must be an array when present.`);
            } else if (step.references.length === 0) {
              addFailure(`${stepPath}.references must include at least one entry when present.`);
            }
            continue;
          }
          if (optionalField === "completion_summary") {
            validateCompletionSummary(step.completion_summary, stepPath, stepStatus);
            continue;
          }
          if (!isNonEmptyString(step[optionalField])) {
            addFailure(
              `${stepPath}.${optionalField} must be a non-empty string when present.`,
            );
            continue;
          }
          if (
            optionalField === "deliverable" &&
            matchesAnyRegexPattern(
              step[optionalField],
              implementationStepDeliverableDenyPatternRegexes,
            )
          ) {
            addFailure(`${stepPath}.deliverable must not match placeholder deny patterns.`);
          }
        }

        if (
          !("acceptance_criteria" in step) &&
          stepStatus &&
          stepStatusesRequiringAcceptanceCriteriaSet.has(stepStatus)
        ) {
          addFailure(
            `${stepPath}.acceptance_criteria must include at least ${acceptanceCriteriaMinCount} non-empty entr${acceptanceCriteriaMinCount === 1 ? "y" : "ies"} when status is ${stepStatus}.`,
          );
        }
      }
    }

    const statusCoherenceContract = isPlainObject(statusCoherence) ? statusCoherence : {};
    if (
      statusCoherenceContract.requireInProgressPlanStatusWhenAnyStepInProgress === true &&
      implementationStepStatusSummary.hasInProgress &&
      status !== "in_progress"
    ) {
      addFailure(
        `${planMachineRef}.status must be in_progress when any implementation step is in_progress.`,
      );
    }
    const statusesRequiringAllComplete = normalizeStringArray(
      statusCoherenceContract.statusesRequiringAllImplementationStepsComplete,
    );
    if (
      statusesRequiringAllComplete.includes(status) &&
      implementationStepStatusSummary.hasAny &&
      !implementationStepStatusSummary.allComplete
    ) {
      addFailure(
        `${planMachineRef}.status ${status} requires all implementation steps to be complete.`,
      );
    }
    const statusesForbiddingInProgressSteps = normalizeStringArray(
      statusCoherenceContract.statusesForbiddingInProgressImplementationSteps,
    );
    if (
      statusesForbiddingInProgressSteps.includes(status) &&
      implementationStepStatusSummary.hasInProgress
    ) {
      addFailure(
        `${planMachineRef}.status ${status} forbids implementation steps with status in_progress.`,
      );
    }

    if (!("pre_spec_outline" in narrative)) {
      addFailure(`${planMachineRef}.narrative is missing required field pre_spec_outline.`);
    } else if (!isPlainObject(narrative.pre_spec_outline)) {
      addFailure(`${planMachineRef}.narrative.pre_spec_outline must be an object.`);
    } else {
      const preSpecOutline = narrative.pre_spec_outline;
      for (const fieldName of preSpecOutlineRequiredFields) {
        if (typeof preSpecOutline[fieldName] !== "string") {
          addFailure(
            `${planMachineRef}.narrative.pre_spec_outline.${fieldName} must be a string.`,
          );
        }
      }
    }
  }

  if (
    isPlainObject(narrative) &&
    normalizeStringArray(statusesRequiringNonEmptyPreSpecNonGoals).includes(status)
  ) {
    const nonGoalsValue =
      isPlainObject(narrative.pre_spec_outline) &&
      typeof narrative.pre_spec_outline.non_goals === "string"
        ? narrative.pre_spec_outline.non_goals.trim()
        : "";
    if (!nonGoalsValue) {
      addFailure(
        `${planMachineRef}.narrative.pre_spec_outline.non_goals must be non-empty when status is ${status}.`,
      );
    }
  }

  if (isPlainObject(narrative)) {
    const specOutlineListField = toNonEmptyString(specOutlineListFieldName) ?? "full_spec_outline";
    const refinedSpecListField = toNonEmptyString(refinedSpecListFieldName) ?? "full_refined_spec";
    const implementationStepsField =
      toNonEmptyString(implementationStepsFieldName) ?? "steps";
    const statusesRequiringSpecOutlineEntriesSet = new Set(
      normalizeStringArray(statusesRequiringSpecOutlineEntries),
    );
    const statusesRequiringRefinedSpecEntriesSet = new Set(
      normalizeStringArray(statusesRequiringRefinedSpecEntries),
    );
    const normalizedSpecOutlineMinEntries =
      Number.isInteger(specOutlineMinEntries) && specOutlineMinEntries >= 1
        ? specOutlineMinEntries
        : 1;
    const normalizedRefinedSpecMinEntries =
      Number.isInteger(refinedSpecMinEntries) && refinedSpecMinEntries >= 1
        ? refinedSpecMinEntries
        : 1;
    const countSectionEntries = (fieldName) => {
      const section = narrative[fieldName];
      if (!isPlainObject(section)) {
        return { count: 0, listFieldName: "steps" };
      }
      if (fieldName === "spec_outline") {
        return {
          count: Array.isArray(section[specOutlineListField]) ? section[specOutlineListField].length : 0,
          listFieldName: specOutlineListField,
        };
      }
      if (fieldName === "refined_spec") {
        return {
          count: Array.isArray(section[refinedSpecListField]) ? section[refinedSpecListField].length : 0,
          listFieldName: refinedSpecListField,
        };
      }
      return {
        count: Array.isArray(section[implementationStepsField])
          ? section[implementationStepsField].length
          : 0,
        listFieldName: implementationStepsField,
      };
    };

    if (statusesRequiringNarrativeContent.includes(status)) {
      for (const fieldName of requiredNarrativeFields) {
        const section = narrative[fieldName];
        const normalizedSummary =
          isPlainObject(section) && typeof section.summary === "string"
            ? section.summary.trim()
            : "";
        if (normalizedSummary.length < narrativeMinLength) {
          addFailure(
            `${planMachineRef}.narrative.${fieldName}.summary must be at least ${narrativeMinLength} characters when status is ${status}.`,
          );
        }

        const { count: stepCount, listFieldName } = countSectionEntries(fieldName);
        let minimumCount = narrativeMinSteps;
        if (fieldName === "spec_outline" && statusesRequiringSpecOutlineEntriesSet.has(status)) {
          minimumCount = Math.max(minimumCount, normalizedSpecOutlineMinEntries);
        }
        if (fieldName === "refined_spec" && statusesRequiringRefinedSpecEntriesSet.has(status)) {
          minimumCount = Math.max(minimumCount, normalizedRefinedSpecMinEntries);
        }
        if (stepCount < minimumCount) {
          addFailure(
            `${planMachineRef}.narrative.${fieldName}.${listFieldName} must contain at least ${minimumCount} item(s) when status is ${status}.`,
          );
        }
      }

      if (isPlainObject(narrative.pre_spec_outline)) {
        for (const fieldName of preSpecOutlineRequiredFields) {
          const value =
            typeof narrative.pre_spec_outline[fieldName] === "string"
              ? narrative.pre_spec_outline[fieldName].trim()
              : "";
          if (value.length < preSpecOutlineMinLength) {
            addFailure(
              `${planMachineRef}.narrative.pre_spec_outline.${fieldName} must be at least ${preSpecOutlineMinLength} characters when status is ${status}.`,
            );
          }
        }
      }
    } else {
      if (statusesRequiringSpecOutlineEntriesSet.has(status)) {
        const { count, listFieldName } = countSectionEntries("spec_outline");
        if (count < normalizedSpecOutlineMinEntries) {
          addFailure(
            `${planMachineRef}.narrative.spec_outline.${listFieldName} must contain at least ${normalizedSpecOutlineMinEntries} item(s) when status is ${status}.`,
          );
        }
      }
      if (statusesRequiringRefinedSpecEntriesSet.has(status)) {
        const { count, listFieldName } = countSectionEntries("refined_spec");
        if (count < normalizedRefinedSpecMinEntries) {
          addFailure(
            `${planMachineRef}.narrative.refined_spec.${listFieldName} must contain at least ${normalizedRefinedSpecMinEntries} item(s) when status is ${status}.`,
          );
        }
      }
    }
  }

  const subagent = planMachine.subagent;
  if (!isPlainObject(subagent)) {
    addFailure(`${planMachineRef}.subagent must be an object.`);
    return;
  }

  for (const fieldName of requiredSubagentFields) {
    if (!(fieldName in subagent)) {
      addFailure(`${planMachineRef}.subagent is missing required field ${fieldName}.`);
    }
  }

  const requirement = toNonEmptyString(subagent.requirement);
  if (!requirement || !allowedSubagentRequirements.includes(requirement)) {
    addFailure(
      `${planMachineRef}.subagent.requirement must be one of: ${allowedSubagentRequirements.join(", ")}.`,
    );
  }

  if (!(subagent.primary_agent === null || isNonEmptyString(subagent.primary_agent))) {
    addFailure(`${planMachineRef}.subagent.primary_agent must be null or a non-empty string.`);
  }

  if (!Array.isArray(subagent.execution_agents)) {
    addFailure(`${planMachineRef}.subagent.execution_agents must be an array.`);
  } else {
    const invalidAgent = subagent.execution_agents.find((entry) => !isNonEmptyString(entry));
    if (invalidAgent !== undefined) {
      addFailure(
        `${planMachineRef}.subagent.execution_agents must contain non-empty string values.`,
      );
    }
  }

  if (!(subagent.last_executor === null || isNonEmptyString(subagent.last_executor))) {
    addFailure(`${planMachineRef}.subagent.last_executor must be null or a non-empty string.`);
  }

  if (
    statusesRequiringLastExecutor.includes(status) &&
    !isNonEmptyString(subagent.last_executor)
  ) {
    addFailure(
      `${planMachineRef}.subagent.last_executor must be a non-empty string when status is ${status}.`,
    );
  }
}

function checkWorkspaceLayoutContract(config, runtimeRepoRoot, workspaceLayoutBaseRepoRoot) {
  const contractPath = "contracts.workspaceLayout";
  const contract = config?.contracts?.workspaceLayout;
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }

  const requiredStringFields = ["canonicalRepoRoot", "canonicalAgentsRoot", "worktreesRoot"];
  for (const fieldName of requiredStringFields) {
    const actualValue = toNonEmptyString(contract[fieldName]);
    if (!actualValue) {
      addFailure(`${contractPath}.${fieldName} must be a non-empty string.`);
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

  const canonicalRepoRootResolved = resolvePathFromBase(
    canonicalRepoRoot,
    workspaceLayoutBaseRepoRoot ?? runtimeRepoRoot,
  );
  const canonicalAgentsRootResolved = resolvePathFromBase(
    canonicalAgentsRoot,
    canonicalRepoRootResolved,
  );
  const worktreesRootResolved = resolvePathFromBase(worktreesRoot, canonicalRepoRootResolved);
  const runtimeRepoRootResolved = path.resolve(runtimeRepoRoot);
  const localAgentsPath = toNonEmptyString(contract.localAgentsPath) ?? ".agents";
  const normalizedLocalAgentsPath = localAgentsPath.replace(/\\/g, "/");
  const expectedWorktreesRootResolved = resolveCanonicalWorktreesRoot(canonicalRepoRootResolved);
  const ciMode = activeRunOptions.ci === true;

  if (worktreesRootResolved !== expectedWorktreesRootResolved) {
    addFailure(
      `${contractPath}.worktreesRoot must equal ${expectedWorktreesRootResolved}.`,
    );
  }

  const gitignoreContent = readFileIfPresent(".gitignore");
  if (gitignoreContent !== null) {
    for (const snippet of [
      normalizedLocalAgentsPath,
      `${normalizedLocalAgentsPath}/`,
      `${normalizedLocalAgentsPath}/**`,
    ]) {
      if (!gitignoreContent.includes(snippet)) {
        addFailure(`.gitignore must include ${snippet} for local-context hygiene.`);
      }
    }
  }

  if (ciMode) {
    addWarning(
      "CI mode enabled; skipping workspace symlink/worktree runtime checks for .agents state.",
    );
    return;
  }

  const inCanonicalRoot = runtimeRepoRootResolved === canonicalRepoRootResolved;
  const inConfiguredWorktreeRoot = isPathWithin(runtimeRepoRootResolved, worktreesRootResolved);
  if (!inCanonicalRoot && !inConfiguredWorktreeRoot) {
    addFailure(
      `Current repo root ${runtimeRepoRootResolved} must be canonical root ${canonicalRepoRootResolved} or inside ${worktreesRootResolved}.`,
    );
  }

  if (inConfiguredWorktreeRoot) {
    const worktreeAgentsPath = path.resolve(runtimeRepoRootResolved, localAgentsPath);
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
  if (inCanonicalRoot && contract.requireLocalAgentsSymlink === true) {
    const canonicalLocalAgentsPath = path.resolve(canonicalRepoRootResolved, localAgentsPath);
    if (canonicalAgentsRootResolved !== canonicalLocalAgentsPath) {
      if (!fs.existsSync(canonicalLocalAgentsPath)) {
        addFailure(
          `${canonicalLocalAgentsPath} must exist as a symlink to canonical agents root ${canonicalAgentsRootResolved}.`,
        );
      } else {
        const stats = fs.lstatSync(canonicalLocalAgentsPath);
        if (!stats.isSymbolicLink()) {
          addFailure(
            `${canonicalLocalAgentsPath} must be a symlink to canonical agents root ${canonicalAgentsRootResolved}.`,
          );
        } else {
          const targetResolved = path.resolve(fs.realpathSync(canonicalLocalAgentsPath));
          if (targetResolved !== canonicalAgentsRootResolved) {
            addFailure(
              `${canonicalLocalAgentsPath} must resolve to ${canonicalAgentsRootResolved} (found ${targetResolved}).`,
            );
          }
        }
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
      const agentsPath = path.resolve(worktreePath, localAgentsPath);
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
  if (!isContractEnabled(config, contract)) {
    return;
  }

  if (contract.indexFile !== ".agents-config/docs/CONTEXT_INDEX.json") {
    addFailure(
      `${contractPath}.indexFile must equal \".agents-config/docs/CONTEXT_INDEX.json\".`,
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
        ".agents-config/docs/AGENT_RULES.md",
      contextFile:
        toNonEmptyString(documentationModel.humanContextFile) ??
        ".agents-config/docs/AGENT_CONTEXT.md",
      canonicalRulesFile:
        toNonEmptyString(config?.contracts?.canonicalRules?.file) ??
        ".agents-config/contracts/rules/canonical-ruleset.json",
      policyFile:
        toNonEmptyString(documentationModel.machinePolicyFile) ??
        ".agents-config/policies/agent-governance.json",
      enforcerFile:
        toNonEmptyString(documentationModel.enforcementScript) ??
        ".agents-config/scripts/enforce-agent-policies.mjs",
      preflightFile:
        toNonEmptyString(documentationModel.sessionPreflightScript) ??
        ".agents-config/scripts/agent-session-preflight.mjs",
      managedManifestFile:
        toNonEmptyString(config?.contracts?.managedFilesCanonical?.manifestFile) ??
        ".agents-config/agent-managed.json",
      managedManifestTemplateFile:
        toNonEmptyString(config?.contracts?.managedFilesCanonical?.manifestTemplateFile) ??
        ".agents-config/tools/bootstrap/managed-files.template.json",
      projectToolingConfigFile: ".agents-config/config/project-tooling.json",
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

  const expectedStartupReadOrder = [
    toNonEmptyString(documentationModel.bootstrapFile) ?? "AGENTS.md",
    ".agents-config/docs/AGENT_RULES.md",
    ".agents-config/docs/CONTEXT_INDEX.json",
    ".agents-config/docs/AGENT_CONTEXT.md",
    ".agents/EXECUTION_QUEUE.json",
    ".agents/MEMORY.md",
  ];

  checkExactOrderedArray({
    value: contract.requiredStartupReadOrder,
    expected: expectedStartupReadOrder,
    pathName: `${contractPath}.requiredStartupReadOrder`,
  });

  checkExactOrderedArray({
    value: index.startupReadOrder,
    expected: contract.requiredStartupReadOrder ?? [],
    pathName: `${contract.indexFile}.startupReadOrder`,
  });

  if (!isPlainObject(contract.requiredCommandKeysByProfile)) {
    addFailure(`${contractPath}.requiredCommandKeysByProfile must be an object.`);
  }

  const { requiredValues: requiredCommandKeys } = resolveProfileScopedRequiredStrings(
    {
      config,
      baseValues: contract.requiredCommandKeys,
      baseFieldPath: `${contractPath}.requiredCommandKeys`,
      byProfileValues: contract.requiredCommandKeysByProfile,
      byProfileFieldPath: `${contractPath}.requiredCommandKeysByProfile`,
    },
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

  if (!isPlainObject(index.profiles)) {
    addFailure(`${contract.indexFile}.profiles must be an object.`);
  } else {
    const profilesContract = config?.contracts?.profiles;
    const expectedAvailableProfiles = normalizeStringArray(
      profilesContract?.availableProfiles,
    );
    if (expectedAvailableProfiles.length > 0) {
      checkExactOrderedArray({
        value: index.profiles.availableProfiles,
        expected: expectedAvailableProfiles,
        pathName: `${contract.indexFile}.profiles.availableProfiles`,
      });
    }

    const expectedActiveProfiles = normalizeStringArray(
      profilesContract?.activeProfiles,
    );
    if (expectedActiveProfiles.length > 0) {
      checkExactOrderedArray({
        value: index.profiles.activeProfiles,
        expected: expectedActiveProfiles,
        pathName: `${contract.indexFile}.profiles.activeProfiles`,
      });
    }

    // Profile-scoped required rule IDs/command keys are policy-only contracts.

    const disallowedProfileContractKeys = [
      "requiredRuleIdsByProfile",
      "requiredCommandKeysByProfile",
    ];
    for (const key of disallowedProfileContractKeys) {
      if (key in index.profiles) {
        addFailure(
          `${contract.indexFile}.profiles.${key} must not be present; keep profile requirement maps in contracts.ruleCatalog/contracts.contextIndex of policy.`,
        );
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
      memoryFile:
        toNonEmptyString(sessionArtifactsContract.memoryFile) ??
        ".agents/MEMORY.md",
      memoryTopicsRoot:
        toNonEmptyString(sessionArtifactsContract.memoryTopicsRoot) ??
        ".agents/memory",
      sessionLogFile:
        toNonEmptyString(sessionArtifactsContract.sessionLogFile) ??
        ".agents/SESSION_LOG.md",
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

    checkExactOrderedArray({
      value: index.sessionArtifacts.planRoots,
      expected: normalizeStringArray(sessionArtifactsContract.planRoots),
      pathName: `${contract.indexFile}.sessionArtifacts.planRoots`,
    });

    if (
      toNonEmptyString(index.sessionArtifacts.policyContractPath) !==
      "contracts.sessionArtifacts"
    ) {
      addFailure(
        `${contract.indexFile}.sessionArtifacts.policyContractPath must equal "contracts.sessionArtifacts".`,
      );
    }

    const disallowedSessionArtifactKeys = [
      "queueScopedRead",
      "archiveOnComplete",
      "planQueueSync",
      "planMachineContract",
      "archivedPlanSync",
      "stalePlanReferenceCheck",
      "queueQualityGate",
      "workspaceLayout",
      "sessionBriefContract",
    ];
    for (const key of disallowedSessionArtifactKeys) {
      if (key in index.sessionArtifacts) {
        addFailure(
          `${contract.indexFile}.sessionArtifacts.${key} must not be present; keep deep machine contracts in policy only.`,
        );
      }
    }
  }

  if ("orchestratorSubagent" in index) {
    addFailure(
      `${contract.indexFile}.orchestratorSubagent must not be present; use contracts.orchestratorSubagent in policy as canonical source.`,
    );
  }

  if ("managedFilesCanonical" in index) {
    addFailure(
      `${contract.indexFile}.managedFilesCanonical must not be present; use contracts.managedFilesCanonical in policy as canonical source.`,
    );
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
    templateFile: ".agents-config/docs/RELEASE_NOTES_TEMPLATE.md",
    generatorScript: ".agents-config/scripts/generate-release-notes.mjs",
    prepareScript: ".agents-config/scripts/release-version-sync.mjs",
    prepareNpmScriptName: "release:prepare",
    prepareNpmScriptCommand: "node .agents-config/scripts/release-version-sync.mjs --write",
    prepareCommandExample: "npm run release:prepare -- --version <X.Y.Z>",
    npmScriptName: "release:notes",
    npmScriptCommand: "node .agents-config/scripts/generate-release-notes.mjs",
    commandExample:
      "npm run release:notes -- --version <X.Y.Z> --from <tag> [--to <ref>] [--output <path>] [--summary <text>] [--known-issue <text>] [--compat-note <text>]",
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
  for (const fieldName of [
    "helmRepoName",
    "helmRepoUrl",
    "helmChartName",
    "helmChartReference",
  ]) {
    const actualValue = toNonEmptyString(contract[fieldName]);
    if (!actualValue) {
      addFailure(`${contractPath}.${fieldName} must be a non-empty string.`);
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

    const helmReleaseName =
      toNonEmptyString(contract.helmReleaseName) ?? toNonEmptyString(contract.helmChartName);
    const requiredTemplateSnippets = [
      `Helm chart repository: \`${contract.helmRepoUrl}\``,
      `Helm chart name: \`${contract.helmChartName}\``,
      `Helm chart reference: \`${contract.helmChartReference}\``,
      `helm repo add ${contract.helmRepoName} ${contract.helmRepoUrl}`,
      `helm upgrade --install ${helmReleaseName ?? "<release-name>"} ${contract.helmChartReference} --version {{VERSION}}`,
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

  const contextIndex = readJsonIfPresent(".agents-config/docs/CONTEXT_INDEX.json");
  if (contextIndex && typeof contextIndex === "object") {
    const commandExample = toNonEmptyString(contract.commandExample);
    const prepareCommandExample = toNonEmptyString(contract.prepareCommandExample);
    const commands =
      contextIndex.commands && typeof contextIndex.commands === "object"
        ? contextIndex.commands
        : null;

    if (!commands) {
      addFailure(".agents-config/docs/CONTEXT_INDEX.json commands block is required.");
    } else if (commandExample) {
      const releaseNotesCommand = toNonEmptyString(commands.releaseNotes);
      if (!releaseNotesCommand) {
        addFailure(".agents-config/docs/CONTEXT_INDEX.json.commands.releaseNotes must be present.");
      } else if (releaseNotesCommand !== commandExample) {
        addFailure(
          `.agents-config/docs/CONTEXT_INDEX.json.commands.releaseNotes must equal contracts.releaseNotes.commandExample.`,
        );
      }
    }

    if (prepareCommandExample) {
      const releasePrepareCommand = toNonEmptyString(commands?.releasePrepare);
      if (!releasePrepareCommand) {
        addFailure(".agents-config/docs/CONTEXT_INDEX.json.commands.releasePrepare must be present.");
      } else if (releasePrepareCommand !== prepareCommandExample) {
        addFailure(
          ".agents-config/docs/CONTEXT_INDEX.json.commands.releasePrepare must equal contracts.releaseNotes.prepareCommandExample.",
        );
      }
    }
  }
}

function checkFeatureIndexContract(config) {
  const contractPath = "contracts.featureIndex";
  const contract = config?.contracts?.featureIndex;
  if (!isContractEnabled(config, contract)) {
    return;
  }
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }

  const featureIndexFile = toNonEmptyString(contract.file);
  if (!featureIndexFile) {
    addFailure(`${contractPath}.file must be a non-empty string.`);
    return;
  }

  const featureIndexVerifyScript = ".agents-config/tools/docs/feature-index-check.mjs";
  const featureIndexVerifyCommand = "node .agents-config/tools/docs/feature-index-check.mjs --strict";
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
  if (!isContractEnabled(config, contract)) {
    return;
  }
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
  if (!isContractEnabled(config, contract)) {
    return;
  }
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }

  const requiredStrings = {
    file: ".agents-config/docs/JSDOC_COVERAGE.md",
    generatorScript: ".agents-config/tools/docs/generate-jsdoc-coverage.mjs",
    npmGenerateScriptName: "jsdoc-coverage:generate",
    npmGenerateScriptCommand: "node .agents-config/tools/docs/generate-jsdoc-coverage.mjs --write",
    npmVerifyScriptName: "jsdoc-coverage:verify",
    npmVerifyScriptCommand: "node .agents-config/tools/docs/generate-jsdoc-coverage.mjs --check",
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

  if (
    !Number.isFinite(contract.minimumTotalCoveragePercent) ||
    Number(contract.minimumTotalCoveragePercent) < 0 ||
    Number(contract.minimumTotalCoveragePercent) > 100
  ) {
    addFailure(
      `${contractPath}.minimumTotalCoveragePercent must be a number between 0 and 100.`,
    );
  }
  if (
    !Number.isInteger(contract.maximumMissingExportedSymbols) ||
    contract.maximumMissingExportedSymbols < 0
  ) {
    addFailure(
      `${contractPath}.maximumMissingExportedSymbols must be an integer greater than or equal to 0.`,
    );
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

    const totalRowMatch = jsdocContent.match(
      /^\|\s*\*\*Total\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|\s*\*\*([0-9]+(?:\.[0-9]+)?)%\*\*\s*\|/m,
    );
    if (!totalRowMatch) {
      addFailure(
        `${jsdocCoverageFile} must include a parseable **Total** summary row in the Coverage Summary table.`,
      );
    } else {
      const missingExportedSymbols = Number.parseInt(totalRowMatch[4], 10);
      const totalCoveragePercent = Number.parseFloat(totalRowMatch[5]);
      const minimumTotalCoveragePercent = Number.isFinite(
        contract.minimumTotalCoveragePercent,
      )
        ? Number(contract.minimumTotalCoveragePercent)
        : null;
      const maximumMissingExportedSymbols = Number.isInteger(
        contract.maximumMissingExportedSymbols,
      )
        ? Number(contract.maximumMissingExportedSymbols)
        : null;

      if (
        minimumTotalCoveragePercent !== null &&
        totalCoveragePercent < minimumTotalCoveragePercent
      ) {
        addFailure(
          `${jsdocCoverageFile} total coverage ${totalCoveragePercent}% is below minimum ${minimumTotalCoveragePercent}%.`,
        );
      }
      if (
        maximumMissingExportedSymbols !== null &&
        missingExportedSymbols > maximumMissingExportedSymbols
      ) {
        addFailure(
          `${jsdocCoverageFile} missing exported symbols ${missingExportedSymbols} exceeds maximum ${maximumMissingExportedSymbols}.`,
        );
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

  const contextIndex = readJsonIfPresent(".agents-config/docs/CONTEXT_INDEX.json");
  if (contextIndex && typeof contextIndex === "object") {
    const commands =
      contextIndex.commands && typeof contextIndex.commands === "object"
        ? contextIndex.commands
        : null;
    if (!commands) {
      addFailure(".agents-config/docs/CONTEXT_INDEX.json commands block is required.");
      return;
    }

    const generateCommand = toNonEmptyString(commands.jsdocCoverageGenerate);
    if (generateCommand !== "npm run jsdoc-coverage:generate") {
      addFailure(
        '.agents-config/docs/CONTEXT_INDEX.json.commands.jsdocCoverageGenerate must equal "npm run jsdoc-coverage:generate".',
      );
    }

    const verifyCommand = toNonEmptyString(commands.jsdocCoverageVerify);
    if (verifyCommand !== "npm run jsdoc-coverage:verify") {
      addFailure(
        '.agents-config/docs/CONTEXT_INDEX.json.commands.jsdocCoverageVerify must equal "npm run jsdoc-coverage:verify".',
      );
    }

    const jsdocCoverageFileCommand = toNonEmptyString(commands.jsdocCoverageFile);
    if (jsdocCoverageFileCommand !== "cat .agents-config/docs/JSDOC_COVERAGE.md") {
      addFailure(
        '.agents-config/docs/CONTEXT_INDEX.json.commands.jsdocCoverageFile must equal "cat .agents-config/docs/JSDOC_COVERAGE.md".',
      );
    }
  }
}

function checkOpenAPICoverageContract(config) {
  const contractPath = "contracts.openapiCoverage";
  const contract = config?.contracts?.openapiCoverage;
  if (!isContractEnabled(config, contract)) {
    return;
  }
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }

  const requiredStrings = {
    file: ".agents-config/docs/OPENAPI_COVERAGE.md",
    generatorScript: ".agents-config/tools/docs/generate-openapi-coverage.mjs",
    npmGenerateScriptName: "openapi-coverage:generate",
    npmGenerateScriptCommand:
      "node .agents-config/tools/docs/generate-openapi-coverage.mjs --write",
    npmVerifyScriptName: "openapi-coverage:verify",
    npmVerifyScriptCommand:
      "node .agents-config/tools/docs/generate-openapi-coverage.mjs --check",
    contextIndexGenerateCommandKey: "openapiCoverageGenerate",
    contextIndexVerifyCommandKey: "openapiCoverageVerify",
    contextIndexCoverageFileCommandKey: "openapiCoverageFile",
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

  if (
    !Number.isFinite(contract.minimumTotalCoveragePercent) ||
    Number(contract.minimumTotalCoveragePercent) < 0 ||
    Number(contract.minimumTotalCoveragePercent) > 100
  ) {
    addFailure(
      `${contractPath}.minimumTotalCoveragePercent must be a number between 0 and 100.`,
    );
  }
  if (!Number.isInteger(contract.maximumMissingEndpoints) || contract.maximumMissingEndpoints < 0) {
    addFailure(
      `${contractPath}.maximumMissingEndpoints must be an integer greater than or equal to 0.`,
    );
  }
  if (
    !Number.isInteger(contract.maximumUndocumentableEndpoints) ||
    contract.maximumUndocumentableEndpoints < 0
  ) {
    addFailure(
      `${contractPath}.maximumUndocumentableEndpoints must be an integer greater than or equal to 0.`,
    );
  }

  const openapiCoverageFile = toNonEmptyString(contract.file);
  const openapiContent = openapiCoverageFile ? readFileIfPresent(openapiCoverageFile) : null;
  if (openapiContent !== null) {
    const requiredSections = validateStringArray(
      contract.requiredSections,
      `${contractPath}.requiredSections`,
    );
    let cursor = 0;
    for (const section of requiredSections) {
      const index = openapiContent.indexOf(section, cursor);
      if (index === -1) {
        if (openapiContent.includes(section)) {
          addFailure(
            `${openapiCoverageFile} contains section out of order relative to ${contractPath}.requiredSections: ${section}`,
          );
        } else {
          addFailure(`${openapiCoverageFile} is missing required section: ${section}`);
        }
        continue;
      }
      cursor = index + section.length;
    }

    const normalizeCellValue = (value) => value.replace(/\*\*/g, "").replace(/`/g, "").trim();
    const parseTableCells = (line) => {
      const trimmedLine = line.trim();
      if (!trimmedLine.startsWith("|")) {
        return [];
      }
      return trimmedLine
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
    };
    const extractSectionBody = (content, heading) => {
      const headingIndex = content.indexOf(heading);
      if (headingIndex === -1) {
        return null;
      }
      const afterHeading = content.slice(headingIndex + heading.length);
      const nextHeadingIndex = afterHeading.search(/\n##\s+/);
      if (nextHeadingIndex === -1) {
        return afterHeading;
      }
      return afterHeading.slice(0, nextHeadingIndex);
    };
    const parseIntegerCell = (cellValue) => {
      const normalized = normalizeCellValue(cellValue).replace(/,/g, "");
      if (!/^\d+$/.test(normalized)) {
        return null;
      }
      return Number.parseInt(normalized, 10);
    };
    const parsePercentCell = (cellValue) => {
      const normalized = normalizeCellValue(cellValue).replace("%", "").replace(/,/g, "");
      if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
        return null;
      }
      return Number.parseFloat(normalized);
    };

    const coverageSummarySection = extractSectionBody(openapiContent, "## Coverage Summary");
    if (!coverageSummarySection) {
      addFailure(
        `${openapiCoverageFile} must include a Coverage Summary section to parse total metrics.`,
      );
    } else {
      const lines = coverageSummarySection.split(/\r?\n/);
      let headerCells = null;
      let totalRowCells = null;

      for (const line of lines) {
        const cells = parseTableCells(line);
        if (cells.length === 0) {
          continue;
        }
        const isSeparatorRow = cells.every((cell) =>
          /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")),
        );
        if (isSeparatorRow) {
          continue;
        }
        if (!headerCells) {
          headerCells = cells;
          continue;
        }
        const rowLabel = normalizeCellValue(cells[0]).toLowerCase();
        if (rowLabel === "total") {
          totalRowCells = cells;
          break;
        }
      }

      if (!headerCells || !totalRowCells) {
        addFailure(
          `${openapiCoverageFile} must include a parseable **Total** summary row in the Coverage Summary table.`,
        );
      } else {
        const normalizedHeaders = headerCells.map((cell) =>
          normalizeCellValue(cell).toLowerCase(),
        );
        const coverageColumnIndex = normalizedHeaders.findIndex((header) =>
          header.includes("coverage"),
        );
        const missingColumnIndex = normalizedHeaders.findIndex((header) =>
          header.includes("missing"),
        );
        const undocumentableColumnIndex = normalizedHeaders.findIndex((header) =>
          header.includes("undocumentable"),
        );

        const hasRequiredColumns =
          coverageColumnIndex !== -1 &&
          missingColumnIndex !== -1 &&
          undocumentableColumnIndex !== -1;
        const indexesWithinBounds =
          hasRequiredColumns &&
          coverageColumnIndex < totalRowCells.length &&
          missingColumnIndex < totalRowCells.length &&
          undocumentableColumnIndex < totalRowCells.length;

        if (!hasRequiredColumns || !indexesWithinBounds) {
          addFailure(
            `${openapiCoverageFile} Coverage Summary table must include coverage, missing, and undocumentable columns with values in the **Total** row.`,
          );
        } else {
          const totalCoveragePercent = parsePercentCell(totalRowCells[coverageColumnIndex]);
          const missingEndpoints = parseIntegerCell(totalRowCells[missingColumnIndex]);
          const undocumentableEndpoints = parseIntegerCell(
            totalRowCells[undocumentableColumnIndex],
          );

          if (
            !Number.isFinite(totalCoveragePercent) ||
            missingEndpoints === null ||
            undocumentableEndpoints === null
          ) {
            addFailure(
              `${openapiCoverageFile} must include parseable coverage/missing/undocumentable metrics in the **Total** row.`,
            );
          } else {
            const minimumTotalCoveragePercent = Number.isFinite(
              contract.minimumTotalCoveragePercent,
            )
              ? Number(contract.minimumTotalCoveragePercent)
              : null;
            const maximumMissingEndpoints = Number.isInteger(contract.maximumMissingEndpoints)
              ? Number(contract.maximumMissingEndpoints)
              : null;
            const maximumUndocumentableEndpoints = Number.isInteger(
              contract.maximumUndocumentableEndpoints,
            )
              ? Number(contract.maximumUndocumentableEndpoints)
              : null;

            if (
              minimumTotalCoveragePercent !== null &&
              totalCoveragePercent < minimumTotalCoveragePercent
            ) {
              addFailure(
                `${openapiCoverageFile} total coverage ${totalCoveragePercent}% is below minimum ${minimumTotalCoveragePercent}%.`,
              );
            }
            if (maximumMissingEndpoints !== null && missingEndpoints > maximumMissingEndpoints) {
              addFailure(
                `${openapiCoverageFile} missing endpoints ${missingEndpoints} exceeds maximum ${maximumMissingEndpoints}.`,
              );
            }
            if (
              maximumUndocumentableEndpoints !== null &&
              undocumentableEndpoints > maximumUndocumentableEndpoints
            ) {
              addFailure(
                `${openapiCoverageFile} undocumentable endpoints ${undocumentableEndpoints} exceeds maximum ${maximumUndocumentableEndpoints}.`,
              );
            }
          }
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
        `${contractPath} generator check failed. Run npm run openapi-coverage:generate. Details: ${details}`,
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
    addFailure("package.json scripts block is required for openapi-coverage wiring.");
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

  const contextIndex = readJsonIfPresent(".agents-config/docs/CONTEXT_INDEX.json");
  if (contextIndex && typeof contextIndex === "object") {
    const commands =
      contextIndex.commands && typeof contextIndex.commands === "object"
        ? contextIndex.commands
        : null;
    if (!commands) {
      addFailure(".agents-config/docs/CONTEXT_INDEX.json commands block is required.");
      return;
    }

    const generateCommandKey = toNonEmptyString(contract.contextIndexGenerateCommandKey);
    const verifyCommandKey = toNonEmptyString(contract.contextIndexVerifyCommandKey);
    const coverageFileCommandKey = toNonEmptyString(contract.contextIndexCoverageFileCommandKey);

    if (generateCommandKey) {
      const generateCommand = toNonEmptyString(commands[generateCommandKey]);
      if (generateCommand !== "npm run openapi-coverage:generate") {
        addFailure(
          `.agents-config/docs/CONTEXT_INDEX.json.commands.${generateCommandKey} must equal "npm run openapi-coverage:generate".`,
        );
      }
    }

    if (verifyCommandKey) {
      const verifyCommand = toNonEmptyString(commands[verifyCommandKey]);
      if (verifyCommand !== "npm run openapi-coverage:verify") {
        addFailure(
          `.agents-config/docs/CONTEXT_INDEX.json.commands.${verifyCommandKey} must equal "npm run openapi-coverage:verify".`,
        );
      }
    }

    if (coverageFileCommandKey) {
      const coverageFileCommand = toNonEmptyString(commands[coverageFileCommandKey]);
      if (coverageFileCommand !== "cat .agents-config/docs/OPENAPI_COVERAGE.md") {
        addFailure(
          `.agents-config/docs/CONTEXT_INDEX.json.commands.${coverageFileCommandKey} must equal "cat .agents-config/docs/OPENAPI_COVERAGE.md".`,
        );
      }
    }
  }
}

function checkLoggingStandardsContract(config) {
  const contractPath = "contracts.loggingStandards";
  const contract = config?.contracts?.loggingStandards;
  if (!isContractEnabled(config, contract)) {
    return;
  }
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }

  const requiredStrings = {
    standardsFile: ".agents-config/docs/LOGGING_STANDARDS.md",
    verifyScript: ".agents-config/scripts/verify-logging-compliance.mjs",
    baselineFile: ".agents-config/policies/logging-compliance-baseline.json",
    npmGenerateScriptName: "logging:compliance:generate",
    npmGenerateScriptCommand:
      "node .agents-config/scripts/verify-logging-compliance.mjs --write-baseline",
    npmVerifyScriptName: "logging:compliance:verify",
    npmVerifyScriptCommand:
      "node .agents-config/scripts/verify-logging-compliance.mjs --check",
    contextIndexGenerateCommandKey: "loggingComplianceGenerate",
    contextIndexVerifyCommandKey: "loggingComplianceVerify",
    contextIndexStandardsFileCommandKey: "loggingStandardsFile",
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

  const standardsFile = toNonEmptyString(contract.standardsFile);
  const standardsContent = standardsFile ? readFileIfPresent(standardsFile) : null;
  if (standardsContent !== null) {
    const requiredSections = validateStringArray(
      contract.requiredSections,
      `${contractPath}.requiredSections`,
    );
    let cursor = 0;
    for (const section of requiredSections) {
      const index = standardsContent.indexOf(section, cursor);
      if (index === -1) {
        if (standardsContent.includes(section)) {
          addFailure(
            `${standardsFile} contains section out of order relative to ${contractPath}.requiredSections: ${section}`,
          );
        } else {
          addFailure(`${standardsFile} is missing required section: ${section}`);
        }
        continue;
      }
      cursor = index + section.length;
    }

    const requiredSnippets = validateStringArray(
      contract.requiredSnippets,
      `${contractPath}.requiredSnippets`,
    );
    for (const snippet of requiredSnippets) {
      if (!standardsContent.includes(snippet)) {
        addFailure(
          `${standardsFile} is missing required snippet from ${contractPath}.requiredSnippets: ${snippet}`,
        );
      }
    }
  }

  const verifyScript = toNonEmptyString(contract.verifyScript);
  const baselineFile = toNonEmptyString(contract.baselineFile);
  if (verifyScript) {
    readFileIfPresent(verifyScript);
  }
  if (baselineFile) {
    readFileIfPresent(baselineFile);
  }

  if (verifyScript) {
    const verifyResult = runCommandSafe("node", [verifyScript, "--check"]);
    if (!verifyResult.ok) {
      const details = verifyResult.stderr || verifyResult.stdout || "unknown failure";
      addFailure(
        `${contractPath} check failed. Run npm run logging:compliance:generate and review raw logging drift. Details: ${details}`,
      );
    }
  }

  const packageJson = readJsonIfPresent("package.json");
  if (packageJson && typeof packageJson === "object") {
    const scripts =
      packageJson.scripts && typeof packageJson.scripts === "object"
        ? packageJson.scripts
        : null;
    if (!scripts) {
      addFailure("package.json scripts block is required for logging compliance wiring.");
    } else {
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
  }

  const contextIndex = readJsonIfPresent(".agents-config/docs/CONTEXT_INDEX.json");
  if (contextIndex && typeof contextIndex === "object") {
    const commands =
      contextIndex.commands && typeof contextIndex.commands === "object"
        ? contextIndex.commands
        : null;
    if (!commands) {
      addFailure(".agents-config/docs/CONTEXT_INDEX.json commands block is required.");
      return;
    }

    const generateCommandKey = toNonEmptyString(contract.contextIndexGenerateCommandKey);
    const verifyCommandKey = toNonEmptyString(contract.contextIndexVerifyCommandKey);
    const standardsFileCommandKey = toNonEmptyString(
      contract.contextIndexStandardsFileCommandKey,
    );

    if (generateCommandKey) {
      const generateCommand = toNonEmptyString(commands[generateCommandKey]);
      if (generateCommand !== "npm run logging:compliance:generate") {
        addFailure(
          `.agents-config/docs/CONTEXT_INDEX.json.commands.${generateCommandKey} must equal "npm run logging:compliance:generate".`,
        );
      }
    }

    if (verifyCommandKey) {
      const verifyCommand = toNonEmptyString(commands[verifyCommandKey]);
      if (verifyCommand !== "npm run logging:compliance:verify") {
        addFailure(
          `.agents-config/docs/CONTEXT_INDEX.json.commands.${verifyCommandKey} must equal "npm run logging:compliance:verify".`,
        );
      }
    }

    if (standardsFileCommandKey) {
      const standardsFileCommand = toNonEmptyString(commands[standardsFileCommandKey]);
      if (standardsFileCommand !== "cat .agents-config/docs/LOGGING_STANDARDS.md") {
        addFailure(
          `.agents-config/docs/CONTEXT_INDEX.json.commands.${standardsFileCommandKey} must equal "cat .agents-config/docs/LOGGING_STANDARDS.md".`,
        );
      }
    }
  }
}

function checkRouteMapContract(config) {
  const contractPath = "contracts.routeMap";
  const contract = config?.contracts?.routeMap;
  if (!isContractEnabled(config, contract)) {
    return;
  }
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }

  const requiredStrings = {
    file: ".agents-config/docs/ROUTE_MAP.md",
    generatorScript: ".agents-config/tools/docs/generate-route-map.mjs",
    npmGenerateScriptName: "route-map:generate",
    npmGenerateScriptCommand: "node .agents-config/tools/docs/generate-route-map.mjs --write",
    npmVerifyScriptName: "route-map:verify",
    npmVerifyScriptCommand: "node .agents-config/tools/docs/generate-route-map.mjs --check",
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
  if (!isContractEnabled(config, contract)) {
    return;
  }
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }

  const requiredStrings = {
    generatorScript: ".agents-config/tools/docs/generate-domain-readmes.mjs",
    npmGenerateScriptName: "domain-readmes:generate",
    npmGenerateScriptCommand: "node .agents-config/tools/docs/generate-domain-readmes.mjs --write",
    npmVerifyScriptName: "domain-readmes:verify",
    npmVerifyScriptCommand: "node .agents-config/tools/docs/generate-domain-readmes.mjs --check",
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

  const resolveContractPath = (targetPath) =>
    agentsAwareReadResolver(toNonEmptyString(targetPath) ?? String(targetPath ?? ""));

  const requiredStrings = {
    executionQueueFile: ".agents/EXECUTION_QUEUE.json",
    sessionBriefJsonFile: ".agents/SESSION_BRIEF.json",
    memoryFile: ".agents/MEMORY.md",
    memoryTopicsRoot: ".agents/memory",
    sessionLogFile: ".agents/SESSION_LOG.md",
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
  } else if (contract.planQueueSyncPlanFileName !== "PLAN.json") {
    addFailure(`${contractPath}.planQueueSyncPlanFileName must equal "PLAN.json".`);
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

  if (typeof contract.planMachineContractEnabled !== "boolean") {
    addFailure(`${contractPath}.planMachineContractEnabled must be a boolean.`);
  }

  if (!isNonEmptyString(contract.planMachineFileName)) {
    addFailure(`${contractPath}.planMachineFileName must be a non-empty string.`);
  } else if (contract.planMachineFileName !== "PLAN.json") {
    addFailure(`${contractPath}.planMachineFileName must equal "PLAN.json".`);
  }

  if (!isNonEmptyString(contract.planMachineSchemaVersion)) {
    addFailure(`${contractPath}.planMachineSchemaVersion must be a non-empty string.`);
  }

  const planMachineRoots = validateStringArray(
    contract.planMachineRoots,
    `${contractPath}.planMachineRoots`,
  );
  checkRequiredFieldList({
    fieldName: "planMachineRoots",
    actualFields: contract.planMachineRoots,
    requiredFields: [
      ".agents/plans/current",
      ".agents/plans/deferred",
      ".agents/plans/archived",
    ],
    contractPath,
  });

  const planMachineRequiredTopLevelFields = validateStringArray(
    contract.planMachineRequiredTopLevelFields,
    `${contractPath}.planMachineRequiredTopLevelFields`,
  );
  const planMachineRequiredPlanningStages = validateStringArray(
    contract.planMachineRequiredPlanningStages,
    `${contractPath}.planMachineRequiredPlanningStages`,
  );
  const planMachineRequiredNarrativeFields = validateStringArray(
    contract.planMachineRequiredNarrativeFields,
    `${contractPath}.planMachineRequiredNarrativeFields`,
  );
  const planMachinePreSpecOutlineRequiredFields = validateStringArray(
    contract.planMachinePreSpecOutlineRequiredFields,
    `${contractPath}.planMachinePreSpecOutlineRequiredFields`,
  );
  const planMachineStatusesRequiringNonEmptyPreSpecNonGoals = validateStringArray(
    contract.planMachineStatusesRequiringNonEmptyPreSpecNonGoals,
    `${contractPath}.planMachineStatusesRequiringNonEmptyPreSpecNonGoals`,
  );
  const planMachineStatusesRequiringNarrativeContent = validateStringArray(
    contract.planMachineStatusesRequiringNarrativeContent,
    `${contractPath}.planMachineStatusesRequiringNarrativeContent`,
  );
  const planMachineNarrativeMinLength =
    Number.isInteger(contract.planMachineNarrativeMinLength) &&
    contract.planMachineNarrativeMinLength >= 1
      ? contract.planMachineNarrativeMinLength
      : null;
  if (planMachineNarrativeMinLength === null) {
    addFailure(`${contractPath}.planMachineNarrativeMinLength must be an integer >= 1.`);
  }
  const planMachinePreSpecOutlineMinLength =
    Number.isInteger(contract.planMachinePreSpecOutlineMinLength) &&
    contract.planMachinePreSpecOutlineMinLength >= 1
      ? contract.planMachinePreSpecOutlineMinLength
      : null;
  if (planMachinePreSpecOutlineMinLength === null) {
    addFailure(`${contractPath}.planMachinePreSpecOutlineMinLength must be an integer >= 1.`);
  }
  const planMachineNarrativeMinSteps =
    Number.isInteger(contract.planMachineNarrativeMinSteps) &&
    contract.planMachineNarrativeMinSteps >= 0
      ? contract.planMachineNarrativeMinSteps
      : null;
  if (planMachineNarrativeMinSteps === null) {
    addFailure(`${contractPath}.planMachineNarrativeMinSteps must be an integer >= 0.`);
  }
  const planMachineSpecOutlineListFieldName = toNonEmptyString(
    contract.planMachineSpecOutlineListFieldName,
  );
  if (!planMachineSpecOutlineListFieldName) {
    addFailure(`${contractPath}.planMachineSpecOutlineListFieldName must be a non-empty string.`);
  } else if (planMachineSpecOutlineListFieldName !== "full_spec_outline") {
    addFailure(
      `${contractPath}.planMachineSpecOutlineListFieldName must equal "full_spec_outline".`,
    );
  }
  const planMachineRefinedSpecListFieldName = toNonEmptyString(
    contract.planMachineRefinedSpecListFieldName,
  );
  if (!planMachineRefinedSpecListFieldName) {
    addFailure(`${contractPath}.planMachineRefinedSpecListFieldName must be a non-empty string.`);
  } else if (planMachineRefinedSpecListFieldName !== "full_refined_spec") {
    addFailure(
      `${contractPath}.planMachineRefinedSpecListFieldName must equal "full_refined_spec".`,
    );
  }
  const planMachineSpecOutlineEntryRequiredFields = validateStringArray(
    contract.planMachineSpecOutlineEntryRequiredFields,
    `${contractPath}.planMachineSpecOutlineEntryRequiredFields`,
  );
  const planMachineRefinedSpecEntryRequiredFields = validateStringArray(
    contract.planMachineRefinedSpecEntryRequiredFields,
    `${contractPath}.planMachineRefinedSpecEntryRequiredFields`,
  );
  const planMachineStatusesRequiringSpecOutlineEntries = validateStringArray(
    contract.planMachineStatusesRequiringSpecOutlineEntries,
    `${contractPath}.planMachineStatusesRequiringSpecOutlineEntries`,
  );
  const planMachineStatusesRequiringRefinedSpecEntries = validateStringArray(
    contract.planMachineStatusesRequiringRefinedSpecEntries,
    `${contractPath}.planMachineStatusesRequiringRefinedSpecEntries`,
  );
  const planMachineSpecOutlineMinEntries =
    Number.isInteger(contract.planMachineSpecOutlineMinEntries) &&
    contract.planMachineSpecOutlineMinEntries >= 1
      ? contract.planMachineSpecOutlineMinEntries
      : null;
  if (planMachineSpecOutlineMinEntries === null) {
    addFailure(`${contractPath}.planMachineSpecOutlineMinEntries must be an integer >= 1.`);
  }
  const planMachineRefinedSpecMinEntries =
    Number.isInteger(contract.planMachineRefinedSpecMinEntries) &&
    contract.planMachineRefinedSpecMinEntries >= 1
      ? contract.planMachineRefinedSpecMinEntries
      : null;
  if (planMachineRefinedSpecMinEntries === null) {
    addFailure(`${contractPath}.planMachineRefinedSpecMinEntries must be an integer >= 1.`);
  }
  const planMachineImplementationStepsFieldName = toNonEmptyString(
    contract.planMachineImplementationStepsFieldName,
  );
  if (!planMachineImplementationStepsFieldName) {
    addFailure(
      `${contractPath}.planMachineImplementationStepsFieldName must be a non-empty string.`,
    );
  } else if (planMachineImplementationStepsFieldName !== "steps") {
    addFailure(
      `${contractPath}.planMachineImplementationStepsFieldName must equal "steps".`,
    );
  }
  const planMachineAllowedNarrativeStepStatuses = validateStringArray(
    contract.planMachineAllowedNarrativeStepStatuses,
    `${contractPath}.planMachineAllowedNarrativeStepStatuses`,
  );
  const planMachineNarrativeStepRequiredFields = validateStringArray(
    contract.planMachineNarrativeStepRequiredFields,
    `${contractPath}.planMachineNarrativeStepRequiredFields`,
  );
  const planMachineNarrativeStepOptionalFields = validateStringArray(
    contract.planMachineNarrativeStepOptionalFields,
    `${contractPath}.planMachineNarrativeStepOptionalFields`,
  );
  const planMachineImplementationStepDeliverableDenyPatterns = validateStringArray(
    contract.planMachineImplementationStepDeliverableDenyPatterns,
    `${contractPath}.planMachineImplementationStepDeliverableDenyPatterns`,
  );
  const planMachineImplementationStepDeliverableDenyPatternRegexes = compileRegexPatternList(
    planMachineImplementationStepDeliverableDenyPatterns,
    `${contractPath}.planMachineImplementationStepDeliverableDenyPatterns`,
  );
  if (planMachineImplementationStepDeliverableDenyPatternRegexes.length === 0) {
    addFailure(
      `${contractPath}.planMachineImplementationStepDeliverableDenyPatterns must compile to at least one valid regex.`,
    );
  }
  const planMachineImplementationStepAcceptanceCriteriaMinCount =
    Number.isInteger(contract.planMachineImplementationStepAcceptanceCriteriaMinCount) &&
    contract.planMachineImplementationStepAcceptanceCriteriaMinCount >= 1
      ? contract.planMachineImplementationStepAcceptanceCriteriaMinCount
      : null;
  if (planMachineImplementationStepAcceptanceCriteriaMinCount === null) {
    addFailure(
      `${contractPath}.planMachineImplementationStepAcceptanceCriteriaMinCount must be an integer >= 1.`,
    );
  }
  const planMachineStepStatusesRequiringAcceptanceCriteria = validateStringArray(
    contract.planMachineStepStatusesRequiringAcceptanceCriteria,
    `${contractPath}.planMachineStepStatusesRequiringAcceptanceCriteria`,
  );
  const planMachineStepStatusesRequiringNonEmptyCompletionSummary = validateStringArray(
    contract.planMachineStepStatusesRequiringNonEmptyCompletionSummary,
    `${contractPath}.planMachineStepStatusesRequiringNonEmptyCompletionSummary`,
  );
  const planMachineImplementationCompletionSummaryRequiredFields = validateStringArray(
    contract.planMachineImplementationCompletionSummaryRequiredFields,
    `${contractPath}.planMachineImplementationCompletionSummaryRequiredFields`,
  );
  const planMachineAllowedPlanningStageStates = validateStringArray(
    contract.planMachineAllowedPlanningStageStates,
    `${contractPath}.planMachineAllowedPlanningStageStates`,
  );
  const planMachineAllowedSubagentRequirements = validateStringArray(
    contract.planMachineAllowedSubagentRequirements,
    `${contractPath}.planMachineAllowedSubagentRequirements`,
  );
  const planMachineRequiredSubagentFields = validateStringArray(
    contract.planMachineRequiredSubagentFields,
    `${contractPath}.planMachineRequiredSubagentFields`,
  );
  const planMachineStatusesRequiringLastExecutor = validateStringArray(
    contract.planMachineStatusesRequiringLastExecutor,
    `${contractPath}.planMachineStatusesRequiringLastExecutor`,
  );
  const planMachineStatusCoherence = isPlainObject(contract.planMachineStatusCoherence)
    ? contract.planMachineStatusCoherence
    : null;
  if (!planMachineStatusCoherence) {
    addFailure(`${contractPath}.planMachineStatusCoherence must be an object.`);
  }
  const planMachineStatusCoherenceRequireInProgress =
    planMachineStatusCoherence?.requireInProgressPlanStatusWhenAnyStepInProgress;
  if (typeof planMachineStatusCoherenceRequireInProgress !== "boolean") {
    addFailure(
      `${contractPath}.planMachineStatusCoherence.requireInProgressPlanStatusWhenAnyStepInProgress must be a boolean.`,
    );
  } else if (planMachineStatusCoherenceRequireInProgress !== true) {
    addFailure(
      `${contractPath}.planMachineStatusCoherence.requireInProgressPlanStatusWhenAnyStepInProgress must be true.`,
    );
  }
  const planMachineStatusCoherenceStatusesRequiringAllComplete = validateStringArray(
    planMachineStatusCoherence?.statusesRequiringAllImplementationStepsComplete,
    `${contractPath}.planMachineStatusCoherence.statusesRequiringAllImplementationStepsComplete`,
  );
  const planMachineStatusCoherenceStatusesForbiddingInProgress = validateStringArray(
    planMachineStatusCoherence?.statusesForbiddingInProgressImplementationSteps,
    `${contractPath}.planMachineStatusCoherence.statusesForbiddingInProgressImplementationSteps`,
  );
  const planMachineAllowedStatusByRoot = normalizePlanMachineAllowedStatusByRoot({
    rawAllowedStatusByRoot: contract.planMachineAllowedStatusByRoot,
    roots: planMachineRoots,
    contractPath,
  });

  checkRequiredFieldList({
    fieldName: "planMachineRequiredTopLevelFields",
    actualFields: contract.planMachineRequiredTopLevelFields,
    requiredFields: [
      "schema_version",
      "feature_id",
      "feature_title",
      "plan_ref",
      "status",
      "updated_at",
      "planning_stages",
      "narrative",
      "subagent",
    ],
    contractPath,
  });
  checkRequiredFieldList({
    fieldName: "planMachineRequiredPlanningStages",
    actualFields: contract.planMachineRequiredPlanningStages,
    requiredFields: [
      "spec_outline",
      "refined_spec",
      "implementation_plan",
    ],
    contractPath,
  });
  checkRequiredFieldList({
    fieldName: "planMachineRequiredNarrativeFields",
    actualFields: contract.planMachineRequiredNarrativeFields,
    requiredFields: [
      "spec_outline",
      "refined_spec",
      "implementation_plan",
    ],
    contractPath,
  });
  checkRequiredFieldList({
    fieldName: "planMachinePreSpecOutlineRequiredFields",
    actualFields: contract.planMachinePreSpecOutlineRequiredFields,
    requiredFields: ["purpose_goals", "non_goals"],
    contractPath,
  });
  checkRequiredFieldList({
    fieldName: "planMachineStatusesRequiringNonEmptyPreSpecNonGoals",
    actualFields: contract.planMachineStatusesRequiringNonEmptyPreSpecNonGoals,
    requiredFields: ["ready", "deferred"],
    contractPath,
  });
  checkRequiredFieldList({
    fieldName: "planMachineStatusesRequiringNarrativeContent",
    actualFields: contract.planMachineStatusesRequiringNarrativeContent,
    requiredFields: ["in_progress", "complete"],
    contractPath,
  });
  checkRequiredFieldList({
    fieldName: "planMachineSpecOutlineEntryRequiredFields",
    actualFields: contract.planMachineSpecOutlineEntryRequiredFields,
    requiredFields: [
      "id",
      "objective",
      "deliverable",
      "acceptance_criteria",
      "references",
    ],
    contractPath,
  });
  checkRequiredFieldList({
    fieldName: "planMachineRefinedSpecEntryRequiredFields",
    actualFields: contract.planMachineRefinedSpecEntryRequiredFields,
    requiredFields: [
      "id",
      "decision",
      "rationale",
      "acceptance_criteria",
      "references",
    ],
    contractPath,
  });
  checkRequiredFieldList({
    fieldName: "planMachineStatusesRequiringSpecOutlineEntries",
    actualFields: contract.planMachineStatusesRequiringSpecOutlineEntries,
    requiredFields: ["in_progress", "complete"],
    contractPath,
  });
  checkRequiredFieldList({
    fieldName: "planMachineStatusesRequiringRefinedSpecEntries",
    actualFields: contract.planMachineStatusesRequiringRefinedSpecEntries,
    requiredFields: ["in_progress", "complete"],
    contractPath,
  });
  checkRequiredFieldList({
    fieldName: "planMachineAllowedNarrativeStepStatuses",
    actualFields: contract.planMachineAllowedNarrativeStepStatuses,
    requiredFields: ["pending", "in_progress", "complete", "blocked"],
    contractPath,
  });
  checkRequiredFieldList({
    fieldName: "planMachineNarrativeStepRequiredFields",
    actualFields: contract.planMachineNarrativeStepRequiredFields,
    requiredFields: [
      "status",
      "deliverable",
      "acceptance_criteria",
      "references",
      "completion_summary",
    ],
    contractPath,
  });
  checkRequiredFieldList({
    fieldName: "planMachineNarrativeStepOptionalFields",
    actualFields: contract.planMachineNarrativeStepOptionalFields,
    requiredFields: [],
    contractPath,
  });
  if (planMachineImplementationStepDeliverableDenyPatterns.length === 0) {
    addFailure(
      `${contractPath}.planMachineImplementationStepDeliverableDenyPatterns must contain at least one regex pattern.`,
    );
  }
  checkRequiredFieldList({
    fieldName: "planMachineStepStatusesRequiringAcceptanceCriteria",
    actualFields: contract.planMachineStepStatusesRequiringAcceptanceCriteria,
    requiredFields: ["in_progress", "complete"],
    contractPath,
  });
  checkRequiredFieldList({
    fieldName: "planMachineStepStatusesRequiringNonEmptyCompletionSummary",
    actualFields: contract.planMachineStepStatusesRequiringNonEmptyCompletionSummary,
    requiredFields: ["complete"],
    contractPath,
  });
  checkRequiredFieldList({
    fieldName: "planMachineImplementationCompletionSummaryRequiredFields",
    actualFields: contract.planMachineImplementationCompletionSummaryRequiredFields,
    requiredFields: [
      "delivered",
      "files_functions_hooks_touched",
      "verification_testing",
    ],
    contractPath,
  });
  checkRequiredFieldList({
    fieldName: "planMachineAllowedPlanningStageStates",
    actualFields: contract.planMachineAllowedPlanningStageStates,
    requiredFields: ["pending", "in_progress", "complete"],
    contractPath,
  });
  checkRequiredFieldList({
    fieldName: "planMachineAllowedSubagentRequirements",
    actualFields: contract.planMachineAllowedSubagentRequirements,
    requiredFields: ["required", "recommended", "optional", "none"],
    contractPath,
  });
  checkRequiredFieldList({
    fieldName: "planMachineRequiredSubagentFields",
    actualFields: contract.planMachineRequiredSubagentFields,
    requiredFields: ["requirement", "primary_agent", "execution_agents", "last_executor"],
    contractPath,
  });
  checkRequiredFieldList({
    fieldName: "planMachineStatusesRequiringLastExecutor",
    actualFields: contract.planMachineStatusesRequiringLastExecutor,
    requiredFields: ["in_progress", "complete"],
    contractPath,
  });
  checkRequiredFieldList({
    fieldName: "planMachineStatusCoherence.statusesRequiringAllImplementationStepsComplete",
    actualFields: planMachineStatusCoherence?.statusesRequiringAllImplementationStepsComplete,
    requiredFields: ["complete"],
    contractPath,
  });
  checkRequiredFieldList({
    fieldName: "planMachineStatusCoherence.statusesForbiddingInProgressImplementationSteps",
    actualFields: planMachineStatusCoherence?.statusesForbiddingInProgressImplementationSteps,
    requiredFields: ["deferred"],
    contractPath,
  });

  if (typeof contract.archivedPlanSyncEnabled !== "boolean") {
    addFailure(`${contractPath}.archivedPlanSyncEnabled must be a boolean.`);
  }

  if (!isNonEmptyString(contract.archivedPlanRoot)) {
    addFailure(`${contractPath}.archivedPlanRoot must be a non-empty string.`);
  }

  if (!isNonEmptyString(contract.archivedPlanFileName)) {
    addFailure(`${contractPath}.archivedPlanFileName must be a non-empty string.`);
  } else if (contract.archivedPlanFileName !== "PLAN.json") {
    addFailure(`${contractPath}.archivedPlanFileName must equal "PLAN.json".`);
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
  if (contract.sessionBriefRequired !== true) {
    addFailure(`${contractPath}.sessionBriefRequired must be true.`);
  }
  if (contract.sessionBriefMustPostdateQueueAndArchive !== true) {
    addFailure(`${contractPath}.sessionBriefMustPostdateQueueAndArchive must be true.`);
  }
  const preflightQueueQualityFailureMode = toNonEmptyString(
    contract.preflightQueueQualityFailureMode,
  );
  if (!preflightQueueQualityFailureMode || !["warn", "fail"].includes(preflightQueueQualityFailureMode)) {
    addFailure(
      `${contractPath}.preflightQueueQualityFailureMode must be either "warn" or "fail".`,
    );
  } else if (preflightQueueQualityFailureMode !== "fail") {
    addFailure(`${contractPath}.preflightQueueQualityFailureMode must equal "fail".`);
  }
  const preflightQueueQualityFailureRules = validateStringArray(
    contract.preflightQueueQualityFailureRules,
    `${contractPath}.preflightQueueQualityFailureRules`,
  );
  for (const requiredRule of [
    "missingTopLevelDeferredReason",
    "missingTopLevelScope",
    "missingTopLevelAcceptance",
    "deferredItemIds",
    "activeOrCompleteMissingStartIds",
    "completeItemMissingCompletedAtIds",
    "completeItemMissingEvidenceIds",
  ]) {
    if (!preflightQueueQualityFailureRules.includes(requiredRule)) {
      addFailure(
        `${contractPath}.preflightQueueQualityFailureRules must include ${requiredRule}.`,
      );
    }
  }
  const completionEvidenceVerificationPrefix = toNonEmptyString(
    contract.completionEvidenceVerificationPrefix,
  );
  if (completionEvidenceVerificationPrefix !== "verify:") {
    addFailure(`${contractPath}.completionEvidenceVerificationPrefix must equal "verify:".`);
  }

  const archivedPlanRoot = toNonEmptyString(contract.archivedPlanRoot) ?? ".agents/plans/archived";
  const archivedPlanRootResolved = resolveContractPath(archivedPlanRoot);
  const archivedPlanFileName = toNonEmptyString(contract.archivedPlanFileName) ?? "PLAN.json";
  const archivedPlanCanonicalHandoffFileName =
    toNonEmptyString(contract.archivedPlanCanonicalHandoffFileName) ?? "HANDOFF.md";
  const planMachineContractEnabled = contract.planMachineContractEnabled === true;
  const planMachineFileName = toNonEmptyString(contract.planMachineFileName) ?? "PLAN.json";
  const planMachineSchemaVersion = toNonEmptyString(contract.planMachineSchemaVersion) ?? "1.0";
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

  const planRootsSet = new Set(normalizeStringArray(contract.planRoots));
  for (const rootPath of planMachineRoots) {
    if (!planRootsSet.has(rootPath)) {
      addFailure(
        `${contractPath}.planMachineRoots contains ${rootPath}, which is not listed in planRoots.`,
      );
    }
  }

  for (const [rootPath, statuses] of Object.entries(planMachineAllowedStatusByRoot)) {
    if (!planMachineRoots.includes(rootPath)) {
      addFailure(
        `${contractPath}.planMachineAllowedStatusByRoot contains unknown root key ${rootPath}.`,
      );
      continue;
    }
    if (!Array.isArray(statuses) || statuses.length === 0) {
      addFailure(
        `${contractPath}.planMachineAllowedStatusByRoot.${rootPath} must be a non-empty array.`,
      );
    }
  }

  const allPlanMachineAllowedStatuses = new Set(
    Object.values(planMachineAllowedStatusByRoot).flat(),
  );
  for (const status of planMachineStatusesRequiringNarrativeContent) {
    if (!allPlanMachineAllowedStatuses.has(status)) {
      addFailure(
        `${contractPath}.planMachineStatusesRequiringNarrativeContent contains unknown status ${status}.`,
      );
    }
  }
  for (const status of planMachineStatusesRequiringSpecOutlineEntries) {
    if (!allPlanMachineAllowedStatuses.has(status)) {
      addFailure(
        `${contractPath}.planMachineStatusesRequiringSpecOutlineEntries contains unknown status ${status}.`,
      );
    }
  }
  for (const status of planMachineStatusesRequiringRefinedSpecEntries) {
    if (!allPlanMachineAllowedStatuses.has(status)) {
      addFailure(
        `${contractPath}.planMachineStatusesRequiringRefinedSpecEntries contains unknown status ${status}.`,
      );
    }
  }
  for (const status of planMachineStatusesRequiringNonEmptyPreSpecNonGoals) {
    if (!allPlanMachineAllowedStatuses.has(status)) {
      addFailure(
        `${contractPath}.planMachineStatusesRequiringNonEmptyPreSpecNonGoals contains unknown status ${status}.`,
      );
    }
  }
  for (const status of planMachineStatusesRequiringLastExecutor) {
    if (!allPlanMachineAllowedStatuses.has(status)) {
      addFailure(
        `${contractPath}.planMachineStatusesRequiringLastExecutor contains unknown status ${status}.`,
      );
    }
  }
  for (const status of planMachineStatusCoherenceStatusesRequiringAllComplete) {
    if (!allPlanMachineAllowedStatuses.has(status)) {
      addFailure(
        `${contractPath}.planMachineStatusCoherence.statusesRequiringAllImplementationStepsComplete contains unknown status ${status}.`,
      );
    }
  }
  for (const status of planMachineStatusCoherenceStatusesForbiddingInProgress) {
    if (!allPlanMachineAllowedStatuses.has(status)) {
      addFailure(
        `${contractPath}.planMachineStatusCoherence.statusesForbiddingInProgressImplementationSteps contains unknown status ${status}.`,
      );
    }
  }
  const allowedNarrativeStepStatusSet = new Set(planMachineAllowedNarrativeStepStatuses);
  for (const stepStatus of planMachineStepStatusesRequiringAcceptanceCriteria) {
    if (!allowedNarrativeStepStatusSet.has(stepStatus)) {
      addFailure(
        `${contractPath}.planMachineStepStatusesRequiringAcceptanceCriteria contains unknown step status ${stepStatus}.`,
      );
    }
  }
  for (const stepStatus of planMachineStepStatusesRequiringNonEmptyCompletionSummary) {
    if (!allowedNarrativeStepStatusSet.has(stepStatus)) {
      addFailure(
        `${contractPath}.planMachineStepStatusesRequiringNonEmptyCompletionSummary contains unknown step status ${stepStatus}.`,
      );
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
      "queue_read_contract",
      "queue_overview",
      "startup_attestation",
      "queue_quality_gate",
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

  if (activeRunOptions.ci === true) {
    addWarning(
      "CI mode enabled; skipping runtime .agents session-artifact state validation checks.",
    );
    return;
  }

  const topLevelArrayFields = [
    "in_scope",
    "out_of_scope",
    "acceptance_criteria",
    "constraints",
    "references",
    "open_questions",
  ];

  if (planMachineContractEnabled === true) {
    const planFileNameDefault = toNonEmptyString(contract.planQueueSyncPlanFileName) ?? "PLAN.json";
    const archivedPlanFileNameResolved =
      toNonEmptyString(contract.archivedPlanFileName) ?? "PLAN.json";

    for (const rootPath of planMachineRoots) {
      const rootResolved = resolveContractPath(rootPath);
      if (!fs.existsSync(rootResolved)) {
        addFailure(
          `${rootPath} must exist when ${contractPath}.planMachineContractEnabled is true.`,
        );
        continue;
      }

      const planFileNameForRoot =
        rootPath === archivedPlanRoot ? archivedPlanFileNameResolved : planFileNameDefault;
      const featureDirs = listFeaturePlanDirectories(rootResolved);
      for (const featureDir of featureDirs) {
        const planRef = `${rootPath}/${featureDir}/${planFileNameForRoot}`;
        const planAbs = resolveContractPath(planRef);
        if (!fs.existsSync(planAbs)) {
          addFailure(`${planRef} is required for plan directory ${rootPath}/${featureDir}.`);
          continue;
        }

        const planMachineRef = `${rootPath}/${featureDir}/${contract.planMachineFileName}`;
        const planMachineAbs = resolveContractPath(planMachineRef);
        validatePlanMachineDocument({
          planMachineRef,
          planMachineAbs,
          expectedFeatureId: featureDir,
          expectedPlanRef: planRef,
          expectedRoot: rootPath,
          expectedSchemaVersion: contract.planMachineSchemaVersion,
          requiredTopLevelFields: planMachineRequiredTopLevelFields,
          requiredPlanningStages: planMachineRequiredPlanningStages,
          requiredNarrativeFields: planMachineRequiredNarrativeFields,
          preSpecOutlineRequiredFields: planMachinePreSpecOutlineRequiredFields,
          statusesRequiringNonEmptyPreSpecNonGoals:
            planMachineStatusesRequiringNonEmptyPreSpecNonGoals,
          statusesRequiringNarrativeContent: planMachineStatusesRequiringNarrativeContent,
          narrativeMinLength: planMachineNarrativeMinLength ?? 24,
          preSpecOutlineMinLength: planMachinePreSpecOutlineMinLength ?? 24,
          narrativeMinSteps: planMachineNarrativeMinSteps ?? 1,
          specOutlineListFieldName: planMachineSpecOutlineListFieldName,
          refinedSpecListFieldName: planMachineRefinedSpecListFieldName,
          specOutlineEntryRequiredFields: planMachineSpecOutlineEntryRequiredFields,
          refinedSpecEntryRequiredFields: planMachineRefinedSpecEntryRequiredFields,
          statusesRequiringSpecOutlineEntries: planMachineStatusesRequiringSpecOutlineEntries,
          statusesRequiringRefinedSpecEntries: planMachineStatusesRequiringRefinedSpecEntries,
          specOutlineMinEntries: planMachineSpecOutlineMinEntries ?? 1,
          refinedSpecMinEntries: planMachineRefinedSpecMinEntries ?? 1,
          implementationStepsFieldName: planMachineImplementationStepsFieldName,
          allowedNarrativeStepStatuses: planMachineAllowedNarrativeStepStatuses,
          narrativeStepRequiredFields: planMachineNarrativeStepRequiredFields,
          narrativeStepOptionalFields: planMachineNarrativeStepOptionalFields,
          implementationStepDeliverableDenyPatternRegexes:
            planMachineImplementationStepDeliverableDenyPatternRegexes,
          implementationStepAcceptanceCriteriaMinCount:
            planMachineImplementationStepAcceptanceCriteriaMinCount,
          stepStatusesRequiringAcceptanceCriteria:
            planMachineStepStatusesRequiringAcceptanceCriteria,
          stepStatusesRequiringNonEmptyCompletionSummary:
            planMachineStepStatusesRequiringNonEmptyCompletionSummary,
          implementationCompletionSummaryRequiredFields:
            planMachineImplementationCompletionSummaryRequiredFields,
          statusCoherence: planMachineStatusCoherence,
          allowedPlanningStageStates: planMachineAllowedPlanningStageStates,
          allowedSubagentRequirements: planMachineAllowedSubagentRequirements,
          requiredSubagentFields: planMachineRequiredSubagentFields,
          statusesRequiringLastExecutor: planMachineStatusesRequiringLastExecutor,
          allowedStatusByRoot: planMachineAllowedStatusByRoot,
        });
      }
    }
  }

  const archivedPlanDirectories = listFeaturePlanDirectories(archivedPlanRootResolved);
  const archivedPlanExpectations = [];
  for (const featureDir of archivedPlanDirectories) {
    const featureDirPath = `${archivedPlanRoot}/${featureDir}`;
    const featureDirResolved = path.resolve(archivedPlanRootResolved, featureDir);
    const canonicalPlanRef = `${featureDirPath}/${archivedPlanFileName}`;
    const canonicalPlanDiskPath = path.resolve(featureDirResolved, archivedPlanFileName);
    const planMachineRef = `${featureDirPath}/${contract.planMachineFileName}`;
    const planMachineDiskPath = path.resolve(featureDirResolved, contract.planMachineFileName);
    const canonicalHandoffRef = `${featureDirPath}/${archivedPlanCanonicalHandoffFileName}`;
    const canonicalPlanExists = fs.existsSync(canonicalPlanDiskPath);
    if (!canonicalPlanExists) {
      addFailure(
        `${canonicalPlanRef} is required for archived plan directory ${featureDirPath}.`,
      );
    }
    if (planMachineContractEnabled === true && planMachineRoots.includes(archivedPlanRoot)) {
      if (!fs.existsSync(planMachineDiskPath)) {
        addFailure(
          `${planMachineRef} is required for archived plan directory ${featureDirPath}.`,
        );
      }
    }

    const hasLegacyHandoff = archivedPlanLegacyHandoffFileNames.some((legacyFileName) =>
      fs.existsSync(path.resolve(featureDirResolved, legacyFileName)),
    );
    const hasCanonicalHandoff = fs.existsSync(
      path.resolve(featureDirResolved, archivedPlanCanonicalHandoffFileName),
    );
    if (hasLegacyHandoff && !hasCanonicalHandoff) {
      addWarning(
        `${featureDirPath} contains legacy handoff naming but is missing canonical ${archivedPlanCanonicalHandoffFileName}.`,
      );
    }

    archivedPlanExpectations.push({
      featureId: featureDir,
      archiveKey: `${archivedPlanArchiveKeyPrefix}${featureDir}`,
      planRef: canonicalPlanRef,
      planMachineRef,
      archiveRef: `${contract.archiveRoot}/${toArchiveFeatureShardName(featureDir)}.${contract.archiveFormat}`,
      planExists: canonicalPlanExists,
    });
  }

  if (contract.stalePlanReferenceCheckEnabled === true) {
    const staleReferenceFindings = scanStalePlanReferences(
      stalePlanReferenceScanRoots,
      resolveContractPath,
    );
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
          if (completionEvidenceVerificationPrefix) {
            const evidenceEntries = Array.isArray(item.evidence) ? item.evidence : [];
            const hasVerificationEvidence = evidenceEntries.some((entry) => {
              const text = toNonEmptyString(entry);
              return Boolean(text && text.startsWith(completionEvidenceVerificationPrefix));
            });
            if (!hasVerificationEvidence) {
              addFailure(
                `${contract.executionQueueFile}.items[${index}].evidence must include at least one entry prefixed ${completionEvidenceVerificationPrefix} for state ${state}.`,
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
          const rootPathResolved = resolveContractPath(rootPath);
          if (!fs.existsSync(rootPathResolved)) {
            addFailure(
              `${rootPath} must exist when ${contractPath}.planQueueSyncEnabled is true.`,
            );
            continue;
          }
          const expectedState = toNonEmptyString(planQueueSyncStateByRoot?.[rootPath]);
          const featureDirs = listFeaturePlanDirectories(rootPathResolved);

          for (const featureDir of featureDirs) {
            const planRef = `${rootPath}/${featureDir}/${contract.planQueueSyncPlanFileName}`;
            const planAbs = resolveContractPath(planRef);
            if (!fs.existsSync(planAbs)) {
              addFailure(`${planRef} is required for plan directory ${rootPath}/${featureDir}.`);
              continue;
            }

            let planMachineRef = null;
            if (planMachineContractEnabled === true && planMachineRoots.includes(rootPath)) {
              planMachineRef = `${rootPath}/${featureDir}/${contract.planMachineFileName}`;
              const planMachineAbs = resolveContractPath(planMachineRef);
              if (!fs.existsSync(planMachineAbs)) {
                addFailure(
                  `${planMachineRef} is required for plan directory ${rootPath}/${featureDir}.`,
                );
              }
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

            if (planMachineRef) {
              const hasMachineReference = matchedItems.some((item) =>
                Array.isArray(item?.references) && item.references.includes(planMachineRef),
              );
              if (!hasMachineReference) {
                addFailure(
                  `${contract.executionQueueFile} plan_ref ${planRef} must include ${planMachineRef} in item references.`,
                );
              }
            }
          }
        }
      }
    }
  }

  const archiveRootResolved = resolveContractPath(contract.archiveRoot);
  if (fs.existsSync(archiveRootResolved)) {
    const archiveRootStats = fs.statSync(archiveRootResolved);
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

        const archiveRefResolved = resolveContractPath(archiveRef);
        if (!fs.existsSync(archiveRefResolved)) {
          addFailure(
            `${contract.archiveIndexFile}.items[${index}].archive_ref points to missing file ${archiveRef}.`,
          );
          continue;
        }

        if (!archiveShardCache.has(archiveRef)) {
          archiveShardCache.set(archiveRef, readJsonLinesFile(archiveRefResolved));
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
          if (
            planMachineContractEnabled === true &&
            planMachineRoots.includes(archivedPlanRoot) &&
            toNonEmptyString(matchedEntry.plan_machine_ref) !== expected.planMachineRef
          ) {
            addFailure(
              `${contract.archiveIndexFile} entry ${expected.archiveKey} must reference plan_machine_ref ${expected.planMachineRef}.`,
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

  const sessionBriefOptional = contract.sessionBriefRequired === true ? false : true;
  const sessionBrief = readJsonIfPresent(contract.sessionBriefJsonFile, sessionBriefOptional);
  if (sessionBrief === null && contract.sessionBriefRequired === true) {
    addFailure(`${contract.sessionBriefJsonFile} is required. Run npm run agent:preflight.`);
  }
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
        if (contract.sessionBriefMustPostdateQueueAndArchive === true) {
          addFailure(
            `${contract.sessionBriefJsonFile}.generated_at predates ${contract.executionQueueFile}.last_updated.`,
          );
        } else {
          addWarning(
            `${contract.sessionBriefJsonFile}.generated_at predates ${contract.executionQueueFile}.last_updated.`,
          );
        }
      }
      if (
        archiveIndex !== null &&
        isValidIsoDate(archiveIndex.last_updated) &&
        generatedAtMs < Date.parse(archiveIndex.last_updated)
      ) {
        if (contract.sessionBriefMustPostdateQueueAndArchive === true) {
          addFailure(
            `${contract.sessionBriefJsonFile}.generated_at predates ${contract.archiveIndexFile}.last_updated.`,
          );
        } else {
          addWarning(
            `${contract.sessionBriefJsonFile}.generated_at predates ${contract.archiveIndexFile}.last_updated.`,
          );
        }
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
    if (
      !sessionBrief.startup_attestation ||
      typeof sessionBrief.startup_attestation !== "object"
    ) {
      addFailure(`${contract.sessionBriefJsonFile}.startup_attestation must be an object.`);
    } else {
      if (sessionBrief.startup_attestation.startup_files_verified !== true) {
        addFailure(
          `${contract.sessionBriefJsonFile}.startup_attestation.startup_files_verified must be true.`,
        );
      }
      if (!isValidIsoDate(sessionBrief.startup_attestation.attested_at)) {
        addFailure(
          `${contract.sessionBriefJsonFile}.startup_attestation.attested_at must be a valid ISO timestamp.`,
        );
      }
    }
    if (!sessionBrief.queue_quality_gate || typeof sessionBrief.queue_quality_gate !== "object") {
      addFailure(`${contract.sessionBriefJsonFile}.queue_quality_gate must be an object.`);
    }
  }

  readFileIfPresent(contract.memoryFile, false);
  readFileIfPresent(contract.sessionLogFile, false);
  const memoryTopicsRoot = toNonEmptyString(contract.memoryTopicsRoot);
  if (!memoryTopicsRoot) {
    addFailure(`${contractPath}.memoryTopicsRoot must be a non-empty string.`);
  } else {
    const memoryTopicsRootResolved = resolveContractPath(memoryTopicsRoot);
    if (!fs.existsSync(memoryTopicsRootResolved)) {
      addFailure(`${memoryTopicsRoot} must exist.`);
    } else if (!fs.statSync(memoryTopicsRootResolved).isDirectory()) {
      addFailure(`${memoryTopicsRoot} must be a directory.`);
    }
  }
}

function checkManagedFilesCanonicalContract(config) {
  const contractPath = "contracts.managedFilesCanonical";
  const contract = config?.contracts?.managedFilesCanonical;
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }
  if (!isContractEnabled(config, contract)) {
    return;
  }

  const manifestFile = toNonEmptyString(contract.manifestFile);
  const manifestTemplateFile = toNonEmptyString(contract.manifestTemplateFile);
  const canonicalContractField = toNonEmptyString(contract.canonicalContractField);
  const defaultAuthority = toNonEmptyString(contract.defaultAuthority);
  const overrideMode = toNonEmptyString(contract.overrideMode);
  const entryAllowOverrideField = toNonEmptyString(contract.entryAllowOverrideField);
  const entryAuthorityField = toNonEmptyString(contract.entryAuthorityField);
  const entryStructureContractField = toNonEmptyString(contract.entryStructureContractField);
  const markdownPlaceholderPatternsField = toNonEmptyString(
    contract.markdownPlaceholderPatternsField,
  );
  const markdownPlaceholderFailureModeField = toNonEmptyString(
    contract.markdownPlaceholderFailureModeField,
  );
  const allowOverrideTemplateAuthorityOnly =
    contract.allowOverrideTemplateAuthorityOnly === true;
  const overrideModeExclusivity = toNonEmptyString(contract.overrideModeExclusivity);
  const deprecatedOverrideSuffixes = normalizeStringArray(contract.deprecatedOverrideSuffixes);
  const npmScriptName = toNonEmptyString(contract.npmScriptName);
  const npmScriptCommand = toNonEmptyString(contract.npmScriptCommand);
  const contextIndexCheckCommandKey =
    toNonEmptyString(contract.contextIndexCheckCommandKey) ?? "agentManaged";
  const contextIndexFixCommandKey =
    toNonEmptyString(contract.contextIndexFixCommandKey) ?? "agentManagedFix";
  const checkCommand = toNonEmptyString(contract.checkCommand);
  const fixCommand = toNonEmptyString(contract.fixCommand);

  if (manifestFile !== ".agents-config/agent-managed.json") {
    addFailure(`${contractPath}.manifestFile must equal ".agents-config/agent-managed.json".`);
  }
  if (manifestTemplateFile !== ".agents-config/tools/bootstrap/managed-files.template.json") {
    addFailure(
      `${contractPath}.manifestTemplateFile must equal ".agents-config/tools/bootstrap/managed-files.template.json".`,
    );
  }
  if (canonicalContractField !== "canonical_contract") {
    addFailure(`${contractPath}.canonicalContractField must equal "canonical_contract".`);
  }
  if (defaultAuthority !== "template") {
    addFailure(`${contractPath}.defaultAuthority must equal "template".`);
  }
  if (overrideMode !== "explicit_allowlist") {
    addFailure(`${contractPath}.overrideMode must equal "explicit_allowlist".`);
  }
  if (entryAllowOverrideField !== "allow_override") {
    addFailure(`${contractPath}.entryAllowOverrideField must equal "allow_override".`);
  }
  if (entryAuthorityField !== "authority") {
    addFailure(`${contractPath}.entryAuthorityField must equal "authority".`);
  }
  if (entryStructureContractField !== "structure_contract") {
    addFailure(
      `${contractPath}.entryStructureContractField must equal "structure_contract".`,
    );
  }
  if (markdownPlaceholderPatternsField !== "placeholder_patterns") {
    addFailure(
      `${contractPath}.markdownPlaceholderPatternsField must equal "placeholder_patterns".`,
    );
  }
  if (markdownPlaceholderFailureModeField !== "placeholder_failure_mode") {
    addFailure(
      `${contractPath}.markdownPlaceholderFailureModeField must equal "placeholder_failure_mode".`,
    );
  }
  if (!allowOverrideTemplateAuthorityOnly) {
    addFailure(`${contractPath}.allowOverrideTemplateAuthorityOnly must be true.`);
  }
  if (overrideModeExclusivity !== "single_mode_per_managed_path") {
    addFailure(
      `${contractPath}.overrideModeExclusivity must equal "single_mode_per_managed_path".`,
    );
  }
  if (!deprecatedOverrideSuffixes.includes(".replace")) {
    addFailure(`${contractPath}.deprecatedOverrideSuffixes must include ".replace".`);
  }
  if (npmScriptName !== "agent:managed") {
    addFailure(`${contractPath}.npmScriptName must equal "agent:managed".`);
  }
  if (npmScriptCommand !== "node .agents-config/tools/bootstrap/agent-managed-files.mjs") {
    addFailure(
      `${contractPath}.npmScriptCommand must equal "node .agents-config/tools/bootstrap/agent-managed-files.mjs".`,
    );
  }
  if (checkCommand !== "npm run agent:managed -- --mode check") {
    addFailure(
      `${contractPath}.checkCommand must equal "npm run agent:managed -- --mode check".`,
    );
  }
  if (fixCommand !== "npm run agent:managed -- --fix --recheck") {
    addFailure(
      `${contractPath}.fixCommand must equal "npm run agent:managed -- --fix --recheck".`,
    );
  }

  const allowedAuthorities = normalizeStringArray(contract.allowedAuthorities);
  const allowedAuthoritySet = new Set(allowedAuthorities);
  for (const requiredAuthority of ["template", "project", "structured"]) {
    if (!allowedAuthoritySet.has(requiredAuthority)) {
      addFailure(
        `${contractPath}.allowedAuthorities is missing required value: ${requiredAuthority}.`,
      );
    }
  }

  const overrideReservedPaths = normalizeStringArray(contract.overrideReservedPaths);
  const requiredOverrideReservedPaths = [".gitkeep"];
  for (const requiredPath of requiredOverrideReservedPaths) {
    if (!overrideReservedPaths.includes(requiredPath)) {
      addFailure(
        `${contractPath}.overrideReservedPaths is missing required value: ${requiredPath}.`,
      );
    }
  }

  const packageJson = readJsonIfPresent("package.json", true);
  if (!packageJson || typeof packageJson !== "object") {
    addFailure("package.json must exist for managed-files script checks.");
  } else {
    const scripts = packageJson.scripts;
    if (!scripts || typeof scripts !== "object") {
      addFailure("package.json.scripts must be an object.");
    } else if (npmScriptName && scripts[npmScriptName] !== npmScriptCommand) {
      addFailure(
        `package.json scripts.${npmScriptName} must equal ${JSON.stringify(npmScriptCommand)}.`,
      );
    }
  }

  const contextContract = config?.contracts?.contextIndex;
  const { requiredValues: requiredCommandKeys } = resolveProfileScopedRequiredStrings({
    config,
    baseValues: contextContract?.requiredCommandKeys,
    baseFieldPath: "contracts.contextIndex.requiredCommandKeys",
    byProfileValues: contextContract?.requiredCommandKeysByProfile,
    byProfileFieldPath: "contracts.contextIndex.requiredCommandKeysByProfile",
  });
  for (const commandKey of [contextIndexCheckCommandKey, contextIndexFixCommandKey]) {
    if (!requiredCommandKeys.includes(commandKey)) {
      addFailure(
        `contracts.contextIndex required command keys must include ${commandKey} for active profiles.`,
      );
    }
  }

  const contextIndexPath =
    toNonEmptyString(contextContract?.indexFile) ?? ".agents-config/docs/CONTEXT_INDEX.json";
  const contextIndex = readJsonIfPresent(contextIndexPath);
  if (contextIndex && typeof contextIndex === "object") {
    if (!contextIndex.commands || typeof contextIndex.commands !== "object") {
      addFailure(`${contextIndexPath}.commands must be an object.`);
    } else {
      if (contextIndex.commands[contextIndexCheckCommandKey] !== checkCommand) {
        addFailure(
          `${contextIndexPath}.commands.${contextIndexCheckCommandKey} must equal ${JSON.stringify(checkCommand)}.`,
        );
      }
      if (contextIndex.commands[contextIndexFixCommandKey] !== fixCommand) {
        addFailure(
          `${contextIndexPath}.commands.${contextIndexFixCommandKey} must equal ${JSON.stringify(fixCommand)}.`,
        );
      }
    }
  }

  const manifestFiles = [manifestFile, manifestTemplateFile];
  for (const filePath of manifestFiles) {
    const manifest = readJsonIfPresent(filePath);
    if (!manifest || typeof manifest !== "object") {
      continue;
    }

    const manifestContract = manifest[canonicalContractField];
    if (!manifestContract || typeof manifestContract !== "object") {
      addFailure(`${filePath}.${canonicalContractField} must be an object.`);
      continue;
    }

    if (manifestContract.default_authority !== defaultAuthority) {
      addFailure(
        `${filePath}.${canonicalContractField}.default_authority must equal ${JSON.stringify(defaultAuthority)}.`,
      );
    }
    if (manifestContract.override_mode !== overrideMode) {
      addFailure(
        `${filePath}.${canonicalContractField}.override_mode must equal ${JSON.stringify(overrideMode)}.`,
      );
    }

    const manifestAllowedAuthorities = normalizeStringArray(
      manifestContract.allowed_authorities,
    );
    for (const requiredAuthority of ["template", "project", "structured"]) {
      if (!manifestAllowedAuthorities.includes(requiredAuthority)) {
        addFailure(
          `${filePath}.${canonicalContractField}.allowed_authorities must include ${requiredAuthority}.`,
        );
      }
    }

    const manifestReservedPaths = normalizeStringArray(
      manifestContract.override_reserved_paths,
    );
    for (const requiredPath of requiredOverrideReservedPaths) {
      if (!manifestReservedPaths.includes(requiredPath)) {
        addFailure(
          `${filePath}.${canonicalContractField}.override_reserved_paths must include ${requiredPath}.`,
        );
      }
    }

    const managedEntries = Array.isArray(manifest.managed_files) ? manifest.managed_files : [];
    if (managedEntries.length === 0) {
      addFailure(`${filePath}.managed_files must be a non-empty array.`);
      continue;
    }

    let allowOverrideCount = 0;
    for (let index = 0; index < managedEntries.length; index += 1) {
      const entry = managedEntries[index];
      if (!entry || typeof entry !== "object") {
        addFailure(`${filePath}.managed_files[${index}] must be an object.`);
        continue;
      }

      const entryPath = toNonEmptyString(entry.path);
      if (!entryPath) {
        addFailure(`${filePath}.managed_files[${index}].path must be a non-empty string.`);
      }

      if (
        Object.prototype.hasOwnProperty.call(entry, entryAllowOverrideField) &&
        typeof entry[entryAllowOverrideField] !== "boolean"
      ) {
        addFailure(
          `${filePath}.managed_files[${index}].${entryAllowOverrideField} must be boolean when set.`,
        );
      }

      const authority = toNonEmptyString(entry[entryAuthorityField]) ?? defaultAuthority;
      if (!allowedAuthoritySet.has(authority)) {
        addFailure(
          `${filePath}.managed_files[${index}].${entryAuthorityField} must be one of ${[...allowedAuthoritySet].join(", ")}.`,
        );
      }

      const hasStructureContract = Object.prototype.hasOwnProperty.call(
        entry,
        "structure_contract",
      );
      if (authority === "structured") {
        const structureContract = entry.structure_contract;
        if (
          !structureContract ||
          typeof structureContract !== "object" ||
          Array.isArray(structureContract)
        ) {
          addFailure(
            `${filePath}.managed_files[${index}].structure_contract is required when ${entryAuthorityField}=structured.`,
          );
        } else {
          const kind = toNonEmptyString(structureContract.kind);
          if (!["markdown_sections", "json_required_paths"].includes(kind ?? "")) {
            addFailure(
              `${filePath}.managed_files[${index}].structure_contract.kind must be markdown_sections or json_required_paths.`,
            );
          } else if (kind === "markdown_sections") {
            const requiredSections = Array.isArray(structureContract.required_sections)
              ? structureContract.required_sections
              : [];
            if (requiredSections.length === 0) {
              addFailure(
                `${filePath}.managed_files[${index}].structure_contract.required_sections must be a non-empty array.`,
              );
            } else {
              for (const sectionHeading of requiredSections) {
                const value = toNonEmptyString(sectionHeading);
                if (!value || !value.startsWith("##")) {
                  addFailure(
                    `${filePath}.managed_files[${index}].structure_contract.required_sections entries must be markdown headings beginning with ##.`,
                  );
                  break;
                }
              }
            }

            const hasPlaceholderPatterns = Object.prototype.hasOwnProperty.call(
              structureContract,
              "placeholder_patterns",
            );
            if (hasPlaceholderPatterns) {
              const placeholderPatterns = Array.isArray(structureContract.placeholder_patterns)
                ? structureContract.placeholder_patterns
                : null;
              if (!placeholderPatterns || placeholderPatterns.length === 0) {
                addFailure(
                  `${filePath}.managed_files[${index}].structure_contract.placeholder_patterns must be a non-empty array when set.`,
                );
              } else {
                for (const patternText of placeholderPatterns) {
                  if (!toNonEmptyString(patternText)) {
                    addFailure(
                      `${filePath}.managed_files[${index}].structure_contract.placeholder_patterns entries must be non-empty strings.`,
                    );
                    break;
                  }
                }
              }
            }
            if (
              Object.prototype.hasOwnProperty.call(
                structureContract,
                "placeholder_failure_mode",
              )
            ) {
              const mode = toNonEmptyString(structureContract.placeholder_failure_mode);
              if (!["warn", "fail"].includes(mode ?? "")) {
                addFailure(
                  `${filePath}.managed_files[${index}].structure_contract.placeholder_failure_mode must be warn or fail when set.`,
                );
              } else if (!hasPlaceholderPatterns) {
                addFailure(
                  `${filePath}.managed_files[${index}].structure_contract.placeholder_failure_mode requires structure_contract.placeholder_patterns.`,
                );
              }
            }
          } else if (kind === "json_required_paths") {
            const requiredPaths = Array.isArray(structureContract.required_paths)
              ? structureContract.required_paths
              : [];
            if (requiredPaths.length === 0) {
              addFailure(
                `${filePath}.managed_files[${index}].structure_contract.required_paths must be a non-empty array.`,
              );
            } else {
              for (const pathRule of requiredPaths) {
                if (!pathRule || typeof pathRule !== "object" || Array.isArray(pathRule)) {
                  addFailure(
                    `${filePath}.managed_files[${index}].structure_contract.required_paths entries must be objects.`,
                  );
                  break;
                }
                const pathValue = toNonEmptyString(pathRule.path);
                const typeValue = toNonEmptyString(pathRule.type);
                if (!pathValue) {
                  addFailure(
                    `${filePath}.managed_files[${index}].structure_contract.required_paths entries must define non-empty path values.`,
                  );
                  break;
                }
                if (!["object", "array", "string", "number", "boolean"].includes(typeValue ?? "")) {
                  addFailure(
                    `${filePath}.managed_files[${index}].structure_contract.required_paths path ${pathValue} must define type object|array|string|number|boolean.`,
                  );
                  break;
                }
                if (
                  Object.prototype.hasOwnProperty.call(pathRule, "min_items") &&
                  pathRule.min_items !== null &&
                  pathRule.min_items !== undefined
                ) {
                  const minItems = Number(pathRule.min_items);
                  if (!Number.isInteger(minItems) || minItems < 0) {
                    addFailure(
                      `${filePath}.managed_files[${index}].structure_contract.required_paths path ${pathValue} min_items must be a non-negative integer.`,
                    );
                    break;
                  }
                  if (typeValue !== "array") {
                    addFailure(
                      `${filePath}.managed_files[${index}].structure_contract.required_paths path ${pathValue} cannot set min_items unless type=array.`,
                    );
                    break;
                  }
                }
              }
            }
          }
        }
      } else if (hasStructureContract) {
        addFailure(
          `${filePath}.managed_files[${index}].structure_contract is only valid when ${entryAuthorityField}=structured.`,
        );
      }

      if (entry[entryAllowOverrideField] === true) {
        allowOverrideCount += 1;
        if (authority !== "template") {
          addFailure(
            `${filePath}.managed_files[${index}] cannot set ${entryAllowOverrideField}=true when ${entryAuthorityField}=${authority}.`,
          );
        }
      }
    }

    if (allowOverrideCount === 0) {
      addWarning(
        `${filePath} currently has no ${entryAllowOverrideField}=true entries; known override surfaces may be too restrictive.`,
      );
    }
  }
}

function checkCanonicalRulesContract(config, repoRoot, activeConfigPath) {
  const contractPath = "contracts.canonicalRules";
  const contract = config?.contracts?.canonicalRules;
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }
  if (!isContractEnabled(config, contract)) {
    return;
  }

  const canonicalFile = toNonEmptyString(contract.file);
  const overrideSchemaFile = toNonEmptyString(contract.overrideSchemaFile);
  const overrideFile =
    toNonEmptyString(contract.optionalOverrideFile) ??
    ".agents-config/rule-overrides.json";
  const verifyScript = toNonEmptyString(contract.verifyScript);

  if (canonicalFile !== ".agents-config/contracts/rules/canonical-ruleset.json") {
    addFailure(`${contractPath}.file must equal ".agents-config/contracts/rules/canonical-ruleset.json".`);
  }
  if (overrideSchemaFile !== ".agents-config/rule-overrides.schema.json") {
    addFailure(
      `${contractPath}.overrideSchemaFile must equal ".agents-config/rule-overrides.schema.json".`,
    );
  }
  if (verifyScript !== ".agents-config/tools/rules/verify-canonical-ruleset.mjs") {
    addFailure(
      `${contractPath}.verifyScript must equal ".agents-config/tools/rules/verify-canonical-ruleset.mjs".`,
    );
  }

  const verifyNpmName = toNonEmptyString(contract.npmVerifyScriptName);
  const verifyNpmCommand = toNonEmptyString(contract.npmVerifyScriptCommand);
  const syncNpmName = toNonEmptyString(contract.npmSyncScriptName);
  const syncNpmCommand = toNonEmptyString(contract.npmSyncScriptCommand);

  if (verifyNpmName !== "rules:canonical:verify") {
    addFailure(`${contractPath}.npmVerifyScriptName must equal "rules:canonical:verify".`);
  }
  if (verifyNpmCommand !== "node .agents-config/tools/rules/verify-canonical-ruleset.mjs --check") {
    addFailure(
      `${contractPath}.npmVerifyScriptCommand must equal "node .agents-config/tools/rules/verify-canonical-ruleset.mjs --check".`,
    );
  }
  if (syncNpmName !== "rules:canonical:sync") {
    addFailure(`${contractPath}.npmSyncScriptName must equal "rules:canonical:sync".`);
  }
  if (syncNpmCommand !== "node .agents-config/tools/rules/verify-canonical-ruleset.mjs --write") {
    addFailure(
      `${contractPath}.npmSyncScriptCommand must equal "node .agents-config/tools/rules/verify-canonical-ruleset.mjs --write".`,
    );
  }

  const packageJson = readJsonIfPresent("package.json", true);
  if (!packageJson || typeof packageJson !== "object") {
    addFailure("package.json must exist for canonical-rules script checks.");
  } else {
    const scripts = packageJson.scripts;
    if (!scripts || typeof scripts !== "object") {
      addFailure("package.json.scripts must be an object.");
    } else {
      if (verifyNpmName && scripts[verifyNpmName] !== verifyNpmCommand) {
        addFailure(
          `package.json scripts.${verifyNpmName} must equal ${JSON.stringify(verifyNpmCommand)}.`,
        );
      }
      if (syncNpmName && scripts[syncNpmName] !== syncNpmCommand) {
        addFailure(
          `package.json scripts.${syncNpmName} must equal ${JSON.stringify(syncNpmCommand)}.`,
        );
      }
    }
  }

  const contextIndexPath =
    toNonEmptyString(config?.contracts?.contextIndex?.indexFile) ??
    ".agents-config/docs/CONTEXT_INDEX.json";
  const contextIndex = readJsonIfPresent(contextIndexPath);
  if (contextIndex && typeof contextIndex === "object") {
    const sectionName =
      toNonEmptyString(contract.contextIndexSection) ?? "canonicalRules";
    const section = contextIndex[sectionName];
    if (!section || typeof section !== "object") {
      addFailure(`${contextIndexPath}.${sectionName} must be an object.`);
    } else {
      if (section.file !== canonicalFile) {
        addFailure(
          `${contextIndexPath}.${sectionName}.file must equal ${JSON.stringify(canonicalFile)}.`,
        );
      }
      if (section.overrideSchemaFile !== overrideSchemaFile) {
        addFailure(
          `${contextIndexPath}.${sectionName}.overrideSchemaFile must equal ${JSON.stringify(overrideSchemaFile)}.`,
        );
      }
      if (section.optionalOverrideFile !== overrideFile) {
        addFailure(
          `${contextIndexPath}.${sectionName}.optionalOverrideFile must equal ${JSON.stringify(overrideFile)}.`,
        );
      }
      if (
        section.verifyCommandKey !==
        toNonEmptyString(contract.contextIndexVerifyCommandKey)
      ) {
        addFailure(
          `${contextIndexPath}.${sectionName}.verifyCommandKey must equal contracts.canonicalRules.contextIndexVerifyCommandKey.`,
        );
      }
      if (
        section.syncCommandKey !==
        toNonEmptyString(contract.contextIndexSyncCommandKey)
      ) {
        addFailure(
          `${contextIndexPath}.${sectionName}.syncCommandKey must equal contracts.canonicalRules.contextIndexSyncCommandKey.`,
        );
      }
    }

    if (!contextIndex.commands || typeof contextIndex.commands !== "object") {
      addFailure(`${contextIndexPath}.commands must be an object.`);
    } else {
      const verifyCommandKey =
        toNonEmptyString(contract.contextIndexVerifyCommandKey) ??
        "canonicalRulesVerify";
      const syncCommandKey =
        toNonEmptyString(contract.contextIndexSyncCommandKey) ??
        "canonicalRulesSync";
      if (contextIndex.commands[verifyCommandKey] !== "npm run rules:canonical:verify") {
        addFailure(
          `${contextIndexPath}.commands.${verifyCommandKey} must equal "npm run rules:canonical:verify".`,
        );
      }
      if (contextIndex.commands[syncCommandKey] !== "npm run rules:canonical:sync") {
        addFailure(
          `${contextIndexPath}.commands.${syncCommandKey} must equal "npm run rules:canonical:sync".`,
        );
      }
    }
  }

  const policyPathRelative = toPosixPath(
    path.relative(repoRoot, path.resolve(repoRoot, activeConfigPath)),
  );
  const rulesFile =
    toNonEmptyString(config?.contracts?.ruleCatalog?.file) ?? ".agents-config/docs/AGENT_RULES.md";
  const verifyResult = verifyCanonicalRuleset({
    repoRoot,
    policyFile: policyPathRelative || ".agents-config/policies/agent-governance.json",
    rulesFile,
    canonicalFile: canonicalFile ?? ".agents-config/contracts/rules/canonical-ruleset.json",
    overridesSchemaFile:
      overrideSchemaFile ?? ".agents-config/rule-overrides.schema.json",
    overridesFile: overrideFile,
    mode: "check",
  });
  for (const warning of verifyResult.warnings) {
    addWarning(`[${contractPath}] ${warning}`);
  }
  for (const error of verifyResult.errors) {
    addFailure(`[${contractPath}] ${error}`);
  }
}

const POLICY_ENFORCEMENT_CHECK_IDS = new Set([
  "checkDocumentationModelContract",
  "checkContextIndexContract",
  "checkReleaseNotesContract",
  "checkFeatureIndexContract",
  "checkTestMatrixContract",
  "checkRouteMapContract",
  "checkDomainReadmesContract",
  "checkJSDocCoverageContract",
  "checkOpenAPICoverageContract",
  "checkLoggingStandardsContract",
  "checkSessionArtifactsContract",
  "checkManagedFilesCanonicalContract",
  "checkCanonicalRulesContract",
  "checkRuleCatalogContract",
  "checkOrchestratorSubagentContracts",
  "checkWorkspaceLayoutContract",
  "checkRequiredTextSnippets",
  "checkRequiredMarkdownSections",
  "checkRequiredSequenceSnippets",
  "checkPlaceholderMarkers",
  "checkSessionLogEntryFormat",
  "checkMemoryIndexContract",
  "checkForbiddenTextPatterns",
  "checkDisallowedTrackedPathPrefixes",
  "checkPolicyRuleQuality",
]);

function inferRuleEnforcementChecks(ruleId) {
  if (!isNonEmptyString(ruleId)) {
    return [];
  }

  if (ruleId.startsWith("orch_")) {
    return ["checkOrchestratorSubagentContracts"];
  }

  if (
    [
      "rule_execution_queue_required",
      "rule_queue_plan_before_execution",
      "rule_queue_single_source_of_truth",
      "rule_queue_scoped_context_read",
      "rule_queue_archive_on_complete",
      "rule_plan_machine_contract_required",
      "rule_plan_step_reference_required",
      "rule_plan_non_goals_status_gate",
      "rule_plan_placeholder_deliverables_forbidden",
      "rule_plan_complete_step_summary_required",
      "rule_plan_status_coherence_required",
      "rule_post_compaction_rebootstrap",
    ].includes(ruleId)
  ) {
    return ["checkSessionArtifactsContract"];
  }

  if (ruleId === "rule_continuity_required") {
    return ["checkSessionArtifactsContract", "checkMemoryIndexContract"];
  }

  if (ruleId === "rule_startup_read_order") {
    return ["checkDocumentationModelContract"];
  }

  if (["rule_context_index_usage", "rule_context_index_drift_guard"].includes(ruleId)) {
    return ["checkContextIndexContract"];
  }

  if (
    [
      "rule_canonical_ruleset_contract_required",
      "rule_local_rule_overrides_contract_required",
    ].includes(ruleId)
  ) {
    return ["checkCanonicalRulesContract"];
  }

  if (
    [
      "rule_managed_files_known_overrides_only",
      "rule_managed_files_canonical_contract_required",
    ].includes(ruleId)
  ) {
    return ["checkManagedFilesCanonicalContract"];
  }

  if (
    [
      "rule_canonical_agents_root",
      "rule_worktree_root_required",
      "rule_agents_semantic_merge_required",
    ].includes(ruleId)
  ) {
    return ["checkWorkspaceLayoutContract"];
  }

  if (
    [
      "rule_release_notes_template_required",
      "rule_release_notes_changelog_source_required",
    ].includes(ruleId)
  ) {
    return ["checkReleaseNotesContract"];
  }

  if (ruleId === "rule_feature_index_required") {
    return ["checkFeatureIndexContract"];
  }
  if (ruleId === "rule_test_matrix_required") {
    return ["checkTestMatrixContract"];
  }
  if (ruleId === "rule_route_map_required") {
    return ["checkRouteMapContract"];
  }
  if (ruleId === "rule_domain_readmes_required") {
    return ["checkDomainReadmesContract"];
  }
  if (ruleId === "rule_jsdoc_coverage_required") {
    return ["checkJSDocCoverageContract"];
  }
  if (ruleId === "rule_openapi_endpoint_docs_required") {
    return ["checkOpenAPICoverageContract"];
  }
  if (ruleId === "rule_logging_contract_required") {
    return ["checkLoggingStandardsContract"];
  }

  if (
    [
      "rule_scope_tight_no_overbroad_refactor",
      "rule_hybrid_machine_human_contract",
      "rule_policy_sync_required",
      "rule_tdd_default",
      "rule_coverage_default_100",
      "rule_scope_completeness_gate",
    ].includes(ruleId)
  ) {
    return ["checkRequiredTextSnippets"];
  }

  return [];
}

function checkRuleCatalogContract(config) {
  const contractPath = "contracts.ruleCatalog";
  const contract = config?.contracts?.ruleCatalog;
  if (!contract || typeof contract !== "object") {
    addFailure(`${contractPath} is required and must be an object.`);
    return;
  }

  if (contract.file !== ".agents-config/docs/AGENT_RULES.md") {
    addFailure(`${contractPath}.file must equal \".agents-config/docs/AGENT_RULES.md\".`);
    return;
  }

  if (!isPlainObject(contract.requiredIdsByProfile)) {
    addFailure(`${contractPath}.requiredIdsByProfile must be an object.`);
  }

  const { requiredValues: requiredIds } = resolveProfileScopedRequiredStrings({
    config,
    baseValues: contract.requiredIds,
    baseFieldPath: `${contractPath}.requiredIds`,
    byProfileValues: contract.requiredIdsByProfile,
    byProfileFieldPath: `${contractPath}.requiredIdsByProfile`,
  });
  if (requiredIds.length === 0) {
    addFailure(
      `${contractPath} must define at least one required rule id across base and active profile scopes.`,
    );
  }

  const rulesContent = readFileIfPresent(contract.file);
  if (rulesContent === null) {
    return;
  }

  for (const id of requiredIds) {
    const snippet = `\`${id}\``;
    if (!rulesContent.includes(snippet)) {
      addFailure(`${contract.file} must reference rule id ${snippet}.`);
    }

    const enforcingChecks = inferRuleEnforcementChecks(id);
    if (enforcingChecks.length === 0) {
      addFailure(
        `${contractPath} required rule id ${id} has no enforcement-check mapping; update inferRuleEnforcementChecks.`,
      );
      continue;
    }
    for (const checkId of enforcingChecks) {
      if (!POLICY_ENFORCEMENT_CHECK_IDS.has(checkId)) {
        addFailure(
          `${contractPath} required rule id ${id} maps to unknown enforcement check ${checkId}.`,
        );
      }
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
      "orchestrator_id",
      "objective",
      "inputs",
      "constraints",
      "acceptance_criteria",
      "deliverables",
      "verification",
      "atomic_scope",
      "context_budget",
    ],
    contractPath,
  });

  checkRequiredFieldList({
    fieldName: "resultEnvelopeRequiredFields",
    actualFields: contract.resultEnvelopeRequiredFields,
    requiredFields: [
      "status",
      "outputs",
      "evidence",
      "unresolved_questions",
      "concise_summary",
    ],
    contractPath,
  });

  if (!contract.topology || typeof contract.topology !== "object") {
    addFailure(`${contractPath}.topology must be an object.`);
  } else {
    if (contract.topology.singleOrchestratorOnly !== true) {
      addFailure(`${contractPath}.topology.singleOrchestratorOnly must be true.`);
    }
    if (contract.topology.allowSubagentDelegation !== false) {
      addFailure(`${contractPath}.topology.allowSubagentDelegation must be false.`);
    }
  }

  if (contract.subagentDelegationRequiredWhenPossible !== true) {
    addFailure(`${contractPath}.subagentDelegationRequiredWhenPossible must be true.`);
  }
  if (contract.delegationForDiscoveryRequiredWhenPossible !== true) {
    addFailure(
      `${contractPath}.delegationForDiscoveryRequiredWhenPossible must be true.`,
    );
  }
  if (contract.delegationForImplementationRequiredWhenPossible !== true) {
    addFailure(
      `${contractPath}.delegationForImplementationRequiredWhenPossible must be true.`,
    );
  }
  if (contract.strictAtomicTaskBriefsRequired !== true) {
    addFailure(`${contractPath}.strictAtomicTaskBriefsRequired must be true.`);
  }
  if (contract.closeSubagentOnCompletionRequired !== true) {
    addFailure(`${contractPath}.closeSubagentOnCompletionRequired must be true.`);
  }
  if (contract.idleSubagentReleaseRequired !== true) {
    addFailure(`${contractPath}.idleSubagentReleaseRequired must be true.`);
  }
  if (
    !Number.isInteger(contract.idleSubagentMaxIdleMinutes) ||
    contract.idleSubagentMaxIdleMinutes < 1
  ) {
    addFailure(`${contractPath}.idleSubagentMaxIdleMinutes must be a positive integer.`);
  }

  if (!contract.verbosityBudgets || typeof contract.verbosityBudgets !== "object") {
    addFailure(`${contractPath}.verbosityBudgets must be an object.`);
  } else {
    const requiredBudgetFields = [
      "subagentObjectiveMaxWords",
      "subagentInputContextMaxWords",
      "subagentSummaryMaxWords",
      "specOutlineMaxWords",
      "refinedSpecMaxWords",
      "implementationTaskMaxWords",
    ];
    for (const fieldName of requiredBudgetFields) {
      const value = contract.verbosityBudgets[fieldName];
      if (!Number.isInteger(value) || value <= 0) {
        addFailure(
          `${contractPath}.verbosityBudgets.${fieldName} must be a positive integer.`,
        );
      }
    }

    const objectiveMax = contract.verbosityBudgets.subagentObjectiveMaxWords;
    const inputMax = contract.verbosityBudgets.subagentInputContextMaxWords;
    const summaryMax = contract.verbosityBudgets.subagentSummaryMaxWords;
    const specMax = contract.verbosityBudgets.specOutlineMaxWords;
    const refinedMax = contract.verbosityBudgets.refinedSpecMaxWords;
    const taskMax = contract.verbosityBudgets.implementationTaskMaxWords;

    if (
      Number.isInteger(objectiveMax) &&
      Number.isInteger(inputMax) &&
      objectiveMax > inputMax
    ) {
      addFailure(
        `${contractPath}.verbosityBudgets.subagentObjectiveMaxWords must be <= subagentInputContextMaxWords.`,
      );
    }
    if (
      Number.isInteger(summaryMax) &&
      Number.isInteger(inputMax) &&
      summaryMax > inputMax
    ) {
      addFailure(
        `${contractPath}.verbosityBudgets.subagentSummaryMaxWords must be <= subagentInputContextMaxWords.`,
      );
    }
    if (Number.isInteger(specMax) && Number.isInteger(refinedMax) && specMax > refinedMax) {
      addFailure(
        `${contractPath}.verbosityBudgets.specOutlineMaxWords must be <= refinedSpecMaxWords.`,
      );
    }
    if (
      Number.isInteger(taskMax) &&
      Number.isInteger(refinedMax) &&
      taskMax > refinedMax
    ) {
      addFailure(
        `${contractPath}.verbosityBudgets.implementationTaskMaxWords must be <= refinedSpecMaxWords.`,
      );
    }
  }

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
    const expectedModelRouting = {
      orchestrator: "gpt-5.3-codex",
      subagent: "gpt-5.3-codex",
      lowRiskLoop: "gpt-5.3-codex-spark",
    };
    for (const [fieldName, expectedModel] of Object.entries(expectedModelRouting)) {
      const actualModel = toNonEmptyString(contract.defaultModelRouting[fieldName]);
      if (actualModel !== expectedModel) {
        addFailure(
          `${contractPath}.defaultModelRouting.${fieldName} must equal "${expectedModel}".`,
        );
      }
    }
  }

  if (
    !contract.defaultReasoningEffortRouting ||
    typeof contract.defaultReasoningEffortRouting !== "object"
  ) {
    addFailure(`${contractPath}.defaultReasoningEffortRouting must be an object.`);
  } else {
    const expectedEffortRouting = {
      orchestrator: "xhigh",
      subagent: "high",
      lowRiskLoop: "medium",
    };
    for (const [fieldName, expectedEffort] of Object.entries(expectedEffortRouting)) {
      const actualEffort = toNonEmptyString(
        contract.defaultReasoningEffortRouting[fieldName],
      );
      if (actualEffort !== expectedEffort) {
        addFailure(
          `${contractPath}.defaultReasoningEffortRouting.${fieldName} must equal "${expectedEffort}".`,
        );
      }
    }
  }

  if (
    !contract.claudeModelRouting ||
    typeof contract.claudeModelRouting !== "object"
  ) {
    addFailure(`${contractPath}.claudeModelRouting must be an object.`);
  } else {
    const expectedClaudeModelRouting = {
      orchestrator: "claude-opus-4-6",
      subagent: "claude-opus-4-6",
      alternativeSubagent: "claude-sonnet-4-6",
      lowRiskLoop: "claude-haiku-4-5",
    };
    for (const [fieldName, expectedModel] of Object.entries(expectedClaudeModelRouting)) {
      const actualModel = toNonEmptyString(contract.claudeModelRouting[fieldName]);
      if (actualModel !== expectedModel) {
        addFailure(
          `${contractPath}.claudeModelRouting.${fieldName} must equal "${expectedModel}".`,
        );
      }
    }
  }

  if (
    !contract.claudeDelegationToCodex ||
    typeof contract.claudeDelegationToCodex !== "object"
  ) {
    addFailure(`${contractPath}.claudeDelegationToCodex must be an object.`);
  } else {
    const preferredMethod = toNonEmptyString(contract.claudeDelegationToCodex.preferredMethod);
    if (preferredMethod !== "codex_exec") {
      addFailure(
        `${contractPath}.claudeDelegationToCodex.preferredMethod must equal "codex_exec".`,
      );
    }
  }

  if (!contract.lowRiskSparkPolicy || typeof contract.lowRiskSparkPolicy !== "object") {
    addFailure(`${contractPath}.lowRiskSparkPolicy must be an object.`);
  } else {
    checkRequiredFieldList({
      fieldName: "allowedTaskClasses",
      actualFields: contract.lowRiskSparkPolicy.allowedTaskClasses,
      requiredFields: ["single_file_edit", "grep_triage", "draft_rewrite"],
      contractPath: `${contractPath}.lowRiskSparkPolicy`,
    });

    if (contract.lowRiskSparkPolicy.explicitVerificationCommandsRequired !== true) {
      addFailure(
        `${contractPath}.lowRiskSparkPolicy.explicitVerificationCommandsRequired must be true.`,
      );
    }
    if (contract.lowRiskSparkPolicy.minimumVerificationCommands !== 1) {
      addFailure(
        `${contractPath}.lowRiskSparkPolicy.minimumVerificationCommands must equal 1.`,
      );
    }

    const requiredCommands = validateStringArray(
      contract.lowRiskSparkPolicy.requiredVerificationCommands,
      `${contractPath}.lowRiskSparkPolicy.requiredVerificationCommands`,
    );
    if (!requiredCommands.includes("node .agents-config/scripts/enforce-agent-policies.mjs")) {
      addFailure(
        `${contractPath}.lowRiskSparkPolicy.requiredVerificationCommands must include "node .agents-config/scripts/enforce-agent-policies.mjs".`,
      );
    }
    const requiredEvidencePrefix = toNonEmptyString(
      contract.lowRiskSparkPolicy.requiredEvidencePrefix,
    );
    if (requiredEvidencePrefix !== "verify:") {
      addFailure(`${contractPath}.lowRiskSparkPolicy.requiredEvidencePrefix must equal "verify:".`);
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
    "orch_operator_subagent_default",
    "orch_subagent_delegation_required_when_possible",
    "orch_human_nuance_addendum",
    "orch_atomic_task_delegation",
    "orch_dual_channel_result_envelope",
    "orch_orchestrator_coordination_only",
    "orch_release_idle_subagents_required",
    "orch_default_cli_routing",
    "orch_unconfirmed_unknowns",
    "orch_atomic_single_objective_scope",
    "orch_single_orchestrator_authority",
    "orch_concise_subagent_briefs",
    "orch_spec_refined_plan_verbosity",
    "orch_codex_model_default",
    "orch_claude_model_default",
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

  const rulesContent = readFileIfPresent(".agents-config/docs/AGENT_RULES.md");
  if (rulesContent !== null) {
    for (const requiredRuleId of requiredRuleIds) {
      const idSnippet = `\`${requiredRuleId}\``;
      if (!rulesContent.includes(idSnippet)) {
        addFailure(`.agents-config/docs/AGENT_RULES.md must reference contract id ${idSnippet}.`);
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

  const placeholderRules = config?.checks?.placeholderMarkers ?? [];
  for (const rule of placeholderRules) {
    const patterns = normalizeStringArray(rule?.patterns);
    const regexPatterns = normalizeStringArray(rule?.regexPatterns);
    if (patterns.length === 0 && regexPatterns.length === 0) {
      addWarning(`placeholderMarkers rule for ${rule.file} has no patterns.`);
      continue;
    }

    const seen = new Set();
    for (const pattern of patterns) {
      if (seen.has(pattern)) {
        addWarning(
          `Duplicate placeholder literal pattern in policy config for ${rule.file}: ${pattern}`,
        );
      }
      seen.add(pattern);
    }

    const seenRegex = new Set();
    for (const pattern of regexPatterns) {
      if (seenRegex.has(pattern)) {
        addWarning(
          `Duplicate placeholder regex pattern in policy config for ${rule.file}: ${pattern}`,
        );
      }
      seenRegex.add(pattern);
    }
  }
}

function runPolicyChecks(activeConfigPath = configPath, options = {}) {
  const runOptions = {
    ci: cliArgs.ci === true,
    ...(options && typeof options === "object" ? options : {}),
  };
  activeRunOptions = runOptions;

  const repoRoot = resolveRepoRoot();
  process.chdir(repoRoot);
  const workspaceLayoutBaseRepoRoot = resolvePrimaryRepoRoot(repoRoot);

  failures.length = 0;
  warnings.length = 0;

  const absoluteConfigPath = path.resolve(repoRoot, activeConfigPath);
  const config = readJson(absoluteConfigPath);
  const workspaceLayout = config?.contracts?.workspaceLayout ?? {};
  const canonicalRepoRoot = toNonEmptyString(workspaceLayout.canonicalRepoRoot)
    ? resolvePathFromBase(workspaceLayout.canonicalRepoRoot, workspaceLayoutBaseRepoRoot)
    : path.resolve(repoRoot);
  const canonicalAgentsRoot = toNonEmptyString(workspaceLayout.canonicalAgentsRoot)
    ? resolvePathFromBase(workspaceLayout.canonicalAgentsRoot, canonicalRepoRoot)
    : path.resolve(canonicalRepoRoot, ".agents");
  agentsAwareReadResolver = (targetPath) =>
    resolveAgentsAwarePath({
      repoRoot,
      canonicalAgentsRoot,
      targetPath,
    });
  const { files: trackedFiles, reliable: trackedFilesReliable } = listTrackedFiles();

  checkPolicyMetadata(config);
  checkWorkspaceLayoutContract(config, repoRoot, workspaceLayoutBaseRepoRoot);
  checkDocumentationModelContract(config);
  checkContextIndexContract(config);
  checkReleaseNotesContract(config);
  checkFeatureIndexContract(config);
  checkTestMatrixContract(config);
  checkRouteMapContract(config);
  checkDomainReadmesContract(config);
  checkJSDocCoverageContract(config);
  checkOpenAPICoverageContract(config);
  checkLoggingStandardsContract(config);
  checkSessionArtifactsContract(config);
  checkManagedFilesCanonicalContract(config);
  checkCanonicalRulesContract(config, repoRoot, activeConfigPath);
  checkRuleCatalogContract(config);
  checkOrchestratorSubagentContracts(config);
  checkPolicyRuleQuality(config);
  checkRequiredTextSnippets(config);
  checkRequiredMarkdownSections(config);
  checkRequiredSequenceSnippets(config);
  checkPlaceholderMarkers(config);
  checkSessionLogEntryFormat(config);
  checkMemoryIndexContract(config);
  checkForbiddenTextPatterns(config, trackedFiles, trackedFilesReliable);
  checkDisallowedTrackedPathPrefixes(config, trackedFiles, trackedFilesReliable);

  return {
    config,
    warnings: [...warnings],
    failures: [...failures],
  };
}

function main() {
  const { config, warnings: runWarnings, failures: runFailures } = runPolicyChecks(
    configPath,
    {
      ci: cliArgs.ci === true,
    },
  );

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
