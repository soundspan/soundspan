#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runPolicyChecks } from "./enforce-agent-policies.mjs";

const POLICY_PATH = ".agents-config/policies/agent-governance.json";

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
  const verifyArgs = [".agents-config/tools/index/indexer.mjs", "verify"];
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
      command: "node .agents-config/tools/index/indexer.mjs build --json",
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
      ".agents-config/tools/index/indexer.mjs",
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
    ".agents-config/tools/index/indexer.mjs",
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

function resolveGitCommonDir(repoRoot) {
  const commonDirProbe = runCommandSafe("git", ["rev-parse", "--git-common-dir"]);
  if (!commonDirProbe.ok || commonDirProbe.stdout.length === 0) {
    return null;
  }

  const commonDir = commonDirProbe.stdout;
  if (path.isAbsolute(commonDir)) {
    return path.resolve(commonDir);
  }
  return path.resolve(repoRoot, commonDir);
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

function ensureWorktreeAgentsSymlink({
  repoRoot,
  canonicalRepoRoot,
  canonicalAgentsRoot,
  worktreesRoot,
  localAgentsPath = ".agents",
  requireLocalAgentsSymlink = true,
  requireWorktreeAgentsSymlink = true,
}) {
  const repoRootResolved = path.resolve(repoRoot);
  const canonicalRepoRootResolved = path.resolve(canonicalRepoRoot);
  const canonicalAgentsRootResolved = path.resolve(canonicalAgentsRoot);
  const worktreesRootResolved = path.resolve(worktreesRoot);
  const expectedWorktreesRootResolved =
    resolveCanonicalWorktreesRoot(canonicalRepoRootResolved);

  const inCanonicalRoot = repoRootResolved === canonicalRepoRootResolved;
  const inConfiguredWorktree = isPathWithin(repoRootResolved, worktreesRootResolved);
  if (!inCanonicalRoot && !inConfiguredWorktree) {
    throw new Error(
      `Current repo root ${repoRootResolved} must be canonical root ${canonicalRepoRootResolved} or under ${worktreesRootResolved}.`,
    );
  }

  if (worktreesRootResolved !== expectedWorktreesRootResolved) {
    throw new Error(
      `workspaceLayout.worktreesRoot must resolve to ${expectedWorktreesRootResolved}.`,
    );
  }

  ensureDir(canonicalAgentsRootResolved);

  const normalizedLocalAgentsPath = toNonEmptyString(localAgentsPath) ?? ".agents";
  const localAgentsAbsolutePath = path.resolve(repoRootResolved, normalizedLocalAgentsPath);
  const canonicalLocalAgentsPath = path.resolve(
    canonicalRepoRootResolved,
    normalizedLocalAgentsPath,
  );

  const requiresSymlink =
    (inConfiguredWorktree && requireWorktreeAgentsSymlink === true) ||
    (inCanonicalRoot &&
      requireLocalAgentsSymlink === true &&
      canonicalAgentsRootResolved !== canonicalLocalAgentsPath);

  if (!requiresSymlink) {
    if (
      inCanonicalRoot &&
      canonicalAgentsRootResolved === localAgentsAbsolutePath &&
      !fs.existsSync(localAgentsAbsolutePath)
    ) {
      ensureDir(localAgentsAbsolutePath);
    }

    return {
      mode: inCanonicalRoot ? "canonical_root" : "worktree",
      local_agents_path: localAgentsAbsolutePath,
      canonical_agents_root: canonicalAgentsRootResolved,
      symlink_created: false,
    };
  }

  if (!fs.existsSync(localAgentsAbsolutePath)) {
    fs.symlinkSync(canonicalAgentsRootResolved, localAgentsAbsolutePath, "dir");
    return {
      mode: inCanonicalRoot ? "canonical_root" : "worktree",
      local_agents_path: localAgentsAbsolutePath,
      canonical_agents_root: canonicalAgentsRootResolved,
      symlink_created: true,
    };
  }

  const stats = fs.lstatSync(localAgentsAbsolutePath);
  if (!stats.isSymbolicLink()) {
    throw new Error(
      `${localAgentsAbsolutePath} exists but is not a symlink. It must link to ${canonicalAgentsRootResolved}.`,
    );
  }

  const localTargetResolved = path.resolve(fs.realpathSync(localAgentsAbsolutePath));
  if (localTargetResolved !== canonicalAgentsRootResolved) {
    throw new Error(
      `${localAgentsAbsolutePath} points to ${localTargetResolved}; expected ${canonicalAgentsRootResolved}.`,
    );
  }

  return {
    mode: inCanonicalRoot ? "canonical_root" : "worktree",
    local_agents_path: localAgentsAbsolutePath,
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isNonEmptyString(value) {
  return toNonEmptyString(value) !== null;
}

function sleepMs(ms) {
  const duration = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
  if (duration <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
}

function acquireFileLock(lockFile, options = {}) {
  const timeoutMs =
    Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : 15000;
  const pollMs =
    Number.isInteger(options.pollMs) && options.pollMs > 0
      ? options.pollMs
      : 100;
  const staleMs =
    Number.isInteger(options.staleMs) && options.staleMs > 0
      ? options.staleMs
      : 5 * 60 * 1000;

  const start = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      return fd;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      try {
        const lockStats = fs.statSync(lockFile);
        if (Date.now() - lockStats.mtimeMs > staleMs) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch (staleError) {
        if (staleError?.code !== "ENOENT") {
          throw staleError;
        }
      }

      if (Date.now() - start >= timeoutMs) {
        throw new Error(`Timed out waiting for lock ${lockFile} after ${timeoutMs}ms.`);
      }
      sleepMs(pollMs);
    }
  }
}

function releaseFileLock(lockFile, fd) {
  try {
    fs.closeSync(fd);
  } catch (_error) {
    // Ignore close failures; lock file removal is the source of truth.
  }
  try {
    fs.unlinkSync(lockFile);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
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

function compileRegexPatternList(value) {
  const compiled = [];
  for (const pattern of normalizeStringArray(value)) {
    try {
      compiled.push(new RegExp(pattern, "i"));
    } catch (_error) {
      // Ignore invalid patterns in preflight normalization; policy checks enforce validity.
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

function normalizePlanNarrativeHeading(value) {
  const text = toNonEmptyString(value);
  if (!text) {
    return null;
  }

  return text
    .toLowerCase()
    .replace(/[`*_]+/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function mapNarrativeHeadingToField(value) {
  const normalized = normalizePlanNarrativeHeading(value);
  if (normalized === "spec outline") {
    return "spec_outline";
  }
  if (normalized === "refined spec") {
    return "refined_spec";
  }
  if (normalized === "detailed implementation plan" || normalized === "implementation plan") {
    return "implementation_plan";
  }
  return null;
}

function mapPreSpecOutlineHeadingToField(value) {
  const normalized = normalizePlanNarrativeHeading(value);
  if (
    normalized === "purpose" ||
    normalized === "goals" ||
    normalized === "purpose goals" ||
    normalized === "purpose and goals" ||
    normalized === "goals and purpose" ||
    normalized === "objectives"
  ) {
    return "purpose_goals";
  }
  if (
    normalized === "non goals" ||
    normalized === "out of scope" ||
    normalized === "non goals and out of scope" ||
    normalized === "out of scope and non goals"
  ) {
    return "non_goals";
  }
  return null;
}

function normalizeNarrativeText(value) {
  if (typeof value !== "string") {
    return null;
  }
  return value.replace(/\r\n/g, "\n").trim();
}

function normalizePlanNarrativeStepStatus(value, allowedStepStatuses) {
  const normalizedStatus = toNonEmptyString(value);
  if (normalizedStatus && allowedStepStatuses.includes(normalizedStatus)) {
    return normalizedStatus;
  }
  if (allowedStepStatuses.includes("pending")) {
    return "pending";
  }
  return allowedStepStatuses[0] ?? "pending";
}

function normalizeStringArrayLike(value) {
  if (Array.isArray(value)) {
    return normalizeStringArray(value);
  }

  const singleValue = toNonEmptyString(value);
  return singleValue ? [singleValue] : [];
}

function toDeterministicSlug(value, fallbackPrefix, index) {
  const raw = normalizeNarrativeText(value);
  const normalized = raw
    ? raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
    : "";
  if (normalized) {
    return normalized.slice(0, 64);
  }
  return `${fallbackPrefix}-${index + 1}`;
}

function firstNonEmptyNarrativeText(...values) {
  for (const value of values) {
    const normalized = normalizeNarrativeText(value);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function normalizeSpecOrRefinedEntries(
  value,
  {
    entryType = "spec_outline",
    requiredFields = [],
    fallbackReference = null,
    fallbackSummary = null,
  } = {},
) {
  if (!Array.isArray(value)) {
    return [];
  }

  const fallbackReferenceText = toNonEmptyString(fallbackReference);
  const fallbackSummaryText = normalizeNarrativeText(fallbackSummary) ?? "";
  const fallbackSummaryLine = fallbackSummaryText.split(/\n+/)[0]?.trim() ?? "";
  const normalizedRequiredFields = normalizeStringArray(requiredFields);
  const requiredFieldSet = new Set(normalizedRequiredFields);
  const usedIds = new Set();
  const normalized = [];

  for (const [index, entry] of value.entries()) {
    const entryObject = isPlainObject(entry) ? { ...entry } : {};
    const rawTextEntry = toNonEmptyString(entry);
    const commonText = firstNonEmptyNarrativeText(
      entryObject.text,
      entryObject.summary,
      entryObject.description,
      entryObject.notes,
      entryObject.title,
      entryObject.name,
      rawTextEntry,
      fallbackSummaryLine,
    );
    const references = normalizeStringArrayLike(
      entryObject.references ??
        entryObject.refs ??
        entryObject.reference ??
        entryObject.sources ??
        entryObject.source ??
        entryObject.links ??
        entryObject.link ??
        entryObject.files ??
        entryObject.file ??
        entryObject.paths ??
        entryObject.path ??
        entryObject.url,
    );
    if (references.length === 0 && fallbackReferenceText) {
      references.push(fallbackReferenceText);
    }

    const acceptanceCriteria = normalizeStringArrayLike(
      entryObject.acceptance_criteria ??
        entryObject.acceptanceCriteria ??
        entryObject.success_criteria ??
        entryObject.criteria ??
        entryObject.done_when ??
        entryObject.definition_of_done ??
        entryObject.verification_testing ??
        entryObject.verification ??
        entryObject.testing ??
        entryObject.tests,
    );

    let requiredTextA = "";
    let requiredTextB = "";
    const fallbackCriterionPrefix =
      entryType === "refined_spec" ? "Validate decision" : "Complete deliverable";
    const idPrefix = entryType === "refined_spec" ? "refined-spec" : "spec-outline";

    if (entryType === "refined_spec") {
      requiredTextA = firstNonEmptyNarrativeText(
        entryObject.decision,
        entryObject.resolution,
        entryObject.choice,
        entryObject.proposal,
        entryObject.recommendation,
        entryObject.outcome,
        commonText,
        fallbackSummaryLine,
      );
      requiredTextB = firstNonEmptyNarrativeText(
        entryObject.rationale,
        entryObject.reason,
        entryObject.reasoning,
        entryObject.why,
        entryObject.context,
        entryObject.notes,
        commonText,
        requiredTextA,
        fallbackSummaryLine,
      );
      entryObject.decision = requiredTextA;
      entryObject.rationale = requiredTextB;
    } else {
      requiredTextA = firstNonEmptyNarrativeText(
        entryObject.objective,
        entryObject.goal,
        entryObject.goals,
        entryObject.purpose,
        entryObject.problem,
        commonText,
        fallbackSummaryLine,
      );
      requiredTextB = firstNonEmptyNarrativeText(
        entryObject.deliverable,
        entryObject.output,
        entryObject.outcome,
        entryObject.result,
        entryObject.artifact,
        commonText,
        requiredTextA,
        fallbackSummaryLine,
      );
      entryObject.objective = requiredTextA;
      entryObject.deliverable = requiredTextB;
    }

    if (acceptanceCriteria.length === 0) {
      const criteriaTarget = requiredTextB || requiredTextA || commonText;
      if (criteriaTarget) {
        acceptanceCriteria.push(`${fallbackCriterionPrefix}: ${criteriaTarget}`);
      }
    }
    if (references.length === 0 && fallbackReferenceText) {
      references.push(fallbackReferenceText);
    }

    const idCandidate = toNonEmptyString(entryObject.id);
    const fallbackIdSeed = firstNonEmptyNarrativeText(
      idCandidate,
      entryObject.key,
      entryObject.slug,
      requiredTextA,
      requiredTextB,
      commonText,
      fallbackSummaryLine,
    );
    const normalizedId = ensureUniqueValue(
      idCandidate ?? toDeterministicSlug(fallbackIdSeed, idPrefix, index),
      usedIds,
      idPrefix,
      index,
    );
    entryObject.id = normalizedId;
    entryObject.acceptance_criteria = [...new Set(acceptanceCriteria)];
    entryObject.references = [...new Set(references)];

    if (!requiredTextA) {
      if (entryType === "refined_spec") {
        entryObject.decision = fallbackSummaryLine || normalizedId;
      } else {
        entryObject.objective = fallbackSummaryLine || normalizedId;
      }
    }
    if (!requiredTextB) {
      if (entryType === "refined_spec") {
        entryObject.rationale = entryObject.decision;
      } else {
        entryObject.deliverable = entryObject.objective;
      }
    }

    for (const fieldName of requiredFieldSet) {
      if (fieldName === "acceptance_criteria") {
        if (!Array.isArray(entryObject.acceptance_criteria)) {
          entryObject.acceptance_criteria = [];
        }
        if (entryObject.acceptance_criteria.length === 0) {
          const criteriaTarget =
            firstNonEmptyNarrativeText(requiredTextB, requiredTextA, fallbackSummaryLine) ||
            normalizedId;
          entryObject.acceptance_criteria.push(`${fallbackCriterionPrefix}: ${criteriaTarget}`);
        }
        continue;
      }
      if (fieldName === "references") {
        if (!Array.isArray(entryObject.references)) {
          entryObject.references = [];
        }
        if (entryObject.references.length === 0 && fallbackReferenceText) {
          entryObject.references.push(fallbackReferenceText);
        }
        continue;
      }
      if (!isNonEmptyString(entryObject[fieldName])) {
        entryObject[fieldName] =
          firstNonEmptyNarrativeText(
            entryObject[fieldName],
            requiredTextA,
            requiredTextB,
            commonText,
            fallbackSummaryLine,
          ) || normalizedId;
      }
    }

    normalized.push(entryObject);
  }

  return normalized;
}

function normalizeImplementationCompletionSummary(
  value,
  fallbackDeliveredText = null,
  requiredFields = [
    "delivered",
    "files_functions_hooks_touched",
    "verification_testing",
  ],
) {
  const completionSummary = isPlainObject(value) ? { ...value } : {};
  const fallbackDelivered = toNonEmptyString(fallbackDeliveredText);
  const normalizedRequiredFields = normalizeStringArray(requiredFields);
  const output = {};

  for (const fieldName of normalizedRequiredFields) {
    let sourceValue = completionSummary[fieldName];
    if (fieldName === "files_functions_hooks_touched") {
      sourceValue =
        completionSummary.files_functions_hooks_touched ??
        completionSummary.files_functions_hooks ??
        completionSummary.files_touched;
    }
    if (fieldName === "verification_testing") {
      sourceValue =
        completionSummary.verification_testing ??
        completionSummary.verification ??
        completionSummary.testing;
    }
    const normalizedArray = normalizeStringArray(sourceValue);
    if (fieldName === "delivered" && normalizedArray.length === 0 && fallbackDelivered) {
      normalizedArray.push(fallbackDelivered);
    }
    output[fieldName] = normalizedArray;
  }

  return output;
}

function normalizeImplementationPlanSteps(
  value,
  {
    allowedStepStatuses = ["pending", "in_progress", "complete", "blocked"],
    fallbackReference = null,
    fallbackSummary = null,
    implementationStepDeliverableDenyPatterns = [],
    implementationStepAcceptanceCriteriaMinCount = 1,
    stepStatusesRequiringAcceptanceCriteria = ["in_progress", "complete"],
    stepStatusesRequiringNonEmptyCompletionSummary = ["complete"],
    completionSummaryRequiredFields = [
      "delivered",
      "files_functions_hooks_touched",
      "verification_testing",
    ],
  } = {},
) {
  if (!Array.isArray(value)) {
    return [];
  }

  const fallbackReferenceText = toNonEmptyString(fallbackReference);
  const fallbackSummaryText = normalizeNarrativeText(fallbackSummary) ?? "";
  const deliverableDenyRegexes = compileRegexPatternList(
    implementationStepDeliverableDenyPatterns,
  );
  const acceptanceCriteriaMinCount =
    Number.isInteger(implementationStepAcceptanceCriteriaMinCount) &&
    implementationStepAcceptanceCriteriaMinCount >= 1
      ? implementationStepAcceptanceCriteriaMinCount
      : 1;
  const statusesRequiringAcceptanceCriteriaSet = new Set(
    normalizeStringArray(stepStatusesRequiringAcceptanceCriteria),
  );
  const completeStepStatuses = new Set(
    normalizeStringArray(stepStatusesRequiringNonEmptyCompletionSummary),
  );
  const normalizeDeliverableCandidate = (candidate) => {
    const text = normalizeNarrativeText(candidate);
    if (!text) {
      return null;
    }
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
  };

  const normalized = [];
  for (const [index, entry] of value.entries()) {
    const entryObject = isPlainObject(entry) ? entry : {};
    const stepNotes = normalizeNarrativeText(entryObject.notes);
    const fallbackSummaryDeliverable = fallbackSummaryText
      ? `Implement: ${fallbackSummaryText.split(/\n+/)[0]?.trim() ?? fallbackSummaryText}`
      : null;
    const explicitDeliverableCandidates = [
      entryObject.deliverable,
      entryObject.title,
      entryObject.name,
      entryObject.summary,
      stepNotes,
      entryObject.id,
      entry,
    ]
      .map((candidate) => normalizeDeliverableCandidate(candidate))
      .filter(Boolean);
    const deliverableCandidates = [
      ...explicitDeliverableCandidates,
      fallbackSummaryDeliverable,
      `Step ${index + 1}`,
    ]
      .map((candidate) => normalizeDeliverableCandidate(candidate))
      .filter(Boolean);
    let fallbackDeliverable = deliverableCandidates[0] ?? `Step ${index + 1}`;
    if (matchesAnyRegexPattern(fallbackDeliverable, deliverableDenyRegexes)) {
      const nonPlaceholderCandidate = deliverableCandidates.find(
        (candidate) => !matchesAnyRegexPattern(candidate, deliverableDenyRegexes),
      );
      if (nonPlaceholderCandidate) {
        fallbackDeliverable = nonPlaceholderCandidate;
      }
    }
    const status = normalizePlanNarrativeStepStatus(
      entryObject.status,
      allowedStepStatuses,
    );
    const references = normalizeStringArray(
      entryObject.references ??
        entryObject.refs ??
        entryObject.reference ??
        entryObject.files ??
        entryObject.file ??
        entryObject.path ??
        entryObject.paths ??
        entryObject.links ??
        entryObject.link ??
        entryObject.url,
    );
    const completionSummaryObject = isPlainObject(entryObject.completion_summary)
      ? entryObject.completion_summary
      : {};
    if (references.length === 0) {
      const fallbackSummaryReferences = normalizeStringArray(
        completionSummaryObject.files_functions_hooks_touched ??
          completionSummaryObject.files_functions_hooks ??
          completionSummaryObject.files_touched,
      );
      references.push(...fallbackSummaryReferences);
    }
    if (references.length === 0 && fallbackReferenceText) {
      references.push(fallbackReferenceText);
    }
    const completionSummary = normalizeImplementationCompletionSummary(
      entryObject.completion_summary,
      stepNotes,
      completionSummaryRequiredFields,
    );
    const acceptanceCriteria = normalizeStringArray(
      entryObject.acceptance_criteria ??
        entryObject.acceptanceCriteria ??
        entryObject.success_criteria ??
        entryObject.criteria ??
        entryObject.done_when ??
        entryObject.definition_of_done,
    );
    if (acceptanceCriteria.length === 0) {
      acceptanceCriteria.push(
        ...normalizeStringArray(
          entryObject.verification_testing ??
            entryObject.verification ??
            entryObject.testing ??
            entryObject.tests ??
            completionSummaryObject.verification_testing ??
            completionSummaryObject.verification ??
            completionSummaryObject.testing,
        ),
      );
    }
    if (acceptanceCriteria.length === 0) {
      const explicitStepContext = explicitDeliverableCandidates[0] ?? fallbackSummaryDeliverable;
      if (isNonEmptyString(explicitStepContext)) {
        acceptanceCriteria.push(`Complete deliverable: ${explicitStepContext}`);
      }
    }
    if (
      statusesRequiringAcceptanceCriteriaSet.has(status) &&
      acceptanceCriteria.length === 0 &&
      acceptanceCriteriaMinCount >= 1
    ) {
      const statusScopedStepContext = explicitDeliverableCandidates[0] ?? fallbackSummaryDeliverable;
      if (isNonEmptyString(statusScopedStepContext)) {
        acceptanceCriteria.push(`Complete deliverable: ${statusScopedStepContext}`);
      }
    }
    if (completeStepStatuses.has(status)) {
      if (
        Array.isArray(completionSummary.delivered) &&
        completionSummary.delivered.length === 0 &&
        fallbackDeliverable
      ) {
        completionSummary.delivered.push(fallbackDeliverable);
      }
      if (
        Array.isArray(completionSummary.files_functions_hooks_touched) &&
        completionSummary.files_functions_hooks_touched.length === 0 &&
        references.length > 0
      ) {
        completionSummary.files_functions_hooks_touched.push(...references);
      }
      if (
        Array.isArray(completionSummary.verification_testing) &&
        completionSummary.verification_testing.length === 0 &&
        stepNotes
      ) {
        completionSummary.verification_testing.push(stepNotes);
      }
    }

    normalized.push({
      status,
      deliverable: fallbackDeliverable,
      acceptance_criteria: [...new Set(acceptanceCriteria)],
      references: [...new Set(references)],
      completion_summary: completionSummary,
    });
  }

  return normalized;
}

function normalizeSpecOrRefinedNarrativeSection(
  value,
  fallbackSummary,
  {
    listFieldName = "steps",
    entryType = "spec_outline",
    requiredFields = [],
    fallbackReference = null,
  } = {},
) {
  const fallbackSummaryText = normalizeNarrativeText(fallbackSummary) ?? "";
  const normalizedListFieldName = toNonEmptyString(listFieldName) ?? "steps";

  if (typeof value === "string") {
    return {
      summary: normalizeNarrativeText(value) ?? fallbackSummaryText,
      [normalizedListFieldName]: [],
    };
  }

  if (!isPlainObject(value)) {
    return {
      summary: fallbackSummaryText,
      [normalizedListFieldName]: [],
    };
  }

  const summary = normalizeNarrativeText(value.summary) ?? fallbackSummaryText;
  const listEntries = normalizeSpecOrRefinedEntries(
    Array.isArray(value[normalizedListFieldName]) ? value[normalizedListFieldName] : value.steps,
    {
      entryType,
      requiredFields,
      fallbackReference,
      fallbackSummary: summary,
    },
  );
  return { summary, [normalizedListFieldName]: listEntries };
}

function normalizeImplementationNarrativeSection(
  value,
  fallbackSummary,
  {
    allowedStepStatuses = ["pending", "in_progress", "complete", "blocked"],
    stepsFieldName = "steps",
    fallbackReference = null,
    implementationStepDeliverableDenyPatterns = [],
    implementationStepAcceptanceCriteriaMinCount = 1,
    stepStatusesRequiringAcceptanceCriteria = ["in_progress", "complete"],
    stepStatusesRequiringNonEmptyCompletionSummary = ["complete"],
    completionSummaryRequiredFields = [
      "delivered",
      "files_functions_hooks_touched",
      "verification_testing",
    ],
  } = {},
) {
  const fallbackSummaryText = normalizeNarrativeText(fallbackSummary) ?? "";
  const normalizedStepsFieldName = toNonEmptyString(stepsFieldName) ?? "steps";

  if (typeof value === "string") {
    return {
      summary: normalizeNarrativeText(value) ?? fallbackSummaryText,
      [normalizedStepsFieldName]: [],
    };
  }

  if (!isPlainObject(value)) {
    return {
      summary: fallbackSummaryText,
      [normalizedStepsFieldName]: [],
    };
  }

  const summary = normalizeNarrativeText(value.summary) ?? fallbackSummaryText;
  const normalizedSteps = normalizeImplementationPlanSteps(
    Array.isArray(value[normalizedStepsFieldName]) ? value[normalizedStepsFieldName] : value.steps,
    {
      allowedStepStatuses,
      fallbackReference,
      fallbackSummary: summary,
      implementationStepDeliverableDenyPatterns,
      implementationStepAcceptanceCriteriaMinCount,
      stepStatusesRequiringAcceptanceCriteria,
      stepStatusesRequiringNonEmptyCompletionSummary,
      completionSummaryRequiredFields,
    },
  );
  return { summary, [normalizedStepsFieldName]: normalizedSteps };
}
function readLegacyPlanNarrativeSections(planFileAbs, requiredNarrativeFields) {
  const output = {};
  const requiredFields = normalizeStringArray(requiredNarrativeFields);
  for (const fieldName of requiredFields) {
    output[fieldName] = "";
  }

  if (!fs.existsSync(planFileAbs)) {
    return output;
  }

  const content = fs.readFileSync(planFileAbs, "utf8");
  const lines = content.split(/\r?\n/);
  const sectionLinesByField = new Map();
  for (const fieldName of requiredFields) {
    sectionLinesByField.set(fieldName, []);
  }

  let activeField = null;
  for (const line of lines) {
    const headingMatch = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (headingMatch) {
      activeField = mapNarrativeHeadingToField(headingMatch[1]);
      continue;
    }

    if (!activeField || !sectionLinesByField.has(activeField)) {
      continue;
    }
    sectionLinesByField.get(activeField).push(line);
  }

  for (const fieldName of requiredFields) {
    const sectionLines = sectionLinesByField.get(fieldName) ?? [];
    const sectionText = normalizeNarrativeText(sectionLines.join("\n"));
    output[fieldName] = sectionText ?? "";
  }

  return output;
}

function normalizePlanPreSpecOutline(
  value,
  {
    requiredFields = ["purpose_goals", "non_goals"],
    fallbackValues = {},
  } = {},
) {
  const existing = isPlainObject(value) ? { ...value } : {};
  const normalizedRequiredFields = normalizeStringArray(requiredFields);

  for (const fieldName of normalizedRequiredFields) {
    const normalizedCurrent = normalizeNarrativeText(existing[fieldName]);
    const normalizedFallback = normalizeNarrativeText(fallbackValues[fieldName]) ?? "";
    existing[fieldName] = normalizedCurrent ?? normalizedFallback;
  }

  return existing;
}

function readLegacyPlanPreSpecOutline(planFileAbs, requiredPreSpecOutlineFields) {
  const output = {};
  const requiredFields = normalizeStringArray(requiredPreSpecOutlineFields);
  for (const fieldName of requiredFields) {
    output[fieldName] = "";
  }

  if (!fs.existsSync(planFileAbs)) {
    return output;
  }

  const content = fs.readFileSync(planFileAbs, "utf8");
  const lines = content.split(/\r?\n/);
  const sectionLinesByField = new Map();
  for (const fieldName of requiredFields) {
    sectionLinesByField.set(fieldName, []);
  }

  let activeField = null;
  for (const line of lines) {
    const headingMatch = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (headingMatch) {
      activeField = mapPreSpecOutlineHeadingToField(headingMatch[1]);
      continue;
    }

    if (!activeField || !sectionLinesByField.has(activeField)) {
      continue;
    }
    sectionLinesByField.get(activeField).push(line);
  }

  for (const fieldName of requiredFields) {
    const sectionLines = sectionLinesByField.get(fieldName) ?? [];
    const sectionText = normalizeNarrativeText(sectionLines.join("\n"));
    output[fieldName] = sectionText ?? "";
  }

  return output;
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

function readPlanDisplayTitle(planFileAbs) {
  if (!fs.existsSync(planFileAbs)) {
    return null;
  }

  if (planFileAbs.endsWith(".json")) {
    const parsed = readJsonSafeFromDisk(planFileAbs);
    if (!parsed.error && parsed.data && typeof parsed.data === "object") {
      return (
        toNonEmptyString(parsed.data.feature_title) ??
        toNonEmptyString(parsed.data.title) ??
        null
      );
    }
    return null;
  }

  return readPlanHeading(planFileAbs);
}

function toLegacyPlanMarkdownRef(planRef) {
  const normalizedPlanRef = (toNonEmptyString(planRef) ?? "").replace(/\\/g, "/");
  if (!normalizedPlanRef) {
    return null;
  }
  const planDir = path.posix.dirname(normalizedPlanRef);
  return `${planDir}/PLAN.md`;
}

function defaultPlanLifecycleStatus(rootPath) {
  if (rootPath.endsWith("/deferred")) {
    return "deferred";
  }
  if (rootPath.endsWith("/archived")) {
    return "archived";
  }
  return "draft";
}

function defaultPlanStageState(rootPath) {
  if (rootPath.endsWith("/archived")) {
    return "complete";
  }
  return "pending";
}

function normalizePlanMachineStatus({
  currentStatus,
  allowedStatusesForRoot,
  defaultStatus,
}) {
  const normalizedCurrent = toNonEmptyString(currentStatus);
  if (
    normalizedCurrent &&
    Array.isArray(allowedStatusesForRoot) &&
    allowedStatusesForRoot.includes(normalizedCurrent)
  ) {
    return normalizedCurrent;
  }
  return defaultStatus;
}

function buildPlanMachineTemplate({
  schemaVersion,
  featureId,
  featureTitle,
  planRef,
  rootPath,
  now,
  requiredPlanningStages,
  requiredNarrativeFields,
  preSpecOutlineRequiredFields,
  specOutlineEntryRequiredFields,
  refinedSpecEntryRequiredFields,
  legacyNarrativeSections,
  legacyPreSpecOutline,
  specOutlineListFieldName,
  refinedSpecListFieldName,
  implementationStepsFieldName,
  allowedNarrativeStepStatuses,
  implementationStepDeliverableDenyPatterns,
  implementationStepAcceptanceCriteriaMinCount,
  stepStatusesRequiringAcceptanceCriteria,
  stepStatusesRequiringNonEmptyCompletionSummary,
  implementationCompletionSummaryRequiredFields,
  allowedStatusByRoot,
}) {
  const defaultStatus = defaultPlanLifecycleStatus(rootPath);
  const allowedStatusesForRoot = allowedStatusByRoot[rootPath] ?? [defaultStatus];
  const normalizedSpecOutlineListFieldName =
    toNonEmptyString(specOutlineListFieldName) ?? "full_spec_outline";
  const normalizedRefinedSpecListFieldName =
    toNonEmptyString(refinedSpecListFieldName) ?? "full_refined_spec";
  const normalizedImplementationStepsFieldName =
    toNonEmptyString(implementationStepsFieldName) ?? "steps";
  const stageState = defaultPlanStageState(rootPath);
  const planningStages = {};
  for (const stage of requiredPlanningStages) {
    planningStages[stage] = stageState;
  }
  const narrative = {};
  const normalizedNarrativeFields = normalizeStringArray(requiredNarrativeFields);
  const legacyNarrative =
    legacyNarrativeSections && isPlainObject(legacyNarrativeSections)
      ? legacyNarrativeSections
      : {};
  for (const fieldName of normalizedNarrativeFields) {
    if (fieldName === "spec_outline") {
      narrative[fieldName] = normalizeSpecOrRefinedNarrativeSection(
        null,
        legacyNarrative[fieldName],
        {
          listFieldName: normalizedSpecOutlineListFieldName,
          entryType: "spec_outline",
          requiredFields: normalizeStringArray(specOutlineEntryRequiredFields),
          fallbackReference: planRef,
        },
      );
      continue;
    }
    if (fieldName === "refined_spec") {
      narrative[fieldName] = normalizeSpecOrRefinedNarrativeSection(
        null,
        legacyNarrative[fieldName],
        {
          listFieldName: normalizedRefinedSpecListFieldName,
          entryType: "refined_spec",
          requiredFields: normalizeStringArray(refinedSpecEntryRequiredFields),
          fallbackReference: planRef,
        },
      );
      continue;
    }
    if (fieldName === "implementation_plan") {
      narrative[fieldName] = normalizeImplementationNarrativeSection(
        null,
        legacyNarrative[fieldName],
        {
          allowedStepStatuses: normalizeStringArray(allowedNarrativeStepStatuses),
          stepsFieldName: normalizedImplementationStepsFieldName,
          fallbackReference: planRef,
          implementationStepDeliverableDenyPatterns: normalizeStringArray(
            implementationStepDeliverableDenyPatterns,
          ),
          implementationStepAcceptanceCriteriaMinCount,
          stepStatusesRequiringAcceptanceCriteria: normalizeStringArray(
            stepStatusesRequiringAcceptanceCriteria,
          ),
          stepStatusesRequiringNonEmptyCompletionSummary: normalizeStringArray(
            stepStatusesRequiringNonEmptyCompletionSummary,
          ),
          completionSummaryRequiredFields: normalizeStringArray(
            implementationCompletionSummaryRequiredFields,
          ),
        },
      );
      continue;
    }
    narrative[fieldName] = normalizeSpecOrRefinedNarrativeSection(
      null,
      legacyNarrative[fieldName],
      "steps",
    );
  }
  const normalizedPreSpecOutlineFields = normalizeStringArray(preSpecOutlineRequiredFields);
  const normalizedLegacyPreSpecOutline =
    legacyPreSpecOutline && isPlainObject(legacyPreSpecOutline) ? legacyPreSpecOutline : {};
  const preSpecOutlineFallbacks = {};
  for (const fieldName of normalizedPreSpecOutlineFields) {
    let fallbackText =
      normalizeNarrativeText(normalizedLegacyPreSpecOutline[fieldName]) ?? "";
    if (!fallbackText && fieldName === "purpose_goals") {
      const specOutlineSummary =
        isPlainObject(narrative.spec_outline) && typeof narrative.spec_outline.summary === "string"
          ? narrative.spec_outline.summary
          : legacyNarrative.spec_outline;
      fallbackText = normalizeNarrativeText(specOutlineSummary) ?? "";
    }
    preSpecOutlineFallbacks[fieldName] = fallbackText;
  }
  narrative.pre_spec_outline = normalizePlanPreSpecOutline(null, {
    requiredFields: normalizedPreSpecOutlineFields,
    fallbackValues: preSpecOutlineFallbacks,
  });

  return {
    schema_version: schemaVersion,
    feature_id: featureId,
    feature_title: featureTitle,
    plan_ref: planRef,
    status: normalizePlanMachineStatus({
      currentStatus: defaultStatus,
      allowedStatusesForRoot,
      defaultStatus,
    }),
    updated_at: now,
    planning_stages: planningStages,
    narrative,
    subagent: {
      requirement: "optional",
      primary_agent: null,
      execution_agents: [],
      last_executor: null,
    },
  };
}

function readJsonSafeFromDisk(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return { data: JSON.parse(raw), error: null };
  } catch (error) {
    return { data: null, error };
  }
}

function normalizePlanMachineDocument({
  rawData,
  schemaVersion,
  featureId,
  featureTitle,
  planRef,
  rootPath,
  now,
  requiredPlanningStages,
  requiredNarrativeFields,
  preSpecOutlineRequiredFields,
  specOutlineEntryRequiredFields,
  refinedSpecEntryRequiredFields,
  legacyNarrativeSections,
  legacyPreSpecOutline,
  specOutlineListFieldName,
  refinedSpecListFieldName,
  implementationStepsFieldName,
  allowedNarrativeStepStatuses,
  implementationStepDeliverableDenyPatterns,
  implementationStepAcceptanceCriteriaMinCount,
  stepStatusesRequiringAcceptanceCriteria,
  stepStatusesRequiringNonEmptyCompletionSummary,
  implementationCompletionSummaryRequiredFields,
  allowedPlanningStageStates,
  allowedSubagentRequirements,
  requiredSubagentFields,
  statusesRequiringLastExecutor,
  allowedStatusByRoot,
}) {
  const normalizedSpecOutlineListFieldName =
    toNonEmptyString(specOutlineListFieldName) ?? "full_spec_outline";
  const normalizedRefinedSpecListFieldName =
    toNonEmptyString(refinedSpecListFieldName) ?? "full_refined_spec";
  const normalizedImplementationStepsFieldName =
    toNonEmptyString(implementationStepsFieldName) ?? "steps";
  const template = buildPlanMachineTemplate({
    schemaVersion,
    featureId,
    featureTitle,
    planRef,
    rootPath,
    now,
    requiredPlanningStages,
    requiredNarrativeFields,
    preSpecOutlineRequiredFields,
    specOutlineEntryRequiredFields,
    refinedSpecEntryRequiredFields,
    legacyNarrativeSections,
    legacyPreSpecOutline,
    specOutlineListFieldName: normalizedSpecOutlineListFieldName,
    refinedSpecListFieldName: normalizedRefinedSpecListFieldName,
    implementationStepsFieldName: normalizedImplementationStepsFieldName,
    allowedNarrativeStepStatuses,
    implementationStepDeliverableDenyPatterns,
    implementationStepAcceptanceCriteriaMinCount,
    stepStatusesRequiringAcceptanceCriteria,
    stepStatusesRequiringNonEmptyCompletionSummary,
    implementationCompletionSummaryRequiredFields,
    allowedStatusByRoot,
  });

  const value =
    rawData && typeof rawData === "object" && !Array.isArray(rawData)
      ? { ...rawData }
      : {};

  let changed = false;
  const setIfDifferent = (fieldName, nextValue) => {
    if (JSON.stringify(value[fieldName]) !== JSON.stringify(nextValue)) {
      value[fieldName] = nextValue;
      changed = true;
    }
  };

  setIfDifferent("schema_version", schemaVersion);
  setIfDifferent("feature_id", featureId);
  setIfDifferent("plan_ref", planRef);

  const normalizedFeatureTitle = toNonEmptyString(value.feature_title) ?? featureTitle;
  setIfDifferent("feature_title", normalizedFeatureTitle);

  const defaultStatus = defaultPlanLifecycleStatus(rootPath);
  const allowedStatusesForRoot = allowedStatusByRoot[rootPath] ?? [defaultStatus];
  const normalizedStatus = normalizePlanMachineStatus({
    currentStatus: value.status,
    allowedStatusesForRoot,
    defaultStatus,
  });
  setIfDifferent("status", normalizedStatus);

  const planningStages =
    value.planning_stages &&
    typeof value.planning_stages === "object" &&
    !Array.isArray(value.planning_stages)
      ? { ...value.planning_stages }
      : {};
  const defaultStageState = defaultPlanStageState(rootPath);
  for (const stage of requiredPlanningStages) {
    const currentStageState = toNonEmptyString(planningStages[stage]);
    planningStages[stage] =
      currentStageState && allowedPlanningStageStates.includes(currentStageState)
        ? currentStageState
        : defaultStageState;
  }
  setIfDifferent("planning_stages", planningStages);

  const narrative = isPlainObject(value.narrative) ? { ...value.narrative } : {};
  const normalizedNarrativeFields = normalizeStringArray(requiredNarrativeFields);
  const legacyNarrative =
    legacyNarrativeSections && isPlainObject(legacyNarrativeSections)
      ? legacyNarrativeSections
      : {};
  for (const fieldName of normalizedNarrativeFields) {
    if (fieldName === "spec_outline") {
      narrative[fieldName] = normalizeSpecOrRefinedNarrativeSection(
        narrative[fieldName],
        legacyNarrative[fieldName],
        {
          listFieldName: normalizedSpecOutlineListFieldName,
          entryType: "spec_outline",
          requiredFields: normalizeStringArray(specOutlineEntryRequiredFields),
          fallbackReference: planRef,
        },
      );
      continue;
    }
    if (fieldName === "refined_spec") {
      narrative[fieldName] = normalizeSpecOrRefinedNarrativeSection(
        narrative[fieldName],
        legacyNarrative[fieldName],
        {
          listFieldName: normalizedRefinedSpecListFieldName,
          entryType: "refined_spec",
          requiredFields: normalizeStringArray(refinedSpecEntryRequiredFields),
          fallbackReference: planRef,
        },
      );
      continue;
    }
    if (fieldName === "implementation_plan") {
      narrative[fieldName] = normalizeImplementationNarrativeSection(
        narrative[fieldName],
        legacyNarrative[fieldName],
        {
          allowedStepStatuses: normalizeStringArray(allowedNarrativeStepStatuses),
          stepsFieldName: normalizedImplementationStepsFieldName,
          fallbackReference: planRef,
          implementationStepDeliverableDenyPatterns: normalizeStringArray(
            implementationStepDeliverableDenyPatterns,
          ),
          implementationStepAcceptanceCriteriaMinCount,
          stepStatusesRequiringAcceptanceCriteria: normalizeStringArray(
            stepStatusesRequiringAcceptanceCriteria,
          ),
          stepStatusesRequiringNonEmptyCompletionSummary: normalizeStringArray(
            stepStatusesRequiringNonEmptyCompletionSummary,
          ),
          completionSummaryRequiredFields: normalizeStringArray(
            implementationCompletionSummaryRequiredFields,
          ),
        },
      );
      continue;
    }
    narrative[fieldName] = normalizeSpecOrRefinedNarrativeSection(
      narrative[fieldName],
      legacyNarrative[fieldName],
      "steps",
    );
  }
  const normalizedPreSpecOutlineFields = normalizeStringArray(preSpecOutlineRequiredFields);
  const normalizedLegacyPreSpecOutline =
    legacyPreSpecOutline && isPlainObject(legacyPreSpecOutline) ? legacyPreSpecOutline : {};
  const preSpecOutlineFallbacks = {};
  for (const fieldName of normalizedPreSpecOutlineFields) {
    let fallbackText =
      normalizeNarrativeText(normalizedLegacyPreSpecOutline[fieldName]) ?? "";
    if (!fallbackText && fieldName === "purpose_goals") {
      const specOutlineSummary =
        isPlainObject(narrative.spec_outline) && typeof narrative.spec_outline.summary === "string"
          ? narrative.spec_outline.summary
          : legacyNarrative.spec_outline;
      fallbackText = normalizeNarrativeText(specOutlineSummary) ?? "";
    }
    preSpecOutlineFallbacks[fieldName] = fallbackText;
  }
  narrative.pre_spec_outline = normalizePlanPreSpecOutline(narrative.pre_spec_outline, {
    requiredFields: normalizedPreSpecOutlineFields,
    fallbackValues: preSpecOutlineFallbacks,
  });
  setIfDifferent("narrative", narrative);

  const subagent =
    value.subagent && typeof value.subagent === "object" && !Array.isArray(value.subagent)
      ? { ...value.subagent }
      : {};
  const requiredSubagentFieldSet = new Set(requiredSubagentFields);
  const statusesRequiringLastExecutorSet = new Set(statusesRequiringLastExecutor);

  const requirement = toNonEmptyString(subagent.requirement);
  const normalizedRequirement =
    requirement && allowedSubagentRequirements.includes(requirement)
      ? requirement
      : template.subagent.requirement;
  if (requiredSubagentFieldSet.has("requirement") || "requirement" in subagent) {
    subagent.requirement = normalizedRequirement;
  }

  const primaryAgent = toNonEmptyString(subagent.primary_agent);
  if (requiredSubagentFieldSet.has("primary_agent") || "primary_agent" in subagent) {
    subagent.primary_agent = primaryAgent ?? null;
  }

  const executionAgents = normalizeStringArray(subagent.execution_agents);
  if (requiredSubagentFieldSet.has("execution_agents") || "execution_agents" in subagent) {
    subagent.execution_agents = executionAgents;
  }

  let lastExecutor = toNonEmptyString(subagent.last_executor);
  if (!lastExecutor && statusesRequiringLastExecutorSet.has(normalizedStatus)) {
    lastExecutor = primaryAgent ?? executionAgents[0] ?? "orchestrator";
  }
  if (requiredSubagentFieldSet.has("last_executor") || "last_executor" in subagent) {
    subagent.last_executor = lastExecutor ?? null;
  }
  setIfDifferent("subagent", subagent);

  if (!isValidIsoDate(value.updated_at)) {
    setIfDifferent("updated_at", now);
  } else if (changed) {
    setIfDifferent("updated_at", now);
  }

  return { data: value, changed };
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

function scanStalePlanReferences(
  repoRoot,
  scanRoots,
  resolvePath = (value) => path.resolve(repoRoot, value),
) {
  const summary = {
    scanned_files: 0,
    references_checked: 0,
    missing_references: [],
  };
  const seen = new Set();
  const pattern = /\.agents\/plans\/(?:current|deferred|archived)\/[^\s`"'()<>{}\[\]]+/g;

  for (const scanRoot of scanRoots) {
    const rootAbs = resolvePath(scanRoot);
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
          const targetAbs = resolvePath(targetRef);
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
  const workspaceLayoutBaseRepoRoot = resolvePrimaryRepoRoot(repoRoot);

  const canonicalRepoRoot = toNonEmptyString(workspaceLayout.canonicalRepoRoot)
    ? resolvePathFromBase(workspaceLayout.canonicalRepoRoot, workspaceLayoutBaseRepoRoot)
    : path.resolve(repoRoot);
  const canonicalAgentsRoot = toNonEmptyString(workspaceLayout.canonicalAgentsRoot)
    ? resolvePathFromBase(workspaceLayout.canonicalAgentsRoot, canonicalRepoRoot)
    : path.resolve(canonicalRepoRoot, ".agents");
  const resolveArtifactPath = (targetPath) => {
    const normalized = toNonEmptyString(targetPath) ?? "";
    if (normalized === ".agents") {
      return path.resolve(canonicalAgentsRoot);
    }
    if (normalized.startsWith(".agents/")) {
      return path.resolve(canonicalAgentsRoot, normalized.slice(".agents/".length));
    }
    return path.resolve(repoRoot, normalized);
  };
  const worktreesRoot = toNonEmptyString(workspaceLayout.worktreesRoot)
    ? resolvePathFromBase(workspaceLayout.worktreesRoot, canonicalRepoRoot)
    : resolveCanonicalWorktreesRoot(canonicalRepoRoot);
  let workspaceLayoutInfo;
  try {
    workspaceLayoutInfo = ensureWorktreeAgentsSymlink({
      repoRoot,
      canonicalRepoRoot,
      canonicalAgentsRoot,
      worktreesRoot,
      localAgentsPath: toNonEmptyString(workspaceLayout.localAgentsPath) ?? ".agents",
      requireLocalAgentsSymlink: workspaceLayout.requireLocalAgentsSymlink !== false,
      requireWorktreeAgentsSymlink: workspaceLayout.requireWorktreeAgentsSymlink !== false,
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
  ensureDir(resolveArtifactPath(plansRoot));

  const planRoots = normalizeArray(sessionArtifacts.planRoots);
  for (const planRoot of planRoots) {
    ensureDir(resolveArtifactPath(planRoot));
  }

  const planQueueSyncEnabled = sessionArtifacts.planQueueSyncEnabled !== false;
  const planQueueSyncPlanFileName =
    toNonEmptyString(sessionArtifacts.planQueueSyncPlanFileName) ?? "PLAN.json";
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
  const planMachineContractEnabled =
    sessionArtifacts.planMachineContractEnabled !== false;
  const planMachineFileName =
    toNonEmptyString(sessionArtifacts.planMachineFileName) ?? "PLAN.json";
  const planMachineSchemaVersion =
    toNonEmptyString(sessionArtifacts.planMachineSchemaVersion) ?? "1.0";
  const planMachineRoots = normalizeArray(
    sessionArtifacts.planMachineRoots ?? [
      ".agents/plans/current",
      ".agents/plans/deferred",
      ".agents/plans/archived",
    ],
  ).filter((value) => typeof value === "string" && value.trim().length > 0);
  const planMachineRequiredPlanningStages = normalizeStringArray(
    sessionArtifacts.planMachineRequiredPlanningStages ?? [
      "spec_outline",
      "refined_spec",
      "implementation_plan",
    ],
  );
  const planMachineRequiredNarrativeFields = normalizeStringArray(
    sessionArtifacts.planMachineRequiredNarrativeFields ?? [
      "spec_outline",
      "refined_spec",
      "implementation_plan",
    ],
  );
  const planMachinePreSpecOutlineRequiredFields = normalizeStringArray(
    sessionArtifacts.planMachinePreSpecOutlineRequiredFields ?? [
      "purpose_goals",
      "non_goals",
    ],
  );
  const planMachineStatusesRequiringNonEmptyPreSpecNonGoals = normalizeStringArray(
    sessionArtifacts.planMachineStatusesRequiringNonEmptyPreSpecNonGoals ?? [
      "ready",
      "deferred",
    ],
  );
  const planMachineStatusesRequiringNarrativeContent = normalizeStringArray(
    sessionArtifacts.planMachineStatusesRequiringNarrativeContent ?? [
      "in_progress",
      "complete",
    ],
  );
  const planMachineNarrativeMinLength =
    Number.isInteger(sessionArtifacts.planMachineNarrativeMinLength) &&
    sessionArtifacts.planMachineNarrativeMinLength >= 1
      ? sessionArtifacts.planMachineNarrativeMinLength
      : 24;
  const planMachinePreSpecOutlineMinLength =
    Number.isInteger(sessionArtifacts.planMachinePreSpecOutlineMinLength) &&
    sessionArtifacts.planMachinePreSpecOutlineMinLength >= 1
      ? sessionArtifacts.planMachinePreSpecOutlineMinLength
      : 24;
  const planMachineNarrativeMinSteps =
    Number.isInteger(sessionArtifacts.planMachineNarrativeMinSteps) &&
    sessionArtifacts.planMachineNarrativeMinSteps >= 0
      ? sessionArtifacts.planMachineNarrativeMinSteps
      : 1;
  const planMachineSpecOutlineListFieldName =
    toNonEmptyString(sessionArtifacts.planMachineSpecOutlineListFieldName) ??
    "full_spec_outline";
  const planMachineRefinedSpecListFieldName =
    toNonEmptyString(sessionArtifacts.planMachineRefinedSpecListFieldName) ??
    "full_refined_spec";
  const planMachineSpecOutlineEntryRequiredFields = normalizeStringArray(
    sessionArtifacts.planMachineSpecOutlineEntryRequiredFields ?? [
      "id",
      "objective",
      "deliverable",
      "acceptance_criteria",
      "references",
    ],
  );
  const planMachineRefinedSpecEntryRequiredFields = normalizeStringArray(
    sessionArtifacts.planMachineRefinedSpecEntryRequiredFields ?? [
      "id",
      "decision",
      "rationale",
      "acceptance_criteria",
      "references",
    ],
  );
  const planMachineStatusesRequiringSpecOutlineEntries = normalizeStringArray(
    sessionArtifacts.planMachineStatusesRequiringSpecOutlineEntries ??
      planMachineStatusesRequiringNarrativeContent,
  );
  const planMachineStatusesRequiringRefinedSpecEntries = normalizeStringArray(
    sessionArtifacts.planMachineStatusesRequiringRefinedSpecEntries ??
      planMachineStatusesRequiringNarrativeContent,
  );
  const planMachineSpecOutlineMinEntries =
    Number.isInteger(sessionArtifacts.planMachineSpecOutlineMinEntries) &&
    sessionArtifacts.planMachineSpecOutlineMinEntries >= 1
      ? sessionArtifacts.planMachineSpecOutlineMinEntries
      : 1;
  const planMachineRefinedSpecMinEntries =
    Number.isInteger(sessionArtifacts.planMachineRefinedSpecMinEntries) &&
    sessionArtifacts.planMachineRefinedSpecMinEntries >= 1
      ? sessionArtifacts.planMachineRefinedSpecMinEntries
      : 1;
  const planMachineImplementationStepsFieldName =
    toNonEmptyString(sessionArtifacts.planMachineImplementationStepsFieldName) ??
    "steps";
  const planMachineAllowedNarrativeStepStatuses = normalizeStringArray(
    sessionArtifacts.planMachineAllowedNarrativeStepStatuses ?? [
      "pending",
      "in_progress",
      "complete",
      "blocked",
    ],
  );
  const planMachineNarrativeStepRequiredFields = normalizeStringArray(
    sessionArtifacts.planMachineNarrativeStepRequiredFields ?? [
      "status",
      "deliverable",
      "acceptance_criteria",
      "references",
      "completion_summary",
    ],
  );
  const planMachineNarrativeStepOptionalFields = normalizeStringArray(
    sessionArtifacts.planMachineNarrativeStepOptionalFields ?? [],
  );
  const planMachineImplementationStepDeliverableDenyPatterns = normalizeStringArray(
    sessionArtifacts.planMachineImplementationStepDeliverableDenyPatterns ?? [
      "^\\s*(todo|tbd|placeholder|n\\/?a|none|unknown)\\s*$",
      "^\\s*(step|task|item|deliverable)\\s*\\d+\\s*$",
      "^\\s*<[^>]+>\\s*$",
    ],
  );
  const planMachineImplementationStepAcceptanceCriteriaMinCount =
    Number.isInteger(sessionArtifacts.planMachineImplementationStepAcceptanceCriteriaMinCount) &&
    sessionArtifacts.planMachineImplementationStepAcceptanceCriteriaMinCount >= 1
      ? sessionArtifacts.planMachineImplementationStepAcceptanceCriteriaMinCount
      : 1;
  const planMachineStepStatusesRequiringAcceptanceCriteria = normalizeStringArray(
    sessionArtifacts.planMachineStepStatusesRequiringAcceptanceCriteria ?? [
      "in_progress",
      "complete",
    ],
  );
  const planMachineStepStatusesRequiringNonEmptyCompletionSummary = normalizeStringArray(
    sessionArtifacts.planMachineStepStatusesRequiringNonEmptyCompletionSummary ?? [
      "complete",
    ],
  );
  const planMachineImplementationCompletionSummaryRequiredFields = normalizeStringArray(
    sessionArtifacts.planMachineImplementationCompletionSummaryRequiredFields ?? [
      "delivered",
      "files_functions_hooks_touched",
      "verification_testing",
    ],
  );
  const planMachineAllowedPlanningStageStates = normalizeStringArray(
    sessionArtifacts.planMachineAllowedPlanningStageStates ?? [
      "pending",
      "in_progress",
      "complete",
    ],
  );
  const planMachineAllowedSubagentRequirements = normalizeStringArray(
    sessionArtifacts.planMachineAllowedSubagentRequirements ?? [
      "required",
      "recommended",
      "optional",
      "none",
    ],
  );
  const planMachineRequiredSubagentFields = normalizeStringArray(
    sessionArtifacts.planMachineRequiredSubagentFields ?? [
      "requirement",
      "primary_agent",
      "execution_agents",
      "last_executor",
    ],
  );
  const planMachineStatusesRequiringLastExecutor = normalizeStringArray(
    sessionArtifacts.planMachineStatusesRequiringLastExecutor ?? [
      "in_progress",
      "complete",
    ],
  );
  const rawPlanMachineStatusCoherence =
    sessionArtifacts.planMachineStatusCoherence &&
    typeof sessionArtifacts.planMachineStatusCoherence === "object"
      ? sessionArtifacts.planMachineStatusCoherence
      : {};
  const planMachineStatusCoherence = {
    requireInProgressPlanStatusWhenAnyStepInProgress:
      rawPlanMachineStatusCoherence.requireInProgressPlanStatusWhenAnyStepInProgress !== false,
    statusesRequiringAllImplementationStepsComplete: normalizeStringArray(
      rawPlanMachineStatusCoherence.statusesRequiringAllImplementationStepsComplete ?? [
        "complete",
      ],
    ),
    statusesForbiddingInProgressImplementationSteps: normalizeStringArray(
      rawPlanMachineStatusCoherence.statusesForbiddingInProgressImplementationSteps ?? [
        "deferred",
      ],
    ),
  };
  const rawPlanMachineAllowedStatusByRoot =
    sessionArtifacts.planMachineAllowedStatusByRoot &&
    typeof sessionArtifacts.planMachineAllowedStatusByRoot === "object"
      ? sessionArtifacts.planMachineAllowedStatusByRoot
      : {};
  const planMachineAllowedStatusByRoot = {};
  for (const rootPath of planMachineRoots) {
    const requestedStates = normalizeStringArray(rawPlanMachineAllowedStatusByRoot[rootPath]);
    if (requestedStates.length > 0) {
      planMachineAllowedStatusByRoot[rootPath] = requestedStates;
      continue;
    }
    planMachineAllowedStatusByRoot[rootPath] = [defaultPlanLifecycleStatus(rootPath)];
  }
  const archivedPlanSyncEnabled = sessionArtifacts.archivedPlanSyncEnabled !== false;
  const archivedPlanRoot =
    toNonEmptyString(sessionArtifacts.archivedPlanRoot) ?? ".agents/plans/archived";
  const archivedPlanFileName =
    toNonEmptyString(sessionArtifacts.archivedPlanFileName) ?? "PLAN.json";
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
  const queueQualityFailureModeCandidate =
    toNonEmptyString(sessionArtifacts.preflightQueueQualityFailureMode) ?? "fail";
  const queueQualityFailureMode =
    queueQualityFailureModeCandidate === "warn" ? "warn" : "fail";
  const queueQualityFailureRules = new Set(
    normalizeStringArray(
      sessionArtifacts.preflightQueueQualityFailureRules ?? [
        "missingTopLevelDeferredReason",
        "missingTopLevelScope",
        "missingTopLevelAcceptance",
        "deferredItemIds",
        "activeOrCompleteMissingStartIds",
        "completeItemMissingCompletedAtIds",
        "completeItemMissingEvidenceIds",
      ],
    ),
  );
  const completionEvidenceVerificationPrefix =
    toNonEmptyString(sessionArtifacts.completionEvidenceVerificationPrefix) ?? "verify:";
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
  ensureDir(resolveArtifactPath(archiveRoot));

  const repositoryIndexReadiness = runRepositoryIndexReadiness({
    enabled: repositoryIndexPreflightEnabled,
    verifyStrict: repositoryIndexVerifyStrict,
    buildIfMissing: repositoryIndexBuildIfMissing,
    reindexBeforeVerify: repositoryIndexReindexBeforeVerify,
    closeoutVerifyIfPossible: repositoryIndexCloseoutVerifyIfPossible,
    failureMode: repositoryIndexFailureMode,
  });

  const agentsStateLockFile = path.resolve(canonicalAgentsRoot, ".state.lock");
  let agentsStateLockFd;
  try {
    agentsStateLockFd = acquireFileLock(agentsStateLockFile);
  } catch (error) {
    console.error(`Preflight failed: unable to acquire agents state lock: ${error.message}`);
    process.exit(1);
  }

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
    resolveArtifactPath(executionQueuePath),
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
    resolveArtifactPath(archiveIndexPath),
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
    const archiveRefAbs = resolveArtifactPath(archiveRef);
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
  const planMachineSummary = {
    enabled: planMachineContractEnabled,
    machine_file_name: planMachineFileName,
    schema_version: planMachineSchemaVersion,
    roots: planMachineRoots,
    required_narrative_fields: planMachineRequiredNarrativeFields,
    pre_spec_outline_required_fields: planMachinePreSpecOutlineRequiredFields,
    statuses_requiring_non_empty_pre_spec_non_goals:
      planMachineStatusesRequiringNonEmptyPreSpecNonGoals,
    statuses_requiring_narrative_content: planMachineStatusesRequiringNarrativeContent,
    narrative_min_length: planMachineNarrativeMinLength,
    pre_spec_outline_min_length: planMachinePreSpecOutlineMinLength,
    narrative_min_steps: planMachineNarrativeMinSteps,
    spec_outline_list_field_name: planMachineSpecOutlineListFieldName,
    refined_spec_list_field_name: planMachineRefinedSpecListFieldName,
    spec_outline_entry_required_fields: planMachineSpecOutlineEntryRequiredFields,
    refined_spec_entry_required_fields: planMachineRefinedSpecEntryRequiredFields,
    statuses_requiring_spec_outline_entries:
      planMachineStatusesRequiringSpecOutlineEntries,
    statuses_requiring_refined_spec_entries:
      planMachineStatusesRequiringRefinedSpecEntries,
    spec_outline_min_entries: planMachineSpecOutlineMinEntries,
    refined_spec_min_entries: planMachineRefinedSpecMinEntries,
    implementation_steps_field_name: planMachineImplementationStepsFieldName,
    allowed_narrative_step_statuses: planMachineAllowedNarrativeStepStatuses,
    narrative_step_required_fields: planMachineNarrativeStepRequiredFields,
    narrative_step_optional_fields: planMachineNarrativeStepOptionalFields,
    implementation_step_deliverable_deny_patterns:
      planMachineImplementationStepDeliverableDenyPatterns,
    implementation_step_acceptance_criteria_min_count:
      planMachineImplementationStepAcceptanceCriteriaMinCount,
    step_statuses_requiring_acceptance_criteria:
      planMachineStepStatusesRequiringAcceptanceCriteria,
    step_statuses_requiring_non_empty_completion_summary:
      planMachineStepStatusesRequiringNonEmptyCompletionSummary,
    implementation_completion_summary_required_fields:
      planMachineImplementationCompletionSummaryRequiredFields,
    status_coherence: planMachineStatusCoherence,
    created_machine_files: [],
    normalized_machine_files: [],
    migrated_from_legacy_plan_md_refs: [],
    missing_machine_files: [],
    invalid_machine_files: [],
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
      const rootAbs = resolveArtifactPath(rootPath);
      const requestedRootState = toNonEmptyString(planQueueSyncStateByRoot[rootPath]) ?? "pending";
      const defaultRootState = allowedQueueStates.includes(requestedRootState)
        ? requestedRootState
        : "pending";
      const rootToken = toQueueToken(path.basename(rootPath), "root");
      const featureDirs = listFeaturePlanDirectories(rootAbs);

      for (const featureDir of featureDirs) {
        const planRef = `${rootPath}/${featureDir}/${planQueueSyncPlanFileName}`;
        const planAbs = resolveArtifactPath(planRef);
        const legacyPlanMarkdownRef = toLegacyPlanMarkdownRef(planRef);
        const legacyPlanMarkdownAbs = legacyPlanMarkdownRef
          ? resolveArtifactPath(legacyPlanMarkdownRef)
          : null;
        const legacyPlanMarkdownTitle =
          legacyPlanMarkdownAbs && fs.existsSync(legacyPlanMarkdownAbs)
            ? readPlanHeading(legacyPlanMarkdownAbs)
            : null;
        const legacyNarrativeSections =
          legacyPlanMarkdownAbs && fs.existsSync(legacyPlanMarkdownAbs)
            ? readLegacyPlanNarrativeSections(
                legacyPlanMarkdownAbs,
                planMachineRequiredNarrativeFields,
              )
            : {};
        const legacyPreSpecOutline =
          legacyPlanMarkdownAbs && fs.existsSync(legacyPlanMarkdownAbs)
            ? readLegacyPlanPreSpecOutline(
                legacyPlanMarkdownAbs,
                planMachinePreSpecOutlineRequiredFields,
              )
            : {};
        if (!fs.existsSync(planAbs)) {
          if (
            planMachineContractEnabled &&
            planMachineRoots.includes(rootPath) &&
            planQueueSyncPlanFileName === planMachineFileName
          ) {
            const featureTitle =
              legacyPlanMarkdownTitle ?? `Plan Track: ${toFeatureTitleFromSlug(featureDir)}`;
            const template = buildPlanMachineTemplate({
              schemaVersion: planMachineSchemaVersion,
              featureId: featureDir,
              featureTitle,
              planRef,
              rootPath,
              now,
              requiredPlanningStages: planMachineRequiredPlanningStages,
              requiredNarrativeFields: planMachineRequiredNarrativeFields,
              preSpecOutlineRequiredFields: planMachinePreSpecOutlineRequiredFields,
              specOutlineEntryRequiredFields: planMachineSpecOutlineEntryRequiredFields,
              refinedSpecEntryRequiredFields: planMachineRefinedSpecEntryRequiredFields,
              legacyNarrativeSections,
              legacyPreSpecOutline,
              specOutlineListFieldName: planMachineSpecOutlineListFieldName,
              refinedSpecListFieldName: planMachineRefinedSpecListFieldName,
              implementationStepsFieldName: planMachineImplementationStepsFieldName,
              implementationCompletionSummaryRequiredFields: planMachineImplementationCompletionSummaryRequiredFields,
              allowedNarrativeStepStatuses: planMachineAllowedNarrativeStepStatuses,
              implementationStepDeliverableDenyPatterns: planMachineImplementationStepDeliverableDenyPatterns,
              implementationStepAcceptanceCriteriaMinCount: planMachineImplementationStepAcceptanceCriteriaMinCount,
              stepStatusesRequiringAcceptanceCriteria: planMachineStepStatusesRequiringAcceptanceCriteria,
              stepStatusesRequiringNonEmptyCompletionSummary: planMachineStepStatusesRequiringNonEmptyCompletionSummary,
              narrativeStepRequiredFields: planMachineNarrativeStepRequiredFields,
              narrativeStepOptionalFields: planMachineNarrativeStepOptionalFields,
              allowedStatusByRoot: planMachineAllowedStatusByRoot,
            });
            writeJson(planAbs, template);
            if (!planMachineSummary.created_machine_files.includes(planRef)) {
              planMachineSummary.created_machine_files.push(planRef);
            }
            if (
              rootPath !== archivedPlanRoot &&
              legacyPlanMarkdownRef &&
              fs.existsSync(legacyPlanMarkdownAbs)
            ) {
              if (!planMachineSummary.migrated_from_legacy_plan_md_refs.includes(legacyPlanMarkdownRef)) {
                planMachineSummary.migrated_from_legacy_plan_md_refs.push(legacyPlanMarkdownRef);
              }
            }
          }
        }
        if (!fs.existsSync(planAbs)) {
          planQueueSyncSummary.missing_plan_files.push(planRef);
          continue;
        }

        const planTitle = readPlanDisplayTitle(planAbs);
        const featureTitle =
          planTitle ?? legacyPlanMarkdownTitle ?? `Plan Track: ${toFeatureTitleFromSlug(featureDir)}`;
        const planMachineRef = `${rootPath}/${featureDir}/${planMachineFileName}`;
        const planMachineAbs = resolveArtifactPath(planMachineRef);

        if (planMachineContractEnabled && planMachineRoots.includes(rootPath)) {
          if (!fs.existsSync(planMachineAbs)) {
            const template = buildPlanMachineTemplate({
              schemaVersion: planMachineSchemaVersion,
              featureId: featureDir,
              featureTitle,
              planRef,
              rootPath,
              now,
              requiredPlanningStages: planMachineRequiredPlanningStages,
              requiredNarrativeFields: planMachineRequiredNarrativeFields,
              preSpecOutlineRequiredFields: planMachinePreSpecOutlineRequiredFields,
              specOutlineEntryRequiredFields: planMachineSpecOutlineEntryRequiredFields,
              refinedSpecEntryRequiredFields: planMachineRefinedSpecEntryRequiredFields,
              legacyNarrativeSections,
              legacyPreSpecOutline,
              specOutlineListFieldName: planMachineSpecOutlineListFieldName,
              refinedSpecListFieldName: planMachineRefinedSpecListFieldName,
              implementationStepsFieldName: planMachineImplementationStepsFieldName,
              implementationCompletionSummaryRequiredFields: planMachineImplementationCompletionSummaryRequiredFields,
              allowedNarrativeStepStatuses: planMachineAllowedNarrativeStepStatuses,
              implementationStepDeliverableDenyPatterns: planMachineImplementationStepDeliverableDenyPatterns,
              implementationStepAcceptanceCriteriaMinCount: planMachineImplementationStepAcceptanceCriteriaMinCount,
              stepStatusesRequiringAcceptanceCriteria: planMachineStepStatusesRequiringAcceptanceCriteria,
              stepStatusesRequiringNonEmptyCompletionSummary: planMachineStepStatusesRequiringNonEmptyCompletionSummary,
              narrativeStepRequiredFields: planMachineNarrativeStepRequiredFields,
              narrativeStepOptionalFields: planMachineNarrativeStepOptionalFields,
              allowedStatusByRoot: planMachineAllowedStatusByRoot,
            });
            writeJson(planMachineAbs, template);
            planMachineSummary.created_machine_files.push(planMachineRef);
          }

          if (!fs.existsSync(planMachineAbs)) {
            planMachineSummary.missing_machine_files.push(planMachineRef);
          } else {
            const parsedMachine = readJsonSafeFromDisk(planMachineAbs);
            if (parsedMachine.error) {
              planMachineSummary.invalid_machine_files.push({
                ref: planMachineRef,
                error: parsedMachine.error.message,
              });
            } else {
              const normalizedMachine = normalizePlanMachineDocument({
                rawData: parsedMachine.data,
                schemaVersion: planMachineSchemaVersion,
                featureId: featureDir,
                featureTitle,
                planRef,
                rootPath,
                now,
                requiredPlanningStages: planMachineRequiredPlanningStages,
                requiredNarrativeFields: planMachineRequiredNarrativeFields,
                preSpecOutlineRequiredFields: planMachinePreSpecOutlineRequiredFields,
                specOutlineEntryRequiredFields: planMachineSpecOutlineEntryRequiredFields,
                refinedSpecEntryRequiredFields: planMachineRefinedSpecEntryRequiredFields,
                legacyNarrativeSections,
                legacyPreSpecOutline,
                specOutlineListFieldName: planMachineSpecOutlineListFieldName,
                refinedSpecListFieldName: planMachineRefinedSpecListFieldName,
                implementationStepsFieldName: planMachineImplementationStepsFieldName,
                implementationCompletionSummaryRequiredFields: planMachineImplementationCompletionSummaryRequiredFields,
                allowedNarrativeStepStatuses: planMachineAllowedNarrativeStepStatuses,
                implementationStepDeliverableDenyPatterns: planMachineImplementationStepDeliverableDenyPatterns,
                implementationStepAcceptanceCriteriaMinCount: planMachineImplementationStepAcceptanceCriteriaMinCount,
                stepStatusesRequiringAcceptanceCriteria: planMachineStepStatusesRequiringAcceptanceCriteria,
                stepStatusesRequiringNonEmptyCompletionSummary: planMachineStepStatusesRequiringNonEmptyCompletionSummary,
                narrativeStepRequiredFields: planMachineNarrativeStepRequiredFields,
                narrativeStepOptionalFields: planMachineNarrativeStepOptionalFields,
                allowedPlanningStageStates: planMachineAllowedPlanningStageStates,
                allowedSubagentRequirements: planMachineAllowedSubagentRequirements,
                requiredSubagentFields: planMachineRequiredSubagentFields,
                statusesRequiringLastExecutor: planMachineStatusesRequiringLastExecutor,
                allowedStatusByRoot: planMachineAllowedStatusByRoot,
              });
              if (normalizedMachine.changed) {
                writeJson(planMachineAbs, normalizedMachine.data);
                planMachineSummary.normalized_machine_files.push(planMachineRef);
              }
            }
          }
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
          if (planMachineContractEnabled && planMachineRoots.includes(rootPath)) {
            for (const existingIndex of existingIndices) {
              const existingItem = executionQueue.items[existingIndex];
              if (!existingItem || typeof existingItem !== "object") {
                continue;
              }
              if (!Array.isArray(existingItem.references)) {
                existingItem.references = [planRef];
                queueMutated = true;
                planQueueSyncSummary.normalized_existing_items += 1;
              }
              if (!existingItem.references.includes(planMachineRef)) {
                existingItem.references.push(planMachineRef);
                queueMutated = true;
                planQueueSyncSummary.normalized_existing_items += 1;
              }
            }
          }
          continue;
        }

        const featureToken = toQueueToken(featureDir, "feature");
        const newItem = {
          id: `plan-${rootToken}-${featureToken}`,
          idempotency_key: `plan-sync:${rootToken}:${featureToken}`,
          feature_id: featureDir,
          subscope: planQueueSyncDefaultSubscope,
          title: featureTitle,
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
          references: (() => {
            const refs = new Set([planRef]);
            if (planMachineContractEnabled && planMachineRoots.includes(rootPath)) {
              refs.add(planMachineRef);
            }
            return [...refs];
          })(),
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
    const archivedRootAbs = resolveArtifactPath(archivedPlanRoot);
    const archivedFeatureDirs = listFeaturePlanDirectories(archivedRootAbs);
    archivedPlanSyncSummary.discovered_feature_dirs = archivedFeatureDirs.length;

    for (const featureDir of archivedFeatureDirs) {
      const featureDirectoryRef = `${archivedPlanRoot}/${featureDir}`;
      const planRef = `${featureDirectoryRef}/${archivedPlanFileName}`;
      const planAbs = resolveArtifactPath(planRef);
      const legacyPlanMarkdownRef = toLegacyPlanMarkdownRef(planRef);
      const legacyPlanMarkdownAbs = legacyPlanMarkdownRef
        ? resolveArtifactPath(legacyPlanMarkdownRef)
        : null;
      const legacyPlanMarkdownTitle =
        legacyPlanMarkdownAbs && fs.existsSync(legacyPlanMarkdownAbs)
          ? readPlanHeading(legacyPlanMarkdownAbs)
          : null;
      const legacyNarrativeSections =
        legacyPlanMarkdownAbs && fs.existsSync(legacyPlanMarkdownAbs)
          ? readLegacyPlanNarrativeSections(
              legacyPlanMarkdownAbs,
              planMachineRequiredNarrativeFields,
            )
          : {};
      const legacyPreSpecOutline =
        legacyPlanMarkdownAbs && fs.existsSync(legacyPlanMarkdownAbs)
          ? readLegacyPlanPreSpecOutline(
              legacyPlanMarkdownAbs,
              planMachinePreSpecOutlineRequiredFields,
            )
          : {};
      if (!fs.existsSync(planAbs)) {
        if (
          planMachineContractEnabled &&
          planMachineRoots.includes(archivedPlanRoot) &&
          archivedPlanFileName === planMachineFileName
        ) {
          const featureTitle =
            legacyPlanMarkdownTitle ?? `Archived Plan: ${toFeatureTitleFromSlug(featureDir)}`;
          const template = buildPlanMachineTemplate({
            schemaVersion: planMachineSchemaVersion,
            featureId: featureDir,
            featureTitle,
            planRef,
            rootPath: archivedPlanRoot,
            now,
            requiredPlanningStages: planMachineRequiredPlanningStages,
            requiredNarrativeFields: planMachineRequiredNarrativeFields,
            preSpecOutlineRequiredFields: planMachinePreSpecOutlineRequiredFields,
            specOutlineEntryRequiredFields: planMachineSpecOutlineEntryRequiredFields,
            refinedSpecEntryRequiredFields: planMachineRefinedSpecEntryRequiredFields,
            legacyNarrativeSections,
            legacyPreSpecOutline,
            specOutlineListFieldName: planMachineSpecOutlineListFieldName,
            refinedSpecListFieldName: planMachineRefinedSpecListFieldName,
            implementationStepsFieldName: planMachineImplementationStepsFieldName,
            implementationCompletionSummaryRequiredFields: planMachineImplementationCompletionSummaryRequiredFields,
            allowedNarrativeStepStatuses: planMachineAllowedNarrativeStepStatuses,
            implementationStepDeliverableDenyPatterns: planMachineImplementationStepDeliverableDenyPatterns,
            implementationStepAcceptanceCriteriaMinCount: planMachineImplementationStepAcceptanceCriteriaMinCount,
            stepStatusesRequiringAcceptanceCriteria: planMachineStepStatusesRequiringAcceptanceCriteria,
            stepStatusesRequiringNonEmptyCompletionSummary: planMachineStepStatusesRequiringNonEmptyCompletionSummary,
            narrativeStepRequiredFields: planMachineNarrativeStepRequiredFields,
            narrativeStepOptionalFields: planMachineNarrativeStepOptionalFields,
            allowedStatusByRoot: planMachineAllowedStatusByRoot,
          });
          writeJson(planAbs, template);
          if (!planMachineSummary.created_machine_files.includes(planRef)) {
            planMachineSummary.created_machine_files.push(planRef);
          }
        }
      }
      if (!fs.existsSync(planAbs)) {
        archivedPlanSyncSummary.missing_plan_files.push(planRef);
        continue;
      }

      const planHeading =
        readPlanDisplayTitle(planAbs) ??
        legacyPlanMarkdownTitle ??
        `Archived Plan: ${toFeatureTitleFromSlug(featureDir)}`;
      const planMachineRef = `${featureDirectoryRef}/${planMachineFileName}`;
      const planMachineAbs = resolveArtifactPath(planMachineRef);
      if (planMachineContractEnabled && planMachineRoots.includes(archivedPlanRoot)) {
        if (!fs.existsSync(planMachineAbs)) {
          const template = buildPlanMachineTemplate({
            schemaVersion: planMachineSchemaVersion,
            featureId: featureDir,
            featureTitle: planHeading,
            planRef,
            rootPath: archivedPlanRoot,
            now,
            requiredPlanningStages: planMachineRequiredPlanningStages,
            requiredNarrativeFields: planMachineRequiredNarrativeFields,
            preSpecOutlineRequiredFields: planMachinePreSpecOutlineRequiredFields,
            specOutlineEntryRequiredFields: planMachineSpecOutlineEntryRequiredFields,
            refinedSpecEntryRequiredFields: planMachineRefinedSpecEntryRequiredFields,
            legacyNarrativeSections,
            legacyPreSpecOutline,
            specOutlineListFieldName: planMachineSpecOutlineListFieldName,
            refinedSpecListFieldName: planMachineRefinedSpecListFieldName,
            implementationStepsFieldName: planMachineImplementationStepsFieldName,
            implementationCompletionSummaryRequiredFields: planMachineImplementationCompletionSummaryRequiredFields,
            allowedNarrativeStepStatuses: planMachineAllowedNarrativeStepStatuses,
            implementationStepDeliverableDenyPatterns: planMachineImplementationStepDeliverableDenyPatterns,
            implementationStepAcceptanceCriteriaMinCount: planMachineImplementationStepAcceptanceCriteriaMinCount,
            stepStatusesRequiringAcceptanceCriteria: planMachineStepStatusesRequiringAcceptanceCriteria,
            stepStatusesRequiringNonEmptyCompletionSummary: planMachineStepStatusesRequiringNonEmptyCompletionSummary,
            narrativeStepRequiredFields: planMachineNarrativeStepRequiredFields,
            narrativeStepOptionalFields: planMachineNarrativeStepOptionalFields,
            allowedStatusByRoot: planMachineAllowedStatusByRoot,
          });
          writeJson(planMachineAbs, template);
          planMachineSummary.created_machine_files.push(planMachineRef);
        }
        if (!fs.existsSync(planMachineAbs)) {
          planMachineSummary.missing_machine_files.push(planMachineRef);
        } else {
          const parsedMachine = readJsonSafeFromDisk(planMachineAbs);
          if (parsedMachine.error) {
            planMachineSummary.invalid_machine_files.push({
              ref: planMachineRef,
              error: parsedMachine.error.message,
            });
          } else {
            const normalizedMachine = normalizePlanMachineDocument({
              rawData: parsedMachine.data,
              schemaVersion: planMachineSchemaVersion,
              featureId: featureDir,
              featureTitle: planHeading,
              planRef,
              rootPath: archivedPlanRoot,
              now,
              requiredPlanningStages: planMachineRequiredPlanningStages,
              requiredNarrativeFields: planMachineRequiredNarrativeFields,
              preSpecOutlineRequiredFields: planMachinePreSpecOutlineRequiredFields,
              specOutlineEntryRequiredFields: planMachineSpecOutlineEntryRequiredFields,
              refinedSpecEntryRequiredFields: planMachineRefinedSpecEntryRequiredFields,
              legacyNarrativeSections,
              legacyPreSpecOutline,
              specOutlineListFieldName: planMachineSpecOutlineListFieldName,
              refinedSpecListFieldName: planMachineRefinedSpecListFieldName,
              implementationStepsFieldName: planMachineImplementationStepsFieldName,
              implementationCompletionSummaryRequiredFields: planMachineImplementationCompletionSummaryRequiredFields,
              allowedNarrativeStepStatuses: planMachineAllowedNarrativeStepStatuses,
              implementationStepDeliverableDenyPatterns: planMachineImplementationStepDeliverableDenyPatterns,
              implementationStepAcceptanceCriteriaMinCount: planMachineImplementationStepAcceptanceCriteriaMinCount,
              stepStatusesRequiringAcceptanceCriteria: planMachineStepStatusesRequiringAcceptanceCriteria,
              stepStatusesRequiringNonEmptyCompletionSummary: planMachineStepStatusesRequiringNonEmptyCompletionSummary,
              narrativeStepRequiredFields: planMachineNarrativeStepRequiredFields,
              narrativeStepOptionalFields: planMachineNarrativeStepOptionalFields,
              allowedPlanningStageStates: planMachineAllowedPlanningStageStates,
              allowedSubagentRequirements: planMachineAllowedSubagentRequirements,
              requiredSubagentFields: planMachineRequiredSubagentFields,
              statusesRequiringLastExecutor: planMachineStatusesRequiringLastExecutor,
              allowedStatusByRoot: planMachineAllowedStatusByRoot,
            });
            if (normalizedMachine.changed) {
              writeJson(planMachineAbs, normalizedMachine.data);
              planMachineSummary.normalized_machine_files.push(planMachineRef);
            }
          }
        }
      }

      archivedPlanSyncSummary.synced_feature_ids.push(featureDir);

      const canonicalHandoffRef = `${featureDirectoryRef}/${archivedPlanCanonicalHandoffFileName}`;
      const canonicalHandoffAbs = resolveArtifactPath(canonicalHandoffRef);
      let handoffRef = null;
      if (fs.existsSync(canonicalHandoffAbs)) {
        handoffRef = canonicalHandoffRef;
      } else {
        for (const legacyHandoffFileName of archivedPlanLegacyHandoffFileNames) {
          const legacyHandoffRef = `${featureDirectoryRef}/${legacyHandoffFileName}`;
          const legacyHandoffAbs = resolveArtifactPath(legacyHandoffRef);
          if (fs.existsSync(legacyHandoffAbs)) {
            handoffRef = legacyHandoffRef;
            break;
          }
        }
      }
      const promptHistoryRef = `${featureDirectoryRef}/PROMPT_HISTORY.md`;

      const archiveKey = `${archivedPlanArchiveKeyPrefix}${featureDir}`;
      const archiveRef = `${archiveRoot}/${toArchiveFeatureShardName(featureDir)}.${archiveFormat}`;
      const archiveRefAbs = resolveArtifactPath(archiveRef);

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
            plan_machine_ref:
              planMachineContractEnabled && fs.existsSync(planMachineAbs)
                ? planMachineRef
                : null,
            handoff_ref: handoffRef,
            prompt_history_ref: fs.existsSync(resolveArtifactPath(promptHistoryRef))
              ? promptHistoryRef
              : null,
          },
        });
        archivedShardRefs.add(archiveRef);
        archivedPlanSyncSummary.added_shard_records += 1;
      }

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
        plan_machine_ref:
          planMachineContractEnabled && fs.existsSync(planMachineAbs)
            ? planMachineRef
            : null,
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
      resolveArtifactPath,
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
      const hasVerificationEvidence = item.evidence.some((entry) => {
        const text = toNonEmptyString(entry);
        return Boolean(text && text.startsWith(completionEvidenceVerificationPrefix));
      });
      if (
        item.outputs.length === 0 ||
        item.evidence.length === 0 ||
        !toNonEmptyString(item.resolution_summary) ||
        !hasVerificationEvidence
      ) {
        queueQualityIssues.completeItemMissingEvidenceIds.push(item.id);
      }
    }
  }

  const queueQualityIssueCounts = {
    missingTopLevelDeferredReason: queueQualityIssues.missingTopLevelDeferredReason ? 1 : 0,
    missingTopLevelScope: queueQualityIssues.missingTopLevelScope ? 1 : 0,
    missingTopLevelAcceptance: queueQualityIssues.missingTopLevelAcceptance ? 1 : 0,
    deferredItemIds: queueQualityIssues.deferredItemIds.length,
    activeOrCompleteMissingStartIds: queueQualityIssues.activeOrCompleteMissingStartIds.length,
    completeItemMissingCompletedAtIds:
      queueQualityIssues.completeItemMissingCompletedAtIds.length,
    completeItemMissingEvidenceIds: queueQualityIssues.completeItemMissingEvidenceIds.length,
  };
  const blockingQueueQualityIssues = [];
  for (const [issueName, issueCount] of Object.entries(queueQualityIssueCounts)) {
    if (!queueQualityFailureRules.has(issueName)) {
      continue;
    }
    if (issueCount > 0) {
      blockingQueueQualityIssues.push({
        issue: issueName,
        count: issueCount,
      });
    }
  }
  const queueQualityGate = {
    failure_mode: queueQualityFailureMode,
    configured_failure_rules: [...queueQualityFailureRules].sort(),
    issue_counts: queueQualityIssueCounts,
    blocking_issues: blockingQueueQualityIssues,
    blocking_issue_count: blockingQueueQualityIssues.length,
  };
  const queueQualityBlocksArchival =
    queueQualityFailureMode === "fail" && blockingQueueQualityIssues.length > 0;

  const hotQueueItems = [];
  for (const item of executionQueue.items) {
    const itemState = toNonEmptyString(item?.state);
    if (!queueQualityBlocksArchival && itemState && archiveOnItemStates.has(itemState)) {
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
    !queueQualityBlocksArchival &&
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
      const rootAbs = resolveArtifactPath(rootPath);
      const requestedRootState = toNonEmptyString(planQueueSyncStateByRoot[rootPath]) ?? "pending";
      const defaultRootState = allowedQueueStates.includes(requestedRootState)
        ? requestedRootState
        : "pending";
      const rootToken = toQueueToken(path.basename(rootPath), "root");
      const featureDirs = listFeaturePlanDirectories(rootAbs);

      for (const featureDir of featureDirs) {
        const planRef = `${rootPath}/${featureDir}/${planQueueSyncPlanFileName}`;
        const planAbs = resolveArtifactPath(planRef);
        const legacyPlanMarkdownRef = toLegacyPlanMarkdownRef(planRef);
        const legacyPlanMarkdownAbs = legacyPlanMarkdownRef
          ? resolveArtifactPath(legacyPlanMarkdownRef)
          : null;
        const legacyPlanMarkdownTitle =
          legacyPlanMarkdownAbs && fs.existsSync(legacyPlanMarkdownAbs)
            ? readPlanHeading(legacyPlanMarkdownAbs)
            : null;
        const legacyNarrativeSections =
          legacyPlanMarkdownAbs && fs.existsSync(legacyPlanMarkdownAbs)
            ? readLegacyPlanNarrativeSections(
                legacyPlanMarkdownAbs,
                planMachineRequiredNarrativeFields,
              )
            : {};
        const legacyPreSpecOutline =
          legacyPlanMarkdownAbs && fs.existsSync(legacyPlanMarkdownAbs)
            ? readLegacyPlanPreSpecOutline(
                legacyPlanMarkdownAbs,
                planMachinePreSpecOutlineRequiredFields,
              )
            : {};

        if (!fs.existsSync(planAbs)) {
          if (
            planMachineContractEnabled &&
            planMachineRoots.includes(rootPath) &&
            planQueueSyncPlanFileName === planMachineFileName
          ) {
            const featureTitle =
              legacyPlanMarkdownTitle ?? `Plan Track: ${toFeatureTitleFromSlug(featureDir)}`;
            const template = buildPlanMachineTemplate({
              schemaVersion: planMachineSchemaVersion,
              featureId: featureDir,
              featureTitle,
              planRef,
              rootPath,
              now,
              requiredPlanningStages: planMachineRequiredPlanningStages,
              requiredNarrativeFields: planMachineRequiredNarrativeFields,
              preSpecOutlineRequiredFields: planMachinePreSpecOutlineRequiredFields,
              specOutlineEntryRequiredFields: planMachineSpecOutlineEntryRequiredFields,
              refinedSpecEntryRequiredFields: planMachineRefinedSpecEntryRequiredFields,
              legacyNarrativeSections,
              legacyPreSpecOutline,
              specOutlineListFieldName: planMachineSpecOutlineListFieldName,
              refinedSpecListFieldName: planMachineRefinedSpecListFieldName,
              implementationStepsFieldName: planMachineImplementationStepsFieldName,
              implementationCompletionSummaryRequiredFields: planMachineImplementationCompletionSummaryRequiredFields,
              allowedNarrativeStepStatuses: planMachineAllowedNarrativeStepStatuses,
              implementationStepDeliverableDenyPatterns: planMachineImplementationStepDeliverableDenyPatterns,
              implementationStepAcceptanceCriteriaMinCount: planMachineImplementationStepAcceptanceCriteriaMinCount,
              stepStatusesRequiringAcceptanceCriteria: planMachineStepStatusesRequiringAcceptanceCriteria,
              stepStatusesRequiringNonEmptyCompletionSummary: planMachineStepStatusesRequiringNonEmptyCompletionSummary,
              narrativeStepRequiredFields: planMachineNarrativeStepRequiredFields,
              narrativeStepOptionalFields: planMachineNarrativeStepOptionalFields,
              allowedStatusByRoot: planMachineAllowedStatusByRoot,
            });
            writeJson(planAbs, template);
            if (!planMachineSummary.created_machine_files.includes(planRef)) {
              planMachineSummary.created_machine_files.push(planRef);
            }
            if (
              rootPath !== archivedPlanRoot &&
              legacyPlanMarkdownRef &&
              fs.existsSync(legacyPlanMarkdownAbs)
            ) {
              if (!planMachineSummary.migrated_from_legacy_plan_md_refs.includes(legacyPlanMarkdownRef)) {
                planMachineSummary.migrated_from_legacy_plan_md_refs.push(legacyPlanMarkdownRef);
              }
            }
          }
        }
        if (!fs.existsSync(planAbs)) {
          if (!planQueueSyncSummary.missing_plan_files.includes(planRef)) {
            planQueueSyncSummary.missing_plan_files.push(planRef);
          }
          continue;
        }

        if (!planQueueSyncSummary.synced_plan_refs.includes(planRef)) {
          planQueueSyncSummary.synced_plan_refs.push(planRef);
        }

        const planHeading = readPlanDisplayTitle(planAbs);
        const featureTitle =
          planHeading ?? legacyPlanMarkdownTitle ?? `Plan Track: ${toFeatureTitleFromSlug(featureDir)}`;
        const planMachineRef = `${rootPath}/${featureDir}/${planMachineFileName}`;
        const planMachineAbs = resolveArtifactPath(planMachineRef);
        if (planMachineContractEnabled && planMachineRoots.includes(rootPath)) {
          if (!fs.existsSync(planMachineAbs)) {
            const template = buildPlanMachineTemplate({
              schemaVersion: planMachineSchemaVersion,
              featureId: featureDir,
              featureTitle,
              planRef,
              rootPath,
              now,
              requiredPlanningStages: planMachineRequiredPlanningStages,
              requiredNarrativeFields: planMachineRequiredNarrativeFields,
              preSpecOutlineRequiredFields: planMachinePreSpecOutlineRequiredFields,
              specOutlineEntryRequiredFields: planMachineSpecOutlineEntryRequiredFields,
              refinedSpecEntryRequiredFields: planMachineRefinedSpecEntryRequiredFields,
              legacyNarrativeSections,
              legacyPreSpecOutline,
              specOutlineListFieldName: planMachineSpecOutlineListFieldName,
              refinedSpecListFieldName: planMachineRefinedSpecListFieldName,
              implementationStepsFieldName: planMachineImplementationStepsFieldName,
              implementationCompletionSummaryRequiredFields: planMachineImplementationCompletionSummaryRequiredFields,
              allowedNarrativeStepStatuses: planMachineAllowedNarrativeStepStatuses,
              implementationStepDeliverableDenyPatterns: planMachineImplementationStepDeliverableDenyPatterns,
              implementationStepAcceptanceCriteriaMinCount: planMachineImplementationStepAcceptanceCriteriaMinCount,
              stepStatusesRequiringAcceptanceCriteria: planMachineStepStatusesRequiringAcceptanceCriteria,
              stepStatusesRequiringNonEmptyCompletionSummary: planMachineStepStatusesRequiringNonEmptyCompletionSummary,
              narrativeStepRequiredFields: planMachineNarrativeStepRequiredFields,
              narrativeStepOptionalFields: planMachineNarrativeStepOptionalFields,
              allowedStatusByRoot: planMachineAllowedStatusByRoot,
            });
            writeJson(planMachineAbs, template);
            if (!planMachineSummary.created_machine_files.includes(planMachineRef)) {
              planMachineSummary.created_machine_files.push(planMachineRef);
            }
          }
          if (!fs.existsSync(planMachineAbs)) {
            if (!planMachineSummary.missing_machine_files.includes(planMachineRef)) {
              planMachineSummary.missing_machine_files.push(planMachineRef);
            }
          } else {
            const parsedMachine = readJsonSafeFromDisk(planMachineAbs);
            if (parsedMachine.error) {
              if (!planMachineSummary.invalid_machine_files.some((entry) => entry.ref === planMachineRef)) {
                planMachineSummary.invalid_machine_files.push({
                  ref: planMachineRef,
                  error: parsedMachine.error.message,
                });
              }
            } else {
              const normalizedMachine = normalizePlanMachineDocument({
                rawData: parsedMachine.data,
                schemaVersion: planMachineSchemaVersion,
                featureId: featureDir,
                featureTitle,
                planRef,
                rootPath,
                now,
                requiredPlanningStages: planMachineRequiredPlanningStages,
                requiredNarrativeFields: planMachineRequiredNarrativeFields,
                preSpecOutlineRequiredFields: planMachinePreSpecOutlineRequiredFields,
                specOutlineEntryRequiredFields: planMachineSpecOutlineEntryRequiredFields,
                refinedSpecEntryRequiredFields: planMachineRefinedSpecEntryRequiredFields,
                legacyNarrativeSections,
                legacyPreSpecOutline,
                specOutlineListFieldName: planMachineSpecOutlineListFieldName,
                refinedSpecListFieldName: planMachineRefinedSpecListFieldName,
                implementationStepsFieldName: planMachineImplementationStepsFieldName,
                implementationCompletionSummaryRequiredFields: planMachineImplementationCompletionSummaryRequiredFields,
                allowedNarrativeStepStatuses: planMachineAllowedNarrativeStepStatuses,
                implementationStepDeliverableDenyPatterns: planMachineImplementationStepDeliverableDenyPatterns,
                implementationStepAcceptanceCriteriaMinCount: planMachineImplementationStepAcceptanceCriteriaMinCount,
                stepStatusesRequiringAcceptanceCriteria: planMachineStepStatusesRequiringAcceptanceCriteria,
                stepStatusesRequiringNonEmptyCompletionSummary: planMachineStepStatusesRequiringNonEmptyCompletionSummary,
                narrativeStepRequiredFields: planMachineNarrativeStepRequiredFields,
                narrativeStepOptionalFields: planMachineNarrativeStepOptionalFields,
                allowedPlanningStageStates: planMachineAllowedPlanningStageStates,
                allowedSubagentRequirements: planMachineAllowedSubagentRequirements,
                requiredSubagentFields: planMachineRequiredSubagentFields,
                statusesRequiringLastExecutor: planMachineStatusesRequiringLastExecutor,
                allowedStatusByRoot: planMachineAllowedStatusByRoot,
              });
              if (normalizedMachine.changed) {
                writeJson(planMachineAbs, normalizedMachine.data);
                if (!planMachineSummary.normalized_machine_files.includes(planMachineRef)) {
                  planMachineSummary.normalized_machine_files.push(planMachineRef);
                }
              }
            }
          }
        }

        if (existingPlanRefs.has(planRef)) {
          continue;
        }

        const featureToken = toQueueToken(featureDir, "feature");
        executionQueue.items.push({
          id: `plan-${rootToken}-${featureToken}`,
          idempotency_key: `plan-sync:${rootToken}:${featureToken}`,
          feature_id: featureDir,
          subscope: planQueueSyncDefaultSubscope,
          title: featureTitle,
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
          references: (() => {
            const refs = new Set([planRef]);
            if (planMachineContractEnabled && planMachineRoots.includes(rootPath)) {
              refs.add(planMachineRef);
            }
            return [...refs];
          })(),
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
    writeJson(resolveArtifactPath(executionQueuePath), executionQueue);
  }

  if (archiveIndexMutated) {
    archiveIndex.last_updated = now;
    writeJson(resolveArtifactPath(archiveIndexPath), archiveIndex);
  }

  try {
    releaseFileLock(agentsStateLockFile, agentsStateLockFd);
  } catch (error) {
    console.error(`Preflight failed: unable to release agents state lock: ${error.message}`);
    process.exit(1);
  }

  const startupReadOrderBootstrap = normalizeArray(documentationModel.startupReadOrder).filter(
    (entry) => typeof entry === "string" && entry.trim().length > 0,
  );
  const startupFilesVerifiedBootstrap = startupReadOrderBootstrap.every((filePath) => {
    if (filePath === ".agents") {
      return fs.existsSync(path.resolve(canonicalAgentsRoot));
    }
    if (filePath.startsWith(".agents/")) {
      const suffix = filePath.slice(".agents/".length);
      return fs.existsSync(path.resolve(canonicalAgentsRoot, suffix));
    }
    return fs.existsSync(path.resolve(repoRoot, filePath));
  });
  const bootstrapSessionBrief = {
    generated_at: now,
    policy: {
      id: policy?.metadata?.id ?? null,
      version: policy?.metadata?.version ?? null,
      check_state: "pending",
      check_command: "node .agents-config/scripts/enforce-agent-policies.mjs",
      check_error: null,
      warnings: [],
    },
    scope: {
      state: toNonEmptyString(executionQueue.state),
      feature_id: toNonEmptyString(executionQueue.feature_id),
      task_id: toNonEmptyString(executionQueue.task_id),
      objective: toNonEmptyString(executionQueue.objective),
      total_queue_items: Array.isArray(executionQueue.items) ? executionQueue.items.length : 0,
    },
    queue_file: executionQueuePath,
    archive_index_file: archiveIndexPath,
    index_readiness: repositoryIndexReadiness,
    queue_read_contract: queueReadContract,
    queue_overview: {
      state_counts: {},
      status_counts: {},
      non_complete_count: 0,
      non_complete_items: [],
      active_item_ids: [],
      in_progress_item_ids: [],
    },
    startup_attestation: {
      startup_read_order: startupReadOrderBootstrap,
      startup_files_verified: startupFilesVerifiedBootstrap,
      preflight_command: "npm run agent:preflight",
      attested_at: now,
    },
    queue_quality_gate: {
      failure_mode: queueQualityFailureMode,
      configured_failure_rules: [...queueQualityFailureRules].sort(),
      issue_counts: {},
      blocking_issues: [],
      blocking_issue_count: 0,
    },
    next_actions: ["Preflight in progress"],
  };
  writeJson(resolveArtifactPath(sessionBriefJsonPath), bootstrapSessionBrief);

  const policyCheckCommand = `node ${documentationModel.enforcementScript ?? ".agents-config/scripts/enforce-agent-policies.mjs"}`;

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
    fs.existsSync(resolveArtifactPath(artifactPath)),
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
      `Record outputs/evidence/resolution_summary with at least one ${completionEvidenceVerificationPrefix} evidence entry for ${queueQualityIssues.completeItemMissingEvidenceIds.length} complete item(s) (sample: ${sample})`,
    );
  }
  if (queueQualityGate.blocking_issue_count > 0) {
    const blockingSummary = queueQualityGate.blocking_issues
      .map((entry) => `${entry.issue}:${entry.count}`)
      .join(", ");
    nextActions.push(
      `Queue quality gate is blocking archival/closeout (${queueQualityGate.failure_mode}): ${blockingSummary}`,
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
  if (planMachineSummary.created_machine_files.length > 0) {
    nextActions.push(
      `Plan machine contract created ${planMachineSummary.created_machine_files.length} ${planMachineFileName} file(s); fill status/planning/narrative/subagent metadata before implementation`,
    );
  }
  if (planMachineSummary.normalized_machine_files.length > 0) {
    nextActions.push(
      `Plan machine contract normalized ${planMachineSummary.normalized_machine_files.length} ${planMachineFileName} file(s) to canonical schema`,
    );
  }
  if (planMachineSummary.migrated_from_legacy_plan_md_refs.length > 0) {
    nextActions.push(
      `Converted ${planMachineSummary.migrated_from_legacy_plan_md_refs.length} legacy PLAN.md artifact(s) into authoritative ${planMachineFileName} (including narrative section extraction when present)`,
    );
  }
  if (planMachineSummary.missing_machine_files.length > 0) {
    nextActions.push(
      `Add missing ${planMachineFileName} files for ${planMachineSummary.missing_machine_files.length} plan track(s)`,
    );
  }
  if (planMachineSummary.invalid_machine_files.length > 0) {
    nextActions.push(
      `Fix invalid ${planMachineFileName} JSON in ${planMachineSummary.invalid_machine_files.length} plan track(s)`,
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
  if (queueQualityBlocksArchival) {
    nextActions.push("Archival was skipped because queue quality gate is in fail mode.");
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
      "Run `node .agents-config/scripts/enforce-agent-policies.mjs` in a shell with git subprocess access",
    );
  }

  if (nextActions.length === 0) {
    nextActions.push("Proceed with next atomic task in current scope");
  }

  const startupReadOrder = normalizeArray(documentationModel.startupReadOrder).filter(
    (entry) => typeof entry === "string" && entry.trim().length > 0,
  );
  const startupFilesVerified = startupReadOrder.every((filePath) => {
    if (filePath === ".agents") {
      return fs.existsSync(path.resolve(canonicalAgentsRoot));
    }
    if (filePath.startsWith(".agents/")) {
      const suffix = filePath.slice(".agents/".length);
      return fs.existsSync(path.resolve(canonicalAgentsRoot, suffix));
    }
    return fs.existsSync(path.resolve(repoRoot, filePath));
  });

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
    startup_read_order: startupReadOrder,
    startup_attestation: {
      startup_read_order: startupReadOrder,
      startup_files_verified: startupFilesVerified,
      preflight_command: "npm run agent:preflight",
      attested_at: now,
    },
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
    context_index_file: documentationModel.contextIndexFile ?? ".agents-config/docs/CONTEXT_INDEX.json",
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
    plan_machine_contract: {
      enabled: planMachineSummary.enabled,
      machine_file_name: planMachineSummary.machine_file_name,
      schema_version: planMachineSummary.schema_version,
      roots: planMachineSummary.roots,
      required_narrative_fields: planMachineSummary.required_narrative_fields,
      pre_spec_outline_required_fields: planMachineSummary.pre_spec_outline_required_fields,
      statuses_requiring_narrative_content:
        planMachineSummary.statuses_requiring_narrative_content,
      narrative_min_length: planMachineSummary.narrative_min_length,
      pre_spec_outline_min_length: planMachineSummary.pre_spec_outline_min_length,
      narrative_min_steps: planMachineSummary.narrative_min_steps,
      spec_outline_list_field_name: planMachineSummary.spec_outline_list_field_name,
      refined_spec_list_field_name: planMachineSummary.refined_spec_list_field_name,
      implementation_steps_field_name: planMachineSummary.implementation_steps_field_name,
      allowed_narrative_step_statuses:
        planMachineSummary.allowed_narrative_step_statuses,
      narrative_step_required_fields:
        planMachineSummary.narrative_step_required_fields,
      narrative_step_optional_fields:
        planMachineSummary.narrative_step_optional_fields,
      implementation_step_acceptance_criteria_min_count:
        planMachineSummary.implementation_step_acceptance_criteria_min_count,
      step_statuses_requiring_acceptance_criteria:
        planMachineSummary.step_statuses_requiring_acceptance_criteria,
      implementation_completion_summary_required_fields:
        planMachineSummary.implementation_completion_summary_required_fields,
      created_machine_files: planMachineSummary.created_machine_files,
      normalized_machine_files: planMachineSummary.normalized_machine_files,
      migrated_from_legacy_plan_md_refs: planMachineSummary.migrated_from_legacy_plan_md_refs,
      missing_machine_files: planMachineSummary.missing_machine_files,
      invalid_machine_files: planMachineSummary.invalid_machine_files,
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
    queue_quality_gate: queueQualityGate,
    next_actions: nextActions,
  };

  writeJson(resolveArtifactPath(sessionBriefJsonPath), sessionBrief);

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

  if (planMachineContractEnabled && planMachineSummary.invalid_machine_files.length > 0) {
    const sample = planMachineSummary.invalid_machine_files
      .slice(0, 5)
      .map((entry) => `${entry.ref}: ${entry.error}`)
      .join(" | ");
    console.error(
      `Preflight failed: invalid ${planMachineFileName} documents detected (${planMachineSummary.invalid_machine_files.length}). ${sample}`,
    );
    process.exit(1);
  }

  if (queueQualityGate.failure_mode === "fail" && queueQualityGate.blocking_issue_count > 0) {
    const blockingSummary = queueQualityGate.blocking_issues
      .map((entry) => `${entry.issue}:${entry.count}`)
      .join(", ");
    console.error(
      `Preflight failed: queue quality gate blocked closeout (${blockingSummary}).`,
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

  const sessionBriefResolvedPath = resolveArtifactPath(sessionBriefJsonPath);
  const defaultSessionBriefPath = path.resolve(repoRoot, sessionBriefJsonPath);
  if (sessionBriefResolvedPath === defaultSessionBriefPath) {
    console.log(`Preflight complete. Wrote ${sessionBriefJsonPath}.`);
  } else {
    console.log(
      `Preflight complete. Wrote ${sessionBriefJsonPath} (resolved: ${sessionBriefResolvedPath}).`,
    );
  }
}

main();
