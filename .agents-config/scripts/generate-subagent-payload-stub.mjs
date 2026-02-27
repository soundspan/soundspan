#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

function toNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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

    if (key === "help") {
      flags.set("help", ["true"]);
      continue;
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

function getSingleFlag(flags, key, fallback = null) {
  const values = flags.get(key) ?? [];
  if (values.length === 0) {
    return fallback;
  }
  if (values.length > 1) {
    fail(`Flag --${key} may only be provided once.`);
  }
  return toNonEmptyString(values[0]) ?? fallback;
}

function getMultiFlag(flags, key) {
  const values = flags.get(key) ?? [];
  return values
    .map((value) => toNonEmptyString(value))
    .filter((value) => value !== null);
}

function loadPolicy(repoRoot) {
  const policyFile = path.resolve(repoRoot, POLICY_PATH);
  if (!fs.existsSync(policyFile)) {
    fail(`Missing policy file: ${POLICY_PATH}`);
  }
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(policyFile, "utf8"));
  } catch (error) {
    fail(`Invalid JSON in ${POLICY_PATH}: ${error.message}`);
  }
  const contract = policy?.contracts?.orchestratorSubagent;
  if (!contract || typeof contract !== "object") {
    fail(`Missing contracts.orchestratorSubagent in ${POLICY_PATH}.`);
  }
  return contract;
}

function printHelp() {
  info("Generate a policy-aligned subagent payload stub.");
  info("");
  info("Usage:");
  info("  npm run agent:payload:stub -- [flags]");
  info("");
  info("Flags:");
  info("  --task-id <id>");
  info("  --orchestrator-id <id>");
  info("  --objective <text>");
  info("  --runtime <codex|claude> (default: codex)");
  info("  --task-class <single_file_edit|grep_triage|draft_rewrite|implementation>");
  info("  --input <text> (repeatable)");
  info("  --constraint <text> (repeatable)");
  info("  --acceptance <text> (repeatable)");
  info("  --deliverable <text> (repeatable)");
  info("  --verification <command> (repeatable)");
  info("  --in-scope <text> (repeatable)");
  info("  --out-of-scope <text> (repeatable)");
  info("  --output <path> (optional, writes file; default prints to stdout)");
}

