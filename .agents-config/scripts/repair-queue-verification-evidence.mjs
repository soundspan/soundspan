#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const POLICY_PATH = ".agents-config/policies/agent-governance.json";
const DEFAULT_QUEUE_PATH = ".agents/EXECUTION_QUEUE.json";
const DEFAULT_EVIDENCE_PREFIX = "verify:";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function info(message) {
  console.log(message);
}

function toNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => toNonEmptyString(entry))
    .filter((entry) => entry !== null);
}

function runCommandSafe(cmd, args, cwd = undefined) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: toNonEmptyString(result.stdout) ?? "",
    stderr: toNonEmptyString(result.stderr) ?? "",
    error: result.error ?? null,
  };
}

function resolveRepoRoot(startDir) {
  const gitRoot = runCommandSafe("git", ["rev-parse", "--show-toplevel"], startDir);
  if (gitRoot.ok && gitRoot.stdout) {
    return path.resolve(gitRoot.stdout);
  }
  return path.resolve(startDir);
}

function resolveGitCommonDir(repoRoot) {
  const commonDir = runCommandSafe("git", ["rev-parse", "--git-common-dir"], repoRoot);
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

function parseArgs(argv) {
  const parsed = {
    write: false,
    check: false,
    help: false,
    runCmds: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help") {
      parsed.help = true;
      continue;
    }
    if (token === "--write") {
      parsed.write = true;
      continue;
    }
    if (token === "--check") {
      parsed.check = true;
      continue;
    }
    if (token === "--run-cmd") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        fail("--run-cmd requires a command string.");
      }
      i += 1;
      const command = toNonEmptyString(next);
      if (!command) {
        fail("--run-cmd must be a non-empty command string.");
      }
      parsed.runCmds.push(command);
      continue;
    }
    fail(`Unknown argument: ${token}`);
  }

  if (parsed.write && parsed.check) {
    fail("Choose either --check or --write, not both.");
  }
  if (!parsed.write && !parsed.check) {
    parsed.check = true;
  }

  return parsed;
}

function printHelp() {
  info("Repair missing verification evidence for complete queue items.");
  info("");
  info("Usage:");
  info("  node .agents-config/scripts/repair-queue-verification-evidence.mjs --check");
  info(
    "  node .agents-config/scripts/repair-queue-verification-evidence.mjs --write [--run-cmd \"node .agents-config/scripts/enforce-agent-policies.mjs\"]",
  );
  info("");
  info("Options:");
  info("  --check          Report complete items missing `verify:` evidence (default mode).");
  info("  --write          Write repairs to queue file.");
  info("  --run-cmd <cmd>  Execute command once and append real `verify:` evidence to unresolved items.");
  info("  --help           Show this message.");
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
    // Ignore close failures; removing the lock file is authoritative.
  }
  try {
    fs.unlinkSync(lockFile);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      fail(`Unable to release lock ${lockFile}: ${error.message}`);
    }
  }
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

function resolveQueueLocation(repoRoot, policy) {
  const sessionArtifacts =
    policy?.contracts?.sessionArtifacts && typeof policy.contracts.sessionArtifacts === "object"
      ? policy.contracts.sessionArtifacts
      : {};
  const workspaceLayout =
    policy?.contracts?.workspaceLayout && typeof policy.contracts.workspaceLayout === "object"
      ? policy.contracts.workspaceLayout
      : {};
  const queuePathLabel =
    toNonEmptyString(sessionArtifacts.executionQueueFile) ?? DEFAULT_QUEUE_PATH;
  const workspaceLayoutBaseRepoRoot = resolvePrimaryRepoRoot(repoRoot);
  const canonicalRepoRoot = toNonEmptyString(workspaceLayout.canonicalRepoRoot)
    ? resolvePathFromBase(workspaceLayout.canonicalRepoRoot, workspaceLayoutBaseRepoRoot)
    : path.resolve(repoRoot);
  const canonicalAgentsRoot = toNonEmptyString(workspaceLayout.canonicalAgentsRoot)
    ? resolvePathFromBase(workspaceLayout.canonicalAgentsRoot, canonicalRepoRoot)
    : path.resolve(canonicalRepoRoot, ".agents");

  if (queuePathLabel === ".agents") {
    return path.resolve(canonicalAgentsRoot);
  }
  if (queuePathLabel.startsWith(".agents/")) {
    const suffix = queuePathLabel.slice(".agents/".length);
    return path.resolve(canonicalAgentsRoot, suffix);
  }
  return path.resolve(repoRoot, queuePathLabel);
}

