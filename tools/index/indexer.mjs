#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const DEFAULT_CONFIG_PATH = "tools/index/index.config.json";
const MANIFEST_FILE = "manifest.json";
const FILES_FILE = "files.jsonl";
const CHUNKS_FILE = "chunks.jsonl";
const SYMBOLS_FILE = "symbols.jsonl";
const VECTORS_FILE = "vectors.f32";
const LOCK_FILE = ".index.lock";
const LOCK_STALE_MS = 60 * 60 * 1000;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "he",
  "i",
  "if",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "were",
  "will",
  "with",
  "you",
]);

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function nowIso() {
  return new Date().toISOString();
}

function resolveRepoRoot() {
  const probe = runCommand("git", ["rev-parse", "--show-toplevel"]);
  if (probe.ok && probe.stdout.trim()) {
    return probe.stdout.trim();
  }
  return process.cwd();
}

function runCommand(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    error: result.error ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function toSafeSegment(value) {
  const base = (value ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return base || "unknown";
}

function tryRealPath(inputPath) {
  try {
    return fs.realpathSync(inputPath);
  } catch {
    return path.resolve(inputPath);
  }
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeTextAtomic(filePath, content) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, content, "utf8");
  fs.renameSync(tempPath, filePath);
}

function writeBufferAtomic(filePath, buffer) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, buffer);
  fs.renameSync(tempPath, filePath);
}

function parseJsonLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, "utf8");
  if (!content.trim()) {
    return [];
  }
  const rows = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    rows.push(JSON.parse(trimmed));
  }
  return rows;
}

function toJsonLines(rows) {
  if (rows.length === 0) {
    return "";
  }
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseArgs(argv) {
  const command = argv[2];
  const options = {
    command,
    configPath: DEFAULT_CONFIG_PATH,
    outputDir: null,
    full: false,
    strict: false,
    strictFresh: false,
    json: false,
    top: null,
    verify: false,
    help: false,
    queryText: "",
  };

  if (command === "--help" || command === "-h") {
    options.help = true;
    return options;
  }

  const extra = [];
  for (let i = 3; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--config") {
      i += 1;
      options.configPath = argv[i];
    } else if (token === "--output") {
      i += 1;
      options.outputDir = argv[i];
    } else if (token === "--full") {
      options.full = true;
    } else if (token === "--strict") {
      options.strict = true;
    } else if (token === "--strict-fresh") {
      options.strictFresh = true;
    } else if (token === "--json") {
      options.json = true;
    } else if (token === "--verify") {
      options.verify = true;
    } else if (token === "--top") {
      i += 1;
      options.top = Number(argv[i]);
    } else if (token === "--help" || token === "-h") {
      options.help = true;
    } else {
      extra.push(token);
    }
  }

  if (options.command === "query") {
    options.queryText = extra.join(" ").trim();
  } else if (extra.length > 0) {
    options.queryText = extra.join(" ").trim();
  }

  return options;
}

function printHelp() {
  process.stdout.write(`Repo Indexer

Usage:
  node tools/index/indexer.mjs build [--full] [--config <path>] [--output <dir>]
  node tools/index/indexer.mjs query "<text>" [--top <n>] [--json] [--strict-fresh] [--verify] [--output <dir>]
  node tools/index/indexer.mjs verify [--strict] [--config <path>] [--output <dir>] [--json]

Commands:
  build   Build or incrementally refresh the local index.
  query   Query indexed chunks and return ranked retrieval candidates.
  verify  Validate index integrity and source-drift status.
`);
}

function loadConfig(repoRoot, configPath, outputOverride) {
  const absoluteConfigPath = path.resolve(repoRoot, configPath);
  if (!fs.existsSync(absoluteConfigPath)) {
    fail(`Missing config file: ${toPosixPath(path.relative(repoRoot, absoluteConfigPath))}`);
  }

  const config = readJson(absoluteConfigPath);
  const outputRoot = path.resolve(repoRoot, config.outputDir);

  let outputDir = outputRoot;
  let namespace = null;
  let isolationMode = "none";
  let isolationDetails = {
    reason: null,
    branch: null,
    branch_slug: null,
    worktree_identity_sha256: null,
    worktree_hash: null,
  };

  if (outputOverride) {
    outputDir = path.resolve(repoRoot, outputOverride);
    isolationMode = "manual-output-override";
    isolationDetails.reason = "--output provided";
  } else {
    const configuredMode = config.isolation?.mode ?? "branch-worktree";
    if (configuredMode === "none") {
      isolationMode = "none";
    } else if (configuredMode === "branch-worktree") {
      const branchProbe = runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
      const branchName = branchProbe.ok ? branchProbe.stdout.trim() : "unknown";
      const branchSlug = toSafeSegment(branchName);

      const gitDirProbe = runCommand("git", ["rev-parse", "--git-dir"]);
      const gitDirRaw = gitDirProbe.ok ? gitDirProbe.stdout.trim() : ".git";
      const gitDirAbs = path.isAbsolute(gitDirRaw)
        ? gitDirRaw
        : path.resolve(repoRoot, gitDirRaw);

      const worktreeKey = `${tryRealPath(repoRoot)}::${tryRealPath(gitDirAbs)}`;
      const worktreeIdentitySha256 = sha256Text(worktreeKey);
      const hashLength = Math.max(
        6,
        Math.min(24, Number(config.isolation?.worktreeHashLength ?? 10))
      );
      const worktreeHash = worktreeIdentitySha256.slice(0, hashLength);

      namespace = `br-${branchSlug}--wt-${worktreeHash}`;
      outputDir = path.join(outputRoot, namespace);
      isolationMode = configuredMode;
      isolationDetails = {
        reason: "default isolation",
        branch: branchName,
        branch_slug: branchSlug,
        worktree_identity_sha256: worktreeIdentitySha256,
        worktree_hash: worktreeHash,
      };
    } else {
      fail(`Unsupported isolation mode: ${configuredMode}`);
    }
  }

  const configHash = sha256Text(stableStringify(config));
  return {
    config,
    configHash,
    configPath: absoluteConfigPath,
    outputRoot,
    outputDir,
    namespace,
    isolationMode,
    isolationDetails,
  };
}

function globToRegex(glob) {
  const marker = "__DOUBLE_STAR__";
  let pattern = glob.replace(/\*\*/g, marker);
  pattern = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  pattern = pattern.replace(/\*/g, "[^/]*");
  pattern = pattern.replace(new RegExp(marker, "g"), ".*");
  return new RegExp(`^${pattern}$`);
}

