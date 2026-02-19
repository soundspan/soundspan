#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runPolicyChecks } from "./enforce-agent-policies.mjs";

const POLICY_PATH = ".github/policies/agent-governance.json";

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureJsonTemplate(filePath, templateFactory) {
  if (!fs.existsSync(filePath)) {
    const template = templateFactory();
    writeJson(filePath, template);
    return { data: template, created: true };
  }

  return { data: readJson(filePath), created: false };
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

function parseJsonSafe(rawText) {
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(rawText);
  } catch (_error) {
    return null;
  }
}

function normalizeStringList(value, limit = 20) {
  if (!Array.isArray(value)) {
    return [];
  }

  const output = [];
  for (const entry of value) {
    const text = typeof entry === "string" ? entry.trim() : "";
    if (!text) {
      continue;
    }
    output.push(text);
    if (output.length >= limit) {
      break;
    }
  }
  return output;
}

function isMissingIndexArtifactsPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const errors = normalizeStringList(payload.errors, 50);
  if (errors.length === 0) {
    return false;
  }

  return errors.every((error) => /^Missing [A-Za-z0-9._-]+$/.test(error));
}

function runRepositoryIndexReadiness({
  enabled,
  verifyStrict,
  buildIfMissing,
  reindexBeforeVerify,
  closeoutVerifyIfPossible,
  failureMode,
}) {
  const verifyArgs = ["tools/index/indexer.mjs", "verify"];
  if (verifyStrict) {
    verifyArgs.push("--strict");
  }
  verifyArgs.push("--json");

  const summary = {
    enabled,
    verify_strict: verifyStrict,
    build_if_missing: buildIfMissing,
    reindex_before_verify: reindexBeforeVerify,
    closeout_verify_if_possible: closeoutVerifyIfPossible,
    failure_mode: failureMode,
    preflight_state: enabled ? "pending" : "disabled",
    index_present: null,
    output_dir: null,
    check_error: null,
    verify: {
      command: `node ${verifyArgs.join(" ")}`,
      state: "not_run",
      exit_status: null,
      status: null,
      warnings: [],
      errors: [],
    },
    build: {
      command: "node tools/index/indexer.mjs build --json",
      state: "not_run",
      exit_status: null,
      status: null,
      warnings: [],
      errors: [],
    },
    verify_after_build: {
      command: `node ${verifyArgs.join(" ")}`,
      state: "not_run",
      exit_status: null,
      status: null,
      warnings: [],
      errors: [],
    },
  };

  if (!enabled) {
    return summary;
  }

  if (reindexBeforeVerify) {
    const buildResult = runCommandSafe("node", [
      "tools/index/indexer.mjs",
      "build",
      "--json",
    ]);
    const buildPayload = parseJsonSafe(buildResult.stdout);

    summary.build.state = buildResult.ok ? "pass" : "fail";
    summary.build.exit_status = buildResult.status;
    summary.build.status = toNonEmptyString(buildPayload?.status) ?? (buildResult.ok ? "ok" : "error");
    summary.build.warnings = normalizeStringList(buildPayload?.warnings);
    summary.build.errors = normalizeStringList(buildPayload?.errors);
    summary.output_dir = toNonEmptyString(buildPayload?.output_dir);

    if (!buildResult.ok) {
      const buildFailureSummary =
        summary.build.errors[0] ??
        summarizeErrorText(buildResult.stderr) ??
        summarizeErrorText(buildResult.stdout);
      summary.preflight_state = "fail";
      summary.check_error = buildFailureSummary ?? "Repository index build failed.";
      return summary;
    }

    const verifyAfterBuildResult = runCommandSafe("node", verifyArgs);
    const verifyAfterBuildPayload = parseJsonSafe(verifyAfterBuildResult.stdout);
    summary.verify_after_build.state = verifyAfterBuildResult.ok ? "pass" : "fail";
    summary.verify_after_build.exit_status = verifyAfterBuildResult.status;
    summary.verify_after_build.status =
      toNonEmptyString(verifyAfterBuildPayload?.status) ??
      (verifyAfterBuildResult.ok ? "ok" : "error");
    summary.verify_after_build.warnings = normalizeStringList(
      verifyAfterBuildPayload?.warnings,
    );
    summary.verify_after_build.errors = normalizeStringList(
      verifyAfterBuildPayload?.errors,
    );
    if (!summary.output_dir) {
      summary.output_dir = toNonEmptyString(verifyAfterBuildPayload?.output_dir);
    }

    if (!verifyAfterBuildResult.ok) {
      const verifyAfterBuildFailureSummary =
        summary.verify_after_build.errors[0] ??
        summarizeErrorText(verifyAfterBuildResult.stderr) ??
        summarizeErrorText(verifyAfterBuildResult.stdout);
      summary.preflight_state = "fail";
      summary.check_error =
        verifyAfterBuildFailureSummary ??
        "Repository index verify failed after build.";
      return summary;
    }

    summary.index_present = true;
    summary.preflight_state = "built_and_verified";
    return summary;
  }

  const verifyResult = runCommandSafe("node", verifyArgs);
  const verifyPayload = parseJsonSafe(verifyResult.stdout);
  summary.verify.state = verifyResult.ok ? "pass" : "fail";
  summary.verify.exit_status = verifyResult.status;
  summary.verify.status = toNonEmptyString(verifyPayload?.status) ?? (verifyResult.ok ? "ok" : "error");
  summary.verify.warnings = normalizeStringList(verifyPayload?.warnings);
  summary.verify.errors = normalizeStringList(verifyPayload?.errors);
  summary.output_dir = toNonEmptyString(verifyPayload?.output_dir);

  if (verifyResult.ok) {
    summary.index_present = true;
    summary.preflight_state = "ready";
    return summary;
  }

  const verifyFailureSummary =
    summary.verify.errors[0] ??
    summarizeErrorText(verifyResult.stderr) ??
    summarizeErrorText(verifyResult.stdout);

  const missingIndexArtifacts = isMissingIndexArtifactsPayload(verifyPayload);
  summary.index_present = !missingIndexArtifacts;

  if (!missingIndexArtifacts || !buildIfMissing) {
    summary.preflight_state = "fail";
    summary.check_error = verifyFailureSummary ?? "Repository index strict verify failed.";
    return summary;
  }

  summary.verify.state = "missing";
  const buildResult = runCommandSafe("node", [
    "tools/index/indexer.mjs",
    "build",
    "--json",
  ]);
  const buildPayload = parseJsonSafe(buildResult.stdout);

  summary.build.state = buildResult.ok ? "pass" : "fail";
  summary.build.exit_status = buildResult.status;
  summary.build.status = toNonEmptyString(buildPayload?.status) ?? (buildResult.ok ? "ok" : "error");
  summary.build.warnings = normalizeStringList(buildPayload?.warnings);
  summary.build.errors = normalizeStringList(buildPayload?.errors);

  if (!buildResult.ok) {
    const buildFailureSummary =
      summary.build.errors[0] ??
      summarizeErrorText(buildResult.stderr) ??
      summarizeErrorText(buildResult.stdout);
    summary.preflight_state = "fail";
    summary.check_error = buildFailureSummary ?? "Repository index build failed.";
    return summary;
  }

  const verifyAfterBuildResult = runCommandSafe("node", verifyArgs);
  const verifyAfterBuildPayload = parseJsonSafe(verifyAfterBuildResult.stdout);
  summary.verify_after_build.state = verifyAfterBuildResult.ok ? "pass" : "fail";
  summary.verify_after_build.exit_status = verifyAfterBuildResult.status;
  summary.verify_after_build.status =
    toNonEmptyString(verifyAfterBuildPayload?.status) ??
    (verifyAfterBuildResult.ok ? "ok" : "error");
  summary.verify_after_build.warnings = normalizeStringList(
    verifyAfterBuildPayload?.warnings,
  );
  summary.verify_after_build.errors = normalizeStringList(
    verifyAfterBuildPayload?.errors,
  );
  if (!summary.output_dir) {
    summary.output_dir = toNonEmptyString(verifyAfterBuildPayload?.output_dir);
  }

  if (!verifyAfterBuildResult.ok) {
    const verifyAfterBuildFailureSummary =
      summary.verify_after_build.errors[0] ??
      summarizeErrorText(verifyAfterBuildResult.stderr) ??
      summarizeErrorText(verifyAfterBuildResult.stdout);
    summary.preflight_state = "fail";
    summary.check_error =
      verifyAfterBuildFailureSummary ??
      "Repository index verify failed after build.";
    return summary;
  }

  summary.index_present = true;
  summary.preflight_state = "built_and_verified";
  return summary;
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
  const gitProbe = runCommandSafe("git", ["rev-parse", "--show-toplevel"]);
  if (gitProbe.ok && gitProbe.stdout.length > 0) {
    return gitProbe.stdout;
  }

  return findRepoRootByGitDir(process.cwd());
}

