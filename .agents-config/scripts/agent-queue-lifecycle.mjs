#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const QUEUE_PATH = ".agents/EXECUTION_QUEUE.json";
const POLICY_PATH = ".agents-config/policies/agent-governance.json";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function info(message) {
  console.log(message);
}

function runCommandSafe(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      stdout,
      stderr,
    };
  }
  return { ok: true, stdout, stderr };
}

function resolveRepoRoot(startDir) {
  const gitRoot = runCommandSafe("git", ["rev-parse", "--show-toplevel"]);
  if (gitRoot.ok && gitRoot.stdout) {
    return path.resolve(gitRoot.stdout);
  }
  return path.resolve(startDir);
}

function resolveGitCommonDir(repoRoot) {
  const commonDir = runCommandSafe("git", ["rev-parse", "--git-common-dir"]);
  if (!commonDir.ok || !commonDir.stdout) {
    return null;
  }
  if (path.isAbsolute(commonDir.stdout)) {
    return path.resolve(commonDir.stdout);
  }
  return path.resolve(repoRoot, commonDir.stdout);
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

function toNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isValidIsoDate(value) {
  const text = toNonEmptyString(value);
  return text !== null && Number.isFinite(Date.parse(text));
}

function resolveCanonicalWorktreesRoot(canonicalRepoRoot) {
  const canonicalRepoRootResolved = path.resolve(canonicalRepoRoot);
  const repoName = path.basename(canonicalRepoRootResolved);
  return path.resolve(canonicalRepoRootResolved, "..", `${repoName}.worktrees`);
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
      const payload = `${process.pid}\n${new Date().toISOString()}\n`;
      fs.writeFileSync(fd, payload, "utf8");
      return fd;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        fail(`Unable to acquire lock ${lockFile}: ${error.message}`);
      }

      try {
        const lockStats = fs.statSync(lockFile);
        if (Date.now() - lockStats.mtimeMs > staleMs) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch (staleError) {
        if (staleError?.code !== "ENOENT") {
          fail(`Unable to inspect lock ${lockFile}: ${staleError.message}`);
        }
      }

      if (Date.now() - start >= timeoutMs) {
        fail(`Timed out waiting for lock ${lockFile} after ${timeoutMs}ms.`);
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
      fail(`Unable to release lock ${lockFile}: ${error.message}`);
    }
  }
}

function withQueueStateLock(repoRoot, action) {
  const { queueFile } = resolveQueueLocation(repoRoot);
  const lockDir = path.dirname(queueFile);
  fs.mkdirSync(lockDir, { recursive: true });
  const lockFile = path.resolve(lockDir, ".state.lock");
  const lockFd = acquireFileLock(lockFile);
  try {
    return action();
  } finally {
    releaseFileLock(lockFile, lockFd);
  }
}

function summarizeOutputSnippet(text) {
  const normalized = toNonEmptyString(text);
  if (!normalized) {
    return null;
  }
  const firstLine = normalized.split("\n")[0]?.trim() ?? "";
  if (!firstLine) {
    return null;
  }
  return firstLine.length > 140 ? `${firstLine.slice(0, 137)}...` : firstLine;
}

function runVerificationCommand(command, cwd) {
  const result = spawnSync("/bin/bash", ["-lc", command], {
    cwd,
    encoding: "utf8",
  });
  const stdout = toNonEmptyString(result.stdout) ?? "";
  const stderr = toNonEmptyString(result.stderr) ?? "";
  const exitCode = Number.isInteger(result.status) ? result.status : null;
  if (result.error || exitCode !== 0) {
    const detail = summarizeOutputSnippet(stderr) ?? summarizeOutputSnippet(stdout);
    const reason = result.error?.message ?? detail ?? "unknown failure";
    fail(`Verification command failed: ${command} (${reason})`);
  }

  const stdoutSummary = summarizeOutputSnippet(stdout);
  return `verify: ${command} | exit=0${stdoutSummary ? ` | stdout=${stdoutSummary}` : ""}`;
}

