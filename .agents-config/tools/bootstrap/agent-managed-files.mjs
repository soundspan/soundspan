#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { spawnSync } from "node:child_process";

const DEFAULT_MANIFEST_PATH = ".agents-config/agent-managed.json";
const DEFAULT_PROFILES = ["base", "node-web"];
const DEFAULT_CANONICAL_AUTHORITY = "template";
const DEFAULT_ALLOWED_AUTHORITIES = ["template", "project"];
const DEFAULT_OVERRIDE_MODE = "explicit_allowlist";
const DEFAULT_OVERRIDE_RESERVED_PATHS = [
  "rule-overrides.schema.json",
  "rule-overrides.json",
  "README.md",
  ".gitkeep",
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function toNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizePath(input) {
  return input.split(path.sep).join("/");
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    const text = toNonEmptyString(entry);
    if (!text) {
      continue;
    }
    if (seen.has(text)) {
      continue;
    }
    seen.add(text);
    out.push(text);
  }
  return out;
}

function parseArgs(argv) {
  const args = {
    mode: "check",
    manifestPath: DEFAULT_MANIFEST_PATH,
    preferRemote: false,
    profilesOverride: [],
    fix: false,
    recheck: false,
    ci: false,
  };

  if (argv.length === 0) {
    return args;
  }

  let startIndex = 0;
  const first = argv[0];
  if (first === "sync" || first === "check") {
    args.mode = first;
    startIndex = 1;
  }

  for (let i = startIndex; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      fail(`Unexpected positional argument: ${token}`);
    }

    const key = token.slice(2);
    if (key === "prefer-remote") {
      args.preferRemote = true;
      continue;
    }
    if (key === "fix") {
      args.fix = true;
      continue;
    }
    if (key === "recheck") {
      args.recheck = true;
      continue;
    }
    if (key === "ci") {
      args.ci = true;
      continue;
    }

    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for --${key}`);
    }
    i += 1;

    if (key === "manifest") {
      args.manifestPath = value;
      continue;
    }
    if (key === "mode") {
      args.mode = value.trim();
      continue;
    }

    if (key === "profiles") {
      args.profilesOverride = value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      continue;
    }

    fail(`Unknown option: --${key}`);
  }

  if (!["sync", "check"].includes(args.mode)) {
    fail(`Unknown mode: ${args.mode}. Use --mode sync or --mode check.`);
  }

  if (args.ci && args.fix) {
    fail("Cannot combine --ci with --fix.");
  }

  if (args.recheck && !args.fix && args.mode === "check") {
    fail("--recheck requires --fix in check mode.");
  }

  return args;
}

function resolveRepoRoot() {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  const stdout = toNonEmptyString(result.stdout);
  if (result.status === 0 && stdout) {
    return path.resolve(stdout);
  }
  return process.cwd();
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Unable to parse JSON at ${filePath}: ${error.message}`);
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeRelativePath(input) {
  const normalized = path.posix
    .normalize(normalizePath(input))
    .replace(/^\.\//, "");
  if (normalized === ".") {
    return "";
  }
  return normalized;
}

function assertSafeRepoRelativePath(candidatePath, label) {
  const normalized = normalizeRelativePath(candidatePath);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    fail(`${label} must remain inside the repository root (received: ${candidatePath}).`);
  }
}

function resolveOverrideRepoRelativePath({
  entry,
  targetRelativePath,
  overrideRoot,
}) {
  const explicitOverridePath = toNonEmptyString(entry?.override_path);
  if (explicitOverridePath) {
    if (path.isAbsolute(explicitOverridePath)) {
      fail(
        `Managed entry ${JSON.stringify(entry?.path ?? "<unknown>")} uses absolute override_path; use a repo-relative path.`,
      );
    }
    assertSafeRepoRelativePath(
      explicitOverridePath,
      `Managed entry ${JSON.stringify(entry?.path ?? "<unknown>")} override_path`,
    );
    return normalizeRelativePath(explicitOverridePath);
  }

  const normalizedOverrideRoot = toNonEmptyString(overrideRoot)
    ? normalizeRelativePath(overrideRoot)
    : "";
  if (normalizedOverrideRoot) {
    assertSafeRepoRelativePath(normalizedOverrideRoot, "overrideRoot");
  }
  if (!normalizedOverrideRoot) {
    return null;
  }

  return normalizeRelativePath(
    path.posix.join(normalizedOverrideRoot, normalizeRelativePath(targetRelativePath)),
  );
}