function isPathWithin(candidatePath, parentPath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function ensureWorktreeAgentsSymlink({
  repoRoot,
  canonicalRepoRoot,
  canonicalAgentsRoot,
  worktreesRoot,
}) {
  const repoRootResolved = path.resolve(repoRoot);
  const canonicalRepoRootResolved = path.resolve(canonicalRepoRoot);
  const canonicalAgentsRootResolved = path.resolve(canonicalAgentsRoot);
  const worktreesRootResolved = path.resolve(worktreesRoot);

  const inCanonicalRoot = repoRootResolved === canonicalRepoRootResolved;
  const inConfiguredWorktree = isPathWithin(repoRootResolved, worktreesRootResolved);
  if (!inCanonicalRoot && !inConfiguredWorktree) {
    throw new Error(
      `Current repo root ${repoRootResolved} must be canonical root ${canonicalRepoRootResolved} or under ${worktreesRootResolved}.`,
    );
  }

  if (canonicalAgentsRootResolved !== path.resolve(canonicalRepoRootResolved, ".agents")) {
    throw new Error(
      `workspaceLayout.canonicalAgentsRoot must resolve to ${path.resolve(canonicalRepoRootResolved, ".agents")}.`,
    );
  }
  if (worktreesRootResolved !== path.resolve(canonicalRepoRootResolved, ".worktrees")) {
    throw new Error(
      `workspaceLayout.worktreesRoot must resolve to ${path.resolve(canonicalRepoRootResolved, ".worktrees")}.`,
    );
  }

  ensureDir(canonicalAgentsRootResolved);
  if (inCanonicalRoot) {
    return {
      mode: "canonical_root",
      local_agents_path: canonicalAgentsRootResolved,
      canonical_agents_root: canonicalAgentsRootResolved,
      symlink_created: false,
    };
  }

  const localAgentsPath = path.resolve(repoRootResolved, ".agents");
  if (!fs.existsSync(localAgentsPath)) {
    fs.symlinkSync(canonicalAgentsRootResolved, localAgentsPath, "dir");
    return {
      mode: "worktree",
      local_agents_path: localAgentsPath,
      canonical_agents_root: canonicalAgentsRootResolved,
      symlink_created: true,
    };
  }

  const stats = fs.lstatSync(localAgentsPath);
  if (!stats.isSymbolicLink()) {
    throw new Error(
      `${localAgentsPath} exists but is not a symlink. It must link to ${canonicalAgentsRootResolved}.`,
    );
  }

  const localTargetResolved = path.resolve(fs.realpathSync(localAgentsPath));
  if (localTargetResolved !== canonicalAgentsRootResolved) {
    throw new Error(
      `${localAgentsPath} points to ${localTargetResolved}; expected ${canonicalAgentsRootResolved}.`,
    );
  }

  return {
    mode: "worktree",
    local_agents_path: localAgentsPath,
    canonical_agents_root: canonicalAgentsRootResolved,
    symlink_created: false,
  };
}

function readBranchFromHead(repoRoot) {
  const gitDir = path.join(repoRoot, ".git");
  const headPath = path.join(gitDir, "HEAD");
  if (!fs.existsSync(headPath)) {
    return "UNKNOWN";
  }

  const headValue = fs.readFileSync(headPath, "utf8").trim();
  const refPrefix = "ref: ";
  if (headValue.startsWith(refPrefix)) {
    const ref = headValue.slice(refPrefix.length);
    const parts = ref.split("/");
    return parts[parts.length - 1] || "UNKNOWN";
  }

  return headValue.slice(0, 12) || "UNKNOWN";
}

function getBranch(repoRoot) {
  const gitBranch = runCommandSafe("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (gitBranch.ok && gitBranch.stdout.length > 0) {
    return gitBranch.stdout;
  }

  return readBranchFromHead(repoRoot);
}

function getGitStatusLines() {
  const gitStatus = runCommandSafe("git", ["status", "--short"]);
  if (!gitStatus.ok) {
    return ["UNAVAILABLE: git status could not be read in this runtime"];
  }

  return gitStatus.stdout ? gitStatus.stdout.split("\n") : [];
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isValidIsoDate(value) {
  const text = toNonEmptyString(value);
  return text !== null && Number.isFinite(Date.parse(text));
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = [];
  for (const entry of value) {
    const text = toNonEmptyString(entry);
    if (text) {
      normalized.push(text);
    }
  }
  return normalized;
}

function ensureUniqueValue(baseValue, usedValues, fallbackPrefix, fallbackIndex) {
  const normalizedBase =
    toNonEmptyString(baseValue) ?? `${fallbackPrefix}-${fallbackIndex + 1}`;
  if (!usedValues.has(normalizedBase)) {
    usedValues.add(normalizedBase);
    return normalizedBase;
  }

  let suffix = 2;
  let candidate = `${normalizedBase}-${suffix}`;
  while (usedValues.has(candidate)) {
    suffix += 1;
    candidate = `${normalizedBase}-${suffix}`;
  }

  usedValues.add(candidate);
  return candidate;
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

function appendJsonLine(filePath, value) {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function readJsonLinesFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const parsed = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    parsed.push(JSON.parse(line));
  }

  return parsed;
}

function summarizeErrorText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return null;
  }

  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (!firstLine) {
    return null;
  }

  return firstLine.length > 240 ? `${firstLine.slice(0, 237)}...` : firstLine;
}

function mapLegacyStatusToState(status) {
  if (status === "in_progress") {
    return "active";
  }
  if (status === "blocked") {
    return "deferred";
  }
  if (status === "done" || status === "cancelled") {
    return "complete";
  }
  if (status === "planned") {
    return "pending";
  }
  return null;
}

function toQueueToken(value, fallback = "item") {
  const normalized = (toNonEmptyString(value) ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || fallback;
}

function toFeatureTitleFromSlug(slug) {
  const text = toNonEmptyString(slug) ?? "feature";
  const spaced = text.replace(/[-_]+/g, " ").trim();
  if (!spaced) {
    return "Feature";
  }
  return spaced
    .split(/\s+/)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function readPlanHeading(planFileAbs) {
  if (!fs.existsSync(planFileAbs)) {
    return null;
  }

  const content = fs.readFileSync(planFileAbs, "utf8");
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^#\s+(.+?)\s*$/);
    if (match) {
      return toNonEmptyString(match[1]);
    }
  }

  return null;
}

function listFeaturePlanDirectories(rootAbs) {
  if (!fs.existsSync(rootAbs)) {
    return [];
  }

  const entries = fs.readdirSync(rootAbs, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function listMarkdownFilesForPath(targetAbs) {
  if (!fs.existsSync(targetAbs)) {
    return [];
  }

  const targetStats = fs.statSync(targetAbs);
  if (targetStats.isFile()) {
    return targetAbs.endsWith(".md") ? [targetAbs] : [];
  }

  if (!targetStats.isDirectory()) {
    return [];
  }

  const files = [];
  const stack = [targetAbs];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryAbs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryAbs);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(entryAbs);
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

function scanStalePlanReferences(repoRoot, scanRoots) {
  const summary = {
    scanned_files: 0,
    references_checked: 0,
    missing_references: [],
  };
  const seen = new Set();
  const pattern = /\.agents\/plans\/(?:current|deferred|archived)\/[^\s`"'()<>{}\[\]]+/g;

  for (const scanRoot of scanRoots) {
    const rootAbs = path.resolve(repoRoot, scanRoot);
    const markdownFiles = listMarkdownFilesForPath(rootAbs);
    for (const fileAbs of markdownFiles) {
      const fileRef = path.relative(repoRoot, fileAbs).replace(/\\/g, "/");
      const content = fs.readFileSync(fileAbs, "utf8");
      const lines = content.split(/\r?\n/);
      summary.scanned_files += 1;

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        const matches = line.match(pattern) ?? [];
        for (const match of matches) {
          const normalized = normalizePlanReferenceCandidate(match);
          if (!normalized) {
            continue;
          }

          const targetRef = normalized.split("#")[0];
          if (!targetRef) {
            continue;
          }

          summary.references_checked += 1;
          const targetAbs = path.resolve(repoRoot, targetRef);
          if (fs.existsSync(targetAbs)) {
            continue;
          }

          const key = `${fileRef}:${lineIndex + 1}:${targetRef}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          summary.missing_references.push({
            file: fileRef,
            line: lineIndex + 1,
            reference: normalized,
            target: targetRef,
          });
        }
      }
    }
  }

  return summary;
}

function summarizeQueue(queueItems) {
  const stateCounts = {
    active: 0,
    deferred: 0,
    pending: 0,
    complete: 0,
    other: 0,
  };

  const nonCompleteItems = [];
  const activeItems = [];

  for (const item of queueItems) {
    if (!item || typeof item !== "object") {
      stateCounts.other += 1;
      continue;
    }

    const state = toNonEmptyString(item.state) ?? "other";
    if (state in stateCounts) {
      stateCounts[state] += 1;
    } else {
      stateCounts.other += 1;
    }

    if (state === "active") {
      activeItems.push(item);
    }

    if (state !== "complete") {
      nonCompleteItems.push(item);
    }
  }

  return {
    stateCounts,
    nonCompleteItems,
    activeItems,
  };
}