function parseArgs(argv) {
  const flags = new Map();
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    if (!key) {
      fail("Invalid empty flag.");
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      fail(`Flag --${key} requires a value.`);
    }
    i += 1;

    if (!flags.has(key)) {
      flags.set(key, []);
    }
    flags.get(key).push(next);
  }

  return { flags, positionals };
}

function getSingleFlag(flags, key, required = false) {
  const values = flags.get(key) ?? [];
  if (values.length === 0) {
    if (required) {
      fail(`Missing required flag --${key}.`);
    }
    return null;
  }
  if (values.length > 1) {
    fail(`Flag --${key} may only be provided once.`);
  }
  const normalized = toNonEmptyString(values[0]);
  if (!normalized && required) {
    fail(`Flag --${key} must be a non-empty value.`);
  }
  return normalized;
}

function getMultiFlag(flags, key) {
  const values = flags.get(key) ?? [];
  return values
    .map((value) => toNonEmptyString(value))
    .filter((value) => value !== null);
}

function resolveQueueLocation(repoRoot) {
  const policyFile = path.resolve(repoRoot, POLICY_PATH);
  if (!fs.existsSync(policyFile)) {
    return {
      queueFile: path.resolve(repoRoot, QUEUE_PATH),
      queuePathLabel: QUEUE_PATH,
    };
  }

  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(policyFile, "utf8"));
  } catch (error) {
    fail(`Invalid JSON in ${POLICY_PATH}: ${error.message}`);
  }

  const workspaceLayout = policy?.contracts?.workspaceLayout ?? {};
  const sessionArtifacts = policy?.contracts?.sessionArtifacts ?? {};
  const queuePathLabel =
    toNonEmptyString(sessionArtifacts.executionQueueFile) ?? QUEUE_PATH;
  const workspaceLayoutBaseRepoRoot = resolvePrimaryRepoRoot(repoRoot);
  const canonicalRepoRoot = toNonEmptyString(workspaceLayout.canonicalRepoRoot)
    ? resolvePathFromBase(workspaceLayout.canonicalRepoRoot, workspaceLayoutBaseRepoRoot)
    : path.resolve(repoRoot);
  const canonicalAgentsRoot = toNonEmptyString(workspaceLayout.canonicalAgentsRoot)
    ? resolvePathFromBase(workspaceLayout.canonicalAgentsRoot, canonicalRepoRoot)
    : path.resolve(canonicalRepoRoot, ".agents");
  const worktreesRoot = toNonEmptyString(workspaceLayout.worktreesRoot)
    ? resolvePathFromBase(workspaceLayout.worktreesRoot, canonicalRepoRoot)
    : resolveCanonicalWorktreesRoot(canonicalRepoRoot);

  const repoRootResolved = path.resolve(repoRoot);
  const canonicalRepoRootResolved = path.resolve(canonicalRepoRoot);
  const worktreesRootResolved = path.resolve(worktreesRoot);
  const relativeToWorktrees = path.relative(worktreesRootResolved, repoRootResolved);
  const inConfiguredWorktree =
    relativeToWorktrees === "" ||
    (!relativeToWorktrees.startsWith("..") && !path.isAbsolute(relativeToWorktrees));
  if (
    repoRootResolved !== canonicalRepoRootResolved &&
    !inConfiguredWorktree
  ) {
    fail(
      `Current repo root ${repoRootResolved} must be ${canonicalRepoRootResolved} or under ${worktreesRootResolved}.`,
    );
  }

  if (queuePathLabel === ".agents") {
    return {
      queueFile: path.resolve(canonicalAgentsRoot),
      queuePathLabel,
    };
  }
  if (queuePathLabel.startsWith(".agents/")) {
    const suffix = queuePathLabel.slice(".agents/".length);
    return {
      queueFile: path.resolve(canonicalAgentsRoot, suffix),
      queuePathLabel,
    };
  }

  return {
    queueFile: path.resolve(repoRootResolved, queuePathLabel),
    queuePathLabel,
  };
}

