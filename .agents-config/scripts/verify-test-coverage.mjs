#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BASELINE_PATH = ".agents-config/policies/test-coverage-baseline.json";
const REPORT_PATH = ".agents-config/docs/TEST_COVERAGE.md";
const TOOLING_CONFIG_PATH = ".agents-config/config/project-tooling.json";
const DEFAULT_BASELINE_METADATA_ID = "agents-template-test-coverage-baseline";

const VALID_RUNNERS = new Set(["jest", "c8", "vitest", "pytest-cov"]);

const METRIC_KEYS = ["statements", "branches", "functions", "lines"];

function toNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveBaselineMetadataId() {
  if (!fs.existsSync(TOOLING_CONFIG_PATH)) {
    return DEFAULT_BASELINE_METADATA_ID;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(TOOLING_CONFIG_PATH, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${TOOLING_CONFIG_PATH}: ${error.message}`);
  }
  return (
    toNonEmptyString(parsed?.testCoverage?.baselineMetadataId) ??
    DEFAULT_BASELINE_METADATA_ID
  );
}

function readBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) {
    throw new Error(
      `Test coverage baseline missing at ${BASELINE_PATH}. Create it with initial scope configuration.`,
    );
  }
  const raw = fs.readFileSync(BASELINE_PATH, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${BASELINE_PATH}: ${error.message}`);
  }
  if (!parsed.metadata || typeof parsed.metadata !== "object") {
    throw new Error(`${BASELINE_PATH}.metadata must be an object.`);
  }
  if (parsed.metadata.schema_version !== "1.0") {
    throw new Error(
      `${BASELINE_PATH}.metadata.schema_version must be "1.0" (found "${parsed.metadata.schema_version}").`,
    );
  }
  if (!Array.isArray(parsed.scopes)) {
    throw new Error(`${BASELINE_PATH}.scopes must be an array.`);
  }
  return parsed;
}

function validateScope(scope, index) {
  const prefix = `${BASELINE_PATH}.scopes[${index}]`;
  const errors = [];

  if (!toNonEmptyString(scope.id)) {
    errors.push(`${prefix}.id must be a non-empty string.`);
  }
  if (!toNonEmptyString(scope.runner)) {
    errors.push(`${prefix}.runner must be a non-empty string.`);
  } else if (!VALID_RUNNERS.has(scope.runner)) {
    errors.push(
      `${prefix}.runner must be one of [${[...VALID_RUNNERS].join(", ")}] (found "${scope.runner}").`,
    );
  }
  if (!toNonEmptyString(scope.coverage_summary_path)) {
    errors.push(`${prefix}.coverage_summary_path must be a non-empty string.`);
  }
  if (scope.thresholds && typeof scope.thresholds === "object") {
    for (const key of METRIC_KEYS) {
      const val = scope.thresholds[key];
      if (val !== undefined && val !== null) {
        if (typeof val !== "number" || val < 0 || val > 100) {
          errors.push(`${prefix}.thresholds.${key} must be a number 0-100 (found ${val}).`);
        }
      }
    }
  }
  return errors;
}

/**
 * Normalize coverage output from different runners into a common shape:
 * { statements: number|null, branches: number|null, functions: number|null, lines: number|null }
 */
function normalizeCoverage(runner, summaryPath) {
  if (!fs.existsSync(summaryPath)) {
    return null;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  } catch {
    return null;
  }

  if (runner === "jest" || runner === "c8" || runner === "vitest") {
    const total = raw?.total;
    if (!total || typeof total !== "object") {
      return null;
    }
    return {
      statements: typeof total.statements?.pct === "number" ? total.statements.pct : null,
      branches: typeof total.branches?.pct === "number" ? total.branches.pct : null,
      functions: typeof total.functions?.pct === "number" ? total.functions.pct : null,
      lines: typeof total.lines?.pct === "number" ? total.lines.pct : null,
    };
  }

  if (runner === "pytest-cov") {
    const totals = raw?.totals;
    if (!totals || typeof totals !== "object") {
      return null;
    }
    return {
      statements:
        typeof totals.percent_covered === "number" ? totals.percent_covered : null,
      branches:
        typeof totals.percent_covered_branches === "number"
          ? totals.percent_covered_branches
          : (typeof totals.percent_covered === "number" ? totals.percent_covered : null),
      functions: null,
      lines: null,
    };
  }

  return null;
}

function runScopeTests(scope) {
  const cmd = toNonEmptyString(scope.run_command);
  if (!cmd) {
    return { ok: false, error: "No run_command configured for scope." };
  }
  const result = spawnSync("sh", ["-c", cmd], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 300_000,
  });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    error: result.error ? result.error.message : null,
  };
}

function checkMetrics(scopeId, current, baseline, thresholds, globalThresholds) {
  const failures = [];

  for (const key of METRIC_KEYS) {
    const currentVal = current?.[key];
    if (currentVal === null || currentVal === undefined) {
      continue;
    }

    const baselineVal = baseline?.[key];
    if (typeof baselineVal === "number" && currentVal < baselineVal) {
      failures.push(
        `[${scopeId}] ${key} regressed: ${currentVal}% < baseline ${baselineVal}%`,
      );
    }

    const threshold =
      thresholds?.[key] ?? globalThresholds?.[key] ?? null;
    if (typeof threshold === "number" && currentVal < threshold) {
      failures.push(
        `[${scopeId}] ${key} below threshold: ${currentVal}% < ${threshold}%`,
      );
    }
  }

  return failures;
}