function buildExcludeMatchers(config) {
  const globs = Array.isArray(config.excludeGlobs) ? config.excludeGlobs : [];
  return globs.map((glob) => ({ glob, regex: globToRegex(glob) }));
}

function hasAllowedExtension(filePath, allowedExtensions) {
  const ext = path.extname(filePath).toLowerCase();
  return allowedExtensions.has(ext);
}

function shouldExcludePath(relPath, excludeMatchers) {
  for (const matcher of excludeMatchers) {
    if (matcher.regex.test(relPath)) {
      return true;
    }
  }
  return false;
}

function collectCandidateFiles(repoRoot, config) {
  const includeRoots = Array.isArray(config.includeRoots) ? config.includeRoots : [];
  const extensions = new Set((config.extensions ?? []).map((ext) => ext.toLowerCase()));
  const excludeMatchers = buildExcludeMatchers(config);
  const pruneSet = new Set(config.pruneDirectories ?? []);

  const files = [];
  const warnings = [];

  function walkDir(absDir, relDir) {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (pruneSet.has(entry.name) || shouldExcludePath(`${relPath}/`, excludeMatchers)) {
          continue;
        }
        walkDir(path.join(absDir, entry.name), relPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }
      if (!hasAllowedExtension(relPath, extensions)) {
        continue;
      }
      if (shouldExcludePath(relPath, excludeMatchers)) {
        continue;
      }
      files.push(relPath);
    }
  }

  for (const includeRoot of includeRoots) {
    const relRoot = toPosixPath(includeRoot);
    const absRoot = path.resolve(repoRoot, includeRoot);
    if (!fs.existsSync(absRoot)) {
      warnings.push(`Include root missing: ${relRoot}`);
      continue;
    }
    const stat = fs.statSync(absRoot);
    if (stat.isDirectory()) {
      walkDir(absRoot, relRoot);
    } else if (stat.isFile()) {
      if (
        hasAllowedExtension(relRoot, extensions) &&
        !shouldExcludePath(relRoot, excludeMatchers)
      ) {
        files.push(relRoot);
      }
    }
  }

  const deduped = Array.from(new Set(files));
  deduped.sort((a, b) => a.localeCompare(b));
  return { files: deduped, warnings };
}

function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") {
    return "typescript";
  }
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return "javascript";
  }
  if (ext === ".json") {
    return "json";
  }
  if (ext === ".md") {
    return "markdown";
  }
  if (ext === ".yml" || ext === ".yaml") {
    return "yaml";
  }
  if (ext === ".sql") {
    return "sql";
  }
  if (ext === ".prisma") {
    return "prisma";
  }
  if (ext === ".sh") {
    return "shell";
  }
  if (ext === ".txt") {
    return "text";
  }
  return "text";
}

function classifyArea(filePath) {
  const normalized = toPosixPath(filePath);
  if (normalized.startsWith("backend/src/")) {
    return "backend-src";
  }
  if (normalized.startsWith("backend/prisma/")) {
    return "backend-prisma";
  }
  if (normalized.startsWith("frontend/app/")) {
    return "frontend-app";
  }
  if (normalized.startsWith("frontend/components/")) {
    return "frontend-components";
  }
  if (normalized.startsWith("frontend/features/")) {
    return "frontend-features";
  }
  if (normalized.startsWith("frontend/hooks/")) {
    return "frontend-hooks";
  }
  if (normalized.startsWith("frontend/lib/")) {
    return "frontend-lib";
  }
  if (normalized.startsWith("docs/")) {
    return "docs";
  }
  if (normalized.startsWith(".github/")) {
    return "governance";
  }
  return "repo-root";
}

function extractImports(content) {
  const imports = new Set();
  const importRegex = /^\s*import\s+.+?\s+from\s+["']([^"']+)["']/gm;
  let match = importRegex.exec(content);
  while (match) {
    imports.add(match[1]);
    match = importRegex.exec(content);
  }
  const requireRegex = /^\s*const\s+.+?\s*=\s*require\(["']([^"']+)["']\)/gm;
  match = requireRegex.exec(content);
  while (match) {
    imports.add(match[1]);
    match = requireRegex.exec(content);
  }
  return Array.from(imports).slice(0, 40);
}

function extractExports(content) {
  const exports = new Set();
  const directExportRegex =
    /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z0-9_$]+)/gm;
  let match = directExportRegex.exec(content);
  while (match) {
    exports.add(match[1]);
    match = directExportRegex.exec(content);
  }
  const aggregateExportRegex = /^\s*export\s*{\s*([^}]+)\s*}/gm;
  match = aggregateExportRegex.exec(content);
  while (match) {
    const names = match[1]
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => name.split(/\s+as\s+/i)[0].trim());
    for (const name of names) {
      if (name) {
        exports.add(name);
      }
    }
    match = aggregateExportRegex.exec(content);
  }
  return Array.from(exports).slice(0, 40);
}