function loadQueue(repoRoot) {
  const { queueFile, queuePathLabel } = resolveQueueLocation(repoRoot);
  if (!fs.existsSync(queueFile)) {
    fail(`Missing queue file: ${queuePathLabel}. Run npm run agent:preflight first.`);
  }
  const queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
  if (!queue || typeof queue !== "object") {
    fail(`${queuePathLabel} must contain a JSON object.`);
  }
  if (!Array.isArray(queue.items)) {
    fail(`${queuePathLabel}.items must be an array.`);
  }
  return { queueFile, queue };
}

function saveQueue(queueFile, queue) {
  queue.updated_at = new Date().toISOString();
  queue.last_updated = queue.updated_at;
  fs.writeFileSync(queueFile, `${JSON.stringify(queue, null, 2)}\n`, "utf8");
}

function ensureSafeFeatureId(featureId) {
  if (!/^[A-Za-z0-9._-]+$/.test(featureId)) {
    fail(
      `Invalid --feature-id ${featureId}. Use only letters, numbers, ".", "_", and "-".`,
    );
  }
}

function listMarkdownFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const stats = fs.statSync(rootDir);
  if (!stats.isDirectory()) {
    return [];
  }

  const files = [];
  const stack = [rootDir];
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

function moveFeaturePlanDirectory(queueFile, featureId) {
  ensureSafeFeatureId(featureId);

  const agentsRoot = path.resolve(path.dirname(queueFile));
  const currentDir = path.resolve(agentsRoot, "plans", "current", featureId);
  const deferredDir = path.resolve(agentsRoot, "plans", "deferred", featureId);
  const archivedDir = path.resolve(agentsRoot, "plans", "archived", featureId);

  const currentExists = fs.existsSync(currentDir);
  const deferredExists = fs.existsSync(deferredDir);
  const archivedExists = fs.existsSync(archivedDir);

  if (currentExists && deferredExists) {
    fail(
      `Feature ${featureId} exists in both current and deferred plans. Resolve manually before closing.`,
    );
  }

  if (archivedExists && (currentExists || deferredExists)) {
    fail(
      `Archived plan already exists for ${featureId} while current/deferred plan still exists. Resolve manually before closing.`,
    );
  }

  const sourceDir = currentExists ? currentDir : deferredExists ? deferredDir : null;
  let moved = false;
  if (sourceDir) {
    fs.mkdirSync(path.dirname(archivedDir), { recursive: true });
    fs.renameSync(sourceDir, archivedDir);
    moved = true;
  } else if (!archivedExists) {
    fail(
      `No plan directory found for feature ${featureId} under .agents/plans/current or .agents/plans/deferred.`,
    );
  }

  const fromCurrentPrefix = `.agents/plans/current/${featureId}`;
  const fromDeferredPrefix = `.agents/plans/deferred/${featureId}`;
  const toArchivedPrefix = `.agents/plans/archived/${featureId}`;
  const plansRoot = path.resolve(agentsRoot, "plans");

  let rewrittenFiles = 0;
  let rewrittenReferences = 0;
  for (const markdownFile of listMarkdownFiles(plansRoot)) {
    const before = fs.readFileSync(markdownFile, "utf8");
    let after = before;
    for (const fromPrefix of [fromCurrentPrefix, fromDeferredPrefix]) {
      const replaced = after.split(fromPrefix).join(toArchivedPrefix);
      if (replaced !== after) {
        const changeCount = after.split(fromPrefix).length - 1;
        rewrittenReferences += changeCount;
        after = replaced;
      }
    }
    if (after !== before) {
      fs.writeFileSync(markdownFile, after, "utf8");
      rewrittenFiles += 1;
    }
  }

  return {
    moved,
    rewrittenFiles,
    rewrittenReferences,
    archivedPlanRef: `${toArchivedPrefix}/PLAN.json`,
    previousPlanRefs: new Set([
      `${fromCurrentPrefix}/PLAN.json`,
      `${fromDeferredPrefix}/PLAN.json`,
      `${fromCurrentPrefix}/PLAN.md`,
      `${fromDeferredPrefix}/PLAN.md`,
    ]),
  };
}

