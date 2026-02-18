#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const QUEUE_PATH = ".agents/EXECUTION_QUEUE.json";
const POLICY_PATH = ".github/policies/agent-governance.json";

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

function toNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isValidIsoDate(value) {
  const text = toNonEmptyString(value);
  return text !== null && Number.isFinite(Date.parse(text));
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
  const canonicalRepoRoot =
    toNonEmptyString(workspaceLayout.canonicalRepoRoot) ?? "/home/joshd/git/soundspan";
  const canonicalAgentsRoot =
    toNonEmptyString(workspaceLayout.canonicalAgentsRoot) ??
    path.resolve(canonicalRepoRoot, ".agents");
  const worktreesRoot =
    toNonEmptyString(workspaceLayout.worktreesRoot) ??
    path.resolve(canonicalRepoRoot, ".worktrees");

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

function usage() {
  info("Usage:");
  info("  open-item --id <id> --title <title> --feature-id <feature_id> --plan-ref <ref> --acceptance <criterion> [--acceptance <criterion> ...]");
  info("  start-item --id <id> [--claimed-by <owner>] [--lease-minutes <minutes>]");
  info("  complete-item --id <id> --summary <summary> --output <output> --evidence <evidence>");
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
  if (outputs.length === 0) {
    fail("complete-item requires at least one --output value.");
  }
  if (evidence.length === 0) {
    fail("complete-item requires at least one --evidence value.");
  }

  const item = queue.items.find((entry) => entry && entry.id === id);
  if (!item) {
    fail(`Unknown queue item id: ${id}`);
  }

  const startedAt = isValidIsoDate(item.execution_started_at) ? item.execution_started_at : now;
  item.state = "complete";
  item.execution_started_at = startedAt;
  item.completed_at = now;
  item.outputs = outputs;
  item.evidence = evidence;
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
  info(`Marked feature ${featureId} complete in hot queue. Run npm run agent:preflight to archive/reset.`);
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
      commandOpenItem(repoRoot, flags);
      return;
    case "start-item":
      commandStartItem(repoRoot, flags);
      return;
    case "complete-item":
      commandCompleteItem(repoRoot, flags);
      return;
    case "close-feature":
      commandCloseFeature(repoRoot, flags);
      return;
    default:
      fail(`Unknown command: ${command}`);
  }
}

main();
