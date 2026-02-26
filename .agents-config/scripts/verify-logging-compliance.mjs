#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BASELINE_PATH = ".agents-config/policies/logging-compliance-baseline.json";
const ALLOW_MARKER = "logging-allow: raw";

const JS_RUNTIME_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const JS_TEST_FILE_PATTERN = /\.(test|spec)\.[jt]sx?$/;

const RULES = [
  {
    id: "ts_raw_console",
    description:
      "Frontend/backend runtime code must use shared logger helpers instead of direct console calls.",
    pattern: /\bconsole\.(debug|info|warn|error|log)\s*\(/,
    applies(filePath) {
      if (
        !filePath.startsWith("frontend/") &&
        !filePath.startsWith("backend/src/")
      ) {
        return false;
      }
      if (
        filePath.startsWith("frontend/tests/") ||
        filePath.startsWith("backend/src/__tests__/") ||
        filePath.includes("/__tests__/")
      ) {
        return false;
      }
      if (
        filePath.startsWith("backend/src/scripts/") ||
        filePath.startsWith("frontend/scripts/")
      ) {
        return false;
      }
      if (
        filePath === "backend/src/utils/logger.ts" ||
        filePath === "frontend/lib/logger.ts"
      ) {
        return false;
      }

      const ext = path.extname(filePath);
      if (!JS_RUNTIME_EXTENSIONS.has(ext)) {
        return false;
      }

      if (JS_TEST_FILE_PATTERN.test(filePath)) {
        return false;
      }

      return true;
    },
  },
  {
    id: "py_raw_print",
    description:
      "Python sidecars must avoid raw print statements in favor of shared logging utilities.",
    pattern: /\bprint\s*\(/,
    applies(filePath) {
      if (!filePath.startsWith("services/") || !filePath.endsWith(".py")) {
        return false;
      }
      if (filePath.includes("/tests/") || filePath.endsWith("_test.py")) {
        return false;
      }
      return filePath !== "services/common/logging_utils.py";
    },
  },
  {
    id: "py_logging_basic_config",
    description:
      "Python sidecars must configure logging through services/common/logging_utils.py.",
    pattern: /\blogging\.basicConfig\s*\(/,
    applies(filePath) {
      if (!filePath.startsWith("services/") || !filePath.endsWith(".py")) {
        return false;
      }
      return filePath !== "services/common/logging_utils.py";
    },
  },
];

function runCommandSafe(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function getTrackedFiles() {
  const result = runCommandSafe("git", ["ls-files"]);
  if (!result.ok) {
    throw new Error(
      `Unable to enumerate tracked files with git ls-files: ${
        result.stderr || result.stdout || "unknown error"
      }`,
    );
  }
  if (!result.stdout) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function hasAllowMarker(lines, lineIndex) {
  const current = lines[lineIndex] ?? "";
  if (current.includes(ALLOW_MARKER)) {
    return true;
  }

  const previous = lines[lineIndex - 1] ?? "";
  return previous.includes(ALLOW_MARKER);
}

function collectFindings() {
  const findings = [];
  const trackedFiles = getTrackedFiles();

  for (const filePath of trackedFiles) {
    let relevantRules = RULES.filter((rule) => rule.applies(filePath));
    if (relevantRules.length === 0) {
      continue;
    }

    const content = fs.readFileSync(filePath, "utf8");
    if (content.includes("\u0000")) {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (!line.trim()) {
        continue;
      }
      if (hasAllowMarker(lines, lineIndex)) {
        continue;
      }

      for (const rule of relevantRules) {
        if (!rule.pattern.test(line)) {
          continue;
        }
        findings.push({
          rule_id: rule.id,
          file: filePath,
          line: lineIndex + 1,
          snippet: line.trim(),
        });
      }
    }
  }

  return findings.sort((a, b) => {
    if (a.file !== b.file) {
      return a.file.localeCompare(b.file);
    }
    if (a.line !== b.line) {
      return a.line - b.line;
    }
    return a.rule_id.localeCompare(b.rule_id);
  });
}

function findingKey(finding) {
  return `${finding.rule_id}|${finding.file}|${finding.line}`;
}

function readBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) {
    throw new Error(
      `Logging baseline missing at ${BASELINE_PATH}. Run: node .agents-config/scripts/verify-logging-compliance.mjs --write-baseline`,
    );
  }

  const raw = fs.readFileSync(BASELINE_PATH, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${BASELINE_PATH}: ${error.message}`);
  }

  if (!Array.isArray(parsed.findings)) {
    throw new Error(`${BASELINE_PATH}.findings must be an array.`);
  }

  return parsed;
}

function writeBaseline(findings) {
  const payload = {
    metadata: {
      id: "soundspan-logging-compliance-baseline",
      version: "2026-02-21.01",
      generated_at: new Date().toISOString(),
      description:
        "Tracked raw logging callsites that are allowed temporarily while log-standard migration reaches 100% coverage.",
    },
    rules: RULES.map((rule) => ({
      id: rule.id,
      description: rule.description,
    })),
    findings,
  };

  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(
    `Wrote ${BASELINE_PATH} with ${findings.length} tracked logging findings.`,
  );
}

function checkAgainstBaseline(currentFindings, baseline) {
  const baselineFindings = baseline.findings
    .filter((entry) => {
      return (
        entry &&
        typeof entry === "object" &&
        typeof entry.rule_id === "string" &&
        typeof entry.file === "string" &&
        Number.isInteger(entry.line)
      );
    })
    .map((entry) => ({
      rule_id: entry.rule_id,
      file: entry.file,
      line: entry.line,
      snippet: typeof entry.snippet === "string" ? entry.snippet : "",
    }));

  const baselineByKey = new Map(
    baselineFindings.map((entry) => [findingKey(entry), entry]),
  );
  const currentByKey = new Map(
    currentFindings.map((entry) => [findingKey(entry), entry]),
  );

  const newFindings = [];
  for (const [key, entry] of currentByKey.entries()) {
    if (!baselineByKey.has(key)) {
      newFindings.push(entry);
    }
  }

  const staleFindings = [];
  for (const [key, entry] of baselineByKey.entries()) {
    if (!currentByKey.has(key)) {
      staleFindings.push(entry);
    }
  }

  if (newFindings.length === 0 && staleFindings.length === 0) {
    console.log(
      `Logging compliance check passed (${currentFindings.length} baseline findings tracked).`,
    );
    return;
  }

  if (newFindings.length > 0) {
    console.error("New raw logging findings detected:");
    for (const finding of newFindings.slice(0, 25)) {
      console.error(
        `- [${finding.rule_id}] ${finding.file}:${finding.line} ${finding.snippet}`,
      );
    }
    if (newFindings.length > 25) {
      console.error(`- ... ${newFindings.length - 25} additional findings`);
    }
  }

  if (staleFindings.length > 0) {
    console.error("Baseline contains stale entries (already fixed in code):");
    for (const finding of staleFindings.slice(0, 25)) {
      console.error(`- [${finding.rule_id}] ${finding.file}:${finding.line}`);
    }
    if (staleFindings.length > 25) {
      console.error(`- ... ${staleFindings.length - 25} additional entries`);
    }
  }

  console.error(
    "Run node .agents-config/scripts/verify-logging-compliance.mjs --write-baseline after intentional migrations.",
  );
  process.exit(1);
}

function main() {
  const write = process.argv.includes("--write-baseline");
  const check = process.argv.includes("--check") || !write;

  const findings = collectFindings();

  if (write) {
    writeBaseline(findings);
    return;
  }

  if (check) {
    const baseline = readBaseline();
    checkAgainstBaseline(findings, baseline);
  }
}

main();