function usage() {
  info("Usage:");
  info("  open-item --id <id> --title <title> --feature-id <feature_id> --plan-ref <ref> --acceptance <criterion> [--acceptance <criterion> ...]");
  info("  start-item --id <id> [--claimed-by <owner>] [--lease-minutes <minutes>]");
  info("  complete-item --id <id> --summary <summary> --output <output> --verify-cmd <command> [--verify-cmd <command> ...] [--evidence <evidence>]");
  info("  close-feature --feature-id <feature_id> [--task-id <task_id>] [--objective <objective>]");
}

function commandOpenItem(repoRoot, flags) {
  const { queueFile, queue } = loadQueue(repoRoot);
  const now = new Date().toISOString();

  const id = getSingleFlag(flags, "id", true);
  const title = getSingleFlag(flags, "title", true);
  const featureId = getSingleFlag(flags, "feature-id", true);
  const planRef = getSingleFlag(flags, "plan-ref", true);
  const owner = getSingleFlag(flags, "owner", false) ?? "orchestrator";
  const type = getSingleFlag(flags, "type", false) ?? "task";
  const subscope = getSingleFlag(flags, "subscope", false);
  const acceptance = getMultiFlag(flags, "acceptance");
  const constraints = getMultiFlag(flags, "constraint");
  const references = getMultiFlag(flags, "reference");
  const dependsOn = getMultiFlag(flags, "depends-on");

  if (acceptance.length === 0) {
    fail("open-item requires at least one --acceptance value.");
  }
  if (queue.items.some((item) => item && item.id === id)) {
    fail(`Queue item id already exists: ${id}`);
  }
  if (queue.items.some((item) => item && item.idempotency_key === `manual:${id}`)) {
    fail(`Queue item idempotency key already exists: manual:${id}`);
  }

  queue.items.push({
    id,
    idempotency_key: `manual:${id}`,
    feature_id: featureId,
    subscope: subscope ?? null,
    title,
    type,
    state: "pending",
    created_at: now,
    updated_at: now,
    planned_at: now,
    owner,
    acceptance_criteria: acceptance,
    constraints,
    references: references.length > 0 ? references : [planRef],
    depends_on: dependsOn,
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
    deferred_reason: null,
    cancel_reason: null,
  });

  saveQueue(queueFile, queue);
  info(`Opened queue item ${id}.`);
}

function commandStartItem(repoRoot, flags) {
  const { queueFile, queue } = loadQueue(repoRoot);
  const now = new Date().toISOString();

  const id = getSingleFlag(flags, "id", true);
  const claimedBy = getSingleFlag(flags, "claimed-by", false) ?? "orchestrator";
  const leaseMinutesRaw = getSingleFlag(flags, "lease-minutes", false);
  const leaseMinutes = leaseMinutesRaw ? Number.parseInt(leaseMinutesRaw, 10) : 60;
  if (!Number.isInteger(leaseMinutes) || leaseMinutes < 1) {
    fail("--lease-minutes must be a positive integer.");
  }

  const item = queue.items.find((entry) => entry && entry.id === id);
  if (!item) {
    fail(`Unknown queue item id: ${id}`);
  }

  const startedAt = isValidIsoDate(item.execution_started_at) ? item.execution_started_at : now;
  const leaseExpiresAt = new Date(Date.parse(now) + leaseMinutes * 60 * 1000).toISOString();
  const attemptCount = Number.isInteger(item.attempt_count) && item.attempt_count >= 0
    ? item.attempt_count + 1
    : 1;

  item.state = "active";
  item.execution_started_at = startedAt;
  item.claimed_by = claimedBy;
  item.claimed_at = now;
  item.lease_expires_at = leaseExpiresAt;
  item.attempt_count = attemptCount;
  item.last_attempt_at = now;
  item.updated_at = now;

  saveQueue(queueFile, queue);
  info(`Started queue item ${id}.`);
}