function toPathRelativeToRoot({ repoRelativePath, rootRelativePath }) {
  const normalizedRepoPath = normalizeRelativePath(repoRelativePath);
  const normalizedRoot = normalizeRelativePath(rootRelativePath);
  if (!normalizedRoot) {
    return normalizedRepoPath;
  }
  if (normalizedRepoPath === normalizedRoot) {
    return "";
  }
  if (!normalizedRepoPath.startsWith(`${normalizedRoot}/`)) {
    return null;
  }
  return normalizedRepoPath.slice(normalizedRoot.length + 1);
}

function listRelativeFilesRecursively(rootPath) {
  if (!fs.existsSync(rootPath)) {
    return [];
  }

  const rootStats = fs.statSync(rootPath);
  if (!rootStats.isDirectory()) {
    return [];
  }

  const files = [];
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      files.push(normalizeRelativePath(path.relative(rootPath, entryPath)));
    }
  }

  files.sort((left, right) => left.localeCompare(right));
  return files;
}

function resolveCanonicalContract(manifest) {
  const contract = manifest?.canonical_contract ?? {};

  const defaultAuthority =
    toNonEmptyString(contract?.default_authority) ?? DEFAULT_CANONICAL_AUTHORITY;

  const configuredAuthorities = normalizeStringArray(contract?.allowed_authorities);
  const allowedAuthorities = new Set(
    configuredAuthorities.length > 0
      ? configuredAuthorities
      : DEFAULT_ALLOWED_AUTHORITIES,
  );

  if (!allowedAuthorities.has(defaultAuthority)) {
    fail(
      `canonical_contract.default_authority (${defaultAuthority}) must be listed in canonical_contract.allowed_authorities.`,
    );
  }

  const overrideMode =
    toNonEmptyString(contract?.override_mode) ?? DEFAULT_OVERRIDE_MODE;
  if (overrideMode !== DEFAULT_OVERRIDE_MODE) {
    fail(
      `Unsupported canonical_contract.override_mode: ${overrideMode}. Supported value: ${DEFAULT_OVERRIDE_MODE}.`,
    );
  }

  const configuredReserved = normalizeStringArray(contract?.override_reserved_paths);
  const reservedPaths = new Set(
    (configuredReserved.length > 0
      ? configuredReserved
      : DEFAULT_OVERRIDE_RESERVED_PATHS
    ).map((entry) => normalizeRelativePath(entry)),
  );

  return {
    defaultAuthority,
    allowedAuthorities,
    overrideMode,
    reservedPaths,
  };
}

function resolveEntryAuthority(entry, canonicalContract) {
  const authority =
    toNonEmptyString(entry?.authority) ?? canonicalContract.defaultAuthority;

  if (!canonicalContract.allowedAuthorities.has(authority)) {
    fail(
      `Managed entry ${JSON.stringify(entry?.path ?? "<unknown>")} uses unsupported authority "${authority}". Allowed: ${[...canonicalContract.allowedAuthorities].join(", ")}.`,
    );
  }

  return authority;
}

function resolveActiveProfiles(manifest, args) {
  const manifestProfiles = normalizeStringArray(manifest?.profiles);
  const selected = args.profilesOverride.length > 0 ? args.profilesOverride : manifestProfiles;
  const activeProfiles = selected.length > 0 ? selected : DEFAULT_PROFILES;
  return new Set(activeProfiles);
}

function isEntryActive(entry, activeProfiles) {
  const requiredProfiles = normalizeStringArray(entry?.profiles);
  if (requiredProfiles.length === 0) {
    return true;
  }
  return requiredProfiles.some((profile) => activeProfiles.has(profile));
}