function extractRouteHints(content) {
  const hints = new Set();
  const routeRegex = /router\.(get|post|put|patch|delete|use)\s*\(\s*["'`]([^"'`]+)["'`]/gm;
  let match = routeRegex.exec(content);
  while (match) {
    hints.add(`${match[1].toUpperCase()} ${match[2]}`);
    match = routeRegex.exec(content);
  }
  return Array.from(hints).slice(0, 60);
}

function extractSymbols(filePath, content, language) {
  const lines = content.split("\n");
  const candidates = [];

  function add(lineNumber, kind, name, signature) {
    if (!name) {
      return;
    }
    candidates.push({
      path: filePath,
      line: lineNumber,
      kind,
      name,
      signature: signature.trim().slice(0, 220),
    });
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNumber = i + 1;

    let match =
      /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(line) ||
      /^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(line);
    if (match) {
      add(lineNumber, "function", match[1], line);
      continue;
    }

    match = /^\s*export\s+class\s+([A-Za-z0-9_$]+)/.exec(line) || /^\s*class\s+([A-Za-z0-9_$]+)/.exec(line);
    if (match) {
      add(lineNumber, "class", match[1], line);
      continue;
    }

    match =
      /^\s*export\s+interface\s+([A-Za-z0-9_$]+)/.exec(line) ||
      /^\s*interface\s+([A-Za-z0-9_$]+)/.exec(line);
    if (match) {
      add(lineNumber, "interface", match[1], line);
      continue;
    }

    match = /^\s*export\s+type\s+([A-Za-z0-9_$]+)/.exec(line) || /^\s*type\s+([A-Za-z0-9_$]+)/.exec(line);
    if (match) {
      add(lineNumber, "type", match[1], line);
      continue;
    }

    match = /^\s*export\s+enum\s+([A-Za-z0-9_$]+)/.exec(line) || /^\s*enum\s+([A-Za-z0-9_$]+)/.exec(line);
    if (match) {
      add(lineNumber, "enum", match[1], line);
      continue;
    }

    match = /^\s*export\s+const\s+([A-Za-z0-9_$]+)\s*=/.exec(line) || /^\s*const\s+([A-Za-z0-9_$]+)\s*=/.exec(line);
    if (match) {
      add(lineNumber, "const", match[1], line);
      continue;
    }

    match = /^\s*router\.(get|post|put|patch|delete|use)\s*\(\s*["'`]([^"'`]+)["'`]/.exec(line);
    if (match) {
      add(lineNumber, "route", `${match[1].toUpperCase()} ${match[2]}`, line);
      continue;
    }

    if (language === "markdown") {
      match = /^(#{1,6})\s+(.+)$/.exec(line);
      if (match) {
        add(lineNumber, "heading", match[2].trim(), line);
      }
    }
  }

  candidates.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  const deduped = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.line}|${candidate.kind}|${candidate.name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }

  for (let i = 0; i < deduped.length; i += 1) {
    const current = deduped[i];
    const next = deduped[i + 1];
    current.start_line = current.line;
    current.end_line = next ? Math.max(current.start_line, next.line - 1) : lines.length;
    current.id = sha256Text(
      `${filePath}:${current.kind}:${current.name}:${current.start_line}:${current.end_line}`
    ).slice(0, 16);
  }

  return deduped;
}

function windowRanges(startLine, endLine, maxLines, overlapLines) {
  if (endLine < startLine) {
    return [];
  }

  const ranges = [];
  let cursor = startLine;
  while (cursor <= endLine) {
    const windowEnd = Math.min(endLine, cursor + maxLines - 1);
    ranges.push([cursor, windowEnd]);
    if (windowEnd >= endLine) {
      break;
    }
    const nextCursor = Math.max(cursor + 1, windowEnd - overlapLines + 1);
    if (nextCursor <= cursor) {
      break;
    }
    cursor = nextCursor;
  }
  return ranges;
}

function sliceLines(lines, startLine, endLine) {
  return lines.slice(startLine - 1, endLine).join("\n");
}

function shouldUseDocChunking(language, filePath) {
  return language === "markdown" || filePath.endsWith(".md");
}

function buildDocSections(lines) {
  const headings = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^(#{1,6})\s+/.test(lines[i])) {
      headings.push(i + 1);
    }
  }
  if (headings.length === 0 || headings[0] !== 1) {
    headings.unshift(1);
  }
  const sections = [];
  for (let i = 0; i < headings.length; i += 1) {
    const start = headings[i];
    const end = i + 1 < headings.length ? headings[i + 1] - 1 : lines.length;
    sections.push([start, end]);
  }
  return sections.filter((section) => section[1] >= section[0]);
}

function generateChunksForFile(filePath, content, language, symbols, chunkingConfig) {
  const lines = content.split("\n");
  const chunks = [];

  function pushChunk(startLine, endLine, type, symbol = null) {
    if (endLine < startLine) {
      return;
    }
    const text = sliceLines(lines, startLine, endLine).trimEnd();
    if (!text.trim()) {
      return;
    }
    const tokenEstimate = Math.max(1, Math.ceil(text.length / 4));
    const hash = sha256Text(`${filePath}:${startLine}:${endLine}:${text}`);
    chunks.push({
      id: hash.slice(0, 16),
      path: filePath,
      area: classifyArea(filePath),
      language,
      chunk_type: type,
      start_line: startLine,
      end_line: endLine,
      symbol_name: symbol?.name ?? null,
      symbol_kind: symbol?.kind ?? null,
      token_estimate: tokenEstimate,
      text_hash: sha256Text(text),
      text,
    });
  }

  if (shouldUseDocChunking(language, filePath)) {
    const sections = buildDocSections(lines);
    for (const [sectionStart, sectionEnd] of sections) {
      const windows = windowRanges(
        sectionStart,
        sectionEnd,
        chunkingConfig.docMaxLines,
        chunkingConfig.docOverlapLines
      );
      for (const [startLine, endLine] of windows) {
        pushChunk(startLine, endLine, "doc");
      }
    }
    return chunks;
  }

  const isCodeLike =
    language === "typescript" ||
    language === "javascript" ||
    language === "sql" ||
    language === "prisma" ||
    language === "json" ||
    language === "yaml" ||
    language === "shell";

  if (!isCodeLike) {
    const windows = windowRanges(
      1,
      lines.length,
      chunkingConfig.textMaxLines,
      chunkingConfig.textOverlapLines
    );
    for (const [startLine, endLine] of windows) {
      pushChunk(startLine, endLine, "text");
    }
    return chunks;
  }

  if (symbols.length === 0) {
    const windows = windowRanges(
      1,
      lines.length,
      chunkingConfig.codeMaxLines,
      chunkingConfig.codeOverlapLines
    );
    for (const [startLine, endLine] of windows) {
      pushChunk(startLine, endLine, "code");
    }
    return chunks;
  }

  const firstSymbol = symbols[0];
  if (firstSymbol.start_line > 1) {
    const windows = windowRanges(
      1,
      firstSymbol.start_line - 1,
      chunkingConfig.codeMaxLines,
      chunkingConfig.codeOverlapLines
    );
    for (const [startLine, endLine] of windows) {
      pushChunk(startLine, endLine, "code_preamble");
    }
  }

  for (const symbol of symbols) {
    const windows = windowRanges(
      symbol.start_line,
      symbol.end_line,
      chunkingConfig.codeMaxLines,
      chunkingConfig.codeOverlapLines
    );
    for (let i = 0; i < windows.length; i += 1) {
      const [startLine, endLine] = windows[i];
      pushChunk(startLine, endLine, i === 0 ? "symbol" : "symbol_continuation", symbol);
    }
  }

  return chunks;
}

function normalizeTextForTokens(text) {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[`~!@#$%^&*()+={}[\]|\\:;"'<>,.?]/g, " ")
    .toLowerCase();
}

function tokenize(text) {
  const normalized = normalizeTextForTokens(text);
  const matches = normalized.match(/[a-z0-9_/-]{2,64}/g) ?? [];
  const filtered = [];
  for (const token of matches) {
    if (STOP_WORDS.has(token)) {
      continue;
    }
    if (/^\d+$/.test(token)) {
      continue;
    }
    filtered.push(token);
  }

  const bigrams = [];
  const maxBigrams = Math.min(filtered.length - 1, 128);
  for (let i = 0; i < maxBigrams; i += 1) {
    bigrams.push(`${filtered[i]}__${filtered[i + 1]}`);
  }
  return filtered.concat(bigrams);
}

function fnv1a32(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function vectorizeText(text, dimension) {
  const vector = new Float32Array(dimension);
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return vector;
  }

  const counts = new Map();
  for (const token of tokens) {
    const idx = fnv1a32(token) % dimension;
    counts.set(idx, (counts.get(idx) ?? 0) + 1);
  }

  let squared = 0;
  for (const [idx, count] of counts.entries()) {
    const value = 1 + Math.log(count);
    vector[idx] = value;
    squared += value * value;
  }

  if (squared <= 0) {
    return vector;
  }

  const norm = Math.sqrt(squared);
  for (let i = 0; i < vector.length; i += 1) {
    if (vector[i] !== 0) {
      vector[i] /= norm;
    }
  }

  return vector;
}

function dotProduct(a, b, offsetB = 0) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += a[i] * b[offsetB + i];
  }
  return sum;
}

function getGitMetadata(repoRoot) {
  const branch = runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = runCommand("git", ["rev-parse", "HEAD"]);
  const status = runCommand("git", ["status", "--porcelain"]);

  return {
    branch: branch.ok ? branch.stdout.trim() : "UNKNOWN",
    head: head.ok ? head.stdout.trim() : "UNKNOWN",
    dirty: status.ok ? Boolean(status.stdout.trim()) : true,
    captured_at: nowIso(),
    repo_root: toPosixPath(repoRoot),
  };
}

function readExistingIndex(outputDir, expectedDimension) {
  const manifestPath = path.join(outputDir, MANIFEST_FILE);
  const filesPath = path.join(outputDir, FILES_FILE);
  const chunksPath = path.join(outputDir, CHUNKS_FILE);
  const symbolsPath = path.join(outputDir, SYMBOLS_FILE);
  const vectorsPath = path.join(outputDir, VECTORS_FILE);

  if (
    !fs.existsSync(manifestPath) ||
    !fs.existsSync(filesPath) ||
    !fs.existsSync(chunksPath) ||
    !fs.existsSync(symbolsPath) ||
    !fs.existsSync(vectorsPath)
  ) {
    return null;
  }

  const manifest = readJson(manifestPath);
  const files = parseJsonLines(filesPath);
  const chunks = parseJsonLines(chunksPath);
  const symbols = parseJsonLines(symbolsPath);
  const vectorsBuffer = fs.readFileSync(vectorsPath);
  const vectors = new Float32Array(
    vectorsBuffer.buffer,
    vectorsBuffer.byteOffset,
    Math.floor(vectorsBuffer.byteLength / Float32Array.BYTES_PER_ELEMENT)
  );

  if (!manifest.engine || manifest.engine.dimension !== expectedDimension) {
    return null;
  }

  if (vectors.length !== chunks.length * expectedDimension) {
    return null;
  }

  const filesByPath = new Map();
  for (const row of files) {
    filesByPath.set(row.path, row);
  }

  const chunksByPath = new Map();
  for (const chunk of chunks) {
    const existing = chunksByPath.get(chunk.path) ?? [];
    existing.push(chunk);
    chunksByPath.set(chunk.path, existing);
  }
  for (const list of chunksByPath.values()) {
    list.sort((a, b) => a.vector_row - b.vector_row);
  }

  const symbolsByPath = new Map();
  for (const symbol of symbols) {
    const existing = symbolsByPath.get(symbol.path) ?? [];
    existing.push(symbol);
    symbolsByPath.set(symbol.path, existing);
  }
  for (const list of symbolsByPath.values()) {
    list.sort((a, b) => a.start_line - b.start_line);
  }

  return {
    manifest,
    files,
    chunks,
    symbols,
    vectors,
    filesByPath,
    chunksByPath,
    symbolsByPath,
  };
}

function acquireBuildLock(outputDir) {
  ensureDir(outputDir);
  const lockPath = path.join(outputDir, LOCK_FILE);

  if (fs.existsSync(lockPath)) {
    const stat = fs.statSync(lockPath);
    const age = Date.now() - stat.mtimeMs;
    if (age > LOCK_STALE_MS) {
      fs.unlinkSync(lockPath);
    } else {
      fail(
        `Index lock exists at ${toPosixPath(path.relative(process.cwd(), lockPath))}. ` +
          "If no build is running, delete the lock file."
      );
    }
  }

  const handle = fs.openSync(lockPath, "wx");
  const payload = {
    pid: process.pid,
    started_at: nowIso(),
    cwd: toPosixPath(process.cwd()),
  };
  fs.writeFileSync(handle, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.closeSync(handle);

  return () => {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  };
}

function computeAreaWeight(filePath, areaWeights) {
  const normalized = toPosixPath(filePath);
  let best = 0.7;
  let bestLength = -1;

  for (const [prefix, weight] of Object.entries(areaWeights ?? {})) {
    if (prefix.endsWith("/")) {
      if (normalized.startsWith(prefix) && prefix.length > bestLength) {
        best = Number(weight);
        bestLength = prefix.length;
      }
    } else if (normalized === prefix && prefix.length > bestLength) {
      best = Number(weight);
      bestLength = prefix.length;
    }
  }

  return Number.isFinite(best) ? best : 0.7;
}

function buildIndex(args) {
  const repoRoot = resolveRepoRoot();
  const {
    config,
    configHash,
    configPath,
    outputRoot,
    outputDir,
    namespace,
    isolationMode,
    isolationDetails,
  } = loadConfig(
    repoRoot,
    args.configPath,
    args.outputDir
  );

  const releaseLock = acquireBuildLock(outputDir);
  const startedAt = nowIso();
  const dimension = config.engine?.dimension;
  if (!Number.isInteger(dimension) || dimension <= 0) {
    releaseLock();
    fail("Invalid config.engine.dimension value");
  }

  const existing = readExistingIndex(outputDir, dimension);
  const canReuse =
    !args.full &&
    existing &&
    existing.manifest?.config_hash === configHash &&
    existing.manifest?.engine?.name === config.engine?.name &&
    existing.manifest?.engine?.version === config.engine?.version &&
    existing.manifest?.engine?.dimension === dimension &&
    existing.manifest?.index_format_version === config.indexFormatVersion;

  const chunkingConfig = config.chunking ?? {};
  const maxFileBytes = Number(chunkingConfig.maxFileBytes ?? 500_000);

  const { files: candidateFiles, warnings } = collectCandidateFiles(repoRoot, config);

  const fileRecords = [];
  const symbolRecords = [];
  const chunkRecords = [];
  const vectorRows = [];

  let filesScanned = 0;
  let filesIndexed = 0;
  let filesReused = 0;
  let chunksCreated = 0;
  let chunksReused = 0;
  let minMtime = Number.POSITIVE_INFINITY;
  let maxMtime = Number.NEGATIVE_INFINITY;

  try {
    for (const relPath of candidateFiles) {
      filesScanned += 1;
      const absPath = path.resolve(repoRoot, relPath);
      const stat = fs.statSync(absPath);
      if (!stat.isFile()) {
        continue;
      }
      if (stat.size > maxFileBytes) {
        warnings.push(`Skipped oversized file (${stat.size} bytes): ${relPath}`);
        continue;
      }

      const content = fs.readFileSync(absPath, "utf8");
      const fileHash = sha256Text(content);
      const language = detectLanguage(relPath);
      const area = classifyArea(relPath);
      const mtimeMs = stat.mtimeMs;
      minMtime = Math.min(minMtime, mtimeMs);
      maxMtime = Math.max(maxMtime, mtimeMs);

      const existingFile = canReuse ? existing.filesByPath.get(relPath) : null;
      const shouldReuse = Boolean(existingFile && existingFile.hash === fileHash);

      const imports = extractImports(content);
      const exports = extractExports(content);
      const routeHints = extractRouteHints(content);

      if (shouldReuse) {
        filesReused += 1;
        filesIndexed += 1;

        const previousChunks = existing.chunksByPath.get(relPath) ?? [];
        const previousSymbols = existing.symbolsByPath.get(relPath) ?? [];

        for (const symbol of previousSymbols) {
          symbolRecords.push({
            ...symbol,
            file_hash: fileHash,
          });
        }

        for (const oldChunk of previousChunks) {
          const rowStart = oldChunk.vector_row * dimension;
          const rowEnd = rowStart + dimension;
          const vector = existing.vectors.slice(rowStart, rowEnd);
          vectorRows.push(vector);
          const cloned = {
            ...oldChunk,
            mtime_ms: mtimeMs,
            vector_row: vectorRows.length - 1,
          };
          chunkRecords.push(cloned);
          chunksReused += 1;
        }

        fileRecords.push({
          path: relPath,
          area,
          language,
          size_bytes: stat.size,
          mtime_ms: mtimeMs,
          hash: fileHash,
          chunk_count: previousChunks.length,
          symbol_count: previousSymbols.length,
          import_count: imports.length,
          export_count: exports.length,
          route_hint_count: routeHints.length,
          imports,
          exports,
          route_hints: routeHints,
          indexed_via: "reused",
          indexed_at: nowIso(),
        });
        continue;
      }

      const symbols = extractSymbols(relPath, content, language);
      const chunks = generateChunksForFile(relPath, content, language, symbols, {
        codeMaxLines: Number(chunkingConfig.codeMaxLines ?? 110),
        codeOverlapLines: Number(chunkingConfig.codeOverlapLines ?? 14),
        docMaxLines: Number(chunkingConfig.docMaxLines ?? 140),
        docOverlapLines: Number(chunkingConfig.docOverlapLines ?? 20),
        textMaxLines: Number(chunkingConfig.textMaxLines ?? 120),
        textOverlapLines: Number(chunkingConfig.textOverlapLines ?? 16),
      });

      filesIndexed += 1;
      chunksCreated += chunks.length;

      for (const symbol of symbols) {
        symbolRecords.push({
          ...symbol,
          path: relPath,
          file_hash: fileHash,
          area,
          language,
        });
      }

      for (const chunk of chunks) {
        const vector = vectorizeText(chunk.text, dimension);
        vectorRows.push(vector);
        chunk.vector_row = vectorRows.length - 1;
        chunk.file_hash = fileHash;
        chunk.mtime_ms = mtimeMs;
        chunk.area_weight = computeAreaWeight(relPath, config.areaWeights);
        chunkRecords.push(chunk);
      }

      fileRecords.push({
        path: relPath,
        area,
        language,
        size_bytes: stat.size,
        mtime_ms: mtimeMs,
        hash: fileHash,
        chunk_count: chunks.length,
        symbol_count: symbols.length,
        import_count: imports.length,
        export_count: exports.length,
        route_hint_count: routeHints.length,
        imports,
        exports,
        route_hints: routeHints,
        indexed_via: "rebuilt",
        indexed_at: nowIso(),
      });
    }

    fileRecords.sort((a, b) => a.path.localeCompare(b.path));
    symbolRecords.sort((a, b) => a.path.localeCompare(b.path) || a.start_line - b.start_line);
    chunkRecords.sort(
      (a, b) => a.path.localeCompare(b.path) || a.start_line - b.start_line || a.end_line - b.end_line
    );

    const orderedRows = [];
    for (const chunk of chunkRecords) {
      orderedRows.push(vectorRows[chunk.vector_row]);
    }

    const orderedChunkRecords = [];
    for (let i = 0; i < chunkRecords.length; i += 1) {
      orderedChunkRecords.push({
        ...chunkRecords[i],
        vector_row: i,
      });
    }

    const vectors = new Float32Array(orderedChunkRecords.length * dimension);
    for (let row = 0; row < orderedRows.length; row += 1) {
      vectors.set(orderedRows[row], row * dimension);
    }

    const filesText = toJsonLines(fileRecords);
    const chunksText = toJsonLines(orderedChunkRecords);
    const symbolsText = toJsonLines(symbolRecords);
    const vectorsBuffer = Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength);

    ensureDir(outputDir);
    const filesPath = path.join(outputDir, FILES_FILE);
    const chunksPath = path.join(outputDir, CHUNKS_FILE);
    const symbolsPath = path.join(outputDir, SYMBOLS_FILE);
    const vectorsPath = path.join(outputDir, VECTORS_FILE);

    writeTextAtomic(filesPath, filesText);
    writeTextAtomic(chunksPath, chunksText);
    writeTextAtomic(symbolsPath, symbolsText);
    writeBufferAtomic(vectorsPath, vectorsBuffer);

    const completedAt = nowIso();
    const git = getGitMetadata(repoRoot);

    const manifest = {
      schema_version: config.schemaVersion ?? "1.0.0",
      index_format_version: config.indexFormatVersion ?? "1.0.0",
      build_mode: args.full ? "full" : "incremental",
      build_started_at: startedAt,
      build_completed_at: completedAt,
      config_path: toPosixPath(path.relative(repoRoot, configPath)),
      output_root: toPosixPath(path.relative(repoRoot, outputRoot)),
      output_dir: toPosixPath(path.relative(repoRoot, outputDir)),
      output_namespace: namespace,
      output_isolation_mode: isolationMode,
      output_isolation: isolationDetails,
      config_hash: configHash,
      engine: {
        name: config.engine?.name ?? "unknown",
        version: config.engine?.version ?? "unknown",
        dimension,
        vector_kind: "hash_tf_l2_normalized",
      },
      git,
      stats: {
        files_scanned: filesScanned,
        files_indexed: filesIndexed,
        files_reused: filesReused,
        chunks_total: orderedChunkRecords.length,
        chunks_rebuilt: chunksCreated,
        chunks_reused: chunksReused,
        symbols_total: symbolRecords.length,
        warnings_count: warnings.length,
        indexed_paths_count: candidateFiles.length,
        mtime_range: {
          min: Number.isFinite(minMtime) ? minMtime : null,
          max: Number.isFinite(maxMtime) ? maxMtime : null,
        },
      },
      artifacts: {
        files_path: FILES_FILE,
        chunks_path: CHUNKS_FILE,
        symbols_path: SYMBOLS_FILE,
        vectors_path: VECTORS_FILE,
        files_sha256: sha256Buffer(Buffer.from(filesText, "utf8")),
        chunks_sha256: sha256Buffer(Buffer.from(chunksText, "utf8")),
        symbols_sha256: sha256Buffer(Buffer.from(symbolsText, "utf8")),
        vectors_sha256: sha256Buffer(vectorsBuffer),
        vectors_bytes: vectorsBuffer.byteLength,
      },
      drift_contract: {
        strict_engine_match: true,
        strict_config_hash_match: true,
        source_hash_validation: true,
        quick_git_state_check: true,
      },
      warnings,
    };

    const manifestPath = path.join(outputDir, MANIFEST_FILE);
    writeTextAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const summary = {
      status: "ok",
      command: "build",
      output_dir: manifest.output_dir,
      output_namespace: manifest.output_namespace,
      output_isolation_mode: manifest.output_isolation_mode,
      build_mode: manifest.build_mode,
      files_indexed: manifest.stats.files_indexed,
      files_reused: manifest.stats.files_reused,
      chunks_total: manifest.stats.chunks_total,
      chunks_rebuilt: manifest.stats.chunks_rebuilt,
      chunks_reused: manifest.stats.chunks_reused,
      symbols_total: manifest.stats.symbols_total,
      warnings_count: manifest.stats.warnings_count,
    };

    if (args.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          "Index build complete.",
          `- Isolation mode: ${summary.output_isolation_mode}`,
          `- Namespace: ${summary.output_namespace ?? "(none)"}`,
          `- Output: ${summary.output_dir}`,
          `- Build mode: ${summary.build_mode}`,
          `- Files indexed: ${summary.files_indexed} (reused: ${summary.files_reused})`,
          `- Chunks: ${summary.chunks_total} (rebuilt: ${summary.chunks_rebuilt}, reused: ${summary.chunks_reused})`,
          `- Symbols: ${summary.symbols_total}`,
          `- Warnings: ${summary.warnings_count}`,
        ].join("\n") + "\n"
      );
      if (warnings.length > 0) {
        for (const warning of warnings.slice(0, 20)) {
          process.stdout.write(`  - warn: ${warning}\n`);
        }
        if (warnings.length > 20) {
          process.stdout.write(`  - warn: ... ${warnings.length - 20} more warnings\n`);
        }
      }
    }
  } finally {
    releaseLock();
  }
}

function loadIndexForQuery(repoRoot, config, outputDir) {
  const manifestPath = path.join(outputDir, MANIFEST_FILE);
  const filesPath = path.join(outputDir, FILES_FILE);
  const chunksPath = path.join(outputDir, CHUNKS_FILE);
  const symbolsPath = path.join(outputDir, SYMBOLS_FILE);
  const vectorsPath = path.join(outputDir, VECTORS_FILE);

  if (!fs.existsSync(manifestPath)) {
    fail("Index not found. Run build first.");
  }

  const manifest = readJson(manifestPath);
  const files = parseJsonLines(filesPath);
  const chunks = parseJsonLines(chunksPath);
  const symbols = parseJsonLines(symbolsPath);
  const vectorsBuffer = fs.readFileSync(vectorsPath);
  const vectors = new Float32Array(
    vectorsBuffer.buffer,
    vectorsBuffer.byteOffset,
    Math.floor(vectorsBuffer.byteLength / Float32Array.BYTES_PER_ELEMENT)
  );

  if (manifest.engine?.dimension !== config.engine?.dimension) {
    fail("Index dimension mismatch with current config. Rebuild the index.");
  }
  if (vectors.length !== chunks.length * manifest.engine.dimension) {
    fail("Index vectors are corrupt (length mismatch). Run verify or rebuild.");
  }

  const filesByPath = new Map();
  for (const file of files) {
    filesByPath.set(file.path, file);
  }

  const symbolNamesByPath = new Map();
  for (const symbol of symbols) {
    const existing = symbolNamesByPath.get(symbol.path) ?? [];
    existing.push(symbol.name.toLowerCase());
    symbolNamesByPath.set(symbol.path, existing);
  }

  return { manifest, files, chunks, symbols, vectors, filesByPath, symbolNamesByPath };
}

function lexicalScore(queryTokens, chunkLower, pathLower, symbolLower) {
  if (queryTokens.length === 0) {
    return 0;
  }

  let matches = 0;
  for (const token of queryTokens) {
    if (
      chunkLower.includes(token) ||
      pathLower.includes(token) ||
      (symbolLower && symbolLower.includes(token))
    ) {
      matches += 1;
    }
  }
  return matches / queryTokens.length;
}

function symbolScore(queryTokens, symbolName, symbolNamesInPath) {
  if (queryTokens.length === 0) {
    return 0;
  }
  const candidateValues = [];
  if (symbolName) {
    candidateValues.push(symbolName.toLowerCase());
  }
  if (Array.isArray(symbolNamesInPath)) {
    candidateValues.push(...symbolNamesInPath);
  }
  if (candidateValues.length === 0) {
    return 0;
  }

  for (const token of queryTokens) {
    for (const value of candidateValues) {
      if (value === token) {
        return 1;
      }
      if (value.includes(token)) {
        return 0.7;
      }
    }
  }
  return 0;
}

function quickDriftStatus(manifest) {
  const current = getGitMetadata(process.cwd());
  const details = {
    indexed_head: manifest.git?.head ?? "UNKNOWN",
    current_head: current.head,
    indexed_dirty: Boolean(manifest.git?.dirty),
    current_dirty: Boolean(current.dirty),
  };
  const stale =
    details.indexed_head !== details.current_head ||
    details.indexed_dirty !== details.current_dirty;
  return { stale, details };
}

function queryIndex(args) {
  const repoRoot = resolveRepoRoot();
  const { config, outputDir } = loadConfig(repoRoot, args.configPath, args.outputDir);

  const queryText = args.queryText.trim();
  if (!queryText) {
    fail("Missing query text. Example: node tools/index/indexer.mjs query \"playback state route\"");
  }

  const { manifest, chunks, vectors, symbolNamesByPath } = loadIndexForQuery(
    repoRoot,
    config,
    outputDir
  );
  const drift = quickDriftStatus(manifest);

  if (args.strictFresh && drift.stale) {
    fail("Index is stale versus current git state. Re-run build before querying.");
  }

  if (args.verify) {
    const result = verifyIndex({
      ...args,
      configPath: args.configPath,
      outputDir: args.outputDir,
      strict: false,
      json: true,
      _fromQuery: true,
    });
    if (result.status !== "ok") {
      fail("Index verify failed before query. Fix index integrity first.");
    }
  }

  const queryVector = vectorizeText(queryText, manifest.engine.dimension);
  const queryTokens = Array.from(new Set(tokenize(queryText)));

  const defaultTop = Number(config.query?.defaultTopK ?? 8);
  const maxTop = Number(config.query?.maxTopK ?? 30);
  let topK = Number.isInteger(args.top) ? args.top : defaultTop;
  if (!Number.isFinite(topK) || topK <= 0) {
    topK = defaultTop;
  }
  topK = Math.min(topK, maxTop);

  const weights = {
    vector: Number(config.query?.weights?.vector ?? 0.62),
    lexical: Number(config.query?.weights?.lexical ?? 0.24),
    symbol: Number(config.query?.weights?.symbol ?? 0.08),
    path: Number(config.query?.weights?.path ?? 0.04),
    recency: Number(config.query?.weights?.recency ?? 0.02),
  };

  const minMtime = Number(manifest.stats?.mtime_range?.min ?? 0);
  const maxMtime = Number(manifest.stats?.mtime_range?.max ?? 0);
  const mtimeRange = Math.max(1, maxMtime - minMtime);

  const scored = [];
  const queryPathHint = queryText.toLowerCase().includes("/");

  for (let row = 0; row < chunks.length; row += 1) {
    const chunk = chunks[row];
    const textLower = chunk.text.toLowerCase();
    const pathLower = chunk.path.toLowerCase();
    const symbolLower = chunk.symbol_name ? chunk.symbol_name.toLowerCase() : "";
    const symbolNamesInPath = symbolNamesByPath.get(chunk.path) ?? [];

    if (queryTokens.length > 0) {
      let candidate = false;
      for (const token of queryTokens) {
        if (textLower.includes(token) || pathLower.includes(token) || symbolLower.includes(token)) {
          candidate = true;
          break;
        }
      }
      if (!candidate && queryTokens.length >= 2) {
        continue;
      }
    }

    const vectorScore = dotProduct(queryVector, vectors, row * manifest.engine.dimension);
    const lexScore = lexicalScore(queryTokens, textLower, pathLower, symbolLower);
    const symScore = symbolScore(queryTokens, chunk.symbol_name, symbolNamesInPath);
    const pathScore = queryPathHint && pathLower.includes(queryText.toLowerCase()) ? 1 : chunk.area_weight ?? 0.7;
    const recencyScore = Math.max(
      0,
      Math.min(1, (Number(chunk.mtime_ms ?? minMtime) - minMtime) / mtimeRange)
    );

    const score =
      weights.vector * vectorScore +
      weights.lexical * lexScore +
      weights.symbol * symScore +
      weights.path * pathScore +
      weights.recency * recencyScore;

    scored.push({
      rank_score: score,
      vector_score: vectorScore,
      lexical_score: lexScore,
      symbol_score: symScore,
      path_score: pathScore,
      recency_score: recencyScore,
      chunk,
    });
  }

  scored.sort((a, b) => b.rank_score - a.rank_score);
  const results = scored.slice(0, topK).map((entry, index) => {
    const snippetLines = entry.chunk.text.split("\n").slice(0, 6).join("\n").trim();
    return {
      rank: index + 1,
      score: Number(entry.rank_score.toFixed(6)),
      path: entry.chunk.path,
      start_line: entry.chunk.start_line,
      end_line: entry.chunk.end_line,
      chunk_type: entry.chunk.chunk_type,
      symbol_name: entry.chunk.symbol_name,
      symbol_kind: entry.chunk.symbol_kind,
      area: entry.chunk.area,
      token_estimate: entry.chunk.token_estimate,
      score_breakdown: {
        vector: Number(entry.vector_score.toFixed(6)),
        lexical: Number(entry.lexical_score.toFixed(6)),
        symbol: Number(entry.symbol_score.toFixed(6)),
        path: Number(entry.path_score.toFixed(6)),
        recency: Number(entry.recency_score.toFixed(6)),
      },
      snippet: snippetLines.length > 420 ? `${snippetLines.slice(0, 417)}...` : snippetLines,
    };
  });

  const payload = {
    status: "ok",
    command: "query",
    query: queryText,
    top_k: topK,
    total_candidates: scored.length,
    stale: drift.stale,
    drift: drift.details,
    results,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  process.stdout.write(`Query: ${queryText}\n`);
  process.stdout.write(`Top results: ${results.length}/${topK} (candidates: ${scored.length})\n`);
  if (drift.stale) {
    process.stdout.write(
      "Warning: index freshness drift detected versus current git state. Rebuild for strict accuracy.\n"
    );
  }
  for (const result of results) {
    process.stdout.write(
      `\n[${result.rank}] ${result.path}:${result.start_line}-${result.end_line} score=${result.score}\n`
    );
    if (result.symbol_name) {
      process.stdout.write(`symbol: ${result.symbol_kind} ${result.symbol_name}\n`);
    }
    process.stdout.write(`${result.snippet}\n`);
  }
}

function verifyIndex(args) {
  const repoRoot = resolveRepoRoot();
  const { config, outputDir } = loadConfig(repoRoot, args.configPath, args.outputDir);

  const manifestPath = path.join(outputDir, MANIFEST_FILE);
  const filesPath = path.join(outputDir, FILES_FILE);
  const chunksPath = path.join(outputDir, CHUNKS_FILE);
  const symbolsPath = path.join(outputDir, SYMBOLS_FILE);
  const vectorsPath = path.join(outputDir, VECTORS_FILE);

  const errors = [];
  const warnings = [];

  if (!fs.existsSync(manifestPath)) {
    errors.push("Missing manifest.json");
  }
  if (!fs.existsSync(filesPath)) {
    errors.push("Missing files.jsonl");
  }
  if (!fs.existsSync(chunksPath)) {
    errors.push("Missing chunks.jsonl");
  }
  if (!fs.existsSync(symbolsPath)) {
    errors.push("Missing symbols.jsonl");
  }
  if (!fs.existsSync(vectorsPath)) {
    errors.push("Missing vectors.f32");
  }

  if (errors.length > 0) {
    const payload = {
      status: "error",
      command: "verify",
      errors,
      warnings,
    };
    if (args.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      for (const error of errors) {
        process.stderr.write(`error: ${error}\n`);
      }
    }
    if (args._fromQuery) {
      return payload;
    }
    process.exit(1);
  }

  const manifest = readJson(manifestPath);
  const files = parseJsonLines(filesPath);
  const chunks = parseJsonLines(chunksPath);
  const symbols = parseJsonLines(symbolsPath);
  const vectorsBuffer = fs.readFileSync(vectorsPath);
  const vectors = new Float32Array(
    vectorsBuffer.buffer,
    vectorsBuffer.byteOffset,
    Math.floor(vectorsBuffer.byteLength / Float32Array.BYTES_PER_ELEMENT)
  );

  const dimension = Number(manifest.engine?.dimension);
  if (!Number.isInteger(dimension) || dimension <= 0) {
    errors.push("Invalid manifest.engine.dimension");
  }
  if (dimension !== config.engine?.dimension) {
    warnings.push("Config dimension differs from manifest dimension");
  }

  const expectedVectorLength = chunks.length * dimension;
  if (vectors.length !== expectedVectorLength) {
    errors.push(
      `Vector length mismatch: expected ${expectedVectorLength} floats, got ${vectors.length}`
    );
  }

  const artifactChecks = {
    files_sha256: sha256Buffer(fs.readFileSync(filesPath)),
    chunks_sha256: sha256Buffer(fs.readFileSync(chunksPath)),
    symbols_sha256: sha256Buffer(fs.readFileSync(symbolsPath)),
    vectors_sha256: sha256Buffer(vectorsBuffer),
  };

  for (const [key, value] of Object.entries(artifactChecks)) {
    const expected = manifest.artifacts?.[key];
    if (expected && expected !== value) {
      errors.push(`Artifact checksum mismatch for ${key}`);
    }
  }

  const filesByPath = new Map();
  for (const file of files) {
    filesByPath.set(file.path, file);
  }

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    if (chunk.vector_row !== i) {
      errors.push(`Chunk vector_row out of sequence at row ${i}`);
      break;
    }
    const sourceFile = filesByPath.get(chunk.path);
    if (!sourceFile) {
      errors.push(`Chunk references missing file record: ${chunk.path}`);
      continue;
    }
    if (sourceFile.hash !== chunk.file_hash) {
      errors.push(`Chunk/file hash mismatch for ${chunk.path}:${chunk.start_line}`);
    }
    const computedTextHash = sha256Text(chunk.text ?? "");
    if (computedTextHash !== chunk.text_hash) {
      errors.push(`Chunk text hash mismatch for ${chunk.path}:${chunk.start_line}`);
    }
  }

  for (const symbol of symbols) {
    if (!filesByPath.has(symbol.path)) {
      errors.push(`Symbol references missing file record: ${symbol.path}`);
      break;
    }
  }

  const drifted = [];
  const missing = [];
  for (const file of files) {
    const absPath = path.resolve(repoRoot, file.path);
    if (!fs.existsSync(absPath)) {
      missing.push(file.path);
      continue;
    }
    const content = fs.readFileSync(absPath, "utf8");
    const hash = sha256Text(content);
    if (hash !== file.hash) {
      drifted.push(file.path);
    }
  }

  if (missing.length > 0) {
    warnings.push(`Indexed source files now missing: ${missing.length}`);
  }
  if (drifted.length > 0) {
    warnings.push(`Indexed source files changed since build: ${drifted.length}`);
  }
  if (args.strict && (missing.length > 0 || drifted.length > 0)) {
    errors.push("Strict verify failed due to source drift");
  }

  const drift = quickDriftStatus(manifest);
  if (drift.stale) {
    warnings.push("Git state differs from indexed git state");
    if (args.strict) {
      errors.push("Strict verify failed due to git-state drift");
    }
  }

  const payload = {
    status: errors.length === 0 ? "ok" : "error",
    command: "verify",
    output_dir: toPosixPath(path.relative(repoRoot, outputDir)),
    files_indexed: files.length,
    chunks_total: chunks.length,
    symbols_total: symbols.length,
    vectors_total: vectors.length,
    dimension,
    drift: {
      git: drift.details,
      changed_files: drifted.length,
      missing_files: missing.length,
      changed_file_examples: drifted.slice(0, 20),
      missing_file_examples: missing.slice(0, 20),
    },
    warnings,
    errors,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`Verify status: ${payload.status}\n`);
    process.stdout.write(
      `- Files: ${payload.files_indexed}, Chunks: ${payload.chunks_total}, Symbols: ${payload.symbols_total}\n`
    );
    process.stdout.write(
      `- Drift: changed=${payload.drift.changed_files}, missing=${payload.drift.missing_files}\n`
    );
    if (warnings.length > 0) {
      for (const warning of warnings) {
        process.stdout.write(`  - warn: ${warning}\n`);
      }
    }
    if (errors.length > 0) {
      for (const error of errors) {
        process.stdout.write(`  - error: ${error}\n`);
      }
    }
  }

  if (args._fromQuery) {
    return payload;
  }
  if (errors.length > 0) {
    process.exit(1);
  }
  return payload;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.command) {
    printHelp();
    process.exit(0);
  }

  if (args.command === "build") {
    buildIndex(args);
    return;
  }
  if (args.command === "query") {
    queryIndex(args);
    return;
  }
  if (args.command === "verify") {
    verifyIndex(args);
    return;
  }

  fail(`Unknown command "${args.command}". Use --help for usage.`);
}

main();
