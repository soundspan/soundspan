#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BACKEND_INDEX_FILE = "backend/src/index.ts";
const BACKEND_ROUTES_DIR = "backend/src/routes";
const BACKEND_SERVICES_DIR = "backend/src/services";
const FRONTEND_FEATURES_DIR = "frontend/features";
const FEATURE_INDEX_FILE = "docs/FEATURE_INDEX.json";

const ROOT_OUTPUTS = [
  "backend/src/routes/README.md",
  "backend/src/services/README.md",
  "frontend/features/README.md",
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

function readTextFile(repoRoot, relativePath) {
  return fs.readFileSync(path.resolve(repoRoot, relativePath), "utf8");
}

function readJsonFileIfExists(repoRoot, relativePath) {
  const absolutePath = path.resolve(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
}

function listFilesRecursively(rootAbsolutePath) {
  if (!fs.existsSync(rootAbsolutePath)) {
    return [];
  }

  const files = [];

  function walk(currentPath) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const nextPath = path.resolve(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(nextPath);
      } else if (entry.isFile()) {
        files.push(nextPath);
      }
    }
  }

  walk(rootAbsolutePath);
  return files;
}

function titleCase(input) {
  return input
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment[0].toUpperCase()}${segment.slice(1)}`)
    .join(" ");
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

function buildFeatureDirContext(featureIndex) {
  const context = new Map();

  if (!featureIndex || !Array.isArray(featureIndex.features)) {
    return context;
  }

  for (const feature of featureIndex.features) {
    const featureId =
      typeof feature?.id === "string" && feature.id.trim().length > 0
        ? feature.id.trim()
        : null;
    if (!featureId) {
      continue;
    }

    const dirs = Array.isArray(feature?.frontend?.feature_dirs)
      ? feature.frontend.feature_dirs
      : [];
    const routes = Array.isArray(feature?.frontend?.routes)
      ? feature.frontend.routes
      : [];
    const commands = Array.isArray(feature?.tests?.targeted_commands)
      ? feature.tests.targeted_commands
      : [];

    for (const rawDir of dirs) {
      const dir = typeof rawDir === "string" ? rawDir.trim() : "";
      if (!dir) {
        continue;
      }

      if (!context.has(dir)) {
        context.set(dir, {
          featureIds: new Set(),
          routes: new Set(),
          commands: new Set(),
        });
      }

      const entry = context.get(dir);
      entry.featureIds.add(featureId);
      for (const route of routes) {
        if (typeof route === "string" && route.trim().length > 0) {
          entry.routes.add(route.trim());
        }
      }
      for (const command of commands) {
        if (typeof command === "string" && command.trim().length > 0) {
          entry.commands.add(command.trim());
        }
      }
    }
  }

  return context;
}

function renderTable(headers, rows) {
  const lines = [];
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);

  for (const row of rows) {
    lines.push(
      `| ${row
        .map((cell) => String(cell).replace(/\|/g, "\\|"))
        .join(" | ")} |`,
    );
  }

  return lines.join("\n");
}

function renderBackendRoutesReadme({ routeFiles, mountsByFile }) {
  const rows = routeFiles.map((routeFile) => {
    const mounts = [...(mountsByFile.get(routeFile) ?? new Set())].sort((a, b) =>
      a.localeCompare(b),
    );

    const mountedPrefixes =
      mounts.length > 0
        ? mounts.map((prefix) => `\`${prefix}\``).join("<br>")
        : "(not found in `backend/src/index.ts` mounts)";

    return [
      `\`${routeFile}\``,
      mountedPrefixes,
    ];
  });

  return [
    "# Backend Routes",
    "",
    "Start-here guide for API route handlers in `backend/src/routes`.",
    "",
    "## Start Here",
    "",
    "1. Mount points and middleware chain: `backend/src/index.ts`.",
    "2. Canonical endpoint map: `docs/ROUTE_MAP.md`.",
    "3. Targeted verification commands: `docs/TEST_MATRIX.md`.",
    "",
    "## Mounted Route Modules",
    "",
    renderTable(["Route File", "Mounted Prefixes"], rows),
    "",
    "## Update Rule",
    "",
    "- When adding, removing, or changing endpoints in this directory, regenerate `docs/ROUTE_MAP.md` and verify impacted targeted commands in `docs/TEST_MATRIX.md`.",
    "",
  ].join("\n");
}

