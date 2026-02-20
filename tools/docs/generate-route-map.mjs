#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const OUTPUT_FILE = "docs/ROUTE_MAP.md";
const BACKEND_INDEX_FILE = "backend/src/index.ts";
const BACKEND_ROUTES_DIR = "backend/src/routes";
const FRONTEND_APP_DIR = "frontend/app";

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

function normalizeEndpoint(endpoint) {
  if (!endpoint || endpoint.trim().length === 0) {
    return "/";
  }

  let normalized = endpoint.replace(/\/\/{2,}/g, "/");
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

function joinEndpoint(prefix, routePath) {
  const normalizedPrefix = normalizeEndpoint(prefix);

  if (!routePath || routePath === "/") {
    return normalizedPrefix;
  }

  if (routePath === "*") {
    return normalizeEndpoint(`${normalizedPrefix}/*`);
  }

  if (routePath.startsWith("<dynamic:")) {
    return normalizeEndpoint(`${normalizedPrefix}/${routePath}`);
  }

  if (routePath.startsWith("/")) {
    return normalizeEndpoint(`${normalizedPrefix}${routePath}`);
  }

  return normalizeEndpoint(`${normalizedPrefix}/${routePath}`);
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

function parseBackendRouteImports(indexText) {
  const importToFile = new Map();
  const importRegex =
    /import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+["']\.\/routes\/([^"']+)["'];/g;

  for (const match of indexText.matchAll(importRegex)) {
    const variableName = match[1].trim();
    const moduleName = match[2].trim();
    importToFile.set(variableName, `${BACKEND_ROUTES_DIR}/${moduleName}.ts`);
  }

  return importToFile;
}

function parseBackendMounts(indexText, importToFile) {
  const fileToMounts = new Map();
  const mountRegex = /app\.use\(\s*(['"`])([^'"`]+)\1\s*,([\s\S]*?)\);/g;

  for (const match of indexText.matchAll(mountRegex)) {
    const prefix = match[2].trim();
    const argsBlock = match[3];

    const tokenRegex = /\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
    const routeVariables = new Set();

    for (const tokenMatch of argsBlock.matchAll(tokenRegex)) {
      const token = tokenMatch[1];
      if (importToFile.has(token)) {
        routeVariables.add(token);
      }
    }

    for (const routeVariable of routeVariables) {
      const routeFile = importToFile.get(routeVariable);
      if (!routeFile) {
        continue;
      }

      if (!fileToMounts.has(routeFile)) {
        fileToMounts.set(routeFile, new Set());
      }
      fileToMounts.get(routeFile).add(prefix);
    }
  }

  return fileToMounts;
}

function parseIndexDirectHandlers(indexText) {
  const directRegex =
    /app\.(get|post|put|patch|delete|options|head|all)\s*\(\s*(['"`])([^'"`]+)\2/g;

  const handlers = [];
  for (const match of indexText.matchAll(directRegex)) {
    handlers.push({
      method: match[1].toUpperCase(),
      endpoint: normalizeEndpoint(match[3].trim()),
      handler: `${BACKEND_INDEX_FILE}:${lineNumberFromIndex(indexText, match.index ?? 0)}`,
    });
  }

  return handlers;
}

function parseRouteFileHandlers(routeContent) {
  const handlers = [];
  const seen = new Set();

  const literalRegex =
    /router\.(get|post|put|patch|delete|options|head|all)\s*\(\s*(['"`])([^'"`]+)\2/g;

  for (const match of routeContent.matchAll(literalRegex)) {
    const method = match[1].toUpperCase();
    const routePath = match[3].trim();
    const line = lineNumberFromIndex(routeContent, match.index ?? 0);
    const key = `${method}|${routePath}|${line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    handlers.push({ method, routePath, line });
  }

  const dynamicRegex =
    /router\.(get|post|put|patch|delete|options|head|all)\s*\(\s*([A-Za-z_$][^,\n)]*)/g;

  for (const match of routeContent.matchAll(dynamicRegex)) {
    const method = match[1].toUpperCase();
    const argExpression = match[2].trim();
    if (/^['"`]/.test(argExpression)) {
      continue;
    }

    const routePath = `<dynamic:${argExpression}>`;
    const line = lineNumberFromIndex(routeContent, match.index ?? 0);
    const key = `${method}|${routePath}|${line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    handlers.push({ method, routePath, line });
  }

  return handlers;
}

function buildBackendRows(repoRoot) {
  const indexText = readTextFile(repoRoot, BACKEND_INDEX_FILE);
  const importToFile = parseBackendRouteImports(indexText);
  const fileToMounts = parseBackendMounts(indexText, importToFile);

  const routeFiles = fs
    .readdirSync(path.resolve(repoRoot, BACKEND_ROUTES_DIR), {
      withFileTypes: true,
    })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `${BACKEND_ROUTES_DIR}/${entry.name}`)
    .sort((a, b) => a.localeCompare(b));

  const rows = [];

  for (const routeFile of routeFiles) {
    const routeContent = readTextFile(repoRoot, routeFile);
    const handlers = parseRouteFileHandlers(routeContent);
    const mounts = [...(fileToMounts.get(routeFile) ?? new Set())].sort((a, b) =>
      a.localeCompare(b),
    );

    if (mounts.length === 0) {
      if (handlers.length === 0) {
        rows.push({
          method: "ANY",
          endpoint: "<unmounted-router>",
          handler: routeFile,
        });
      } else {
        for (const handler of handlers) {
          rows.push({
            method: handler.method,
            endpoint: handler.routePath,
            handler: `${routeFile}:${handler.line}`,
          });
        }
      }
      continue;
    }

    if (handlers.length === 0) {
      for (const mount of mounts) {
        rows.push({
          method: "ANY",
          endpoint: joinEndpoint(mount, "<dynamic:router-level-handler>"),
          handler: routeFile,
        });
      }
      continue;
    }

    for (const mount of mounts) {
      for (const handler of handlers) {
        rows.push({
          method: handler.method,
          endpoint: joinEndpoint(mount, handler.routePath),
          handler: `${routeFile}:${handler.line}`,
        });
      }
    }
  }

  rows.push(...parseIndexDirectHandlers(indexText));

  const unique = new Map();
  for (const row of rows) {
    const key = `${row.method}|${row.endpoint}|${row.handler}`;
    if (!unique.has(key)) {
      unique.set(key, row);
    }
  }

  return [...unique.values()].sort((left, right) => {
    return (
      left.endpoint.localeCompare(right.endpoint) ||
      left.method.localeCompare(right.method) ||
      left.handler.localeCompare(right.handler)
    );
  });
}

function normalizeAppSegment(segment) {
  if (segment.startsWith("(") && segment.endsWith(")")) {
    return null;
  }

  if (segment.startsWith("@")) {
    return null;
  }

  const optionalCatchAll = segment.match(/^\[\[\.\.\.(.+)\]\]$/);
  if (optionalCatchAll) {
    return `*${optionalCatchAll[1]}?`;
  }

  const catchAll = segment.match(/^\[\.\.\.(.+)\]$/);
  if (catchAll) {
    return `*${catchAll[1]}`;
  }

  const dynamic = segment.match(/^\[(.+)\]$/);
  if (dynamic) {
    return `:${dynamic[1]}`;
  }

  return segment;
}

function appFileToRoute(relativeFilePath) {
  const relativeFromApp = path.posix.relative(FRONTEND_APP_DIR, relativeFilePath);
  const segments = relativeFromApp.split("/");

  // Remove terminal page.tsx/page.ts/route.ts/route.tsx
  segments.pop();

  const routeSegments = segments
    .map((segment) => normalizeAppSegment(segment))
    .filter((segment) => typeof segment === "string" && segment.length > 0);

  if (routeSegments.length === 0) {
    return "/";
  }

  return `/${routeSegments.join("/")}`;
}

function parsePrimaryComponentImports(pageContent) {
  const importRegex = /^\s*import\s+[^;]+?\s+from\s+["']([^"']+)["'];?/gm;
  const imports = [];

  for (const match of pageContent.matchAll(importRegex)) {
    const source = match[1];
    if (source.startsWith("@/features/") || source.startsWith("@/components/")) {
      imports.push(source);
    }
  }

  return [...new Set(imports)].slice(0, 3);
}

function buildFrontendRows(repoRoot) {
  const appAbsolute = path.resolve(repoRoot, FRONTEND_APP_DIR);
  const allAppFiles = listFilesRecursively(appAbsolute)
    .map((absolutePath) => toPosixPath(path.relative(repoRoot, absolutePath)))
    .sort((a, b) => a.localeCompare(b));

  const pageFiles = allAppFiles.filter(
    (filePath) =>
      filePath.endsWith("/page.tsx") ||
      filePath.endsWith("/page.ts") ||
      filePath === "frontend/app/page.tsx" ||
      filePath === "frontend/app/page.ts",
  );

  const apiRouteFiles = allAppFiles.filter(
    (filePath) => filePath.endsWith("/route.ts") || filePath.endsWith("/route.tsx"),
  );

  const pageRows = pageFiles
    .map((filePath) => {
      const pageContent = readTextFile(repoRoot, filePath);
      const imports = parsePrimaryComponentImports(pageContent);
      return {
        route: appFileToRoute(filePath),
        pageFile: filePath,
        componentImports:
          imports.length > 0 ? imports.join("<br>") : "(self-rendered page)",
      };
    })
    .sort((left, right) => {
      return (
        left.route.localeCompare(right.route) ||
        left.pageFile.localeCompare(right.pageFile)
      );
    });

  const apiRows = apiRouteFiles
    .map((filePath) => ({
      route: appFileToRoute(filePath),
      handlerFile: filePath,
    }))
    .sort((left, right) => {
      return (
        left.route.localeCompare(right.route) ||
        left.handlerFile.localeCompare(right.handlerFile)
      );
    });

  return { pageRows, apiRows };
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

function renderRouteMapMarkdown({ backendRows, pageRows, apiRows }) {
  const backendTableRows = backendRows.map((row) => [
    `\`${row.method}\``,
    `\`${row.endpoint}\``,
    `\`${row.handler}\``,
  ]);

  const pageTableRows = pageRows.map((row) => [
    `\`${row.route}\``,
    `\`${row.pageFile}\``,
    row.componentImports.includes("(self-rendered page)")
      ? row.componentImports
      : row.componentImports
          .split("<br>")
          .map((value) => `\`${value}\``)
          .join("<br>"),
  ]);

  const apiTableRows = apiRows.map((row) => [
    `\`${row.route}\``,
    `\`${row.handlerFile}\``,
  ]);

  return [
    "# Route Map",
    "",
    "Generated by `npm run route-map:generate`. Do not edit manually.",
    "",
    "## Backend API Endpoint Map",
    "",
    renderTable(["Method", "Endpoint", "Handler File"], backendTableRows),
    "",
    "## Frontend Page Route Map",
    "",
    renderTable([
      "Frontend Route",
      "Page File",
      "Primary Component Imports",
    ], pageTableRows),
    "",
    "## Frontend API Route Handler Map",
    "",
    renderTable(["Frontend Route", "Handler File"], apiTableRows),
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

  const backendRows = buildBackendRows(repoRoot);
  const { pageRows, apiRows } = buildFrontendRows(repoRoot);
  const rendered = renderRouteMapMarkdown({ backendRows, pageRows, apiRows });

  if (printStdout) {
    process.stdout.write(rendered);
    return;
  }

  if (check) {
    if (!fs.existsSync(outputAbsolute)) {
      console.error(`Route map check failed: missing ${OUTPUT_FILE}`);
      process.exit(1);
    }

    const existing = fs.readFileSync(outputAbsolute, "utf8");
    if (existing !== rendered) {
      console.error(
        `Route map check failed: ${OUTPUT_FILE} is stale. Run npm run route-map:generate.`,
      );
      process.exit(1);
    }

    console.log(`Route map check passed: ${OUTPUT_FILE} is current.`);
    return;
  }

  fs.writeFileSync(outputAbsolute, rendered, "utf8");
  if (write) {
    console.log(`Route map written: ${OUTPUT_FILE}`);
  }
}

main();
