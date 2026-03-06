#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TRACKS = ["current", "deferred", "archived"];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function runRead(cmd, args, cwd = process.cwd()) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return null;
  }
  return (result.stdout ?? "").trim();
}

function runChecked(cmd, args, cwd = process.cwd()) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: "inherit" });
  if (result.error) {
    fail(`Failed to run ${cmd}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`Command failed (${cmd} ${args.join(" ")})`);
  }
}

function resolveRepoRoot() {
  const gitRoot = runRead("git", ["rev-parse", "--show-toplevel"]);
  return gitRoot ? path.resolve(gitRoot) : process.cwd();
}

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = {
    project: "soundspan",
    source: "acm-legacy-plans",
    map: "ACM_LEGACY_PLAN_MAP.json",
    legacyRoot: ".agents/plans",
    tracks: TRACKS.join(","),
  };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      fail(`Unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for ${token}`);
    }
    options[key] = value;
    index += 1;
  }

  return { command, options };
}

function normalizeTrackList(raw) {
  const tracks = String(raw)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (tracks.length === 0) {
    fail("At least one track is required.");
  }
  for (const track of tracks) {
    if (!TRACKS.includes(track)) {
      fail(`Unknown track "${track}". Expected one of: ${TRACKS.join(", ")}`);
    }
  }
  return tracks;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sanitizeToken(value) {
  return String(value)
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function stableReceiptId(track, featureId) {
  const prefix = `legacy.${sanitizeToken(track)}`;
  const slug = sanitizeToken(featureId) || "plan";
  const hash = crypto.createHash("sha256").update(`${track}:${featureId}`).digest("hex").slice(0, 10);
  const bodyBudget = 120 - prefix.length - hash.length - 2;
  const body = slug.slice(0, Math.max(16, bodyBudget));
  return `${prefix}.${body}.${hash}`;
}

function normalizeArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const text = typeof entry === "string" ? entry.trim() : "";
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    out.push(text);
  }
  return out;
}

function truncateText(value, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function truncateList(values, maxItems, maxLength) {
  return normalizeArray(values)
    .slice(0, maxItems)
    .map((value) => truncateText(value, maxLength))
    .filter(Boolean);
}

function normalizeStageStatus(value) {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (status === "complete" || status === "completed") {
    return "complete";
  }
  if (status === "in_progress") {
    return "in_progress";
  }
  if (status === "blocked") {
    return "blocked";
  }
  return "pending";
}

function importedPlanStatus(track, legacyStatus) {
  const normalized = typeof legacyStatus === "string" ? legacyStatus.trim().toLowerCase() : "";
  if (track === "archived" || normalized === "archived") {
    return "complete";
  }
  if (normalized === "in_progress") {
    return "in_progress";
  }
  if (normalized === "complete" || normalized === "completed") {
    return "complete";
  }
  if (track === "deferred" || normalized === "deferred" || normalized === "blocked") {
    return "blocked";
  }
  return "pending";
}

function finalDbStatus(track, legacyStatus) {
  const normalized = typeof legacyStatus === "string" ? legacyStatus.trim().toLowerCase() : "";
  if (track === "archived" || normalized === "archived" || normalized === "complete" || normalized === "completed") {
    return "completed";
  }
  return importedPlanStatus(track, legacyStatus);
}

function listCompanionFiles(planDir, planJsonPath) {
  return fs
    .readdirSync(planDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(planDir, entry.name))
    .filter((filePath) => path.resolve(filePath) !== path.resolve(planJsonPath))
    .sort()
    .map((filePath) => ({
      path: toPosix(path.relative(resolveRepoRoot(), filePath)),
      name: path.basename(filePath),
      content: fs.readFileSync(filePath, "utf8"),
    }));
}

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function collectPlanReferences(planJson, exportPath, companionFiles) {
  const references = new Set([exportPath, planJson.plan_ref].filter(Boolean));
  for (const section of [
    ...(planJson?.narrative?.spec_outline?.full_spec_outline ?? []),
    ...(planJson?.narrative?.refined_spec?.full_refined_spec ?? []),
    ...(planJson?.narrative?.implementation_plan?.steps ?? []),
  ]) {
    for (const reference of normalizeArray(section?.references)) {
      references.add(reference);
    }
  }
  for (const companion of companionFiles) {
    references.add(companion.path);
  }
  return [...references];
}

function splitParagraphs(text) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) {
    return [];
  }
  return value
    .split(/\n+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function planObjective(planJson) {
  const purpose = planJson?.narrative?.pre_spec_outline?.purpose_goals ?? "";
  const specSummary = planJson?.narrative?.spec_outline?.summary ?? "";
  const refinedSummary = planJson?.narrative?.refined_spec?.summary ?? "";
  return truncateText(
    [purpose, specSummary, refinedSummary].map((value) => value.trim()).find(Boolean) || planJson.feature_title,
    2000,
  );
}

function planOutOfScope(planJson) {
  return truncateList(splitParagraphs(planJson?.narrative?.pre_spec_outline?.non_goals ?? ""), 128, 600);
}

function planInScope(planJson) {
  const specEntries = Array.isArray(planJson?.narrative?.spec_outline?.full_spec_outline)
    ? planJson.narrative.spec_outline.full_spec_outline
    : [];
  if (specEntries.length > 0) {
    return truncateList(
      specEntries.flatMap((entry) => [entry.objective, entry.deliverable]),
      128,
      600,
    );
  }
  return truncateList(splitParagraphs(planJson?.narrative?.spec_outline?.summary ?? ""), 128, 600);
}

function mapTaskStatus(track, value) {
  const normalized = normalizeStageStatus(value);
  if (track === "archived") {
    return "complete";
  }
  if (track === "deferred" && normalized === "pending") {
    return "blocked";
  }
  return normalized;
}

function createTaskKey(prefix, index) {
  const slug = sanitizeToken(prefix) || `task-${index + 1}`;
  return `task.${String(index + 1).padStart(2, "0")}.${slug}`.slice(0, 127);
}

function createTasks(track, planJson, exportPath) {
  const steps = Array.isArray(planJson?.narrative?.implementation_plan?.steps)
    ? planJson.narrative.implementation_plan.steps
    : [];
  const tasks = [];

  if (steps.length > 0) {
    steps.forEach((step, index) => {
      const delivered = normalizeArray(step?.completion_summary?.delivered);
      const verification = normalizeArray(step?.completion_summary?.verification_testing);
      tasks.push({
        key: createTaskKey(step?.deliverable ?? `step-${index + 1}`, index),
        summary: truncateText(step?.deliverable || `Legacy plan step ${index + 1}`, 600),
        status: mapTaskStatus(track, step?.status),
        acceptance_criteria: truncateList(step?.acceptance_criteria, 128, 600),
        references: truncateList([exportPath, ...(step?.references ?? [])], 256, 2048),
        blocked_reason:
          track === "deferred" && mapTaskStatus(track, step?.status) === "blocked"
            ? truncateText("Imported from deferred legacy plan.", 600)
            : "",
        outcome: truncateText(delivered.join(" | "), 1600),
        evidence: truncateList(verification, 128, 1600),
      });
    });
  } else {
    const fallbackSummary = planObjective(planJson);
    tasks.push({
      key: "task.legacy-summary",
      summary: truncateText(fallbackSummary, 600),
      status: mapTaskStatus(track, importedPlanStatus(track, planJson?.status)),
      acceptance_criteria: truncateList(
        (planJson?.narrative?.spec_outline?.full_spec_outline ?? []).flatMap((entry) => entry.acceptance_criteria ?? []),
        128,
        600,
      ),
      references: [exportPath],
      blocked_reason: track === "deferred" ? truncateText("Imported from deferred legacy plan.", 600) : "",
      outcome: "",
      evidence: [],
    });
  }

  if (track !== "archived" && !tasks.some((task) => task.key === "verify:tests")) {
    tasks.push({
      key: "verify:tests",
      summary: "Run verification for resumed soundspan work",
      status: track === "deferred" ? "blocked" : "pending",
      acceptance_criteria: ["Run the repo-defined ACM verification tests before completion."],
      references: [exportPath],
      blocked_reason: track === "deferred" ? "Legacy plan is deferred until explicitly resumed." : "",
      outcome: "",
      evidence: [],
    });
  }

  return tasks;
}

function buildExportRecord(track, featureDir, planJson, exportRoot, repoRoot) {
  const featureId = planJson?.feature_id || path.basename(featureDir);
  const receiptId = stableReceiptId(track, featureId);
  const planKey = `plan:${receiptId}`;
  const exportRelPath = toPosix(
    path.relative(repoRoot, path.join(exportRoot, track, `${featureId}.json`)),
  );
  const planJsonPath = path.join(featureDir, "PLAN.json");
  const companionFiles = listCompanionFiles(featureDir, planJsonPath);
  const references = collectPlanReferences(planJson, exportRelPath, companionFiles);
  const tasks = createTasks(track, planJson, exportRelPath);

  return {
    version: 1,
    feature_id: featureId,
    feature_title: planJson?.feature_title || featureId,
    track,
    export_path: exportRelPath,
    legacy: {
      plan_path: toPosix(path.relative(repoRoot, planJsonPath)),
      plan_dir: toPosix(path.relative(repoRoot, featureDir)),
      status: planJson?.status || "",
      updated_at: planJson?.updated_at || "",
      companion_files: companionFiles,
    },
    acm: {
      receipt_id: receiptId,
      plan_key: planKey,
      final_db_status: finalDbStatus(track, planJson?.status),
      plan: {
        title: planJson?.feature_title || featureId,
        objective: planObjective(planJson),
        kind: `legacy_${sanitizeToken(track)}`,
        status: importedPlanStatus(track, planJson?.status),
        stages: {
          spec_outline: normalizeStageStatus(planJson?.planning_stages?.spec_outline),
          refined_spec: normalizeStageStatus(planJson?.planning_stages?.refined_spec),
          implementation_plan: normalizeStageStatus(planJson?.planning_stages?.implementation_plan),
        },
        in_scope: planInScope(planJson),
        out_of_scope: planOutOfScope(planJson),
        constraints: [],
        references: truncateList(references, 256, 2048),
        external_refs: truncateList(companionFiles.map((entry) => entry.path), 256, 2048),
      },
      tasks,
    },
    source_plan: planJson,
  };
}

function exportPlans({ legacyRoot, exportRoot, mapPath, tracks }) {
  const repoRoot = resolveRepoRoot();
  const resolvedLegacyRoot = path.resolve(repoRoot, legacyRoot);
  if (!fs.existsSync(resolvedLegacyRoot)) {
    fail(`Legacy plans root not found: ${resolvedLegacyRoot}`);
  }

  fs.rmSync(path.resolve(repoRoot, exportRoot), { recursive: true, force: true });
  ensureDir(path.resolve(repoRoot, exportRoot));
  for (const track of TRACKS) {
    ensureDir(path.resolve(repoRoot, exportRoot, track));
  }

  const manifest = {
    version: 1,
    generated_at: new Date().toISOString(),
    legacy_root: toPosix(path.relative(repoRoot, resolvedLegacyRoot)),
    export_root: toPosix(exportRoot),
    counts_by_track: {
      current: 0,
      deferred: 0,
      archived: 0,
    },
    features: [],
  };

  for (const track of tracks) {
    const trackRoot = path.join(resolvedLegacyRoot, track);
    if (!fs.existsSync(trackRoot)) {
      continue;
    }

    const featureDirs = fs
      .readdirSync(trackRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(trackRoot, entry.name))
      .sort();

    for (const featureDir of featureDirs) {
      const planJsonPath = path.join(featureDir, "PLAN.json");
      if (!fs.existsSync(planJsonPath)) {
        continue;
      }
      const planJson = readJson(planJsonPath);
      const record = buildExportRecord(track, featureDir, planJson, path.resolve(repoRoot, exportRoot), repoRoot);
      const outputPath = path.resolve(repoRoot, record.export_path);
      writeJson(outputPath, record);
      manifest.counts_by_track[track] += 1;
      manifest.features.push({
        track,
        feature_id: record.feature_id,
        export_path: record.export_path,
        legacy_plan_path: record.legacy.plan_path,
        receipt_id: record.acm.receipt_id,
        plan_key: record.acm.plan_key,
        final_db_status: record.acm.final_db_status,
      });
    }
  }

  manifest.features.sort((left, right) => {
    if (left.track !== right.track) {
      return left.track.localeCompare(right.track);
    }
    return left.feature_id.localeCompare(right.feature_id);
  });

  writeJson(path.resolve(repoRoot, exportRoot, "index.json"), manifest);
  writeJson(path.resolve(repoRoot, mapPath), manifest);

  console.log(
    `Exported ${manifest.features.length} legacy plans to ${exportRoot} and ${mapPath}.`,
  );
}

function loadManifest(repoRoot, sourceDir, mapPath) {
  const manifestPath = path.resolve(repoRoot, mapPath);
  if (!fs.existsSync(manifestPath)) {
    fail(`Manifest not found: ${manifestPath}`);
  }
  const manifest = readJson(manifestPath);
  const sourceRoot = path.resolve(repoRoot, sourceDir);
  if (!fs.existsSync(sourceRoot)) {
    fail(`Export root not found: ${sourceRoot}`);
  }
  return { manifest, sourceRoot };
}

function validateManifest({ sourceDir, mapPath }) {
  const repoRoot = resolveRepoRoot();
  const { manifest, sourceRoot } = loadManifest(repoRoot, sourceDir, mapPath);
  const counts = {
    current: 0,
    deferred: 0,
    archived: 0,
  };

  for (const feature of manifest.features ?? []) {
    const exportPath = path.resolve(repoRoot, feature.export_path);
    if (!fs.existsSync(exportPath)) {
      fail(`Missing export file: ${feature.export_path}`);
    }
    const record = readJson(exportPath);
    if (record.feature_id !== feature.feature_id || record.track !== feature.track) {
      fail(`Export mismatch for ${feature.export_path}`);
    }
    if (record.acm?.plan_key !== feature.plan_key || record.acm?.receipt_id !== feature.receipt_id) {
      fail(`ACM key mismatch for ${feature.export_path}`);
    }
    counts[feature.track] += 1;
  }

  for (const track of TRACKS) {
    const manifestCount = Number(manifest?.counts_by_track?.[track] ?? 0);
    if (manifestCount !== counts[track]) {
      fail(`Manifest count mismatch for ${track}: manifest=${manifestCount}, files=${counts[track]}`);
    }
  }

  const indexPath = path.resolve(sourceRoot, "index.json");
  if (!fs.existsSync(indexPath)) {
    fail(`Missing export index: ${indexPath}`);
  }

  console.log(
    `Validated ${manifest.features.length} exported legacy plans from ${sourceDir}.`,
  );
}

function quoteSql(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function finalizeCompletedPlanSqlite(repoRoot, projectId, planKey) {
  const sqlitePath = process.env.ACM_SQLITE_PATH
    ? path.resolve(repoRoot, process.env.ACM_SQLITE_PATH)
    : path.resolve(repoRoot, ".acm/context.db");
  if (!fs.existsSync(sqlitePath)) {
    fail(`ACM SQLite database not found: ${sqlitePath}`);
  }

  const sql = [
    `UPDATE acm_work_plans SET status = 'completed' WHERE project_id = ${quoteSql(projectId)} AND plan_key = ${quoteSql(planKey)};`,
    `UPDATE acm_work_plan_tasks SET status = 'completed' WHERE project_id = ${quoteSql(projectId)} AND plan_key = ${quoteSql(planKey)};`,
  ].join(" ");

  runChecked("sqlite3", [sqlitePath, sql], repoRoot);
}

function seedReceiptSqlite(repoRoot, projectId, record) {
  const sqlitePath = process.env.ACM_SQLITE_PATH
    ? path.resolve(repoRoot, process.env.ACM_SQLITE_PATH)
    : path.resolve(repoRoot, ".acm/context.db");
  if (!fs.existsSync(sqlitePath)) {
    fail(`ACM SQLite database not found: ${sqlitePath}`);
  }

  const pointerKeys = JSON.stringify([`${projectId}:${record.export_path}`]);
  const resolvedTags = JSON.stringify(["plans", "migration", record.track]);
  const summary = JSON.stringify({
    imported_legacy_plan: true,
    export_path: record.export_path,
    feature_id: record.feature_id,
    track: record.track,
  });
  const taskText = `Import legacy ${record.track} plan ${record.feature_id}`;

  const sql = `
INSERT INTO acm_receipts (
  receipt_id,
  project_id,
  task_text,
  phase,
  resolved_tags_json,
  pointer_keys_json,
  memory_ids_json,
  summary_json
)
VALUES (
  ${quoteSql(record.acm.receipt_id)},
  ${quoteSql(projectId)},
  ${quoteSql(taskText)},
  'execute',
  ${quoteSql(resolvedTags)},
  ${quoteSql(pointerKeys)},
  '[]',
  ${quoteSql(summary)}
)
ON CONFLICT(receipt_id) DO UPDATE SET
  project_id = excluded.project_id,
  task_text = excluded.task_text,
  phase = excluded.phase,
  resolved_tags_json = excluded.resolved_tags_json,
  pointer_keys_json = excluded.pointer_keys_json,
  memory_ids_json = excluded.memory_ids_json,
  summary_json = excluded.summary_json;
`;

  runChecked("sqlite3", [sqlitePath, sql], repoRoot);
}

function importPlans({ projectId, sourceDir, mapPath, tracks }) {
  const repoRoot = resolveRepoRoot();
  const { manifest } = loadManifest(repoRoot, sourceDir, mapPath);
  const selected = new Set(tracks);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "soundspan-acm-legacy-plans-"));

  try {
    for (const feature of manifest.features ?? []) {
      if (!selected.has(feature.track)) {
        continue;
      }
      const exportPath = path.resolve(repoRoot, feature.export_path);
      const record = readJson(exportPath);
      const planFile = path.join(tempRoot, `${record.feature_id}.plan.json`);
      const tasksFile = path.join(tempRoot, `${record.feature_id}.tasks.json`);
      writeJson(planFile, record.acm.plan);
      writeJson(tasksFile, record.acm.tasks);

      if (process.env.ACM_PG_DSN) {
        fail("Legacy plan import currently expects SQLite-backed ACM storage. Unset ACM_PG_DSN or extend the importer.");
      }
      seedReceiptSqlite(repoRoot, projectId, record);

      runChecked(
        "acm",
        [
          "work",
          "--project",
          projectId,
          "--receipt-id",
          record.acm.receipt_id,
          "--mode",
          "replace",
          "--plan-file",
          planFile,
          "--tasks-file",
          tasksFile,
        ],
        repoRoot,
      );

      if (record.acm.final_db_status === "completed") {
        finalizeCompletedPlanSqlite(repoRoot, projectId, record.acm.plan_key);
      }
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(`Imported legacy plans into ACM for project ${projectId}.`);
}

function printUsage() {
  console.log(`Usage:
  node scripts/acm-legacy-plans.mjs export [--legacyRoot .agents/plans] [--source acm-legacy-plans] [--map ACM_LEGACY_PLAN_MAP.json] [--tracks current,deferred,archived]
  node scripts/acm-legacy-plans.mjs import [--project soundspan] [--source acm-legacy-plans] [--map ACM_LEGACY_PLAN_MAP.json] [--tracks current,deferred,archived]
  node scripts/acm-legacy-plans.mjs validate [--source acm-legacy-plans] [--map ACM_LEGACY_PLAN_MAP.json]
`);
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const tracks = normalizeTrackList(options.tracks);

  switch (command) {
    case "export":
      exportPlans({
        legacyRoot: options.legacyRoot,
        exportRoot: options.source,
        mapPath: options.map,
        tracks,
      });
      return;
    case "import":
      importPlans({
        projectId: options.project,
        sourceDir: options.source,
        mapPath: options.map,
        tracks,
      });
      return;
    case "validate":
      validateManifest({
        sourceDir: options.source,
        mapPath: options.map,
      });
      return;
    default:
      printUsage();
      if (command !== "help") {
        process.exitCode = 1;
      }
  }
}

main();