function resolveTemplateSource(manifest, repoRoot, preferRemote) {
  const template = manifest?.template ?? {};
  const localPathOverride = toNonEmptyString(process.env.AGENT_TEMPLATE_LOCAL_PATH);
  const localPath = localPathOverride ?? toNonEmptyString(template.localPath);
  const localRoot = localPath ? path.resolve(repoRoot, localPath) : null;
  const localAvailable = Boolean(localRoot && fs.existsSync(localRoot));

  const repoSlug = toNonEmptyString(template.repo);
  const ref = toNonEmptyString(template.ref) ?? "main";

  return {
    localRoot,
    localAvailable,
    preferRemote,
    repoSlug,
    ref,
  };
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "agent-managed-files/1.0",
          Accept: "text/plain",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;

        if ([301, 302, 307, 308].includes(status)) {
          const redirect = response.headers.location;
          response.resume();
          if (!redirect) {
            reject(new Error(`Redirect without location for ${url}`));
            return;
          }
          fetchText(redirect).then(resolve).catch(reject);
          return;
        }

        if (status < 200 || status >= 300) {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            reject(new Error(`HTTP ${status} for ${url}${body ? `: ${body.slice(0, 180)}` : ""}`));
          });
          return;
        }

        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      },
    );

    request.on("error", reject);
  });
}

function buildRawGitHubUrl(repoSlug, ref, relativePath) {
  const encodedPath = relativePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `https://raw.githubusercontent.com/${repoSlug}/${encodeURIComponent(ref)}/${encodedPath}`;
}

async function getTemplateFileContent({
  source,
  relativePath,
  remoteCache,
}) {
  const normalized = normalizePath(relativePath);

  if (!source.preferRemote && source.localAvailable && source.localRoot) {
    const localFile = path.resolve(source.localRoot, normalized);
    if (fs.existsSync(localFile)) {
      return fs.readFileSync(localFile, "utf8");
    }
  }

  if (!source.repoSlug) {
    if (source.localAvailable && source.localRoot) {
      fail(`Template file missing locally: ${normalized}`);
    }
    fail(`No template repo configured and local template path unavailable for ${normalized}`);
  }

  const cacheKey = `${source.repoSlug}@${source.ref}:${normalized}`;
  if (remoteCache.has(cacheKey)) {
    return remoteCache.get(cacheKey);
  }

  const url = buildRawGitHubUrl(source.repoSlug, source.ref, normalized);
  const content = await fetchText(url);
  remoteCache.set(cacheKey, content);
  return content;
}