function ensureArrayWithFallback(values, fallback) {
  if (Array.isArray(values) && values.length > 0) {
    return values;
  }
  return fallback;
}

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.has("help")) {
    printHelp();
    return;
  }

  const repoRoot = resolveRepoRoot(process.cwd());
  const contract = loadPolicy(repoRoot);

  const runtime = getSingleFlag(flags, "runtime", "codex");
  if (runtime !== "codex" && runtime !== "claude") {
    fail(`--runtime must be "codex" or "claude", got "${runtime}".`);
  }
  const isClaude = runtime === "claude";

  const defaultModelRouting = contract.defaultModelRouting ?? {};
  const claudeModelRouting = contract.claudeModelRouting ?? {};
  const defaultReasoningEffortRouting = contract.defaultReasoningEffortRouting ?? {};
  const lowRiskSparkPolicy = contract.lowRiskSparkPolicy ?? {};
  const verbosityBudgets = contract.verbosityBudgets ?? {};

  const taskId = getSingleFlag(flags, "task-id", "queue-item-id");
  const orchestratorId = getSingleFlag(flags, "orchestrator-id", "orchestrator-main");
  const objective = getSingleFlag(
    flags,
    "objective",
    "One concrete objective for this atomic subagent task.",
  );
  const taskClass = getSingleFlag(flags, "task-class", "implementation");

  const inputs = ensureArrayWithFallback(getMultiFlag(flags, "input"), [
    "Only include files and facts required for this atomic objective.",
  ]);
  const constraints = ensureArrayWithFallback(getMultiFlag(flags, "constraint"), [
    "No overbroad refactors.",
    "Stay strictly within atomic_scope.",
    "Mark unknowns as UNCONFIRMED.",
  ]);
  const acceptanceCriteria = ensureArrayWithFallback(getMultiFlag(flags, "acceptance"), [
    "Behavioral outcome is testable.",
    "Evidence command output is included.",
  ]);
  const deliverables = ensureArrayWithFallback(getMultiFlag(flags, "deliverable"), [
    "Patch set",
    "Targeted verification output",
    "Short rationale",
  ]);

  const requiredVerificationCommands = Array.isArray(
    lowRiskSparkPolicy.requiredVerificationCommands,
  )
    ? lowRiskSparkPolicy.requiredVerificationCommands
    : [];

  let verification = getMultiFlag(flags, "verification");
  if (verification.length === 0) {
    verification = requiredVerificationCommands.length
      ? [...requiredVerificationCommands]
      : ["node .agents-config/scripts/enforce-agent-policies.mjs"];
  }

  const allowedLowRiskClasses = Array.isArray(lowRiskSparkPolicy.allowedTaskClasses)
    ? lowRiskSparkPolicy.allowedTaskClasses
    : [];
  const isLowRiskClass = allowedLowRiskClasses.includes(taskClass);
  const requiresExplicitVerification =
    lowRiskSparkPolicy.explicitVerificationCommandsRequired === true;
  const minimumVerificationCommands = Number.isInteger(
    lowRiskSparkPolicy.minimumVerificationCommands,
  )
    ? lowRiskSparkPolicy.minimumVerificationCommands
    : 1;

  if (isLowRiskClass && requiresExplicitVerification) {
    for (const command of requiredVerificationCommands) {
      if (!verification.includes(command)) {
        verification.push(command);
      }
    }
    if (verification.length < minimumVerificationCommands) {
      fail(
        `Low-risk Spark task class ${taskClass} requires at least ${minimumVerificationCommands} verification command(s).`,
      );
    }
  }

  const inScope = ensureArrayWithFallback(getMultiFlag(flags, "in-scope"), [
    "Exactly one concrete objective.",
  ]);
  const outOfScope = ensureArrayWithFallback(getMultiFlag(flags, "out-of-scope"), [
    "Follow-on refactors.",
    "Unrelated cleanup.",
  ]);

  let recommendedModel;
  let recommendedReasoningEffort;

  if (isClaude) {
    recommendedModel = isLowRiskClass
      ? toNonEmptyString(claudeModelRouting.lowRiskLoop) ?? "claude-haiku-4-5"
      : toNonEmptyString(claudeModelRouting.subagent) ?? "claude-opus-4-6";
    recommendedReasoningEffort = null;
  } else {
    recommendedModel = isLowRiskClass
      ? toNonEmptyString(defaultModelRouting.lowRiskLoop) ?? "gpt-5.3-codex-spark"
      : toNonEmptyString(defaultModelRouting.subagent) ?? "gpt-5.3-codex";
    recommendedReasoningEffort = isLowRiskClass
      ? toNonEmptyString(defaultReasoningEffortRouting.lowRiskLoop) ?? "medium"
      : toNonEmptyString(defaultReasoningEffortRouting.subagent) ?? "high";
  }

  const payload = {
    task_id: taskId,
    orchestrator_id: orchestratorId,
    objective,
    inputs,
    constraints,
    acceptance_criteria: acceptanceCriteria,
    deliverables,
    verification,
    atomic_scope: {
      in_scope: inScope,
      out_of_scope: outOfScope,
    },
    context_budget: {
      subagent_objective_max_words: verbosityBudgets.subagentObjectiveMaxWords ?? 32,
      subagent_input_context_max_words: verbosityBudgets.subagentInputContextMaxWords ?? 200,
      subagent_summary_max_words: verbosityBudgets.subagentSummaryMaxWords ?? 120,
      spec_outline_max_words: verbosityBudgets.specOutlineMaxWords ?? 220,
      refined_spec_max_words: verbosityBudgets.refinedSpecMaxWords ?? 420,
      implementation_task_max_words: verbosityBudgets.implementationTaskMaxWords ?? 160,
    },
    routing: {
      runtime,
      task_class: taskClass,
      recommended_model: recommendedModel,
      ...(recommendedReasoningEffort !== null
        ? { recommended_reasoning_effort: recommendedReasoningEffort }
        : {}),
      spark_allowed_for_task_class: isLowRiskClass,
      explicit_verification_required: isLowRiskClass && requiresExplicitVerification,
    },
  };

  const outputJson = `${JSON.stringify(payload, null, 2)}\n`;
  const output = getSingleFlag(flags, "output", null);
  if (output) {
    const outputFile = path.resolve(process.cwd(), output);
    fs.writeFileSync(outputFile, outputJson, "utf8");
    info(`Wrote ${outputFile}`);
    return;
  }

  process.stdout.write(outputJson);
}

main();