function commandCompleteItem(repoRoot, flags) {
  const { queueFile, queue } = loadQueue(repoRoot);
  const now = new Date().toISOString();

  const id = getSingleFlag(flags, "id", true);
  const summary = getSingleFlag(flags, "summary", true);
  const outputs = getMultiFlag(flags, "output");
  const evidence = getMultiFlag(flags, "evidence");
  const verificationCommands = getMultiFlag(flags, "verify-cmd");
  if (outputs.length === 0) {
    fail("complete-item requires at least one --output value.");
  }
  if (verificationCommands.length === 0) {
    fail("complete-item requires at least one --verify-cmd command.");
  }

  const item = queue.items.find((entry) => entry && entry.id === id);
  if (!item) {
    fail(`Unknown queue item id: ${id}`);
  }

  const verificationEvidence = verificationCommands.map((command) =>
    runVerificationCommand(command, repoRoot),
  );

  const startedAt = isValidIsoDate(item.execution_started_at) ? item.execution_started_at : now;
  item.state = "complete";
  item.execution_started_at = startedAt;
  item.completed_at = now;
  item.outputs = outputs;
  item.evidence = [...evidence, ...verificationEvidence];
  item.resolution_summary = summary;
  item.claimed_by = null;
  item.claimed_at = null;
  item.lease_expires_at = null;
  item.updated_at = now;

  saveQueue(queueFile, queue);
  info(`Completed queue item ${id}.`);
}

function commandCloseFeature(repoRoot, flags) {
  const { queueFile, queue } = loadQueue(repoRoot);
  const now = new Date().toISOString();

  const featureId = getSingleFlag(flags, "feature-id", true);
  const taskId = getSingleFlag(flags, "task-id", false);
  const objective = getSingleFlag(flags, "objective", false);
  ensureSafeFeatureId(featureId);

  const planMoveResult = moveFeaturePlanDirectory(queueFile, featureId);
  let updatedPlanRefs = 0;
  for (const item of queue.items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if (item.feature_id !== featureId) {
      continue;
    }
    const existingPlanRef = toNonEmptyString(item.plan_ref);
    if (!existingPlanRef) {
      continue;
    }
    if (!planMoveResult.previousPlanRefs.has(existingPlanRef)) {
      continue;
    }
    item.plan_ref = planMoveResult.archivedPlanRef;
    item.updated_at = now;
    updatedPlanRefs += 1;
  }

  queue.feature_id = featureId;
  if (taskId) {
    queue.task_id = taskId;
  }
  if (objective) {
    queue.objective = objective;
  }
  queue.state = "complete";
  queue.updated_at = now;
  queue.last_updated = now;

  saveQueue(queueFile, queue);
  const moveStatus = planMoveResult.moved
    ? "moved"
    : "already archived";
  info(
    `Marked feature ${featureId} complete in hot queue, ${moveStatus} plan directory, rewrote ${planMoveResult.rewrittenReferences} plan references across ${planMoveResult.rewrittenFiles} markdown files, and updated ${updatedPlanRefs} queue plan_ref entries. Run npm run agent:preflight to archive/reset.`,
  );
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") {
    usage();
    process.exit(0);
  }

  const { flags, positionals } = parseArgs(rest);
  if (positionals.length > 0) {
    fail(`Unexpected positional args: ${positionals.join(" ")}`);
  }

  const repoRoot = resolveRepoRoot(process.cwd());
  switch (command) {
    case "open-item":
      withQueueStateLock(repoRoot, () => {
        commandOpenItem(repoRoot, flags);
      });
      return;
    case "start-item":
      withQueueStateLock(repoRoot, () => {
        commandStartItem(repoRoot, flags);
      });
      return;
    case "complete-item":
      withQueueStateLock(repoRoot, () => {
        commandCompleteItem(repoRoot, flags);
      });
      return;
    case "close-feature":
      withQueueStateLock(repoRoot, () => {
        commandCloseFeature(repoRoot, flags);
      });
      return;
    default:
      fail(`Unknown command: ${command}`);
  }
}

main();
