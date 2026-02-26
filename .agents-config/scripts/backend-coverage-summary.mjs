import fs from "fs";
import path from "path";

const summaryPath = path.resolve("backend/coverage/coverage-summary.json");
const jestResultsPath = path.resolve("backend/coverage/jest-results.json");
const outputMarkdownPath = path.resolve("backend/coverage/coverage-summary.md");

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pct(value) {
  return `${toNumber(value).toFixed(2)}%`;
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const coverage = readJson(summaryPath);
if (!coverage || !coverage.total) {
  const message = "Coverage summary was not found. Ensure Jest coverage generation succeeded.";
  fs.mkdirSync(path.dirname(outputMarkdownPath), { recursive: true });
  fs.writeFileSync(outputMarkdownPath, `## Backend Coverage Summary\n\n${message}\n`);
  console.log(message);
  process.exit(0);
}

const jestResults = readJson(jestResultsPath);
const total = coverage.total;
const perFile = Object.entries(coverage)
  .filter(([key]) => key !== "total")
  .map(([file, stats]) => ({
    file: path.relative(process.cwd(), file),
    statements: toNumber(stats.statements?.pct),
    branches: toNumber(stats.branches?.pct),
    functions: toNumber(stats.functions?.pct),
    lines: toNumber(stats.lines?.pct),
  }));

const byLowLine = [...perFile].sort((a, b) => a.lines - b.lines);
const zeroCoverageFiles = byLowLine.filter((f) => f.lines === 0).map((f) => f.file);
const lowestCoverageFiles = byLowLine.slice(0, 20);

const lineMin = toNumber(process.env.COVERAGE_LINE_MIN, 0);
const branchMin = toNumber(process.env.COVERAGE_BRANCH_MIN, 0);
const functionMin = toNumber(process.env.COVERAGE_FUNCTION_MIN, 0);
const statementMin = toNumber(process.env.COVERAGE_STATEMENT_MIN, 0);
const enforceGate = String(process.env.ENFORCE_COVERAGE_GATE || "false").toLowerCase() === "true";

const gateFailures = [];
if (toNumber(total.lines?.pct) < lineMin) gateFailures.push(`lines ${pct(total.lines?.pct)} < ${lineMin.toFixed(2)}%`);
if (toNumber(total.branches?.pct) < branchMin) gateFailures.push(`branches ${pct(total.branches?.pct)} < ${branchMin.toFixed(2)}%`);
if (toNumber(total.functions?.pct) < functionMin) gateFailures.push(`functions ${pct(total.functions?.pct)} < ${functionMin.toFixed(2)}%`);
if (toNumber(total.statements?.pct) < statementMin) gateFailures.push(`statements ${pct(total.statements?.pct)} < ${statementMin.toFixed(2)}%`);

const suiteCount = jestResults?.numTotalTestSuites ?? "n/a";
const testCount = jestResults?.numTotalTests ?? "n/a";
const passedCount = jestResults?.numPassedTests ?? "n/a";
const failedCount = jestResults?.numFailedTests ?? "n/a";

const lines = [];
lines.push("## Backend Coverage Summary");
lines.push("");
lines.push("| Metric | Coverage |");
lines.push("| --- | ---: |");
lines.push(`| Statements | ${pct(total.statements?.pct)} |`);
lines.push(`| Branches | ${pct(total.branches?.pct)} |`);
lines.push(`| Functions | ${pct(total.functions?.pct)} |`);
lines.push(`| Lines | ${pct(total.lines?.pct)} |`);
lines.push("");
lines.push("| Jest Signal | Value |");
lines.push("| --- | ---: |");
lines.push(`| Test Suites | ${suiteCount} |`);
lines.push(`| Tests | ${testCount} |`);
lines.push(`| Passed | ${passedCount} |`);
lines.push(`| Failed | ${failedCount} |`);
lines.push("");
lines.push(`| Source Files Measured | ${perFile.length} |`);
lines.push(`| Files at 0% Line Coverage | ${zeroCoverageFiles.length} |`);
lines.push("");

if (lowestCoverageFiles.length > 0) {
  lines.push("### Lowest-Coverage Files (Line %)");
  lines.push("");
  lines.push("| File | Line % |");
  lines.push("| --- | ---: |");
  for (const file of lowestCoverageFiles) {
    lines.push(`| \`${file.file}\` | ${pct(file.lines)} |`);
  }
  lines.push("");
}

if (zeroCoverageFiles.length > 0) {
  lines.push("<details>");
  lines.push("<summary>Files with 0% line coverage</summary>");
  lines.push("");
  for (const file of zeroCoverageFiles) {
    lines.push(`- \`${file}\``);
  }
  lines.push("");
  lines.push("</details>");
  lines.push("");
}

if (enforceGate) {
  lines.push("### Coverage Gate");
  lines.push("");
  lines.push(`Thresholds: lines >= ${lineMin.toFixed(2)}%, branches >= ${branchMin.toFixed(2)}%, functions >= ${functionMin.toFixed(2)}%, statements >= ${statementMin.toFixed(2)}%`);
  if (gateFailures.length > 0) {
    lines.push("");
    lines.push("Gate result: ❌ failed");
    for (const failure of gateFailures) {
      lines.push(`- ${failure}`);
    }
  } else {
    lines.push("");
    lines.push("Gate result: ✅ passed");
  }
  lines.push("");
} else {
  lines.push("> Coverage gate is currently disabled (visibility mode).");
  lines.push("");
}

fs.mkdirSync(path.dirname(outputMarkdownPath), { recursive: true });
fs.writeFileSync(outputMarkdownPath, `${lines.join("\n")}\n`, "utf8");
console.log(`Wrote ${outputMarkdownPath}`);

if (enforceGate && gateFailures.length > 0) {
  console.error("Coverage gate failed:");
  for (const failure of gateFailures) {
    console.error(`- ${failure}`);
  }
  process.exit(2);
}