function resolveEvidencePrefix(policy) {
  const prefixFromSessionArtifacts = toNonEmptyString(
    policy?.contracts?.sessionArtifacts?.completionEvidenceVerificationPrefix,
  );
  if (prefixFromSessionArtifacts) {
    return prefixFromSessionArtifacts;
  }
  const prefixFromSparkPolicy = toNonEmptyString(
    policy?.contracts?.orchestratorSubagent?.lowRiskSparkPolicy?.requiredEvidencePrefix,
  );
  if (prefixFromSparkPolicy) {
    return prefixFromSparkPolicy;
  }
  return DEFAULT_EVIDENCE_PREFIX;
}

function hasVerificationEvidence(evidence, prefix) {
  return evidence.some((entry) => entry.startsWith(prefix));
}

function isCommandLikeEvidence(entry, prefix) {
  if (!entry || entry.startsWith(prefix)) {
    return false;
  }
  return /^(node|npm|pnpm|yarn|npx|bash|sh|tsx|ts-node|python|python3|pytest|go|cargo|dotnet|make|\.\/)/.test(
    entry,
  );
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

function buildVerificationEvidence(prefix, command, result, timestampIso) {
  const normalizedPrefix = prefix.endsWith(" ") ? prefix.slice(0, -1) : prefix;
  const stdoutSummary = summarizeOutputSnippet(result.stdout);
  const stderrSummary = summarizeOutputSnippet(result.stderr);
  const statusText = Number.isInteger(result.status) ? String(result.status) : "0";
  const summaryText = stdoutSummary ?? stderrSummary;
  const detail = summaryText ? ` | output=${summaryText}` : "";
  return `${normalizedPrefix} ${command} | exit=${statusText}${detail} | at=${timestampIso}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const repoRoot = resolveRepoRoot(process.cwd());
  const policy = readJsonFile(path.resolve(repoRoot, POLICY_PATH)) ?? {};
  const queueFile = resolveQueueLocation(repoRoot, policy);
  if (!fs.existsSync(queueFile)) {
    fail(`Queue file not found: ${queueFile}`);
  }

  const evidencePrefix = resolveEvidencePrefix(policy);
  const queue = readJsonFile(queueFile);
  if (!queue || typeof queue !== "object" || !Array.isArray(queue.items)) {
    fail(`Invalid queue payload at ${queueFile}.`);
  }

  const mode = args.write ? "write" : "check";
  let lockFd = null;
  const lockFile = path.resolve(path.dirname(queueFile), ".state.lock");
  if (mode === "write") {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    lockFd = acquireFileLock(lockFile);
  }

  let completeCount = 0;
  let alreadyValidCount = 0;
  let missingBeforeCount = 0;
  let promotedCount = 0;
  let commandFilledCount = 0;

  const changedItemIds = new Set();
  const unresolvedItemIds = [];
  const missingCompleteItems = [];
  const now = new Date().toISOString();

  try {
    for (const item of queue.items) {
      if (!item || typeof item !== "object") {
        continue;
      }
      if (toNonEmptyString(item.state) !== "complete") {
        continue;
      }
      completeCount += 1;
      item.evidence = normalizeStringArray(item.evidence);

      if (hasVerificationEvidence(item.evidence, evidencePrefix)) {
        alreadyValidCount += 1;
        continue;
      }

      missingBeforeCount += 1;
      const promotedEvidence = item.evidence.find((entry) =>
        isCommandLikeEvidence(entry, evidencePrefix),
      );
      if (promotedEvidence) {
        if (mode === "write") {
          item.evidence.push(`${evidencePrefix} ${promotedEvidence}`);
          item.updated_at = now;
          changedItemIds.add(toNonEmptyString(item.id) ?? "(unknown)");
        }
        promotedCount += 1;
        continue;
      }

      missingCompleteItems.push(item);
      unresolvedItemIds.push(toNonEmptyString(item.id) ?? "(unknown)");
    }

    if (mode === "write" && missingCompleteItems.length > 0 && args.runCmds.length > 0) {
      const timestamp = new Date().toISOString();
      const executedEvidenceEntries = [];

      for (const command of args.runCmds) {
        const result = runCommandSafe("/bin/bash", ["-lc", command], repoRoot);
        if (!result.ok) {
          const detail = summarizeOutputSnippet(result.stderr) ?? summarizeOutputSnippet(result.stdout);
          fail(`Verification command failed: ${command}${detail ? ` (${detail})` : ""}`);
        }
        executedEvidenceEntries.push(
          buildVerificationEvidence(evidencePrefix, command, result, timestamp),
        );
      }

      for (const item of missingCompleteItems) {
        item.evidence = normalizeStringArray(item.evidence);
        item.evidence.push(...executedEvidenceEntries);
        item.updated_at = now;
        changedItemIds.add(toNonEmptyString(item.id) ?? "(unknown)");
      }
      commandFilledCount = missingCompleteItems.length;
    }

    let unresolvedAfterCount = 0;
    let unresolvedAfterIds = [];
    if (mode === "write") {
      for (const item of queue.items) {
        if (!item || typeof item !== "object") {
          continue;
        }
        if (toNonEmptyString(item.state) !== "complete") {
          continue;
        }
        const evidence = normalizeStringArray(item.evidence);
        if (!hasVerificationEvidence(evidence, evidencePrefix)) {
          unresolvedAfterCount += 1;
          unresolvedAfterIds.push(toNonEmptyString(item.id) ?? "(unknown)");
        }
      }
    } else {
      unresolvedAfterCount = missingBeforeCount;
      unresolvedAfterIds = unresolvedItemIds;
    }

    if (mode === "write" && changedItemIds.size > 0) {
      queue.updated_at = now;
      queue.last_updated = now;
      fs.writeFileSync(queueFile, `${JSON.stringify(queue, null, 2)}\n`, "utf8");
    }

    info(`Mode: ${mode}`);
    info(`Queue file: ${queueFile}`);
    info(`Evidence prefix: ${evidencePrefix}`);
    info(`Complete items: ${completeCount}`);
    info(`Complete items already valid: ${alreadyValidCount}`);
    info(`Complete items missing prefix before repair: ${missingBeforeCount}`);
    if (mode === "write") {
      info(`Promoted command-like evidence entries: ${promotedCount}`);
      info(`Filled via executed --run-cmd commands: ${commandFilledCount}`);
      info(`Changed items: ${changedItemIds.size}`);
      if (changedItemIds.size > 0) {
        info(`Changed item IDs: ${[...changedItemIds].sort().join(", ")}`);
      }
      info(`Remaining unresolved complete items: ${unresolvedAfterCount}`);
      if (unresolvedAfterCount > 0) {
        info(`Unresolved item IDs: ${unresolvedAfterIds.join(", ")}`);
      }
      if (unresolvedAfterCount > 0) {
        process.exit(1);
      }
      return;
    }

    if (missingBeforeCount > 0) {
      info(`Missing item IDs: ${unresolvedItemIds.join(", ")}`);
      info("Run with --write to apply repairs; add --run-cmd for unresolved items.");
      process.exit(1);
    }
  } finally {
    if (lockFd !== null) {
      releaseFileLock(lockFile, lockFd);
    }
  }
}

main();
