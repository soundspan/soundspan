#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const OUTPUT_FILE = "docs/JSDOC_COVERAGE.md";
const SOURCE_ROOTS = ["backend/src", "frontend"];
const INCLUDED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const EXCLUDED_SEGMENTS = [
  "/__tests__/",
  "/tests/",
  "/test/",
  "/node_modules/",
  "/.next/",
  "/dist/",
  "/build/",
  "/coverage/",
];

const DECLARATION_PATTERNS = [
  {
    kind: "function",
    regex:
      /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/,
  },
  {
    kind: "default-function",
    regex: /^\s*export\s+default\s+(?:async\s+)?function\s*\(/,
    fallbackName: "<default-function>",
  },
  {
    kind: "class",
    regex:
      /^\s*export\s+(?:default\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/,
  },
  {
    kind: "default-class",
    regex: /^\s*export\s+default\s+class\s*\{/,
    fallbackName: "<default-class>",
  },
  {
    kind: "const-arrow",
    regex:
      /^\s*export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|<[^>]+>\s*\([^)]*\))\s*=>/,
  },
];

function runCommandSafe(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    ok: !result.error && result.status === 0,
    stdout: (result.stdout ?? "").trim(),
  };
}

function resolveRepoRoot() {
  const gitRoot = runCommandSafe("git", ["rev-parse", "--show-toplevel"]);
  if (gitRoot.ok && gitRoot.stdout) {
    return path.resolve(gitRoot.stdout);
  }
  return process.cwd();
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function listFilesRecursively(rootAbsolutePath) {
  if (!fs.existsSync(rootAbsolutePath)) {
    return [];
  }

  const entries = [];

  function walk(currentPath) {
    const directoryEntries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of directoryEntries) {
      const nextPath = path.resolve(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(nextPath);
      } else if (entry.isFile()) {
        entries.push(nextPath);
      }
    }
  }

  walk(rootAbsolutePath);
  return entries;
}

function isCandidateFile(relativePath) {
  if (relativePath.endsWith(".d.ts")) {
    return false;
  }

  const extension = path.extname(relativePath);
  if (!INCLUDED_EXTENSIONS.has(extension)) {
    return false;
  }

  const posixPath = toPosixPath(relativePath);
  return !EXCLUDED_SEGMENTS.some((segment) => posixPath.includes(segment));
}

function classifyArea(relativePath) {
  const posixPath = toPosixPath(relativePath);

  if (posixPath.startsWith("backend/src/routes/")) return "Backend routes";
  if (posixPath.startsWith("backend/src/services/")) return "Backend services";
  if (posixPath.startsWith("backend/src/utils/")) return "Backend utils";
  if (posixPath.startsWith("backend/src/middleware/")) return "Backend middleware";
  if (posixPath.startsWith("backend/src/workers/")) return "Backend workers";
  if (posixPath.startsWith("backend/src/")) return "Backend other";

  if (posixPath.startsWith("frontend/components/")) return "Frontend components";
  if (posixPath.startsWith("frontend/hooks/")) return "Frontend hooks";
  if (posixPath.startsWith("frontend/lib/")) return "Frontend lib";
  if (posixPath.startsWith("frontend/features/")) return "Frontend features";
  if (posixPath.startsWith("frontend/")) return "Frontend other";

  return "Other";
}

function lineHasExportDeclaration(line) {
  return line.includes("export ") && !line.includes("export type ");
}

function findDeclarationSymbol(line) {
  for (const pattern of DECLARATION_PATTERNS) {
    const match = line.match(pattern.regex);
    if (!match) {
      continue;
    }

    return {
      kind: pattern.kind,
      name: match[1] ?? pattern.fallbackName ?? "<anonymous>",
    };
  }

  return null;
}

function hasJsDocAbove(lines, declarationLineIndex) {
  let cursor = declarationLineIndex - 1;
  while (cursor >= 0 && lines[cursor].trim().length === 0) {
    cursor -= 1;
  }

  if (cursor < 0) {
    return false;
  }

  const line = lines[cursor].trim();
  if (line.startsWith("/**")) {
    return true;
  }

  if (!line.endsWith("*/")) {
    return false;
  }

  let blockCursor = cursor;
  while (blockCursor >= 0) {
    const blockLine = lines[blockCursor].trim();
    if (blockLine.startsWith("/**")) {
      return true;
    }

    if (
      !blockLine.startsWith("*") &&
      !blockLine.startsWith("/*") &&
      !blockLine.endsWith("*/")
    ) {
      return false;
    }

    blockCursor -= 1;
  }

  return false;
}

function analyzeFile(relativePath, fileContent) {
  const lines = fileContent.split(/\r?\n/);
  const symbols = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!lineHasExportDeclaration(line)) {
      continue;
    }

    const symbol = findDeclarationSymbol(line);
    if (!symbol) {
      continue;
    }

    symbols.push({
      ...symbol,
      line: index + 1,
      documented: hasJsDocAbove(lines, index),
      file: relativePath,
    });
  }

  return symbols;
}