function renderBackendServicesReadme({ serviceFiles }) {
  const rows = serviceFiles.map((serviceFile) => {
    const relative = serviceFile.replace(`${BACKEND_SERVICES_DIR}/`, "");
    const area = relative.includes("/")
      ? titleCase(relative.split("/")[0])
      : "Core";
    return [`\`${serviceFile}\``, area];
  });

  return [
    "# Backend Services",
    "",
    "Start-here guide for business logic modules in `backend/src/services`.",
    "",
    "## Start Here",
    "",
    "1. API call entrypoints: `backend/src/routes/*.ts`.",
    "2. Endpoint-to-handler map: `docs/ROUTE_MAP.md`.",
    "3. Feature-targeted verification commands: `docs/TEST_MATRIX.md`.",
    "",
    "## Service Modules",
    "",
    renderTable(["Service File", "Area"], rows),
    "",
    "## Update Rule",
    "",
    "- Keep services reusable and route handlers thin. If service entrypoints or contracts change, update impacted docs/tests in the same change set.",
    "",
  ].join("\n");
}

function renderFrontendFeaturesRootReadme({ featureDirs, featureContextByDir }) {
  const rows = featureDirs.map((dirName) => {
    const context = featureContextByDir.get(dirName);
    const routes = context ? [...context.routes].sort((a, b) => a.localeCompare(b)) : [];

    return [
      `\`${dirName}\``,
      `\`frontend/features/${dirName}/README.md\``,
      routes.length > 0
        ? routes.map((route) => `\`${route}\``).join("<br>")
        : "(no routes mapped in `docs/FEATURE_INDEX.json`)",
    ];
  });

  return [
    "# Frontend Features",
    "",
    "Start-here index for domain modules under `frontend/features`.",
    "",
    "## Start Here",
    "",
    "1. Route entrypoints: `frontend/app/**/page.tsx` and `docs/ROUTE_MAP.md`.",
    "2. Feature ownership map: `docs/FEATURE_INDEX.json`.",
    "3. Targeted regression commands: `docs/TEST_MATRIX.md`.",
    "",
    "## Feature Domains",
    "",
    renderTable(["Directory", "Domain README", "Primary App Routes"], rows),
    "",
    "## Update Rule",
    "",
    "- Whenever feature behavior changes materially, update or verify this index and the affected `frontend/features/*/README.md` file in the same change set.",
    "",
  ].join("\n");
}

function classifyFeaturePathKind(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (segments.length <= 1) {
    return "root";
  }

  const first = segments[0];
  if (first === "components") return "components";
  if (first === "hooks") return "hooks";
  if (first === "types") return "types";
  return first;
}

function renderFrontendFeatureDomainReadme({
  dirName,
  files,
  featureContextByDir,
}) {
  const context = featureContextByDir.get(dirName);
  const routes = context ? [...context.routes].sort((a, b) => a.localeCompare(b)) : [];
  const commands = context
    ? [...context.commands].sort((a, b) => a.localeCompare(b))
    : [];
  const featureIds = context
    ? [...context.featureIds].sort((a, b) => a.localeCompare(b))
    : [];

  const directoryRows = files.map((relativePath) => [
    `\`${relativePath}\``,
    classifyFeaturePathKind(relativePath),
  ]);

  const routeLine =
    routes.length > 0
      ? routes.map((route) => `\`${route}\``).join(", ")
      : "No routes are currently mapped for this domain in `docs/FEATURE_INDEX.json`.";

  const commandLines =
    commands.length > 0
      ? commands.map((command) => `- \`${command}\``).join("\n")
      : "- Use `docs/TEST_MATRIX.md` to identify the right impacted test command(s).";

  const featureIdLine =
    featureIds.length > 0
      ? featureIds.map((featureId) => `\`${featureId}\``).join(", ")
      : "(none)";

  return [
    `# ${titleCase(dirName)} Feature Domain`,
    "",
    `Start-here guide for \`frontend/features/${dirName}\`.`,
    "",
    "## Start Here",
    "",
    `1. Route entrypoints: ${routeLine}`,
    "2. Domain ownership and contracts: `docs/FEATURE_INDEX.json`.",
    "3. Targeted verification commands:",
    commandLines,
    "",
    "## Feature Index Mapping",
    "",
    `- Feature IDs: ${featureIdLine}`,
    "",
    "## Directory Contents",
    "",
    renderTable(["Path", "Kind"], directoryRows),
    "",
    "## Update Rule",
    "",
    "- When adding/removing significant files or changing behavior in this domain, update or verify this README along with `docs/FEATURE_INDEX.json` and `docs/TEST_MATRIX.md`.",
    "",
  ].join("\n");
}