async function resolveExpectedContent({
  repoRoot,
  source,
  allowOverride,
  overrideRepoRelativePath,
  templateRelativePath,
  remoteCache,
}) {
  const normalizedTemplate = normalizePath(templateRelativePath);

  if (allowOverride && overrideRepoRelativePath) {
    const overridePath = path.resolve(repoRoot, overrideRepoRelativePath);
    if (fs.existsSync(overridePath)) {
      return {
        content: fs.readFileSync(overridePath, "utf8"),
        sourceLabel: `override:${normalizePath(path.relative(repoRoot, overridePath))}`,
      };
    }
  }

  const templateContent = await getTemplateFileContent({
    source,
    relativePath: normalizedTemplate,
    remoteCache,
  });

  const sourceLabel =
    !source.preferRemote && source.localAvailable
      ? `template-local:${normalizePath(path.relative(repoRoot, path.resolve(source.localRoot ?? repoRoot, normalizedTemplate)))}`
      : `template-remote:${source.repoSlug}@${source.ref}/${normalizedTemplate}`;

  return {
    content: templateContent,
    sourceLabel,
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolveRepoRoot();
  process.chdir(repoRoot);

  const manifestPath = path.resolve(repoRoot, args.manifestPath);
  if (!fs.existsSync(manifestPath)) {
    fail(`Managed manifest not found: ${normalizePath(path.relative(repoRoot, manifestPath))}`);
  }

  const manifest = readJson(manifestPath);
  const managedFiles = Array.isArray(manifest?.managed_files) ? manifest.managed_files : [];
  if (managedFiles.length === 0) {
    fail(`${normalizePath(path.relative(repoRoot, manifestPath))} must define non-empty managed_files.`);
  }

  const activeProfiles = resolveActiveProfiles(manifest, args);
  const source = resolveTemplateSource(manifest, repoRoot, args.preferRemote);
  const overrideRoot = toNonEmptyString(manifest?.overrideRoot) ?? ".agents-config/agent-overrides";
  const remoteCache = new Map();

  const activeEntriesRaw = managedFiles.filter((entry) => isEntryActive(entry, activeProfiles));
  if (activeEntriesRaw.length === 0) {
    console.log("No managed files selected for active profiles; nothing to do.");
    return;
  }

  const canonicalContract = resolveCanonicalContract(manifest);
  const allowlistedOverrideRootRelativePaths = new Set();
  for (const entry of managedFiles) {
    const candidatePath = toNonEmptyString(entry?.path);
    if (!candidatePath) {
      continue;
    }
    const authority = resolveEntryAuthority(entry, canonicalContract);
    const allowOverride = entry?.allow_override === true;
    if (!allowOverride || authority !== "template") {
      continue;
    }
    const overrideRepoRelativePath = resolveOverrideRepoRelativePath({
      entry,
      targetRelativePath: candidatePath,
      overrideRoot,
    });
    if (overrideRepoRelativePath === null) {
      continue;
    }
    const overrideRootRelativePath = toPathRelativeToRoot({
      repoRelativePath: overrideRepoRelativePath,
      rootRelativePath: overrideRoot,
    });
    if (overrideRootRelativePath !== null) {
      allowlistedOverrideRootRelativePaths.add(overrideRootRelativePath);
    }
  }

  const activeEntriesByPath = new Map();
  const activeEntriesByOverrideRootRelativePath = new Map();
  const activeEntries = [];
  for (const entry of activeEntriesRaw) {
    const targetRelativePath = toNonEmptyString(entry?.path);
    if (!targetRelativePath) {
      fail("Each managed_files entry must include a non-empty path.");
    }

    const normalizedTargetPath = normalizeRelativePath(targetRelativePath);
    if (activeEntriesByPath.has(normalizedTargetPath)) {
      fail(`Duplicate managed_files path for active profiles: ${normalizedTargetPath}`);
    }

    const templateRelativePath = toNonEmptyString(entry?.source_path) ?? targetRelativePath;
    const authority = resolveEntryAuthority(entry, canonicalContract);
    const allowOverride = entry?.allow_override === true;
    const explicitOverridePath = toNonEmptyString(entry?.override_path);
    if (allowOverride && authority !== "template") {
      fail(
        `Managed entry ${normalizedTargetPath} cannot set allow_override=true when authority=${authority}.`,
      );
    }
    if (!allowOverride && explicitOverridePath) {
      fail(
        `Managed entry ${normalizedTargetPath} sets override_path but does not set allow_override=true.`,
      );
    }

    const overrideRepoRelativePath = allowOverride
      ? resolveOverrideRepoRelativePath({
          entry,
          targetRelativePath: targetRelativePath,
          overrideRoot,
        })
      : null;
    const overrideRootRelativePath =
      overrideRepoRelativePath === null
        ? null
        : toPathRelativeToRoot({
            repoRelativePath: overrideRepoRelativePath,
            rootRelativePath: overrideRoot,
          });

    const resolvedEntry = {
      targetRelativePath,
      normalizedTargetPath,
      templateRelativePath,
      authority,
      allowOverride,
      overrideRepoRelativePath,
      overrideRootRelativePath,
    };

    activeEntriesByPath.set(normalizedTargetPath, resolvedEntry);
    if (overrideRootRelativePath !== null) {
      if (activeEntriesByOverrideRootRelativePath.has(overrideRootRelativePath)) {
        fail(
          `Duplicate override path under ${overrideRoot}: ${overrideRootRelativePath}`,
        );
      }
      activeEntriesByOverrideRootRelativePath.set(overrideRootRelativePath, resolvedEntry);
    }
    activeEntries.push(resolvedEntry);
  }

  const overrideViolations = [];
  if (overrideRoot) {
    const overrideRootPath = path.resolve(repoRoot, overrideRoot);
    const overrideFiles = listRelativeFilesRecursively(overrideRootPath);
    for (const overrideRelativePath of overrideFiles) {
      if (canonicalContract.reservedPaths.has(overrideRelativePath)) {
        continue;
      }

      if (!allowlistedOverrideRootRelativePaths.has(overrideRelativePath)) {
        overrideViolations.push({
          path: overrideRelativePath,
          reason:
            "override file exists but no allowlisted managed_files entry maps to this path",
        });
        continue;
      }

      const activeEntry = activeEntriesByOverrideRootRelativePath.get(overrideRelativePath);
      if (!activeEntry) {
        continue;
      }

      if (activeEntry.authority !== "template") {
        overrideViolations.push({
          path: overrideRelativePath,
          reason: `managed authority is ${activeEntry.authority}; overrides only apply to authority=template`,
        });
        continue;
      }

      if (!activeEntry.allowOverride) {
        overrideViolations.push({
          path: overrideRelativePath,
          reason: "override file exists but managed entry does not allow overrides (set allow_override=true)",
        });
      }
    }
  }

  if (overrideViolations.length > 0) {
    console.error("Managed override violations detected:");
    for (const violation of overrideViolations) {
      console.error(`- ${violation.path}: ${violation.reason}`);
    }
    fail("Resolve override violations before running managed sync/check.");
  }

  let unchangedCount = 0;
  const mismatches = [];

  for (const entry of activeEntries) {
    const targetPath = path.resolve(repoRoot, entry.targetRelativePath);
    const targetExists = fs.existsSync(targetPath);
    const actualContent = targetExists ? fs.readFileSync(targetPath, "utf8") : null;

    if (entry.authority === "project") {
      if (targetExists) {
        unchangedCount += 1;
        continue;
      }

      const expected = await resolveExpectedContent({
        repoRoot,
        source,
        allowOverride: false,
        overrideRepoRelativePath: null,
        templateRelativePath: entry.templateRelativePath,
        remoteCache,
      });

      mismatches.push({
        path: normalizePath(entry.targetRelativePath),
        targetPath,
        expectedContent: expected.content,
        expectedSource: expected.sourceLabel,
        reason: "missing target file (project authority seed required)",
      });
      continue;
    }

    const expected = await resolveExpectedContent({
      repoRoot,
      source,
      allowOverride: entry.allowOverride,
      overrideRepoRelativePath: entry.overrideRepoRelativePath,
      templateRelativePath: entry.templateRelativePath,
      remoteCache,
    });

    if (actualContent === expected.content) {
      unchangedCount += 1;
      continue;
    }

    mismatches.push({
      path: normalizePath(entry.targetRelativePath),
      targetPath,
      expectedContent: expected.content,
      expectedSource: expected.sourceLabel,
      reason: targetExists ? "content differs" : "missing target file",
    });
  }

  const printMismatches = () => {
    console.error("Managed file drift detected:");
    for (const mismatch of mismatches) {
      console.error(
        `- ${mismatch.path}: ${mismatch.reason} (expected from ${mismatch.expectedSource})`,
      );
    }
  };

  const runSync = () => {
    let updatedCount = 0;
    for (const mismatch of mismatches) {
      ensureDir(path.dirname(mismatch.targetPath));
      fs.writeFileSync(mismatch.targetPath, mismatch.expectedContent, "utf8");
      updatedCount += 1;
      console.log(`synced ${mismatch.path} <- ${mismatch.expectedSource}`);
    }
    console.log(`Managed file sync complete. Updated: ${updatedCount}, unchanged: ${unchangedCount}.`);
    return updatedCount;
  };

  if (args.mode === "sync") {
    runSync();
    if (!args.recheck) {
      return;
    }
    const verifyArgs = ["check", "--manifest", args.manifestPath];
    if (args.preferRemote) {
      verifyArgs.push("--prefer-remote");
    }
    if (args.profilesOverride.length > 0) {
      verifyArgs.push("--profiles", args.profilesOverride.join(","));
    }
    const verifyResult = spawnSync("node", [process.argv[1], ...verifyArgs], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    if (verifyResult.status !== 0) {
      fail("Managed file recheck failed after sync.");
    }
    return;
  }

  if (mismatches.length === 0) {
    console.log(`Managed file drift check passed (${activeEntries.length} files).`);
    return;
  }

  printMismatches();
  if (args.ci || !args.fix) {
    fail("Run: npm run agent:managed -- --fix --recheck");
  }

  runSync();

  if (args.recheck) {
    const verifyArgs = ["check", "--manifest", args.manifestPath];
    if (args.preferRemote) {
      verifyArgs.push("--prefer-remote");
    }
    if (args.profilesOverride.length > 0) {
      verifyArgs.push("--profiles", args.profilesOverride.join(","));
    }
    const verifyResult = spawnSync("node", [process.argv[1], ...verifyArgs], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    if (verifyResult.status !== 0) {
      fail("Managed file recheck failed after sync.");
    }
  }
}

run().catch((error) => {
  fail(`Managed files command failed: ${error.message}`);
});