function buildCoverageModel(repoRoot) {
  const candidateFiles = [];

  for (const root of SOURCE_ROOTS) {
    const rootAbsolute = path.resolve(repoRoot, root);
    const files = listFilesRecursively(rootAbsolute);
    for (const absolutePath of files) {
      const relativePath = toPosixPath(path.relative(repoRoot, absolutePath));
      if (isCandidateFile(relativePath)) {
        candidateFiles.push(relativePath);
      }
    }
  }

  candidateFiles.sort((a, b) => a.localeCompare(b));

  const byArea = new Map();
  const allSymbols = [];

  for (const relativePath of candidateFiles) {
    const fileContent = fs.readFileSync(path.resolve(repoRoot, relativePath), "utf8");
    const area = classifyArea(relativePath);
    const symbols = analyzeFile(relativePath, fileContent);

    if (!byArea.has(area)) {
      byArea.set(area, {
        area,
        files: new Set(),
        total: 0,
        documented: 0,
        missingSymbols: [],
      });
    }

    const areaStats = byArea.get(area);
    areaStats.files.add(relativePath);
    areaStats.total += symbols.length;
    areaStats.documented += symbols.filter((symbol) => symbol.documented).length;
    areaStats.missingSymbols.push(...symbols.filter((symbol) => !symbol.documented));

    allSymbols.push(...symbols.map((symbol) => ({ ...symbol, area })));
  }

  const areaRows = [...byArea.values()]
    .map((stats) => {
      const missing = stats.total - stats.documented;
      const coverage = stats.total > 0 ? (stats.documented / stats.total) * 100 : 100;
      return {
        area: stats.area,
        filesScanned: stats.files.size,
        total: stats.total,
        documented: stats.documented,
        missing,
        coverage,
        missingSymbols: stats.missingSymbols,
      };
    })
    .sort((left, right) => left.area.localeCompare(right.area));

  const totals = areaRows.reduce(
    (acc, row) => {
      acc.filesScanned += row.filesScanned;
      acc.total += row.total;
      acc.documented += row.documented;
      acc.missing += row.missing;
      return acc;
    },
    { filesScanned: 0, total: 0, documented: 0, missing: 0 },
  );

  totals.coverage = totals.total > 0 ? (totals.documented / totals.total) * 100 : 100;

  return { areaRows, totals, allSymbols };
}

function escapeMarkdownCell(value) {
  return String(value).replace(/\|/g, "\\|");
}

function renderTable(headers, rows) {
  const headerLine = `| ${headers.join(" | ")} |`;
  const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const rowLines = rows.map((row) => {
    return `| ${row.map((cell) => escapeMarkdownCell(cell)).join(" | ")} |`;
  });

  return [headerLine, separatorLine, ...rowLines].join("\n");
}

function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

function renderCoverageMarkdown(model) {
  const summaryRows = model.areaRows.map((row) => [
    row.area,
    String(row.filesScanned),
    String(row.total),
    String(row.documented),
    String(row.missing),
    formatPercent(row.coverage),
  ]);

  summaryRows.push([
    "**Total**",
    `**${model.totals.filesScanned}**`,
    `**${model.totals.total}**`,
    `**${model.totals.documented}**`,
    `**${model.totals.missing}**`,
    `**${formatPercent(model.totals.coverage)}**`,
  ]);

  const missingRows = model.areaRows
    .flatMap((row) =>
      row.missingSymbols.map((symbol) => [
        row.area,
        symbol.name,
        `${symbol.file}:${symbol.line}`,
      ]),
    )
    .sort((left, right) => {
      return (
        left[0].localeCompare(right[0]) ||
        left[2].localeCompare(right[2]) ||
        left[1].localeCompare(right[1])
      );
    })
    .slice(0, 250);

  const missingTable =
    missingRows.length > 0
      ? renderTable(["Area", "Exported Symbol", "File"], missingRows)
      : "_No missing exported-symbol JSDoc detected._";

  return [
    "# JSDoc Coverage Baseline",
    "",
    "Generated by `npm run jsdoc-coverage:generate`. Do not edit manually.",
    "",
    "Scope:",
    "- Exported functions/classes/arrow-function exports in `backend/src` and `frontend`.",
    "- Excludes test/build/generated folders (`__tests__`, `tests`, `.next`, `dist`, `build`, `coverage`).",
    "",
    "## Coverage Summary",
    "",
    renderTable(
      [
        "Area",
        "Files Scanned",
        "Exported Symbols",
        "With JSDoc",
        "Missing JSDoc",
        "Coverage",
      ],
      summaryRows,
    ),
    "",
    "## Missing Exported Symbols (Top 250)",
    "",
    missingTable,
    "",
  ].join("\n");
}

function main() {
  const args = new Set(process.argv.slice(2));
  const check = args.has("--check");
  const write = args.has("--write") || !check;
  const printStdout = args.has("--stdout");

  const repoRoot = resolveRepoRoot();
  const outputAbsolute = path.resolve(repoRoot, OUTPUT_FILE);

  const model = buildCoverageModel(repoRoot);
  const rendered = renderCoverageMarkdown(model);

  if (printStdout) {
    process.stdout.write(rendered);
    return;
  }

  if (check) {
    if (!fs.existsSync(outputAbsolute)) {
      console.error(`JSDoc coverage check failed: missing ${OUTPUT_FILE}`);
      process.exit(1);
    }

    const existing = fs.readFileSync(outputAbsolute, "utf8");
    if (existing !== rendered) {
      console.error(
        `JSDoc coverage check failed: ${OUTPUT_FILE} is stale. Run npm run jsdoc-coverage:generate.`,
      );
      process.exit(1);
    }

    console.log(`JSDoc coverage check passed: ${OUTPUT_FILE} is current.`);
    return;
  }

  fs.writeFileSync(outputAbsolute, rendered, "utf8");
  if (write) {
    console.log(`JSDoc coverage written: ${OUTPUT_FILE}`);
  }
}

main();