function buildExpectedOutputs(repoRoot) {
  const indexText = readTextFile(repoRoot, BACKEND_INDEX_FILE);
  const routeImports = parseBackendRouteImports(indexText);
  const mountsByFile = parseBackendMounts(indexText, routeImports);

  const routeFiles = fs
    .readdirSync(path.resolve(repoRoot, BACKEND_ROUTES_DIR), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `${BACKEND_ROUTES_DIR}/${entry.name}`)
    .sort((a, b) => a.localeCompare(b));

  const serviceFiles = listFilesRecursively(path.resolve(repoRoot, BACKEND_SERVICES_DIR))
    .map((absolutePath) => toPosixPath(path.relative(repoRoot, absolutePath)))
    .filter((filePath) => filePath.endsWith(".ts"))
    .filter((filePath) => !filePath.includes("/__tests__/"))
    .filter((filePath) => !filePath.endsWith(".test.ts"))
    .sort((a, b) => a.localeCompare(b));

  const featureDirs = fs
    .readdirSync(path.resolve(repoRoot, FRONTEND_FEATURES_DIR), {
      withFileTypes: true,
    })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const featureIndex = readJsonFileIfExists(repoRoot, FEATURE_INDEX_FILE);
  const featureContextByDir = buildFeatureDirContext(featureIndex);

  const outputs = new Map();

  outputs.set(
    "backend/src/routes/README.md",
    renderBackendRoutesReadme({ routeFiles, mountsByFile }),
  );

  outputs.set(
    "backend/src/services/README.md",
    renderBackendServicesReadme({ serviceFiles }),
  );

  outputs.set(
    "frontend/features/README.md",
    renderFrontendFeaturesRootReadme({
      featureDirs,
      featureContextByDir,
    }),
  );

  for (const dirName of featureDirs) {
    const featureDirAbsolute = path.resolve(repoRoot, FRONTEND_FEATURES_DIR, dirName);
    const files = listFilesRecursively(featureDirAbsolute)
      .map((absolutePath) =>
        toPosixPath(path.relative(featureDirAbsolute, absolutePath)),
      )
      .filter((relativePath) => !relativePath.endsWith("README.md"))
      .sort((a, b) => a.localeCompare(b));

    outputs.set(
      `${FRONTEND_FEATURES_DIR}/${dirName}/README.md`,
      renderFrontendFeatureDomainReadme({
        dirName,
        files,
        featureContextByDir,
      }),
    );
  }

  return outputs;
}

function checkOutputs(repoRoot, expectedOutputs) {
  const stale = [];
  const missing = [];

  for (const [relativePath, expectedContent] of expectedOutputs.entries()) {
    const absolutePath = path.resolve(repoRoot, relativePath);

    if (!fs.existsSync(absolutePath)) {
      missing.push(relativePath);
      continue;
    }

    const existing = fs.readFileSync(absolutePath, "utf8");
    if (existing !== expectedContent) {
      stale.push(relativePath);
    }
  }

  if (missing.length > 0 || stale.length > 0) {
    for (const filePath of missing) {
      console.error(`Domain README check failed: missing ${filePath}`);
    }
    for (const filePath of stale) {
      console.error(`Domain README check failed: stale ${filePath}`);
    }
    console.error("Run npm run domain-readmes:generate to refresh domain readmes.");
    process.exit(1);
  }

  console.log("Domain README check passed.");
}

function writeOutputs(repoRoot, expectedOutputs) {
  for (const [relativePath, expectedContent] of expectedOutputs.entries()) {
    const absolutePath = path.resolve(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, expectedContent, "utf8");
  }

  console.log(
    `Domain readmes written (${expectedOutputs.size} files).`,
  );
}

function main() {
  const args = new Set(process.argv.slice(2));
  const check = args.has("--check");
  const write = args.has("--write") || !check;

  const repoRoot = resolveRepoRoot();
  const expectedOutputs = buildExpectedOutputs(repoRoot);

  if (check) {
    checkOutputs(repoRoot, expectedOutputs);
    return;
  }

  if (write) {
    writeOutputs(repoRoot, expectedOutputs);
  }
}

main();
