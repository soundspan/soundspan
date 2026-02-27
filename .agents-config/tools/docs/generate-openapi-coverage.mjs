#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const OUTPUT_FILE = ".agents-config/docs/OPENAPI_COVERAGE.md";
const BACKEND_INDEX_FILE = "backend/src/index.ts";
const BACKEND_ROUTES_DIR = "backend/src/routes";
const BACKEND_SOURCE_ROOT = "backend/src";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const EXPRESS_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "all",
];
const OPENAPI_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
]);

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

function lineNumberFromIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function readTextFile(repoRoot, relativePath) {
  const absolutePath = path.resolve(repoRoot, relativePath);
  return fs.readFileSync(absolutePath, "utf8");
}

function listFilesRecursively(rootAbsolutePath) {
  if (!fs.existsSync(rootAbsolutePath)) {
    return [];
  }

  const entries = [];

  function walk(currentPath) {
    const directoryEntries = fs
      .readdirSync(currentPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

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

function normalizePath(pathValue) {
  if (!pathValue || pathValue.trim().length === 0) {
    return "/";
  }

  let normalized = pathValue.trim();

  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  normalized = normalized.replace(/\/{2,}/g, "/");
  normalized = normalized.replace(/:([A-Za-z0-9_]+)\?/g, "{$1}");
  normalized = normalized.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  normalized = normalized.replace(/\{([^}/\s]+)\?\}/g, "{$1}");

  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

function joinPaths(prefix, routePath) {
  const normalizedPrefix = normalizePath(prefix);
  const normalizedRoute = normalizePath(routePath);

  if (normalizedPrefix === "/") {
    return normalizedRoute;
  }

  if (normalizedRoute === "/") {
    return normalizedPrefix;
  }

  return normalizePath(`${normalizedPrefix}${normalizedRoute}`);
}

function parseBackendRouteImports(indexText) {
  const importToFile = new Map();
  const importRegex =
    /import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+["']\.\/routes\/([^"']+)["'];?/g;

  for (const match of indexText.matchAll(importRegex)) {
    const variableName = match[1].trim();
    const moduleName = match[2].trim();
    importToFile.set(variableName, `${BACKEND_ROUTES_DIR}/${moduleName}.ts`);
  }

  return importToFile;
}

function parseBackendMounts(indexText, importToFile) {
  const fileToMounts = new Map();

  const addMount = (routeVariable, prefix) => {
    const routeFile = importToFile.get(routeVariable);
    if (!routeFile) {
      return;
    }

    if (!fileToMounts.has(routeFile)) {
      fileToMounts.set(routeFile, new Set());
    }

    fileToMounts.get(routeFile).add(normalizePath(prefix));
  };

  const mountWithPrefixRegex = /app\.use\(\s*(['"`])([^'"`]+)\1\s*,([\s\S]*?)\);/g;
  for (const match of indexText.matchAll(mountWithPrefixRegex)) {
    const prefix = match[2].trim();
    const argsBlock = match[3];
    const tokenRegex = /\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g;

    for (const tokenMatch of argsBlock.matchAll(tokenRegex)) {
      addMount(tokenMatch[1], prefix);
    }
  }

  const mountWithoutPrefixRegex = /app\.use\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\);/g;
  for (const match of indexText.matchAll(mountWithoutPrefixRegex)) {
    addMount(match[1], "/");
  }

  return fileToMounts;
}

function parseLiteralHandlers(text, variableName) {
  const methodPattern = EXPRESS_METHODS.join("|");
  const literalRegex = new RegExp(
    `${variableName}\\.(?:${methodPattern})\\s*\\(\\s*(['"\`])([^'"\\\`]+)\\1`,
    "g",
  );

  const handlers = [];

  for (const match of text.matchAll(literalRegex)) {
    const methodToken = match[0].match(new RegExp(`${variableName}\\.(${methodPattern})`, "i"));
    if (!methodToken) {
      continue;
    }

    handlers.push({
      method: methodToken[1].toUpperCase(),
      routePath: normalizePath(match[2].trim()),
      line: lineNumberFromIndex(text, match.index ?? 0),
    });
  }

  return handlers;
}

function parseLiteralRouteChainHandlers(text, variableName) {
  const methodPattern = EXPRESS_METHODS.join("|");
  const chainRegex = new RegExp(
    `${variableName}\\.route\\(\\s*(['"\`])([^'"\\\`]+)\\1\\s*\\)([\\s\\S]*?);`,
    "g",
  );
  const methodRegex = new RegExp(`\\.(${methodPattern})\\s*\\(`, "g");
  const handlers = [];

  for (const chainMatch of text.matchAll(chainRegex)) {
    const routePath = normalizePath(chainMatch[2].trim());
    const chainBody = chainMatch[3];
    const chainStart = (chainMatch.index ?? 0) + chainMatch[0].indexOf(chainBody);

    for (const methodMatch of chainBody.matchAll(methodRegex)) {
      const absoluteIndex = chainStart + (methodMatch.index ?? 0);
      handlers.push({
        method: methodMatch[1].toUpperCase(),
        routePath,
        line: lineNumberFromIndex(text, absoluteIndex),
      });
    }
  }

  return handlers;
}

function parseDynamicHandlers(text, variableName) {
  const methodPattern = EXPRESS_METHODS.join("|");
  const dynamicRegex = new RegExp(
    `${variableName}\\.(?:${methodPattern})\\s*\\(\\s*([^,\\n\\)]*)`,
    "g",
  );
  const handlers = [];

  for (const match of text.matchAll(dynamicRegex)) {
    const methodToken = match[0].match(new RegExp(`${variableName}\\.(${methodPattern})`, "i"));
    if (!methodToken) {
      continue;
    }

    const expression = (match[1] ?? "").trim();
    if (!expression || /^['"\`]/.test(expression)) {
      continue;
    }

    handlers.push({
      method: methodToken[1].toUpperCase(),
      expression,
      line: lineNumberFromIndex(text, match.index ?? 0),
    });
  }

  return handlers;
}

function parseDynamicRouteChainHandlers(text, variableName) {
  const methodPattern = EXPRESS_METHODS.join("|");
  const chainRegex = new RegExp(
    `${variableName}\\.route\\(\\s*([^\\n\\)]*)\\s*\\)([\\s\\S]*?);`,
    "g",
  );
  const methodRegex = new RegExp(`\\.(${methodPattern})\\s*\\(`, "g");
  const handlers = [];

  for (const chainMatch of text.matchAll(chainRegex)) {
    const expression = (chainMatch[1] ?? "").trim();
    if (!expression || /^['"\`]/.test(expression)) {
      continue;
    }

    const chainBody = chainMatch[2];
    const chainStart = (chainMatch.index ?? 0) + chainMatch[0].indexOf(chainBody);

    for (const methodMatch of chainBody.matchAll(methodRegex)) {
      const absoluteIndex = chainStart + (methodMatch.index ?? 0);
      handlers.push({
        method: methodMatch[1].toUpperCase(),
        expression,
        line: lineNumberFromIndex(text, absoluteIndex),
      });
    }
  }

  return handlers;
}

function parseHandlersByVariable(text, variableName) {
  const literalHandlers = [
    ...parseLiteralHandlers(text, variableName),
    ...parseLiteralRouteChainHandlers(text, variableName),
  ];
  const dynamicHandlers = [
    ...parseDynamicHandlers(text, variableName),
    ...parseDynamicRouteChainHandlers(text, variableName),
  ];

  const literalUnique = new Map();
  for (const handler of literalHandlers) {
    const key = `${handler.method}|${handler.routePath}|${handler.line}`;
    if (!literalUnique.has(key)) {
      literalUnique.set(key, handler);
    }
  }

  const dynamicUnique = new Map();
  for (const handler of dynamicHandlers) {
    const key = `${handler.method}|${handler.expression}|${handler.line}`;
    if (!dynamicUnique.has(key)) {
      dynamicUnique.set(key, handler);
    }
  }

  return {
    literalHandlers: [...literalUnique.values()],
    dynamicHandlers: [...dynamicUnique.values()],
  };
}

function parseRouteFileHandlers(routeContent) {
  return parseHandlersByVariable(routeContent, "router");
}

function parseIndexDirectHandlers(indexText) {
  const parsed = parseHandlersByVariable(indexText, "app");
  const literalHandlers = parsed.literalHandlers.map((handler) => ({
    method: handler.method,
    path: handler.routePath,
    source: `${BACKEND_INDEX_FILE}:${handler.line}`,
  }));
  const dynamicHandlers = parsed.dynamicHandlers.map((handler) => ({
    method: handler.method,
    path: `<dynamic:${handler.expression}>`,
    source: `${BACKEND_INDEX_FILE}:${handler.line}`,
  }));

  return { literalHandlers, dynamicHandlers };
}

function sortEndpointRows(rows) {
  return rows.sort((left, right) => {
    return (
      left.path.localeCompare(right.path) ||
      left.method.localeCompare(right.method) ||
      left.source.localeCompare(right.source)
    );
  });
}

function dedupeBySignature(rows) {
  const sorted = sortEndpointRows([...rows]);
  const deduped = new Map();

  for (const handler of sorted) {
    const key = `${handler.method}|${handler.path}`;
    if (!deduped.has(key)) {
      deduped.set(key, handler);
    }
  }

  return deduped;
}

function buildImplementedEndpoints(repoRoot) {
  const indexText = readTextFile(repoRoot, BACKEND_INDEX_FILE);
  const importToFile = parseBackendRouteImports(indexText);
  const fileToMounts = parseBackendMounts(indexText, importToFile);

  const routeFiles = fs
    .readdirSync(path.resolve(repoRoot, BACKEND_ROUTES_DIR), {
      withFileTypes: true,
    })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `${BACKEND_ROUTES_DIR}/${entry.name}`)
    .sort((left, right) => left.localeCompare(right));

  const implementedRows = [];
  const undocumentableRows = [];

  for (const routeFile of routeFiles) {
    const routeContent = readTextFile(repoRoot, routeFile);
    const { literalHandlers, dynamicHandlers } = parseRouteFileHandlers(routeContent);
    const mounts = [...(fileToMounts.get(routeFile) ?? new Set())].sort((a, b) =>
      a.localeCompare(b),
    );

    if (literalHandlers.length === 0 && dynamicHandlers.length === 0) {
      continue;
    }

    if (dynamicHandlers.length > 0) {
      if (mounts.length === 0) {
        for (const handler of dynamicHandlers) {
          undocumentableRows.push({
            method: handler.method,
            path: `<dynamic:${handler.expression}>`,
            source: `${routeFile}:${handler.line}`,
          });
        }
      } else {
        for (const mount of mounts) {
          const normalizedMount = normalizePath(mount);
          for (const handler of dynamicHandlers) {
            const dynamicSuffix = `<dynamic:${handler.expression}>`;
            const pathValue =
              normalizedMount === "/"
                ? dynamicSuffix
                : `${normalizedMount}/${dynamicSuffix}`;
            undocumentableRows.push({
              method: handler.method,
              path: pathValue,
              source: `${routeFile}:${handler.line}`,
            });
          }
        }
      }
    }

    if (literalHandlers.length === 0) {
      continue;
    }

    if (mounts.length === 0) {
      for (const handler of literalHandlers) {
        implementedRows.push({
          method: handler.method,
          path: handler.routePath,
          source: `${routeFile}:${handler.line}`,
        });
      }
      continue;
    }

    for (const mount of mounts) {
      for (const handler of literalHandlers) {
        implementedRows.push({
          method: handler.method,
          path: joinPaths(mount, handler.routePath),
          source: `${routeFile}:${handler.line}`,
        });
      }
    }
  }

  const indexHandlers = parseIndexDirectHandlers(indexText);
  implementedRows.push(...indexHandlers.literalHandlers);
  undocumentableRows.push(...indexHandlers.dynamicHandlers);

  return {
    implementedMap: dedupeBySignature(implementedRows),
    undocumentableMap: dedupeBySignature(undocumentableRows),
  };
}

function stripJsDocDecoration(line) {
  let cleaned = line;
  cleaned = cleaned.replace(/^\s*\/\*\*\s?/, "");
  cleaned = cleaned.replace(/^\s*\*\/\s*$/, "");
  cleaned = cleaned.replace(/^\s*\*\s?/, "");
  return cleaned;
}

function extractOpenApiEndpointsFromLines(linesWithNumbers, filePath) {
  const endpoints = [];
  let currentPath = null;
  let currentPathIndent = -1;

  for (const entry of linesWithNumbers) {
    const lineWithoutTabs = entry.text.replace(/\t/g, "  ");
    const line = lineWithoutTabs.replace(/\s+#.*$/, "");
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const pathMatch = trimmed.match(/^['"]?(\/[^'"]*)['"]?\s*:\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      currentPathIndent = indent;
      continue;
    }

    if (!currentPath) {
      continue;
    }

    if (indent <= currentPathIndent) {
      currentPath = null;
      currentPathIndent = -1;
      continue;
    }

    const methodMatch = trimmed.match(
      /^(get|post|put|patch|delete|options|head|trace)\s*:\s*$/i,
    );
    if (!methodMatch) {
      continue;
    }

    const methodToken = methodMatch[1].toLowerCase();
    if (!OPENAPI_METHODS.has(methodToken)) {
      continue;
    }

    endpoints.push({
      method: methodToken.toUpperCase(),
      path: normalizePath(currentPath),
      source: `${filePath}:${entry.line}`,
    });
  }

  return endpoints;
}

function extractDocumentedEndpointsFromFile(relativePath, fileContent) {
  const blockRegex = /\/\*\*[\s\S]*?\*\//g;
  const documentedRows = [];

  for (const match of fileContent.matchAll(blockRegex)) {
    const blockText = match[0];
    if (!/@openapi\b|@swagger\b/.test(blockText)) {
      continue;
    }

    const blockStartLine = lineNumberFromIndex(fileContent, match.index ?? 0);
    const rawLines = blockText.split(/\r?\n/).map(stripJsDocDecoration);

    const tagIndex = rawLines.findIndex((line) =>
      /@(openapi|swagger)\b/.test(line),
    );
    if (tagIndex < 0) {
      continue;
    }

    const tagLine = rawLines[tagIndex];
    const trailing = tagLine.replace(/^[\s\S]*@(openapi|swagger)\b\s*/, "");

    const linesWithNumbers = [];
    if (trailing.trim().length > 0) {
      linesWithNumbers.push({
        text: trailing,
        line: blockStartLine + tagIndex,
      });
    }

    for (let index = tagIndex + 1; index < rawLines.length; index += 1) {
      linesWithNumbers.push({
        text: rawLines[index],
        line: blockStartLine + index,
      });
    }

    documentedRows.push(
      ...extractOpenApiEndpointsFromLines(linesWithNumbers, relativePath),
    );
  }

  return documentedRows;
}

function buildDocumentedEndpoints(repoRoot) {
  const sourceRootAbsolute = path.resolve(repoRoot, BACKEND_SOURCE_ROOT);
  const sourceFiles = listFilesRecursively(sourceRootAbsolute)
    .map((absolutePath) => toPosixPath(path.relative(repoRoot, absolutePath)))
    .filter((relativePath) => SOURCE_EXTENSIONS.has(path.extname(relativePath)))
    .sort((left, right) => left.localeCompare(right));

  const rows = [];
  for (const relativePath of sourceFiles) {
    const fileContent = readTextFile(repoRoot, relativePath);
    rows.push(...extractDocumentedEndpointsFromFile(relativePath, fileContent));
  }

  return dedupeBySignature(rows);
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

function renderEndpointTable(rows) {
  if (rows.length === 0) {
    return "_None._";
  }

  return renderTable(
    ["Method", "Path", "Source"],
    rows.map((row) => [`\`${row.method}\``, `\`${row.path}\``, `\`${row.source}\``]),
  );
}

function buildCoverageModel(repoRoot) {
  const { implementedMap, undocumentableMap } = buildImplementedEndpoints(repoRoot);
  const documentedMap = buildDocumentedEndpoints(repoRoot);

  const implementedKeys = [...implementedMap.keys()].sort((a, b) =>
    a.localeCompare(b),
  );
  const undocumentableKeys = [...undocumentableMap.keys()].sort((a, b) =>
    a.localeCompare(b),
  );
  const documentedKeys = [...documentedMap.keys()].sort((a, b) =>
    a.localeCompare(b),
  );

  const coveredKeys = implementedKeys.filter((key) => documentedMap.has(key));
  const missingKeys = implementedKeys.filter((key) => !documentedMap.has(key));
  const extraKeys = documentedKeys.filter((key) => !implementedMap.has(key));

  const coverage =
    implementedKeys.length > 0
      ? (coveredKeys.length / implementedKeys.length) * 100
      : 100;

  return {
    implemented: implementedKeys.map((key) => implementedMap.get(key)),
    undocumentable: undocumentableKeys.map((key) => undocumentableMap.get(key)),
    documented: documentedKeys.map((key) => documentedMap.get(key)),
    missing: missingKeys.map((key) => implementedMap.get(key)),
    extra: extraKeys.map((key) => documentedMap.get(key)),
    summary: {
      implemented: implementedKeys.length,
      undocumentable: undocumentableKeys.length,
      documented: documentedKeys.length,
      covered: coveredKeys.length,
      missing: missingKeys.length,
      extra: extraKeys.length,
      coverage,
    },
  };
}

function renderOpenApiCoverageMarkdown(model) {
  const summaryRows = [
    [
      "Backend API",
      String(model.summary.implemented),
      String(model.summary.documented),
      String(model.summary.covered),
      String(model.summary.missing),
      String(model.summary.undocumentable),
      formatPercent(model.summary.coverage),
    ],
    [
      "**Total**",
      `**${model.summary.implemented}**`,
      `**${model.summary.documented}**`,
      `**${model.summary.covered}**`,
      `**${model.summary.missing}**`,
      `**${model.summary.undocumentable}**`,
      `**${formatPercent(model.summary.coverage)}**`,
    ],
  ];

  return [
    "# OpenAPI Endpoint Coverage Baseline",
    "",
    "Generated by `npm run openapi-coverage:generate`. Do not edit manually.",
    "",
    "Scope:",
    "- Implemented endpoint signatures from literal Express `app.<method>(...)`, `router.<method>(...)`, and `.route(...).<method>(...)` registrations.",
    "- Router registrations are expanded through `app.use(\"/prefix\", router)` mounts declared in `backend/src/index.ts`.",
    "- Documented endpoint signatures from backend JSDoc blocks tagged `@openapi` or `@swagger`.",
    "- Path normalization aligns Express `:id` and OpenAPI `{id}` parameters.",
    "",
    "## Coverage Summary",
    "",
    renderTable(
      [
        "Area",
        "Implemented Endpoints",
        "Documented Endpoints",
        "Covered Implemented Endpoints",
        "Missing OpenAPI Endpoints",
        "Undocumentable Endpoints",
        "Coverage",
      ],
      summaryRows,
    ),
    "",
    "## Missing OpenAPI Endpoint Docs",
    "",
    renderEndpointTable(model.missing),
    "",
    "## Undocumentable Endpoint Signatures",
    "",
    renderEndpointTable(model.undocumentable),
    "",
    "## Documented But Not Implemented",
    "",
    renderEndpointTable(model.extra),
    "",
    "## Implemented Endpoint Inventory",
    "",
    renderEndpointTable(model.implemented),
    "",
    "## Documented Endpoint Inventory",
    "",
    renderEndpointTable(model.documented),
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
  const rendered = renderOpenApiCoverageMarkdown(model);

  if (printStdout) {
    process.stdout.write(rendered);
    return;
  }

  if (check) {
    if (!fs.existsSync(outputAbsolute)) {
      console.error(`OpenAPI coverage check failed: missing ${OUTPUT_FILE}`);
      process.exit(1);
    }

    const existing = fs.readFileSync(outputAbsolute, "utf8");
    if (existing !== rendered) {
      console.error(
        `OpenAPI coverage check failed: ${OUTPUT_FILE} is stale. Run npm run openapi-coverage:generate.`,
      );
      process.exit(1);
    }

    console.log(`OpenAPI coverage check passed: ${OUTPUT_FILE} is current.`);
    return;
  }

  fs.writeFileSync(outputAbsolute, rendered, "utf8");
  if (write) {
    console.log(`OpenAPI coverage written: ${OUTPUT_FILE}`);
  }
}

main();