function main() {
  const repoRoot = resolveRepoRoot();
  process.chdir(repoRoot);

  const policy = readJson(path.resolve(repoRoot, POLICY_PATH));
  const documentationModel = policy?.contracts?.documentationModel ?? {};
  const sessionArtifacts = policy?.contracts?.sessionArtifacts ?? {};
  const workspaceLayout = policy?.contracts?.workspaceLayout ?? {};

  const canonicalRepoRoot =
    toNonEmptyString(workspaceLayout.canonicalRepoRoot) ?? "/home/joshd/git/soundspan";
  const canonicalAgentsRoot =
    toNonEmptyString(workspaceLayout.canonicalAgentsRoot) ??
    path.resolve(canonicalRepoRoot, ".agents");
  const worktreesRoot =
    toNonEmptyString(workspaceLayout.worktreesRoot) ??
    path.resolve(canonicalRepoRoot, ".worktrees");
  let workspaceLayoutInfo;
  try {
    workspaceLayoutInfo = ensureWorktreeAgentsSymlink({
      repoRoot,
      canonicalRepoRoot,
      canonicalAgentsRoot,
      worktreesRoot,
    });
  } catch (error) {
    const details =
      toNonEmptyString(error?.message) ?? "Workspace layout validation failed during preflight.";
    console.error(details);
    process.exit(1);
  }

  const now = new Date().toISOString();

  const plansRoot = sessionArtifacts.plansRoot ?? ".agents/plans";
  ensureDir(path.resolve(canonicalAgentsRoot));
  ensureDir(path.resolve(repoRoot, plansRoot));

  const planRoots = normalizeArray(sessionArtifacts.planRoots);
  for (const planRoot of planRoots) {
    ensureDir(path.resolve(repoRoot, planRoot));
  }

  const planQueueSyncEnabled = sessionArtifacts.planQueueSyncEnabled !== false;
  const planQueueSyncPlanFileName =
    toNonEmptyString(sessionArtifacts.planQueueSyncPlanFileName) ?? "PLAN.md";
  const planQueueSyncRoots = normalizeArray(
    sessionArtifacts.planQueueSyncRoots ?? [
      ".agents/plans/current",
      ".agents/plans/deferred",
    ],
  ).filter((value) => typeof value === "string" && value.trim().length > 0);
  const rawPlanQueueSyncStateByRoot =
    sessionArtifacts.planQueueSyncStateByRoot &&
    typeof sessionArtifacts.planQueueSyncStateByRoot === "object"
      ? sessionArtifacts.planQueueSyncStateByRoot
      : {};
  const planQueueSyncStateByRoot = {};
  for (const rootPath of planQueueSyncRoots) {
    const requestedState = toNonEmptyString(rawPlanQueueSyncStateByRoot[rootPath]);
    if (requestedState) {
      planQueueSyncStateByRoot[rootPath] = requestedState;
      continue;
    }
    if (rootPath.endsWith("/deferred")) {
      planQueueSyncStateByRoot[rootPath] = "deferred";
    } else {
      planQueueSyncStateByRoot[rootPath] = "pending";
    }
  }
  const planQueueSyncDefaultOwner =
    toNonEmptyString(sessionArtifacts.planQueueSyncDefaultOwner) ?? "orchestrator";
  const planQueueSyncDefaultItemType =
    toNonEmptyString(sessionArtifacts.planQueueSyncDefaultItemType) ?? "task";
  const planQueueSyncDefaultSubscope =
    toNonEmptyString(sessionArtifacts.planQueueSyncDefaultSubscope) ?? "plan-track";
  const archivedPlanSyncEnabled = sessionArtifacts.archivedPlanSyncEnabled !== false;
  const archivedPlanRoot =
    toNonEmptyString(sessionArtifacts.archivedPlanRoot) ?? ".agents/plans/archived";
  const archivedPlanFileName =
    toNonEmptyString(sessionArtifacts.archivedPlanFileName) ?? "PLAN.md";
  const archivedPlanCanonicalHandoffFileName =
    toNonEmptyString(sessionArtifacts.archivedPlanCanonicalHandoffFileName) ?? "HANDOFF.md";
  const archivedPlanLegacyHandoffFileNames = normalizeStringArray(
    sessionArtifacts.archivedPlanLegacyHandoffFileNames ?? [
      "LLM_SESSION_HANDOFF.md",
    ],
  );
  const archivedPlanArchiveKeyPrefix =
    toNonEmptyString(sessionArtifacts.archivedPlanArchiveKeyPrefix) ?? "feature-plan:";
  const archivedPlanIndexKind =
    toNonEmptyString(sessionArtifacts.archivedPlanIndexKind) ?? "feature";
  const stalePlanReferenceCheckEnabled =
    sessionArtifacts.stalePlanReferenceCheckEnabled !== false;
  const stalePlanReferenceFailureMode =
    toNonEmptyString(sessionArtifacts.stalePlanReferenceFailureMode) ?? "fail";
  const stalePlanReferenceScanRoots = normalizeStringArray(
    sessionArtifacts.stalePlanReferenceScanRoots ?? [".agents/plans"],
  );
  const repositoryIndexPreflightConfig =
    sessionArtifacts.repositoryIndexPreflight &&
    typeof sessionArtifacts.repositoryIndexPreflight === "object"
      ? sessionArtifacts.repositoryIndexPreflight
      : {};
  const repositoryIndexPreflightEnabled =
    repositoryIndexPreflightConfig.enabled !== false;
  const repositoryIndexBuildIfMissing =
    repositoryIndexPreflightConfig.buildIfMissing !== false;
  const repositoryIndexReindexBeforeVerify =
    repositoryIndexPreflightConfig.reindexBeforeVerify !== false;
  const repositoryIndexVerifyStrict =
    repositoryIndexPreflightConfig.verifyStrict !== false;
  const repositoryIndexFailureModeCandidate =
    toNonEmptyString(repositoryIndexPreflightConfig.failureMode) ?? "fail";
  const repositoryIndexFailureMode =
    repositoryIndexFailureModeCandidate === "warn" ? "warn" : "fail";
  const repositoryIndexCloseoutVerifyIfPossible =
    repositoryIndexPreflightConfig.closeoutVerifyIfPossible !== false;

  const executionQueuePath =
    sessionArtifacts.executionQueueFile ?? ".agents/EXECUTION_QUEUE.json";
  const sessionBriefJsonPath =
    sessionArtifacts.sessionBriefJsonFile ?? ".agents/SESSION_BRIEF.json";
  const archiveRoot = sessionArtifacts.archiveRoot ?? ".agents/archives";
  const archiveIndexPath =
    sessionArtifacts.archiveIndexFile ?? ".agents/EXECUTION_ARCHIVE_INDEX.json";
  const archiveShardBy = sessionArtifacts.archiveShardBy ?? "feature_id";
  const archiveFormat = sessionArtifacts.archiveFormat ?? "jsonl";
  const retiredArtifacts = normalizeArray(sessionArtifacts.retiredArtifacts ?? [
    ".agents/ACTIVE_SCOPE.json",
    ".agents/UNRESOLVED_QUEUE.json",
  ]);
  const archiveOnItemStates = new Set(
    normalizeArray(sessionArtifacts.archiveOnItemStates ?? ["complete"]),
  );
  const archiveQueueStatesTriggeringFeatureArchive = new Set(
    normalizeArray(sessionArtifacts.archiveQueueStatesTriggeringFeatureArchive ?? ["complete"]),
  );
  const forbidArchivedStatesInHotQueue =
    sessionArtifacts.forbidArchivedStatesInHotQueue !== false;
  const allowedQueueStates = normalizeArray(
    sessionArtifacts.allowedQueueStates ?? ["active", "deferred", "pending", "complete"],
  );
  const allowedQueueItemTypes = normalizeArray(
    sessionArtifacts.allowedQueueItemTypes ?? ["task", "question", "decision"],
  );
  const queueReadContract = {
    required_top_level_fields: normalizeArray(
      sessionArtifacts.scopeReadRequiredTopLevelFields ?? [
        "state",
        "task_id",
        "objective",
        "last_updated",
        "in_scope",
        "out_of_scope",
        "open_questions",
      ],
    ),
    item_selector_fields: normalizeArray(
      sessionArtifacts.scopeReadItemSelectorFields ?? [
        "id",
        "plan_ref",
        "owner",
        "depends_on",
      ],
    ),
    max_items_per_read:
      Number.isInteger(sessionArtifacts.maxScopedItemsPerRead) &&
      sessionArtifacts.maxScopedItemsPerRead > 0
        ? sessionArtifacts.maxScopedItemsPerRead
        : 25,
  };
  ensureDir(path.resolve(repoRoot, archiveRoot));

  const repositoryIndexReadiness = runRepositoryIndexReadiness({
    enabled: repositoryIndexPreflightEnabled,
    verifyStrict: repositoryIndexVerifyStrict,
    buildIfMissing: repositoryIndexBuildIfMissing,
    reindexBeforeVerify: repositoryIndexReindexBeforeVerify,
    closeoutVerifyIfPossible: repositoryIndexCloseoutVerifyIfPossible,
    failureMode: repositoryIndexFailureMode,
  });

  const executionQueueTemplate = () => ({
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
  });

  const executionQueueResult = ensureJsonTemplate(
    path.resolve(repoRoot, executionQueuePath),
    executionQueueTemplate,
  );
  const executionQueue = executionQueueResult.data ?? executionQueueTemplate();
  let queueMutated = false;

  const archiveIndexTemplate = () => ({
    version: "1.0",
    last_updated: now,
    items: [],
  });

  const archiveIndexResult = ensureJsonTemplate(
    path.resolve(repoRoot, archiveIndexPath),
    archiveIndexTemplate,
  );
  const archiveIndex = archiveIndexResult.data ?? archiveIndexTemplate();
  let archiveIndexMutated = archiveIndexResult.created;

  if (!Array.isArray(archiveIndex.items)) {
    archiveIndex.items = [];
    archiveIndexMutated = true;
  }
  if (!isValidIsoDate(archiveIndex.last_updated)) {
    archiveIndex.last_updated = now;
    archiveIndexMutated = true;
  }

  const existingArchiveKeys = new Set();
  const archiveIndexItemIndexByKey = new Map();
  for (const [entryIndex, entry] of archiveIndex.items.entries()) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const archiveKey = toNonEmptyString(entry.archive_key);
    if (archiveKey) {
      existingArchiveKeys.add(archiveKey);
      archiveIndexItemIndexByKey.set(archiveKey, entryIndex);
    }
  }

  const archivedShardRefs = new Set();
  let archivedItemCount = 0;
  let archivedFeatureCount = 0;

  function archiveRecord({
    archiveKey,
    kind,
    featureId,
    id,
    idempotencyKey,
    title,
    completedAt,
    planRef,
    taskId,
    objective,
    payload,
  }) {
    const validArchiveKey = toNonEmptyString(archiveKey);
    if (!validArchiveKey || existingArchiveKeys.has(validArchiveKey)) {
      return false;
    }

    const normalizedFeatureId = toNonEmptyString(featureId) ?? "unassigned";
    const shardName = `${toArchiveFeatureShardName(normalizedFeatureId)}.${archiveFormat}`;
    const archiveRef = `${archiveRoot}/${shardName}`;
    const archiveRefAbs = path.resolve(repoRoot, archiveRef);
    const archivedAt = now;

    const shardRecord = {
      archive_key: validArchiveKey,
      kind,
      feature_id: normalizedFeatureId,
      archived_at: archivedAt,
      archive_ref: archiveRef,
      payload,
    };
    appendJsonLine(archiveRefAbs, shardRecord);

    archiveIndex.items.push({
      archive_key: validArchiveKey,
      kind,
      id: toNonEmptyString(id),
      idempotency_key: toNonEmptyString(idempotencyKey),
      feature_id: normalizedFeatureId,
      title: toNonEmptyString(title),
      completed_at: isValidIsoDate(completedAt) ? completedAt : null,
      archived_at: archivedAt,
      archive_ref: archiveRef,
      plan_ref: toNonEmptyString(planRef),
      task_id: toNonEmptyString(taskId),
      objective: toNonEmptyString(objective),
    });

    existingArchiveKeys.add(validArchiveKey);
    archiveIndexItemIndexByKey.set(validArchiveKey, archiveIndex.items.length - 1);
    archivedShardRefs.add(archiveRef);
    archiveIndexMutated = true;
    return true;
  }

  const queueCreatedAt = isValidIsoDate(executionQueue.created_at)
    ? executionQueue.created_at
    : now;
  if (executionQueue.created_at !== queueCreatedAt) {
    executionQueue.created_at = queueCreatedAt;
    queueMutated = true;
  }

  const rawQueueUpdatedAt = isValidIsoDate(executionQueue.updated_at)
    ? executionQueue.updated_at
    : queueCreatedAt;
  const queueUpdatedAt =
    Date.parse(rawQueueUpdatedAt) < Date.parse(queueCreatedAt)
      ? queueCreatedAt
      : rawQueueUpdatedAt;
  if (executionQueue.updated_at !== queueUpdatedAt) {
    executionQueue.updated_at = queueUpdatedAt;
    queueMutated = true;
  }

  const rawQueueLastUpdated = isValidIsoDate(executionQueue.last_updated)
    ? executionQueue.last_updated
    : queueUpdatedAt;
  const queueLastUpdated =
    Date.parse(rawQueueLastUpdated) < Date.parse(queueUpdatedAt)
      ? queueUpdatedAt
      : rawQueueLastUpdated;
  if (executionQueue.last_updated !== queueLastUpdated) {
    executionQueue.last_updated = queueLastUpdated;
    queueMutated = true;
  }

  const topLevelArrayFields = [
    "in_scope",
    "out_of_scope",
    "acceptance_criteria",
    "constraints",
    "references",
    "open_questions",
  ];
  for (const fieldName of topLevelArrayFields) {
    const normalized = normalizeStringArray(executionQueue[fieldName]);
    const previous = executionQueue[fieldName];
    if (
      !Array.isArray(previous) ||
      normalized.length !== previous.length ||
      normalized.some((entry, idx) => entry !== previous[idx])
    ) {
      executionQueue[fieldName] = normalized;
      queueMutated = true;
    }
  }

  if (!Array.isArray(executionQueue.items)) {
    executionQueue.items = [];
    queueMutated = true;
  }

  const queueState = toNonEmptyString(executionQueue.state);
  if (!queueState || !allowedQueueStates.includes(queueState)) {
    executionQueue.state = "pending";
    queueMutated = true;
  }

  const queueFeatureId =
    toNonEmptyString(executionQueue.feature_id) ??
    toNonEmptyString(executionQueue.task_id) ??
    "unassigned";
  if (executionQueue.feature_id !== queueFeatureId) {
    executionQueue.feature_id = queueFeatureId;
    queueMutated = true;
  }

  const queueDeferredReason = toNonEmptyString(executionQueue.deferred_reason);
  const normalizedQueueDeferredReason = queueDeferredReason ?? null;
  if (executionQueue.deferred_reason !== normalizedQueueDeferredReason) {
    executionQueue.deferred_reason = normalizedQueueDeferredReason;
    queueMutated = true;
  }

  const queueCancelReason = toNonEmptyString(executionQueue.cancel_reason);
  const normalizedQueueCancelReason = queueCancelReason ?? null;
  if (executionQueue.cancel_reason !== normalizedQueueCancelReason) {
    executionQueue.cancel_reason = normalizedQueueCancelReason;
    queueMutated = true;
  }

  const hasQueueObjectiveContext =
    toNonEmptyString(executionQueue.task_id) || toNonEmptyString(executionQueue.objective);

  const queueQualityIssues = {
    missingTopLevelDeferredReason:
      executionQueue.state === "deferred" && !toNonEmptyString(executionQueue.deferred_reason),
    missingTopLevelScope:
      Boolean(hasQueueObjectiveContext) && executionQueue.in_scope.length === 0,
    missingTopLevelAcceptance:
      Boolean(hasQueueObjectiveContext) && executionQueue.acceptance_criteria.length === 0,
    deferredItemIds: [],
    activeOrCompleteMissingStartIds: [],
    completeItemMissingCompletedAtIds: [],
    completeItemMissingEvidenceIds: [],
  };

  const planQueueSyncSummary = {
    enabled: planQueueSyncEnabled,
    discovered_plan_tracks: 0,
    added_queue_items: 0,
    normalized_existing_items: 0,
    missing_plan_files: [],
    synced_plan_refs: [],
  };

  if (planQueueSyncEnabled) {
    const existingPlanRefToIndices = new Map();
    for (const [index, item] of executionQueue.items.entries()) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const planRef = toNonEmptyString(item.plan_ref);
      if (!planRef) {
        continue;
      }
      if (!existingPlanRefToIndices.has(planRef)) {
        existingPlanRefToIndices.set(planRef, []);
      }
      existingPlanRefToIndices.get(planRef).push(index);
    }

    for (const rootPath of planQueueSyncRoots) {
      const rootAbs = path.resolve(repoRoot, rootPath);
      const requestedRootState = toNonEmptyString(planQueueSyncStateByRoot[rootPath]) ?? "pending";
      const defaultRootState = allowedQueueStates.includes(requestedRootState)
        ? requestedRootState
        : "pending";
      const rootToken = toQueueToken(path.basename(rootPath), "root");
      const featureDirs = listFeaturePlanDirectories(rootAbs);

      for (const featureDir of featureDirs) {
        const planRef = `${rootPath}/${featureDir}/${planQueueSyncPlanFileName}`;
        const planAbs = path.resolve(repoRoot, planRef);
        if (!fs.existsSync(planAbs)) {
          planQueueSyncSummary.missing_plan_files.push(planRef);
          continue;
        }

        planQueueSyncSummary.discovered_plan_tracks += 1;
        planQueueSyncSummary.synced_plan_refs.push(planRef);
        const existingIndices = existingPlanRefToIndices.get(planRef) ?? [];
        if (existingIndices.length > 0) {
          if (defaultRootState === "deferred") {
            for (const existingIndex of existingIndices) {
              const existingItem = executionQueue.items[existingIndex];
              if (!existingItem || typeof existingItem !== "object") {
                continue;
              }
              if (toNonEmptyString(existingItem.state) !== "deferred") {
                existingItem.state = "deferred";
                queueMutated = true;
                planQueueSyncSummary.normalized_existing_items += 1;
              }
              if (!toNonEmptyString(existingItem.deferred_reason)) {
                existingItem.deferred_reason = `Plan is in deferred track: ${rootPath}`;
                queueMutated = true;
                planQueueSyncSummary.normalized_existing_items += 1;
              }
            }
          }
          continue;
        }

        const featureToken = toQueueToken(featureDir, "feature");
        const planHeading = readPlanHeading(planAbs);
        const newItem = {
          id: `plan-${rootToken}-${featureToken}`,
          idempotency_key: `plan-sync:${rootToken}:${featureToken}`,
          feature_id: featureDir,
          subscope: planQueueSyncDefaultSubscope,
          title: planHeading ?? `Plan Track: ${toFeatureTitleFromSlug(featureDir)}`,
          type: planQueueSyncDefaultItemType,
          state: defaultRootState,
          created_at: now,
          updated_at: now,
          planned_at: now,
          owner: planQueueSyncDefaultOwner,
          acceptance_criteria: [
            `Queue item exists for ${planRef}.`,
            `Queue state remains synchronized with plan track root ${rootPath}.`,
          ],
          constraints: [
            `Keep scope aligned to ${planRef} and avoid unrelated work.`,
          ],
          references: [planRef],
          depends_on: [],
          plan_ref: planRef,
          execution_started_at: null,
          completed_at: null,
          claimed_by: null,
          claimed_at: null,
          lease_expires_at: null,
          attempt_count: 0,
          last_attempt_at: null,
          last_error: null,
          retry_after: null,
          outputs: [],
          evidence: [],
          resolution_summary: null,
          deferred_reason:
            defaultRootState === "deferred"
              ? `Plan is in deferred track: ${rootPath}`
              : null,
          cancel_reason: null,
        };

        executionQueue.items.push(newItem);
        queueMutated = true;
        planQueueSyncSummary.added_queue_items += 1;
        existingPlanRefToIndices.set(planRef, [executionQueue.items.length - 1]);
      }
    }
  }

  const archivedPlanSyncSummary = {
    enabled: archivedPlanSyncEnabled,
    archived_root: archivedPlanRoot,
    discovered_feature_dirs: 0,
    missing_plan_files: [],
    added_archive_entries: 0,
    normalized_archive_entries: 0,
    added_shard_records: 0,
    synced_feature_ids: [],
  };

  if (archivedPlanSyncEnabled) {
    const archivedRootAbs = path.resolve(repoRoot, archivedPlanRoot);
    const archivedFeatureDirs = listFeaturePlanDirectories(archivedRootAbs);
    archivedPlanSyncSummary.discovered_feature_dirs = archivedFeatureDirs.length;

    for (const featureDir of archivedFeatureDirs) {
      const featureDirectoryRef = `${archivedPlanRoot}/${featureDir}`;
      const planRef = `${featureDirectoryRef}/${archivedPlanFileName}`;
      const planAbs = path.resolve(repoRoot, planRef);
      if (!fs.existsSync(planAbs)) {
        archivedPlanSyncSummary.missing_plan_files.push(planRef);
        continue;
      }

      archivedPlanSyncSummary.synced_feature_ids.push(featureDir);

      const canonicalHandoffRef = `${featureDirectoryRef}/${archivedPlanCanonicalHandoffFileName}`;
      const canonicalHandoffAbs = path.resolve(repoRoot, canonicalHandoffRef);
      let handoffRef = null;
      if (fs.existsSync(canonicalHandoffAbs)) {
        handoffRef = canonicalHandoffRef;
      } else {
        for (const legacyHandoffFileName of archivedPlanLegacyHandoffFileNames) {
          const legacyHandoffRef = `${featureDirectoryRef}/${legacyHandoffFileName}`;
          const legacyHandoffAbs = path.resolve(repoRoot, legacyHandoffRef);
          if (fs.existsSync(legacyHandoffAbs)) {
            handoffRef = legacyHandoffRef;
            break;
          }
        }
      }
      const promptHistoryRef = `${featureDirectoryRef}/PROMPT_HISTORY.md`;

      const archiveKey = `${archivedPlanArchiveKeyPrefix}${featureDir}`;
      const archiveRef = `${archiveRoot}/${toArchiveFeatureShardName(featureDir)}.${archiveFormat}`;
      const archiveRefAbs = path.resolve(repoRoot, archiveRef);

      const shardEntries = readJsonLinesFile(archiveRefAbs);
      const hasShardRecord = shardEntries.some(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          toNonEmptyString(entry.archive_key) === archiveKey,
      );
      if (!hasShardRecord) {
        appendJsonLine(archiveRefAbs, {
          archive_key: archiveKey,
          kind: archivedPlanIndexKind,
          feature_id: featureDir,
          archived_at: now,
          archive_ref: archiveRef,
          payload: {
            source: "archived-plan-sync",
            feature_directory: featureDirectoryRef,
            plan_ref: planRef,
            handoff_ref: handoffRef,
            prompt_history_ref: fs.existsSync(path.resolve(repoRoot, promptHistoryRef))
              ? promptHistoryRef
              : null,
          },
        });
        archivedShardRefs.add(archiveRef);
        archivedPlanSyncSummary.added_shard_records += 1;
      }

      const planHeading = readPlanHeading(planAbs) ?? `Archived Plan: ${toFeatureTitleFromSlug(featureDir)}`;
      const archiveIndexEntryDefaults = {
        archive_key: archiveKey,
        kind: archivedPlanIndexKind,
        id: null,
        idempotency_key: `archive-plan:${featureDir}`,
        feature_id: featureDir,
        title: planHeading,
        completed_at: now,
        archived_at: now,
        archive_ref: archiveRef,
        plan_ref: planRef,
        task_id: `archived-plan:${featureDir}`,
        objective: planHeading,
      };

      const existingIndex = archiveIndexItemIndexByKey.get(archiveKey);
      if (existingIndex === undefined) {
        archiveIndex.items.push(archiveIndexEntryDefaults);
        archiveIndexMutated = true;
        existingArchiveKeys.add(archiveKey);
        archiveIndexItemIndexByKey.set(archiveKey, archiveIndex.items.length - 1);
        archivedPlanSyncSummary.added_archive_entries += 1;
        continue;
      }

      const existingEntry = archiveIndex.items[existingIndex];
      let changed = false;
      for (const [fieldName, desiredValue] of Object.entries(archiveIndexEntryDefaults)) {
        if (fieldName === "title" || fieldName === "objective") {
          if (toNonEmptyString(existingEntry[fieldName])) {
            continue;
          }
        }
        if (fieldName === "completed_at" || fieldName === "archived_at") {
          if (isValidIsoDate(existingEntry[fieldName])) {
            continue;
          }
        }
        if (existingEntry[fieldName] !== desiredValue) {
          existingEntry[fieldName] = desiredValue;
          changed = true;
        }
      }
      if (changed) {
        archiveIndex.items[existingIndex] = existingEntry;
        archiveIndexMutated = true;
        archivedPlanSyncSummary.normalized_archive_entries += 1;
      }
    }
  }

  const stalePlanReferenceSummary = {
    enabled: stalePlanReferenceCheckEnabled,
    failure_mode: stalePlanReferenceFailureMode,
    scan_roots: stalePlanReferenceScanRoots,
    scanned_files: 0,
    references_checked: 0,
    missing_reference_count: 0,
    missing_references: [],
  };
  if (stalePlanReferenceCheckEnabled) {
    const staleScanResult = scanStalePlanReferences(
      repoRoot,
      stalePlanReferenceScanRoots,
    );
    stalePlanReferenceSummary.scanned_files = staleScanResult.scanned_files;
    stalePlanReferenceSummary.references_checked = staleScanResult.references_checked;
    stalePlanReferenceSummary.missing_reference_count =
      staleScanResult.missing_references.length;
    stalePlanReferenceSummary.missing_references =
      staleScanResult.missing_references.slice(0, 50);
  }

  const usedItemIds = new Set();
  const usedIdempotencyKeys = new Set();

  for (const [index, queueItem] of executionQueue.items.entries()) {
    let item = queueItem;
    if (!item || typeof item !== "object") {
      item = {};
      executionQueue.items[index] = item;
      queueMutated = true;
    }

    const itemId = ensureUniqueValue(
      item.id ?? item.idempotency_key ?? item.plan_ref,
      usedItemIds,
      "task",
      index,
    );
    if (item.id !== itemId) {
      item.id = itemId;
      queueMutated = true;
    }

    const legacyStatus = toNonEmptyString(item.status);
    const mappedState = mapLegacyStatusToState(legacyStatus);
    const itemState = toNonEmptyString(item.state);
    if (!itemState || !allowedQueueStates.includes(itemState)) {
      item.state = mappedState ?? "pending";
      queueMutated = true;
    }

    const idempotencyKey = ensureUniqueValue(
      item.idempotency_key ?? item.id,
      usedIdempotencyKeys,
      item.id,
      index,
    );
    if (item.idempotency_key !== idempotencyKey) {
      item.idempotency_key = idempotencyKey;
      queueMutated = true;
    }

    const itemFeatureId = toNonEmptyString(item.feature_id) ?? executionQueue.feature_id;
    if (item.feature_id !== itemFeatureId) {
      item.feature_id = itemFeatureId;
      queueMutated = true;
    }

    const itemSubscope = toNonEmptyString(item.subscope) ?? null;
    if (item.subscope !== itemSubscope) {
      item.subscope = itemSubscope;
      queueMutated = true;
    }

    const itemTitle = toNonEmptyString(item.title) ?? `Queue Item ${item.id}`;
    if (item.title !== itemTitle) {
      item.title = itemTitle;
      queueMutated = true;
    }

    const itemType = toNonEmptyString(item.type);
    if (!itemType || !allowedQueueItemTypes.includes(itemType)) {
      item.type = "task";
      queueMutated = true;
    }

    const itemOwner = toNonEmptyString(item.owner) ?? "orchestrator";
    if (item.owner !== itemOwner) {
      item.owner = itemOwner;
      queueMutated = true;
    }

    const itemCreatedAt = isValidIsoDate(item.created_at)
      ? item.created_at
      : executionQueue.created_at;
    if (item.created_at !== itemCreatedAt) {
      item.created_at = itemCreatedAt;
      queueMutated = true;
    }

    const rawItemUpdatedAt = isValidIsoDate(item.updated_at)
      ? item.updated_at
      : item.created_at;
    const itemUpdatedAt =
      Date.parse(rawItemUpdatedAt) < Date.parse(item.created_at)
        ? item.created_at
        : rawItemUpdatedAt;
    if (item.updated_at !== itemUpdatedAt) {
      item.updated_at = itemUpdatedAt;
      queueMutated = true;
    }

    const rawItemPlannedAt = isValidIsoDate(item.planned_at)
      ? item.planned_at
      : item.updated_at;
    const itemPlannedAt =
      Date.parse(rawItemPlannedAt) < Date.parse(item.created_at)
        ? item.created_at
        : rawItemPlannedAt;
    if (item.planned_at !== itemPlannedAt) {
      item.planned_at = itemPlannedAt;
      queueMutated = true;
    }

    const executionStartedAt =
      isValidIsoDate(item.execution_started_at) && Date.parse(item.execution_started_at) >= Date.parse(item.planned_at)
        ? item.execution_started_at
        : null;
    if (item.execution_started_at !== executionStartedAt) {
      item.execution_started_at = executionStartedAt;
      queueMutated = true;
    }

    const completedAt =
      isValidIsoDate(item.completed_at) &&
      isValidIsoDate(item.execution_started_at) &&
      Date.parse(item.completed_at) >= Date.parse(item.execution_started_at)
        ? item.completed_at
        : null;
    if (item.completed_at !== completedAt) {
      item.completed_at = completedAt;
      queueMutated = true;
    }

    const attemptCount =
      Number.isInteger(item.attempt_count) && item.attempt_count >= 0
        ? item.attempt_count
        : 0;
    if (item.attempt_count !== attemptCount) {
      item.attempt_count = attemptCount;
      queueMutated = true;
    }

    const lastAttemptAt = isValidIsoDate(item.last_attempt_at) ? item.last_attempt_at : null;
    if (item.last_attempt_at !== lastAttemptAt) {
      item.last_attempt_at = lastAttemptAt;
      queueMutated = true;
    }

    const retryAfter = isValidIsoDate(item.retry_after) ? item.retry_after : null;
    if (item.retry_after !== retryAfter) {
      item.retry_after = retryAfter;
      queueMutated = true;
    }

    const lastError = toNonEmptyString(item.last_error) ?? null;
    if (item.last_error !== lastError) {
      item.last_error = lastError;
      queueMutated = true;
    }

    const deferredReason = toNonEmptyString(item.deferred_reason) ?? null;
    if (item.deferred_reason !== deferredReason) {
      item.deferred_reason = deferredReason;
      queueMutated = true;
    }

    const cancelReason = toNonEmptyString(item.cancel_reason) ?? null;
    if (item.cancel_reason !== cancelReason) {
      item.cancel_reason = cancelReason;
      queueMutated = true;
    }

    const resolutionSummary = toNonEmptyString(item.resolution_summary) ?? null;
    if (item.resolution_summary !== resolutionSummary) {
      item.resolution_summary = resolutionSummary;
      queueMutated = true;
    }

    for (const arrayField of [
      "acceptance_criteria",
      "constraints",
      "references",
      "depends_on",
      "outputs",
      "evidence",
    ]) {
      const normalized = normalizeStringArray(item[arrayField]);
      const previous = item[arrayField];
      if (
        !Array.isArray(previous) ||
        normalized.length !== previous.length ||
        normalized.some((entry, idx) => entry !== previous[idx])
      ) {
        item[arrayField] = normalized;
        queueMutated = true;
      }
    }

    if (!toNonEmptyString(item.plan_ref)) {
      item.plan_ref = `queue:${item.id}`;
      queueMutated = true;
    }

    if (!isValidIsoDate(item.last_attempt_at) && item.attempt_count > 0) {
      item.last_attempt_at = item.execution_started_at ?? item.updated_at;
      queueMutated = true;
    }

    if (item.state === "deferred" && !toNonEmptyString(item.deferred_reason)) {
      queueQualityIssues.deferredItemIds.push(item.id);
    }

    const claimedBy = toNonEmptyString(item.claimed_by) ?? null;
    const claimedAt = isValidIsoDate(item.claimed_at) ? item.claimed_at : null;
    const leaseExpiresAt = isValidIsoDate(item.lease_expires_at)
      ? item.lease_expires_at
      : null;

    if (item.state === "active") {
      const activeClaimedBy = claimedBy ?? item.owner;
      const activeClaimedAt = claimedAt ?? item.execution_started_at ?? item.updated_at;
      let activeLeaseExpiresAt = leaseExpiresAt;
      if (
        !activeLeaseExpiresAt ||
        Date.parse(activeLeaseExpiresAt) <= Date.parse(activeClaimedAt)
      ) {
        activeLeaseExpiresAt = new Date(
          Date.parse(activeClaimedAt) + 60 * 60 * 1000,
        ).toISOString();
      }

      if (item.claimed_by !== activeClaimedBy) {
        item.claimed_by = activeClaimedBy;
        queueMutated = true;
      }
      if (item.claimed_at !== activeClaimedAt) {
        item.claimed_at = activeClaimedAt;
        queueMutated = true;
      }
      if (item.lease_expires_at !== activeLeaseExpiresAt) {
        item.lease_expires_at = activeLeaseExpiresAt;
        queueMutated = true;
      }
    } else if (claimedBy || claimedAt || leaseExpiresAt) {
      if (!claimedBy || !claimedAt || !leaseExpiresAt || Date.parse(leaseExpiresAt) <= Date.parse(claimedAt)) {
        item.claimed_by = null;
        item.claimed_at = null;
        item.lease_expires_at = null;
        queueMutated = true;
      } else {
        if (item.claimed_by !== claimedBy) {
          item.claimed_by = claimedBy;
          queueMutated = true;
        }
        if (item.claimed_at !== claimedAt) {
          item.claimed_at = claimedAt;
          queueMutated = true;
        }
        if (item.lease_expires_at !== leaseExpiresAt) {
          item.lease_expires_at = leaseExpiresAt;
          queueMutated = true;
        }
      }
    } else {
      if (item.claimed_by !== null) {
        item.claimed_by = null;
        queueMutated = true;
      }
      if (item.claimed_at !== null) {
        item.claimed_at = null;
        queueMutated = true;
      }
      if (item.lease_expires_at !== null) {
        item.lease_expires_at = null;
        queueMutated = true;
      }
    }

    if ((item.state === "active" || item.state === "complete") && !isValidIsoDate(item.execution_started_at)) {
      queueQualityIssues.activeOrCompleteMissingStartIds.push(item.id);
    }

    if (item.state === "complete") {
      if (!isValidIsoDate(item.completed_at)) {
        queueQualityIssues.completeItemMissingCompletedAtIds.push(item.id);
      }
      if (
        item.outputs.length === 0 ||
        item.evidence.length === 0 ||
        !toNonEmptyString(item.resolution_summary)
      ) {
        queueQualityIssues.completeItemMissingEvidenceIds.push(item.id);
      }
    }
  }

  const hotQueueItems = [];
  for (const item of executionQueue.items) {
    const itemState = toNonEmptyString(item?.state);
    if (itemState && archiveOnItemStates.has(itemState)) {
      const archiveKey = `item:${toNonEmptyString(item.idempotency_key) ?? toNonEmptyString(item.id) ?? "unknown"}`;
      const archived = archiveRecord({
        archiveKey,
        kind: "item",
        featureId: item.feature_id ?? executionQueue.feature_id,
        id: item.id,
        idempotencyKey: item.idempotency_key,
        title: item.title,
        completedAt: item.completed_at,
        planRef: item.plan_ref,
        taskId: executionQueue.task_id,
        objective: executionQueue.objective,
        payload: {
          queue_context: {
            feature_id: executionQueue.feature_id,
            task_id: executionQueue.task_id,
            objective: executionQueue.objective,
          },
          item,
        },
      });
      if (archived) {
        archivedItemCount += 1;
      }
      queueMutated = true;
      continue;
    }
    hotQueueItems.push(item);
  }
  if (hotQueueItems.length !== executionQueue.items.length) {
    executionQueue.items = hotQueueItems;
    queueMutated = true;
  }

  let queueResetAfterFeatureArchive = false;
  const queueStateAfterItemArchival = toNonEmptyString(executionQueue.state);
  if (
    queueStateAfterItemArchival &&
    archiveQueueStatesTriggeringFeatureArchive.has(queueStateAfterItemArchival)
  ) {
    const featureArchiveKey = `feature:${executionQueue.feature_id}:${executionQueue.updated_at}`;
    const archivedFeature = archiveRecord({
      archiveKey: featureArchiveKey,
      kind: "feature",
      featureId: executionQueue.feature_id,
      id: null,
      idempotencyKey: null,
      title: executionQueue.objective || executionQueue.task_id || executionQueue.feature_id,
      completedAt: executionQueue.updated_at,
      planRef: null,
      taskId: executionQueue.task_id,
      objective: executionQueue.objective,
      payload: {
        queue_summary: {
          version: executionQueue.version,
          created_at: executionQueue.created_at,
          updated_at: executionQueue.updated_at,
          last_updated: executionQueue.last_updated,
          state: executionQueue.state,
          feature_id: executionQueue.feature_id,
          task_id: executionQueue.task_id,
          objective: executionQueue.objective,
          in_scope: executionQueue.in_scope,
          out_of_scope: executionQueue.out_of_scope,
          acceptance_criteria: executionQueue.acceptance_criteria,
          constraints: executionQueue.constraints,
          references: executionQueue.references,
          open_questions: executionQueue.open_questions,
          deferred_reason: executionQueue.deferred_reason,
          cancel_reason: executionQueue.cancel_reason,
        },
        hot_queue_items_remaining: executionQueue.items.map((item) => ({
          id: item.id ?? null,
          idempotency_key: item.idempotency_key ?? null,
          title: item.title ?? null,
          state: item.state ?? null,
          plan_ref: item.plan_ref ?? null,
        })),
      },
    });

    if (archivedFeature) {
      archivedFeatureCount += 1;
    }

    if (forbidArchivedStatesInHotQueue) {
      const resetQueue = executionQueueTemplate();
      for (const [key, value] of Object.entries(resetQueue)) {
        executionQueue[key] = value;
      }
      queueResetAfterFeatureArchive = true;
      queueMutated = true;
    }
  }

  if (queueResetAfterFeatureArchive && planQueueSyncEnabled) {
    const existingPlanRefs = new Set(
      executionQueue.items
        .map((item) => toNonEmptyString(item?.plan_ref))
        .filter((value) => value !== null),
    );

    for (const rootPath of planQueueSyncRoots) {
      const rootAbs = path.resolve(repoRoot, rootPath);
      const requestedRootState = toNonEmptyString(planQueueSyncStateByRoot[rootPath]) ?? "pending";
      const defaultRootState = allowedQueueStates.includes(requestedRootState)
        ? requestedRootState
        : "pending";
      const rootToken = toQueueToken(path.basename(rootPath), "root");
      const featureDirs = listFeaturePlanDirectories(rootAbs);

      for (const featureDir of featureDirs) {
        const planRef = `${rootPath}/${featureDir}/${planQueueSyncPlanFileName}`;
        const planAbs = path.resolve(repoRoot, planRef);

        if (!fs.existsSync(planAbs)) {
          if (!planQueueSyncSummary.missing_plan_files.includes(planRef)) {
            planQueueSyncSummary.missing_plan_files.push(planRef);
          }
          continue;
        }

        if (!planQueueSyncSummary.synced_plan_refs.includes(planRef)) {
          planQueueSyncSummary.synced_plan_refs.push(planRef);
        }

        if (existingPlanRefs.has(planRef)) {
          continue;
        }

        const featureToken = toQueueToken(featureDir, "feature");
        const planHeading = readPlanHeading(planAbs);
        executionQueue.items.push({
          id: `plan-${rootToken}-${featureToken}`,
          idempotency_key: `plan-sync:${rootToken}:${featureToken}`,
          feature_id: featureDir,
          subscope: planQueueSyncDefaultSubscope,
          title: planHeading ?? `Plan Track: ${toFeatureTitleFromSlug(featureDir)}`,
          type: planQueueSyncDefaultItemType,
          state: defaultRootState,
          created_at: now,
          updated_at: now,
          planned_at: now,
          owner: planQueueSyncDefaultOwner,
          acceptance_criteria: [
            `Queue item exists for ${planRef}.`,
            `Queue state remains synchronized with plan track root ${rootPath}.`,
          ],
          constraints: [
            `Keep scope aligned to ${planRef} and avoid unrelated work.`,
          ],
          references: [planRef],
          depends_on: [],
          plan_ref: planRef,
          execution_started_at: null,
          completed_at: null,
          claimed_by: null,
          claimed_at: null,
          lease_expires_at: null,
          attempt_count: 0,
          last_attempt_at: null,
          last_error: null,
          retry_after: null,
          outputs: [],
          evidence: [],
          resolution_summary: null,
          deferred_reason:
            defaultRootState === "deferred"
              ? `Plan is in deferred track: ${rootPath}`
              : null,
          cancel_reason: null,
        });
        existingPlanRefs.add(planRef);
        planQueueSyncSummary.added_queue_items += 1;
        queueMutated = true;
      }
    }
  }

  if (queueMutated) {
    executionQueue.updated_at = now;
    executionQueue.last_updated = now;
    writeJson(path.resolve(repoRoot, executionQueuePath), executionQueue);
  }

  if (archiveIndexMutated) {
    archiveIndex.last_updated = now;
    writeJson(path.resolve(repoRoot, archiveIndexPath), archiveIndex);
  }

  const policyCheckCommand = `node ${documentationModel.enforcementScript ?? ".github/scripts/enforce-agent-policies.mjs"}`;

  let policyCheckState = "pass";
  let policyCheckError = null;
  let policyCheckWarnings = [];

  try {
    const policyResult = runPolicyChecks(
      documentationModel.machinePolicyFile ?? POLICY_PATH,
    );
    policyCheckWarnings = policyResult.warnings.slice(0, 20);

    if (policyResult.failures.length > 0) {
      policyCheckState = "fail";
      policyCheckError = summarizeErrorText(policyResult.failures[0]);
    }
  } catch (error) {
    policyCheckState = "unavailable";
    policyCheckError = summarizeErrorText(error?.message);
  }

  const gitStatusShort = getGitStatusLines();
  const branch = getBranch(repoRoot);

  const queueItems = normalizeArray(executionQueue.items);
  const queueSummary = summarizeQueue(queueItems);
  const existingRetiredArtifacts = retiredArtifacts.filter((artifactPath) =>
    fs.existsSync(path.resolve(repoRoot, artifactPath)),
  );

  const nextActions = [];

  if (!toNonEmptyString(executionQueue.task_id)) {
    nextActions.push(`Set ${executionQueuePath} -> task_id`);
  }
  if (!toNonEmptyString(executionQueue.objective)) {
    nextActions.push(`Set ${executionQueuePath} -> objective`);
  }
  if (!toNonEmptyString(executionQueue.state)) {
    nextActions.push(`Set ${executionQueuePath} -> state`);
  }
  if (queueQualityIssues.missingTopLevelDeferredReason) {
    nextActions.push(
      `Set ${executionQueuePath} -> deferred_reason before keeping queue state as deferred`,
    );
  }
  if (queueQualityIssues.missingTopLevelScope) {
    nextActions.push(
      `Set ${executionQueuePath} -> in_scope with explicit non-placeholder scope entries`,
    );
  }
  if (queueQualityIssues.missingTopLevelAcceptance) {
    nextActions.push(
      `Set ${executionQueuePath} -> acceptance_criteria with explicit non-placeholder criteria`,
    );
  }
  if (queueQualityIssues.deferredItemIds.length > 0) {
    const sample = queueQualityIssues.deferredItemIds
      .slice(0, queueReadContract.max_items_per_read)
      .join(", ");
    nextActions.push(
      `Set deferred_reason for ${queueQualityIssues.deferredItemIds.length} deferred item(s) (sample: ${sample})`,
    );
  }
  if (queueQualityIssues.activeOrCompleteMissingStartIds.length > 0) {
    const sample = queueQualityIssues.activeOrCompleteMissingStartIds
      .slice(0, queueReadContract.max_items_per_read)
      .join(", ");
    nextActions.push(
      `Set execution_started_at for ${queueQualityIssues.activeOrCompleteMissingStartIds.length} active/complete item(s) (sample: ${sample})`,
    );
  }
  if (queueQualityIssues.completeItemMissingCompletedAtIds.length > 0) {
    const sample = queueQualityIssues.completeItemMissingCompletedAtIds
      .slice(0, queueReadContract.max_items_per_read)
      .join(", ");
    nextActions.push(
      `Set completed_at for ${queueQualityIssues.completeItemMissingCompletedAtIds.length} complete item(s) (sample: ${sample})`,
    );
  }
  if (queueQualityIssues.completeItemMissingEvidenceIds.length > 0) {
    const sample = queueQualityIssues.completeItemMissingEvidenceIds
      .slice(0, queueReadContract.max_items_per_read)
      .join(", ");
    nextActions.push(
      `Record outputs/evidence/resolution_summary for ${queueQualityIssues.completeItemMissingEvidenceIds.length} complete item(s) (sample: ${sample})`,
    );
  }
  if (queueItems.length === 0) {
    nextActions.push(
      `Plan all execution work as atomic items in ${executionQueuePath} before implementation/investigation execution starts`,
    );
  }
  if (queueItems.length > queueReadContract.max_items_per_read) {
    nextActions.push(
      `Scope queue reads to relevant selectors (${queueReadContract.item_selector_fields.join(", ")}) and avoid full queue ingestion`,
    );
  }
  const hasPendingItems = queueItems.some(
    (item) => item && typeof item === "object" && toNonEmptyString(item.state) === "pending",
  );
  if (hasPendingItems && queueSummary.activeItems.length === 0) {
    nextActions.push("Select next pending queue item and move it to `active` when execution starts");
  }
  if (queueSummary.nonCompleteItems.length > 0) {
    nextActions.push(
      `Resolve, defer, or complete ${queueSummary.nonCompleteItems.length} non-complete queue item(s)`,
    );
  }
  if (planQueueSyncSummary.added_queue_items > 0) {
    nextActions.push(
      `Plan/queue sync registered ${planQueueSyncSummary.added_queue_items} plan track item(s) from ${planQueueSyncRoots.join(", ")}`,
    );
  }
  if (planQueueSyncSummary.normalized_existing_items > 0) {
    nextActions.push(
      `Plan/queue sync normalized ${planQueueSyncSummary.normalized_existing_items} existing queue field(s) for deferred plan tracks`,
    );
  }
  if (planQueueSyncSummary.missing_plan_files.length > 0) {
    nextActions.push(
      `Create missing ${planQueueSyncPlanFileName} files for ${planQueueSyncSummary.missing_plan_files.length} plan track(s) or remove stale directories`,
    );
  }
  if (archivedPlanSyncSummary.missing_plan_files.length > 0) {
    nextActions.push(
      `Add missing ${archivedPlanFileName} files for ${archivedPlanSyncSummary.missing_plan_files.length} archived plan track(s) under ${archivedPlanRoot}`,
    );
  }
  if (
    archivedPlanSyncSummary.added_archive_entries > 0 ||
    archivedPlanSyncSummary.normalized_archive_entries > 0 ||
    archivedPlanSyncSummary.added_shard_records > 0
  ) {
    nextActions.push(
      `Archived plan sync updated index/shards (added entries: ${archivedPlanSyncSummary.added_archive_entries}, normalized: ${archivedPlanSyncSummary.normalized_archive_entries}, added shard records: ${archivedPlanSyncSummary.added_shard_records})`,
    );
  }
  if (stalePlanReferenceSummary.missing_reference_count > 0) {
    nextActions.push(
      `Resolve ${stalePlanReferenceSummary.missing_reference_count} stale .agents/plans reference(s) detected by preflight`,
    );
  }
  if (archivedItemCount > 0 || archivedFeatureCount > 0) {
    nextActions.push(
      `Archive updated: ${archivedItemCount} completed item(s) and ${archivedFeatureCount} completed feature snapshot(s) moved to ${archiveRoot}`,
    );
  }
  if (existingRetiredArtifacts.length > 0) {
    nextActions.push(
      `Remove retired artifacts: ${existingRetiredArtifacts.join(", ")}`,
    );
  }
  if (workspaceLayoutInfo.symlink_created) {
    nextActions.push(
      `Worktree .agents symlink created at ${workspaceLayoutInfo.local_agents_path} -> ${workspaceLayoutInfo.canonical_agents_root}`,
    );
  }
  if (
    repositoryIndexReadiness.enabled &&
    repositoryIndexReadiness.preflight_state === "built_and_verified"
  ) {
    if (repositoryIndexReadiness.reindex_before_verify) {
      nextActions.push(
        "Repository index was re-indexed and strict-verified by preflight",
      );
    } else {
      nextActions.push(
        "Repository index was missing for current branch/worktree namespace and was built + strict-verified by preflight",
      );
    }
  }
  if (
    repositoryIndexReadiness.enabled &&
    repositoryIndexReadiness.preflight_state === "fail"
  ) {
    nextActions.push(
      "Fix repository index readiness before implementation (`npm run index:verify`; if missing/stale, run `npm run index:build` and re-run verify)",
    );
  }
  if (
    repositoryIndexReadiness.enabled &&
    repositoryIndexReadiness.closeout_verify_if_possible
  ) {
    nextActions.push(
      "Before final handoff when feasible, run `npm run index:verify` and rebuild (`npm run index:build`) if drift is reported",
    );
  }
  if (gitStatusShort.length > 0 && !gitStatusShort[0].startsWith("UNAVAILABLE:")) {
    nextActions.push("Review current git working tree before new edits");
  }
  if (policyCheckState === "fail") {
    nextActions.push("Fix policy check failures before implementation");
  }
  if (policyCheckState === "unavailable") {
    nextActions.push(
      "Run `node .github/scripts/enforce-agent-policies.mjs` in a shell with git subprocess access",
    );
  }

  if (nextActions.length === 0) {
    nextActions.push("Proceed with next atomic task in current scope");
  }

  const sessionBrief = {
    generated_at: now,
    policy: {
      id: policy?.metadata?.id ?? null,
      version: policy?.metadata?.version ?? null,
      check_state: policyCheckState,
      check_command: policyCheckCommand,
      check_error: policyCheckError,
      warnings: policyCheckWarnings,
    },
    startup_read_order: normalizeArray(documentationModel.startupReadOrder),
    branch,
    workspace_layout: {
      repo_root: path.resolve(repoRoot),
      canonical_repo_root: path.resolve(canonicalRepoRoot),
      canonical_agents_root: path.resolve(canonicalAgentsRoot),
      worktrees_root: path.resolve(worktreesRoot),
      mode: workspaceLayoutInfo.mode,
      agents_symlink_path: workspaceLayoutInfo.local_agents_path,
      agents_symlink_created: workspaceLayoutInfo.symlink_created,
    },
    git_status_short: gitStatusShort,
    context_index_file: documentationModel.contextIndexFile ?? "docs/CONTEXT_INDEX.json",
    queue_file: executionQueuePath,
    archive_root: archiveRoot,
    archive_index_file: archiveIndexPath,
    index_readiness: repositoryIndexReadiness,
    queue_read_contract: queueReadContract,
    retired_artifacts_detected: existingRetiredArtifacts,
    scope: {
      state: toNonEmptyString(executionQueue.state),
      feature_id: toNonEmptyString(executionQueue.feature_id),
      task_id: toNonEmptyString(executionQueue.task_id),
      objective: toNonEmptyString(executionQueue.objective),
      total_queue_items: queueItems.length,
    },
    archive: {
      shard_by: archiveShardBy,
      shard_format: archiveFormat,
      archived_items_this_run: archivedItemCount,
      archived_features_this_run: archivedFeatureCount,
      shards_touched: [...archivedShardRefs].sort(),
      index_entries_total: normalizeArray(archiveIndex.items).length,
    },
    plan_queue_sync: {
      enabled: planQueueSyncSummary.enabled,
      plan_file_name: planQueueSyncPlanFileName,
      roots: planQueueSyncRoots,
      state_by_root: planQueueSyncStateByRoot,
      discovered_plan_tracks: planQueueSyncSummary.discovered_plan_tracks,
      added_queue_items: planQueueSyncSummary.added_queue_items,
      normalized_existing_items: planQueueSyncSummary.normalized_existing_items,
      missing_plan_files: planQueueSyncSummary.missing_plan_files,
    },
    archived_plan_sync: {
      enabled: archivedPlanSyncSummary.enabled,
      archived_root: archivedPlanSyncSummary.archived_root,
      discovered_feature_dirs: archivedPlanSyncSummary.discovered_feature_dirs,
      synced_feature_ids: archivedPlanSyncSummary.synced_feature_ids,
      missing_plan_files: archivedPlanSyncSummary.missing_plan_files,
      added_archive_entries: archivedPlanSyncSummary.added_archive_entries,
      normalized_archive_entries: archivedPlanSyncSummary.normalized_archive_entries,
      added_shard_records: archivedPlanSyncSummary.added_shard_records,
    },
    stale_plan_reference_check: {
      enabled: stalePlanReferenceSummary.enabled,
      failure_mode: stalePlanReferenceSummary.failure_mode,
      scan_roots: stalePlanReferenceSummary.scan_roots,
      scanned_files: stalePlanReferenceSummary.scanned_files,
      references_checked: stalePlanReferenceSummary.references_checked,
      missing_reference_count: stalePlanReferenceSummary.missing_reference_count,
      missing_references: stalePlanReferenceSummary.missing_references,
    },
    queue_overview: {
      state_counts: queueSummary.stateCounts,
      status_counts: queueSummary.stateCounts,
      non_complete_count: queueSummary.nonCompleteItems.length,
      non_complete_items: queueSummary.nonCompleteItems
        .slice(0, queueReadContract.max_items_per_read)
        .map((item) => ({
        id: item.id ?? null,
        title: item.title ?? null,
        state: item.state ?? null,
        owner: item.owner ?? null,
      })),
      active_item_ids: queueSummary.activeItems
        .slice(0, queueReadContract.max_items_per_read)
        .map((item) => item.id ?? null),
      in_progress_item_ids: queueSummary.activeItems
        .slice(0, queueReadContract.max_items_per_read)
        .map((item) => item.id ?? null),
    },
    next_actions: nextActions,
  };

  writeJson(path.resolve(repoRoot, sessionBriefJsonPath), sessionBrief);

  if (
    stalePlanReferenceCheckEnabled &&
    stalePlanReferenceFailureMode === "fail" &&
    stalePlanReferenceSummary.missing_reference_count > 0
  ) {
    console.error(
      `Preflight failed: ${stalePlanReferenceSummary.missing_reference_count} stale .agents/plans reference(s) detected.`,
    );
    process.exit(1);
  }

  if (policyCheckState === "fail") {
    const details = policyCheckError || "Policy check failed.";
    console.error(details);
    process.exit(1);
  }

  if (
    repositoryIndexReadiness.enabled &&
    repositoryIndexReadiness.preflight_state === "fail" &&
    repositoryIndexFailureMode === "fail"
  ) {
    const details =
      repositoryIndexReadiness.check_error ??
      "Repository index readiness check failed during preflight.";
    console.error(details);
    process.exit(1);
  }

  console.log(`Preflight complete. Wrote ${sessionBriefJsonPath}.`);
}

main();