function generateReport(baseline, scopeResults) {
  const lines = [
    "# Test Coverage Baseline",
    "",
    "Generated by `npm run test-coverage:run`. Do not edit manually.",
    "",
    "## Coverage Summary",
    "",
    "| Scope | Statements | Branches | Functions | Lines | Gate |",
    "|-------|-----------|----------|-----------|-------|------|",
  ];

  if (baseline.scopes.length === 0) {
    lines.push("| *(no scopes configured)* | — | — | — | — | — |");
  } else {
    for (const scope of baseline.scopes) {
      const result = scopeResults.get(scope.id);
      const metrics = result?.current;
      const fmt = (val) =>
        val !== null && val !== undefined ? `${val}%` : "—";
      const gate = result?.failures?.length ? "FAIL" : "PASS";
      lines.push(
        `| ${scope.label || scope.id} | ${fmt(metrics?.statements)} | ${fmt(metrics?.branches)} | ${fmt(metrics?.functions)} | ${fmt(metrics?.lines)} | ${gate} |`,
      );
    }
  }

  lines.push("");
  lines.push("## Scope Details");
  lines.push("");

  if (baseline.scopes.length === 0) {
    lines.push("*(Run `npm run test-coverage:run` to populate.)*");
  } else {
    for (const scope of baseline.scopes) {
      const result = scopeResults.get(scope.id);
      lines.push(`### ${scope.label || scope.id}`);
      lines.push("");
      lines.push(`- **ID:** ${scope.id}`);
      lines.push(`- **Runner:** ${scope.runner}`);
      if (scope.baseline_recorded_at) {
        lines.push(`- **Baseline recorded:** ${scope.baseline_recorded_at}`);
      }
      if (result?.current) {
        const m = result.current;
        lines.push(
          `- **Current:** statements=${m.statements ?? "—"}%, branches=${m.branches ?? "—"}%, functions=${m.functions ?? "—"}%, lines=${m.lines ?? "—"}%`,
        );
      }
      if (result?.failures?.length) {
        lines.push("- **Failures:**");
        for (const f of result.failures) {
          lines.push(`  - ${f}`);
        }
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const modeRun = args.includes("--run");
  const modeWrite = args.includes("--write");
  const modeCheck = args.includes("--check") || (!modeRun && !modeWrite);

  const baseline = readBaseline();
  const allFailures = [];
  const scopeResults = new Map();

  for (let i = 0; i < baseline.scopes.length; i++) {
    const scope = baseline.scopes[i];
    const validationErrors = validateScope(scope, i);
    if (validationErrors.length > 0) {
      for (const err of validationErrors) {
        allFailures.push(err);
      }
      continue;
    }

    if (modeRun || modeWrite) {
      const testResult = runScopeTests(scope);
      if (!testResult.ok) {
        const detail = testResult.stderr || testResult.stdout || testResult.error || "unknown";
        allFailures.push(
          `[${scope.id}] Test execution failed (exit ${testResult.status}): ${detail.slice(0, 500)}`,
        );
        scopeResults.set(scope.id, { current: null, failures: [`Test execution failed`] });
        continue;
      }
    }

    const current = normalizeCoverage(scope.runner, scope.coverage_summary_path);
    if (!current) {
      const missingSummaryFailure = `[${scope.id}] Coverage summary not found or unreadable at ${scope.coverage_summary_path}`;
      allFailures.push(missingSummaryFailure);
      scopeResults.set(scope.id, { current: null, failures: [missingSummaryFailure] });
      continue;
    }

    const metricFailures = checkMetrics(
      scope.id,
      current,
      scope.baseline_metrics,
      scope.thresholds,
      baseline.global_thresholds,
    );

    scopeResults.set(scope.id, { current, failures: metricFailures });

    if (!modeWrite) {
      allFailures.push(...metricFailures);
    }

    if (modeWrite) {
      for (const key of METRIC_KEYS) {
        const currentVal = current[key];
        const baselineVal = scope.baseline_metrics?.[key];
        if (typeof currentVal === "number") {
          if (!scope.baseline_metrics) {
            scope.baseline_metrics = {};
          }
          scope.baseline_metrics[key] =
            typeof baselineVal === "number"
              ? Math.max(currentVal, baselineVal)
              : currentVal;
        }
      }
      scope.baseline_recorded_at = new Date().toISOString();
    }
  }

  if (modeWrite) {
    baseline.metadata.id = resolveBaselineMetadataId();
    baseline.metadata.generated_at = new Date().toISOString();
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    console.log(`Wrote ${BASELINE_PATH} with ${baseline.scopes.length} scopes.`);
  }

  if (modeRun || modeWrite) {
    const reportContent = generateReport(baseline, scopeResults);
    fs.writeFileSync(REPORT_PATH, reportContent, "utf8");
    console.log(`Wrote ${REPORT_PATH}.`);
  }

  if (allFailures.length > 0) {
    console.error("Test coverage check failures:");
    for (const f of allFailures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }

  const scopeCount = baseline.scopes.length;
  console.log(
    `Test coverage ${modeCheck ? "verify" : modeRun ? "run" : "write"} passed (${scopeCount} scope${scopeCount !== 1 ? "s" : ""}).`,
  );
}

main();
