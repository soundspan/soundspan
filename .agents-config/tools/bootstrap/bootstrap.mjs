#!/usr/bin/env node

import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_TEMPLATE_REPO = "BonzTM/agents-template";
const DEFAULT_TEMPLATE_REF = "main";
const DEFAULT_TEMPLATE_LOCAL_PATH = "../agents-template";
const RUNTIME_RELATIVE_PATH = ".agents-config/tools/bootstrap/bootstrap-runtime.mjs";
const MAX_REDIRECTS = 5;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function toNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function run(cmd, args, cwd = process.cwd()) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return {
    ok: !result.error && result.status === 0,
    stdout: (result.stdout ?? "").trim(),
  };
}

function resolveRepoRoot() {
  const gitRoot = run("git", ["rev-parse", "--show-toplevel"]);
  if (gitRoot.ok && gitRoot.stdout) {
    return path.resolve(gitRoot.stdout);
  }
  return process.cwd();
}

function readFlagValue(argv, flagName) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== flagName) {
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      return null;
    }
    return value.trim();
  }
  return null;
}

function normalizeTemplateRepo(input) {
  const value = toNonEmptyString(input) ?? DEFAULT_TEMPLATE_REPO;

  const sshMatch = value.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }

  const httpsMatch = value.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  if (/^[^/]+\/[^/]+$/.test(value)) {
    return value.replace(/\.git$/i, "");
  }

  return DEFAULT_TEMPLATE_REPO;
}

function downloadText(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "agents-template-bootstrap-launcher",
          Accept: "text/plain",
        },
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;

        if (
          statusCode >= 300 &&
          statusCode < 400 &&
          typeof response.headers.location === "string"
        ) {
          response.resume();
          if (redirectCount >= MAX_REDIRECTS) {
            reject(new Error(`Too many redirects while fetching ${url}`));
            return;
          }
          const redirectUrl = new URL(response.headers.location, url).toString();
          downloadText(redirectUrl, redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        if (statusCode !== 200) {
          response.resume();
          reject(new Error(`HTTP ${statusCode} from ${url}`));
          return;
        }

        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          resolve(text);
        });
      },
    );

    request.on("error", (error) => {
      reject(error);
    });
  });
}

async function ensureRuntimeScript({ repoRoot, templateRepo, templateRef }) {
  const runtimePath = path.resolve(repoRoot, RUNTIME_RELATIVE_PATH);
  if (fs.existsSync(runtimePath) && fs.statSync(runtimePath).isFile()) {
    return runtimePath;
  }

  const localTemplateRuntimePath = path.resolve(
    repoRoot,
    DEFAULT_TEMPLATE_LOCAL_PATH,
    RUNTIME_RELATIVE_PATH,
  );
  if (fs.existsSync(localTemplateRuntimePath) && fs.statSync(localTemplateRuntimePath).isFile()) {
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
    fs.copyFileSync(localTemplateRuntimePath, runtimePath);
    return runtimePath;
  }

  const templateSlug = normalizeTemplateRepo(templateRepo);
  const normalizedTemplateRef = toNonEmptyString(templateRef) ?? DEFAULT_TEMPLATE_REF;
  const runtimeUrl =
    `https://raw.githubusercontent.com/${templateSlug}/${normalizedTemplateRef}/${RUNTIME_RELATIVE_PATH}`;

  let runtimeSource;
  try {
    runtimeSource = await downloadText(runtimeUrl);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(
      `Bootstrap runtime not found locally and failed to fetch from ${runtimeUrl}. ${reason}`,
    );
  }

  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.writeFileSync(runtimePath, runtimeSource, "utf8");
  return runtimePath;
}

async function main() {
  const argv = process.argv.slice(2);
  const repoRoot = resolveRepoRoot();
  const templateRepo = readFlagValue(argv, "--template-repo") ?? DEFAULT_TEMPLATE_REPO;
  const templateRef = readFlagValue(argv, "--template-ref") ?? DEFAULT_TEMPLATE_REF;

  const runtimePath = await ensureRuntimeScript({
    repoRoot,
    templateRepo,
    templateRef,
  });

  const result = spawnSync(process.execPath, [runtimePath, ...argv], {
    cwd: process.cwd(),
    stdio: "inherit",
  });

  if (result.error) {
    fail(`Failed to execute bootstrap runtime: ${result.error.message}`);
  }

  if (typeof result.status === "number") {
    process.exit(result.status);
  }

  process.exit(1);
}

main().catch((error) => {
  const reason = error instanceof Error ? error.message : String(error);
  fail(`Bootstrap launcher failed: ${reason}`);
});
