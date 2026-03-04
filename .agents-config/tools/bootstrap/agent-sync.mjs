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
const AGENT_RULES_PATH = ".agents-config/docs/AGENT_RULES.md";
const AGENT_CONTEXT_PATH = ".agents-config/docs/AGENT_CONTEXT.md";
const TEMPLATE_BOOTSTRAP_PATH = ".agents-config/tools/bootstrap/bootstrap.mjs";
const LOCAL_BOOTSTRAP_PROJECT_PATH = ".agents-config/tools/bootstrap/bootstrap-project.mjs";
const GOVERNANCE_ID_SUFFIX = "-agent-governance";
const TOOLING_ID_SUFFIX = "-tooling-config";
const AUTO_SYNC_BLOCK_HEADING = "## Auto-Synced Policy Remediation";
const AUTO_SYNC_BLOCK_NOTE = "<!-- managed by agent:sync conservative remediation -->";
const DEFAULT_ACTIVE_PROFILES = ["base"];

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

function runAllowFailure(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", encoding: "utf8" });
  if (result.error) {
    fail(`Failed to run ${cmd}: ${result.error.message}`);
  }
  return result.status === 0;
}

function runOptional(cmd, args, cwd) {
  const ok = runAllowFailure(cmd, args, cwd);
  if (!ok) {
    console.warn(`Optional command failed (${cmd} ${args.join(" ")}); continuing.`);
  }
  return ok;
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function profileScopeIsActive(activeProfiles, requiredProfiles) {
  const required = normalizeStringArray(requiredProfiles);
  if (required.length === 0) {
    return true;
  }
  return required.some((profile) => activeProfiles.has(profile));
}

function getActiveProfiles(policy) {
  const configured = normalizeStringArray(policy?.contracts?.profiles?.activeProfiles);
  if (configured.length > 0) {
    return new Set(configured);
  }
  return new Set(DEFAULT_ACTIVE_PROFILES);
}

function collectRequiredRuleIds(policy, activeProfiles) {
  const contract = isPlainObject(policy?.contracts?.ruleCatalog)
    ? policy.contracts.ruleCatalog
    : {};
  const ids = [];
  const seen = new Set();
  const append = (value) => {
    const text = toNonEmptyString(value);
    if (!text || seen.has(text)) {
      return;
    }
    seen.add(text);
    ids.push(text);
  };

  for (const id of normalizeStringArray(contract.requiredIds)) {
    append(id);
  }

  const byProfile = isPlainObject(contract.requiredIdsByProfile)
    ? contract.requiredIdsByProfile
    : {};
  for (const profile of activeProfiles) {
    for (const id of normalizeStringArray(byProfile[profile])) {
      append(id);
    }
  }

  return ids;
}

function collectRequiredSnippets(policy, activeProfiles, filePath) {
  const snippets = [];
  const seen = new Set();
  const checks = Array.isArray(policy?.checks?.requiredTextSnippets)
    ? policy.checks.requiredTextSnippets
    : [];
  for (const rule of checks) {
    if (rule?.file !== filePath) {
      continue;
    }
    if (!profileScopeIsActive(activeProfiles, rule?.profiles)) {
      continue;
    }
    for (const snippet of normalizeStringArray(rule?.snippets)) {
      if (seen.has(snippet)) {
        continue;
      }
      seen.add(snippet);
      snippets.push(snippet);
    }
  }
  return snippets;
}

function splitLines(content) {
  const normalized = content.replace(/\r\n/g, "\n");
  const hadTrailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (hadTrailingNewline) {
    lines.pop();
  }
  return {
    lines,
    hadTrailingNewline,
  };
}

function joinLines(lines, hadTrailingNewline) {
  const output = lines.join("\n");
  return hadTrailingNewline ? `${output}\n` : output;
}

function findHeadingIndex(lines, heading) {
  return lines.findIndex((line) => line.trim() === heading);
}

function findLineInRange(lines, start, end, target) {
  for (let index = start; index < end; index += 1) {
    if (lines[index].trim() === target) {
      return index;
    }
  }
  return -1;
}

function findSectionEnd(lines, headingIndex) {
  if (headingIndex < 0 || headingIndex >= lines.length) {
    return lines.length;
  }
  const match = lines[headingIndex].trim().match(/^(#+)\s+/);
  if (!match) {
    return lines.length;
  }
  const level = match[1].length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const headingMatch = lines[index].trim().match(/^(#+)\s+/);
    if (headingMatch && headingMatch[1].length <= level) {
      return index;
    }
  }
  return lines.length;
}

function insertUniqueLines(lines, insertAt, newLines) {
  const existing = new Set(lines.map((line) => line.trimEnd()));
  const filtered = [];
  for (const candidate of newLines) {
    const text = typeof candidate === "string" ? candidate : "";
    const key = text.trimEnd();
    if (existing.has(key)) {
      continue;
    }
    existing.add(key);
    filtered.push(text);
  }
  if (filtered.length === 0) {
    return false;
  }
  lines.splice(insertAt, 0, ...filtered);
  return true;
}

function toBulletLine(text) {
  const snippet = toNonEmptyString(text);
  if (!snippet) {
    return null;
  }
  return snippet.startsWith("- ") ? snippet : `- ${snippet}`;
}

function appendAutoSyncedBlock(lines, entries) {
  const normalized = [];
  for (const entry of entries) {
    const text = toNonEmptyString(entry);
    if (text) {
      normalized.push(text);
    }
  }
  if (normalized.length === 0) {
    return false;
  }

  let changed = false;
  const headingIndex = findHeadingIndex(lines, AUTO_SYNC_BLOCK_HEADING);
  if (headingIndex >= 0) {
    const sectionEnd = findSectionEnd(lines, headingIndex);
    if (lines[sectionEnd - 1]?.trim() !== "") {
      changed = insertUniqueLines(lines, sectionEnd, ["", ...normalized]) || changed;
    } else {
      changed = insertUniqueLines(lines, sectionEnd, normalized) || changed;
    }
    return changed;
  }

  if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
    lines.push("");
  }
  lines.push(AUTO_SYNC_BLOCK_HEADING);
  lines.push(AUTO_SYNC_BLOCK_NOTE);
  lines.push(...normalized);
  return true;
}

function isTestingSnippet(snippet) {
  return /(acceptance criteria|tests-first|tdd|regression coverage|coverage|targeted impacted-suite)/i.test(
    snippet,
  );
}

function writeFileIfChanged(filePath, nextContent) {
  const current = fs.readFileSync(filePath, "utf8");
  if (current === nextContent) {
    return false;
  }
  fs.writeFileSync(filePath, nextContent, "utf8");
  return true;
}

function remediateAgentRulesFile({ repoRoot, policy, activeProfiles }) {
  const filePath = path.resolve(repoRoot, AGENT_RULES_PATH);
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const currentContent = fs.readFileSync(filePath, "utf8");
  const requiredIds = collectRequiredRuleIds(policy, activeProfiles);
  const requiredSnippets = collectRequiredSnippets(policy, activeProfiles, AGENT_RULES_PATH);
  const missingIds = requiredIds.filter((id) => !currentContent.includes(`\`${id}\``));
  const missingSnippets = requiredSnippets.filter((snippet) => !currentContent.includes(snippet));
  if (missingIds.length === 0 && missingSnippets.length === 0) {
    return false;
  }

  const { lines, hadTrailingNewline } = splitLines(currentContent);
  let changed = false;
  const autoEntries = [];

  const catalogHeading = "## Rule ID Catalog (Machine Cross-Reference)";
  const testingHeading = "### Testing and Quality Expectations";
  let catalogIndex = findHeadingIndex(lines, catalogHeading);
  let testingIndex = findHeadingIndex(lines, testingHeading);

  if (missingIds.length > 0) {
    if (catalogIndex >= 0) {
      const sectionEnd = findSectionEnd(lines, catalogIndex);
      const additions = missingIds.map((id) => `- \`${id}\``);
      changed = insertUniqueLines(lines, sectionEnd, additions) || changed;
    } else {
      for (const id of missingIds) {
        autoEntries.push(`- \`${id}\``);
      }
    }
  }

  catalogIndex = findHeadingIndex(lines, catalogHeading);
  testingIndex = findHeadingIndex(lines, testingHeading);
  let workingContent = lines.join("\n");
  const testingInsertions = [];

  for (const snippet of missingSnippets) {
    if (workingContent.includes(snippet)) {
      continue;
    }

    if (snippet.startsWith("## ") || snippet.startsWith("### ")) {
      autoEntries.push(snippet);
      workingContent += `\n${snippet}`;
      continue;
    }

    const isRuleSnippet =
      /^`[^`]+`$/.test(snippet) || /`(?:rule|orch)_[^`]+`/.test(snippet);
    if (isRuleSnippet && catalogIndex >= 0) {
      const sectionEnd = findSectionEnd(lines, catalogIndex);
      const line = toBulletLine(snippet);
      if (line) {
        changed = insertUniqueLines(lines, sectionEnd, [line]) || changed;
        workingContent = lines.join("\n");
      }
      continue;
    }

    if (testingIndex >= 0 && isTestingSnippet(snippet)) {
      const line = toBulletLine(snippet);
      if (line) {
        testingInsertions.push(line);
      }
      continue;
    }

    const line = toBulletLine(snippet);
    if (line) {
      autoEntries.push(line);
      workingContent += `\n${line}`;
    }
  }

  if (testingInsertions.length > 0) {
    if (testingIndex >= 0) {
      const sectionEnd = findSectionEnd(lines, testingIndex);
      changed = insertUniqueLines(lines, sectionEnd, testingInsertions) || changed;
    } else {
      autoEntries.push(testingHeading, ...testingInsertions);
    }
  }

  changed = appendAutoSyncedBlock(lines, autoEntries) || changed;
  if (!changed) {
    return false;
  }

  const nextContent = joinLines(lines, hadTrailingNewline);
  return writeFileIfChanged(filePath, nextContent);
}

function remediateAgentContextFile({ repoRoot, policy, activeProfiles }) {
  const filePath = path.resolve(repoRoot, AGENT_CONTEXT_PATH);
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const currentContent = fs.readFileSync(filePath, "utf8");
  const requiredSnippets = collectRequiredSnippets(policy, activeProfiles, AGENT_CONTEXT_PATH);
  const missingSnippets = requiredSnippets.filter((snippet) => !currentContent.includes(snippet));
  if (missingSnippets.length === 0) {
    return false;
  }

  const { lines, hadTrailingNewline } = splitLines(currentContent);
  let changed = false;
  const autoEntries = [];
  const testingBullets = [];

  for (const snippet of missingSnippets) {
    if (snippet.startsWith("## ")) {
      autoEntries.push(snippet);
      continue;
    }
    if (isTestingSnippet(snippet)) {
      const line = toBulletLine(snippet);
      if (line) {
        testingBullets.push(line);
      }
      continue;
    }
    const line = toBulletLine(snippet);
    if (line) {
      autoEntries.push(line);
    }
  }

  if (testingBullets.length > 0) {
    const testingIndex = findHeadingIndex(lines, "## Testing");
    if (testingIndex >= 0) {
      const sectionEnd = findSectionEnd(lines, testingIndex);
      const defaultExpectationsIndex = findLineInRange(
        lines,
        testingIndex + 1,
        sectionEnd,
        "Default expectations:",
      );
      if (defaultExpectationsIndex >= 0) {
        let insertAt = defaultExpectationsIndex + 1;
        while (insertAt < sectionEnd && lines[insertAt].trim().startsWith("- ")) {
          insertAt += 1;
        }
        changed = insertUniqueLines(lines, insertAt, testingBullets) || changed;
      } else {
        const additions = [];
        if (lines[sectionEnd - 1]?.trim() !== "") {
          additions.push("");
        }
        additions.push("Default expectations:", ...testingBullets);
        changed = insertUniqueLines(lines, sectionEnd, additions) || changed;
      }
    } else {
      autoEntries.push("## Testing", "Default expectations:", ...testingBullets);
    }
  }

  changed = appendAutoSyncedBlock(lines, autoEntries) || changed;
  if (!changed) {
    return false;
  }

  const nextContent = joinLines(lines, hadTrailingNewline);
  return writeFileIfChanged(filePath, nextContent);
}

function toIsoTimestampNoMilliseconds(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function extractSessionLogMessage(rawEntry) {
  const original = toNonEmptyString(rawEntry) ?? "";
  if (!original) {
    return "Session entry normalized.";
  }

  let text = original.replace(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z\s+/,
    "",
  );
  text = text.replace(/^\[(USER|CODE|TOOL|ASSUMPTION|MILESTONE)\]\s+/, "");
  const message = toNonEmptyString(text);
  return message ?? original;
}

function remediateSessionLogFile({ repoRoot, policy }) {
  const rule = policy?.checks?.sessionLogEntryFormat;
  if (!isPlainObject(rule)) {
    return false;
  }
  const relativePath = toNonEmptyString(rule.file);
  if (!relativePath) {
    return false;
  }
  const filePath = path.resolve(repoRoot, relativePath);
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const content = fs.readFileSync(filePath, "utf8");
  const entryRegexText = toNonEmptyString(rule.entryRegex);
  if (!entryRegexText) {
    return false;
  }
  let entryRegex;
  try {
    entryRegex = new RegExp(entryRegexText);
  } catch {
    return false;
  }
  const sectionHeaders = new Set(normalizeStringArray(rule.sectionHeaders));
  if (sectionHeaders.size === 0) {
    return false;
  }

  const { lines, hadTrailingNewline } = splitLines(content);
  let changed = false;
  let activeTrackedSection = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
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
    if (entryRegex.test(trimmed)) {
      continue;
    }

    const rawEntry = trimmed.slice(2).trim();
    const message = extractSessionLogMessage(rawEntry);
    lines[index] = `- ${toIsoTimestampNoMilliseconds()} [TOOL] ${message}`;
    changed = true;
  }

  if (!changed) {
    return false;
  }

  const nextContent = joinLines(lines, hadTrailingNewline);
  return writeFileIfChanged(filePath, nextContent);
}

function applyConservativePolicyRemediation(repoRoot) {
  const result = {
    docsChanged: false,
    rulesChanged: false,
    contextChanged: false,
    sessionLogChanged: false,
  };

  const policyPath = path.resolve(repoRoot, POLICY_PATH);
  if (!fs.existsSync(policyPath)) {
    runOptional("npm", ["run", "openapi-coverage:generate", "--if-present"], repoRoot);
    return result;
  }

  try {
    const policy = readJson(policyPath);
    const activeProfiles = getActiveProfiles(policy);
    result.rulesChanged = remediateAgentRulesFile({ repoRoot, policy, activeProfiles });
    result.contextChanged = remediateAgentContextFile({ repoRoot, policy, activeProfiles });
    result.sessionLogChanged = remediateSessionLogFile({ repoRoot, policy });
    result.docsChanged = result.rulesChanged || result.contextChanged;
  } catch (error) {
    console.warn(
      `Conservative remediation failed to complete: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  runOptional("npm", ["run", "openapi-coverage:generate", "--if-present"], repoRoot);
  return result;
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
  const isTemplateSourceSelfSync = path.resolve(templateRoot) === path.resolve(repoRoot);

  if (isTemplateSourceSelfSync) {
    console.warn("Template source repo detected; skipping bootstrap self-sync step.");
  } else if (fs.existsSync(templateBootstrapPath) && fs.statSync(templateBootstrapPath).isFile()) {
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

  const policyPassed = runAllowFailure("npm", ["run", "policy:check"], repoRoot);
  if (!policyPassed) {
    const remediation = applyConservativePolicyRemediation(repoRoot);
    if (remediation.docsChanged) {
      run("npm", ["run", "rules:canonical:sync"], repoRoot);
    }
    const postRemediationPolicyPassed = runAllowFailure(
      "npm",
      ["run", "policy:check"],
      repoRoot,
    );
    if (!postRemediationPolicyPassed) {
      fail("Command failed (npm run policy:check).");
    }
  }

  run("npm", ["run", "agent:preflight"], repoRoot);
}

main();
