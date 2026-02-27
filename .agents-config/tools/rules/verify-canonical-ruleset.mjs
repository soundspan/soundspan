#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_POLICY_FILE = ".agents-config/policies/agent-governance.json";
const DEFAULT_RULES_FILE = ".agents-config/docs/AGENT_RULES.md";
const DEFAULT_CANONICAL_FILE = ".agents-config/contracts/rules/canonical-ruleset.json";
const DEFAULT_OVERRIDES_SCHEMA_FILE = ".agents-config/agent-overrides/rule-overrides.schema.json";
const DEFAULT_OVERRIDES_FILE = ".agents-config/agent-overrides/rule-overrides.json";
const CATEGORY_VALUES = new Set([
  "governance",
  "execution",
  "orchestration",
  "quality",
  "release",
  "logging",
  ".agents-config/docs",
]);
const SEVERITY_VALUES = new Set(["error", "warn"]);
const ADJUSTED_SEVERITY_VALUES = new Set(["error", "warn", "disabled"]);
const OVERRIDEABLE_RULE_IDS = new Set([
  "rule_tdd_default",
  "rule_coverage_default_100",
  "rule_feature_index_required",
  "rule_test_matrix_required",
  "rule_route_map_required",
  "rule_domain_readmes_required",
  "rule_jsdoc_coverage_required",
  "rule_logging_contract_required",
  "orch_default_cli_routing",
  "orch_codex_model_default",
]);

function toNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizePath(input) {
  return input.split(path.sep).join("/");
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

function parseArgs(argv) {
  const args = {
    mode: "check",
    policyFile: DEFAULT_POLICY_FILE,
    rulesFile: DEFAULT_RULES_FILE,
    canonicalFile: DEFAULT_CANONICAL_FILE,
    overridesSchemaFile: DEFAULT_OVERRIDES_SCHEMA_FILE,
    overridesFile: DEFAULT_OVERRIDES_FILE,
    quiet: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--check") {
      args.mode = "check";
      continue;
    }
    if (token === "--write") {
      args.mode = "write";
      continue;
    }
    if (token === "--quiet") {
      args.quiet = true;
      continue;
    }
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    index += 1;

    switch (key) {
      case "policy":
        args.policyFile = value;
        break;
      case "rules":
        args.rulesFile = value;
        break;
      case "canonical":
        args.canonicalFile = value;
        break;
      case "overrides-schema":
        args.overridesSchemaFile = value;
        break;
      case "overrides":
        args.overridesFile = value;
        break;
      default:
        throw new Error(`Unknown option: --${key}`);
    }
  }

  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readJson(filePath);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseRuleCatalogStatements(rulesMarkdown) {
  const lines = rulesMarkdown.split(/\r?\n/);
  let inCatalog = false;
  const statementsById = new Map();

  for (const line of lines) {
    if (!inCatalog) {
      if (line.trim() === "## Rule ID Catalog (Machine Cross-Reference)") {
        inCatalog = true;
      }
      continue;
    }

    if (line.startsWith("## ")) {
      break;
    }

    const match = line.match(/^\s*-\s*`([^`]+)`:\s*(.+)\s*$/);
    if (!match) {
      continue;
    }

    const id = toNonEmptyString(match[1]);
    const statement = toNonEmptyString(match[2]);
    if (!id || !statement) {
      continue;
    }
    statementsById.set(id, statement);
  }

  return statementsById;
}

function inferCategory(ruleId) {
  if (ruleId.startsWith("orch_")) {
    return "orchestration";
  }
  if (ruleId.startsWith("rule_release_notes_")) {
    return "release";
  }
  if (ruleId.startsWith("rule_logging_")) {
    return "logging";
  }
  if (
    ruleId.startsWith("rule_feature_index_") ||
    ruleId.startsWith("rule_test_matrix_") ||
    ruleId.startsWith("rule_route_map_") ||
    ruleId.startsWith("rule_domain_readmes_") ||
    ruleId.startsWith("rule_jsdoc_coverage_") ||
    ruleId.startsWith("rule_context_index_")
  ) {
    return ".agents-config/docs";
  }
  if (
    ruleId.startsWith("rule_queue_") ||
    ruleId.startsWith("rule_execution_queue_") ||
    ruleId.startsWith("rule_startup_") ||
    ruleId.startsWith("rule_worktree_") ||
    ruleId.startsWith("rule_agents_")
  ) {
    return "execution";
  }
  if (
    ruleId.startsWith("rule_tdd_") ||
    ruleId.startsWith("rule_coverage_") ||
    ruleId.startsWith("rule_scope_completeness_")
  ) {
    return "quality";
  }
  return "governance";
}

function normalizeArrayOfStrings(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const out = [];
  for (const entry of value) {
    const text = toNonEmptyString(entry);
    if (text) {
      out.push(text);
    }
  }
  return out;
}

function buildExpectedCanonical({
  policy,
  ruleCatalogStatements,
  canonicalBaseline,
}) {
  const errors = [];
  const warnings = [];

  const requiredIds = normalizeArrayOfStrings(policy?.contracts?.ruleCatalog?.requiredIds);
  if (requiredIds.length === 0) {
    errors.push("Policy contract contracts.ruleCatalog.requiredIds is missing or empty.");
  }

  const orchestratorRulesRaw = Array.isArray(policy?.contracts?.orchestratorSubagent?.rules)
    ? policy.contracts.orchestratorSubagent.rules
    : [];
  const orchestratorRuleById = new Map();
  for (const entry of orchestratorRulesRaw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const id = toNonEmptyString(entry.id);
    const statement = toNonEmptyString(entry.statement);
    if (!id || !statement) {
      continue;
    }
    orchestratorRuleById.set(id, statement);
  }

  const rules = [];
  for (const id of requiredIds) {
    const statementFromPolicy = orchestratorRuleById.get(id);
    const statementFromDocs = ruleCatalogStatements.get(id);
    const statement =
      statementFromPolicy ??
      statementFromDocs ??
      `Canonical rule ${id} must be preserved in policy and docs.`;

    if (!statementFromPolicy && !statementFromDocs) {
      warnings.push(`No canonical statement source found for ${id}; using fallback statement.`);
    }

    rules.push({
      id,
      statement,
      category: inferCategory(id),
      severity: "error",
      overrideable: OVERRIDEABLE_RULE_IDS.has(id),
      source: statementFromPolicy
        ? "policy.orchestratorSubagent.rules"
        : statementFromDocs
          ? "docs.ruleCatalog"
          : "policy.ruleCatalog.requiredIds",
    });
  }

  const policyRequiredIdsHash = sha256(JSON.stringify(requiredIds));
  const policyOrchestratorRulesHash = sha256(
    JSON.stringify(
      orchestratorRulesRaw
        .map((entry) =>
          entry && typeof entry === "object"
            ? {
              id: toNonEmptyString(entry.id),
              statement: toNonEmptyString(entry.statement),
            }
            : null,
        )
        .filter(Boolean),
    ),
  );
  const docCatalogHash = sha256(
    JSON.stringify(
      [...ruleCatalogStatements.entries()]
        .map(([id, statement]) => ({ id, statement }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ),
  );
  const canonicalRulesHash = sha256(JSON.stringify(rules));

  const existingMetadata = canonicalBaseline?.metadata ?? {};
  const metadata = {
    id: toNonEmptyString(existingMetadata.id) ?? "canonical-ruleset",
    version:
      toNonEmptyString(policy?.metadata?.version) ??
      toNonEmptyString(existingMetadata.version) ??
      "1.0.0",
    description:
      toNonEmptyString(existingMetadata.description) ??
      "Canonical governance rule catalog used for policy and drift checks.",
    generated_from: [DEFAULT_POLICY_FILE, DEFAULT_RULES_FILE],
    lineage: {
      policy_required_ids_sha256: policyRequiredIdsHash,
      policy_orchestrator_rules_sha256: policyOrchestratorRulesHash,
      rules_doc_catalog_sha256: docCatalogHash,
      canonical_rules_sha256: canonicalRulesHash,
    },
  };

  return {
    expectedCanonical: {
      metadata,
      rules,
    },
    requiredIds,
    errors,
    warnings,
  };
}

function validateCanonicalRules({
  canonical,
  expectedCanonical,
  requiredIds,
}) {
  const errors = [];
  const warnings = [];

  if (!canonical || typeof canonical !== "object") {
    errors.push("Canonical ruleset must be a JSON object.");
    return { errors, warnings };
  }

  const metadata = canonical.metadata;
  if (!metadata || typeof metadata !== "object") {
    errors.push("Canonical ruleset metadata must be an object.");
  } else {
    if (!toNonEmptyString(metadata.id)) {
      errors.push("canonical.metadata.id must be a non-empty string.");
    }
    if (!toNonEmptyString(metadata.version)) {
      errors.push("canonical.metadata.version must be a non-empty string.");
    }
    if (!toNonEmptyString(metadata.description)) {
      errors.push("canonical.metadata.description must be a non-empty string.");
    }
    const generatedFrom = normalizeArrayOfStrings(metadata.generated_from);
    for (const requiredSource of [DEFAULT_POLICY_FILE, DEFAULT_RULES_FILE]) {
      if (!generatedFrom.includes(requiredSource)) {
        errors.push(`canonical.metadata.generated_from must include ${requiredSource}.`);
      }
    }
    const lineage = metadata.lineage;
    if (!lineage || typeof lineage !== "object") {
      errors.push("canonical.metadata.lineage must be an object.");
    } else {
      for (const fieldName of [
        "policy_required_ids_sha256",
        "policy_orchestrator_rules_sha256",
        "rules_doc_catalog_sha256",
        "canonical_rules_sha256",
      ]) {
        if (!toNonEmptyString(lineage[fieldName])) {
          errors.push(`canonical.metadata.lineage.${fieldName} must be a non-empty string.`);
        }
      }
    }
  }

  if (!Array.isArray(canonical.rules)) {
    errors.push("canonical.rules must be an array.");
    return { errors, warnings };
  }

  const expectedRuleById = new Map(
    expectedCanonical.rules.map((rule) => [rule.id, rule]),
  );
  const canonicalRuleById = new Map();

  for (let index = 0; index < canonical.rules.length; index += 1) {
    const entry = canonical.rules[index];
    const prefix = `canonical.rules[${index}]`;
    if (!entry || typeof entry !== "object") {
      errors.push(`${prefix} must be an object.`);
      continue;
    }

    const id = toNonEmptyString(entry.id);
    if (!id) {
      errors.push(`${prefix}.id must be a non-empty string.`);
      continue;
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
      errors.push(`${prefix}.id has invalid format: ${id}`);
    }
    if (canonicalRuleById.has(id)) {
      errors.push(`canonical.rules has duplicate id: ${id}`);
      continue;
    }
    canonicalRuleById.set(id, entry);

    if (!toNonEmptyString(entry.statement)) {
      errors.push(`${prefix}.statement must be a non-empty string.`);
    }
    if (!CATEGORY_VALUES.has(toNonEmptyString(entry.category) ?? "")) {
      errors.push(`${prefix}.category must be one of: ${[...CATEGORY_VALUES].join(", ")}`);
    }
    if (!SEVERITY_VALUES.has(toNonEmptyString(entry.severity) ?? "")) {
      errors.push(`${prefix}.severity must be one of: ${[...SEVERITY_VALUES].join(", ")}`);
    }
    if (typeof entry.overrideable !== "boolean") {
      errors.push(`${prefix}.overrideable must be a boolean.`);
    }
    if (!toNonEmptyString(entry.source)) {
      errors.push(`${prefix}.source must be a non-empty string.`);
    }
  }

  for (const id of requiredIds) {
    if (!canonicalRuleById.has(id)) {
      errors.push(`canonical.rules must include required policy rule id: ${id}`);
    }
  }

  for (const id of canonicalRuleById.keys()) {
    if (!expectedRuleById.has(id)) {
      errors.push(`canonical.rules includes unknown id not declared in policy requiredIds: ${id}`);
    }
  }

  for (const [id, expected] of expectedRuleById.entries()) {
    const actual = canonicalRuleById.get(id);
    if (!actual) {
      continue;
    }
    for (const fieldName of ["statement", "category", "severity", "overrideable", "source"]) {
      if (actual[fieldName] !== expected[fieldName]) {
        errors.push(
          `canonical.rules entry ${id} field ${fieldName} drifted (expected ${JSON.stringify(expected[fieldName])}, found ${JSON.stringify(actual[fieldName])}).`,
        );
      }
    }
  }

  const expectedLineage = expectedCanonical.metadata.lineage;
  const actualLineage = canonical?.metadata?.lineage;
  if (!actualLineage || typeof actualLineage !== "object") {
    errors.push("canonical.metadata.lineage must be present and valid.");
  } else {
    for (const [key, expectedValue] of Object.entries(expectedLineage)) {
      const actualValue = toNonEmptyString(actualLineage[key]);
      if (actualValue !== expectedValue) {
        errors.push(
          `canonical.metadata.lineage.${key} drifted (expected ${expectedValue}, found ${actualValue ?? "<missing>"}).`,
        );
      }
    }
  }

  if (canonical.rules.length !== expectedCanonical.rules.length) {
    warnings.push(
      `canonical.rules length ${canonical.rules.length} differs from expected ${expectedCanonical.rules.length}.`,
    );
  }

  return { errors, warnings };
}

function validateOverrideSchema(schema) {
  const errors = [];

  if (!schema || typeof schema !== "object") {
    errors.push("Override schema file must contain a JSON object.");
    return errors;
  }
  if (toNonEmptyString(schema.$schema) === null) {
    errors.push("Override schema must declare a non-empty $schema.");
  }
  if (schema.type !== "object") {
    errors.push("Override schema root type must be object.");
  }
  if (!schema.properties || typeof schema.properties !== "object") {
    errors.push("Override schema must define properties.");
    return errors;
  }
  const overridesProperty = schema.properties.overrides;
  if (!overridesProperty || typeof overridesProperty !== "object") {
    errors.push("Override schema must define properties.overrides.");
    return errors;
  }
  if (overridesProperty.type !== "array") {
    errors.push("Override schema properties.overrides.type must equal array.");
  }
  if (!overridesProperty.items || typeof overridesProperty.items !== "object") {
    errors.push("Override schema properties.overrides.items must be an object.");
    return errors;
  }
  const required = normalizeArrayOfStrings(overridesProperty.items.required);
  for (const fieldName of ["id", "extends", "reason", "owner", "created_at"]) {
    if (!required.includes(fieldName)) {
      errors.push(
        `Override schema properties.overrides.items.required must include ${fieldName}.`,
      );
    }
  }

  return errors;
}

function isValidIsoDate(value) {
  return toNonEmptyString(value) !== null && Number.isFinite(Date.parse(value));
}

function validateOverridesFile({
  overrides,
  canonicalRuleById,
  overridesFile,
}) {
  const errors = [];
  const warnings = [];

  if (!overrides || typeof overrides !== "object") {
    errors.push(`${overridesFile} must contain a JSON object.`);
    return { errors, warnings };
  }

  const entries = Array.isArray(overrides.overrides) ? overrides.overrides : null;
  if (!entries) {
    errors.push(`${overridesFile}.overrides must be an array.`);
    return { errors, warnings };
  }

  const seenOverrideIds = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const prefix = `${overridesFile}.overrides[${index}]`;
    if (!entry || typeof entry !== "object") {
      errors.push(`${prefix} must be an object.`);
      continue;
    }

    const id = toNonEmptyString(entry.id);
    const extendsId = toNonEmptyString(entry.extends);
    const reason = toNonEmptyString(entry.reason);
    const owner = toNonEmptyString(entry.owner);
    const createdAt = toNonEmptyString(entry.created_at);
    const expiresAt = toNonEmptyString(entry.expires_at);

    if (!id) {
      errors.push(`${prefix}.id must be a non-empty string.`);
      continue;
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
      errors.push(`${prefix}.id has invalid format: ${id}`);
    }
    if (seenOverrideIds.has(id)) {
      errors.push(`${overridesFile} has duplicate local override id: ${id}`);
    }
    seenOverrideIds.add(id);

    if (canonicalRuleById.has(id)) {
      errors.push(`${prefix}.id must be local-only and must not collide with canonical rule id ${id}.`);
    }

    if (!extendsId) {
      errors.push(`${prefix}.extends must be a non-empty string.`);
      continue;
    }
    const canonicalRule = canonicalRuleById.get(extendsId);
    if (!canonicalRule) {
      errors.push(`${prefix}.extends references unknown canonical rule id ${extendsId}.`);
      continue;
    }
    if (canonicalRule.overrideable !== true) {
      errors.push(`${prefix}.extends references non-overrideable canonical rule ${extendsId}.`);
    }

    if (!reason || reason.length < 8) {
      errors.push(`${prefix}.reason must be at least 8 characters.`);
    }
    if (!owner || owner.length < 2) {
      errors.push(`${prefix}.owner must be at least 2 characters.`);
    }
    if (!createdAt || !isValidIsoDate(createdAt)) {
      errors.push(`${prefix}.created_at must be a valid ISO timestamp.`);
    }
    if (expiresAt && !isValidIsoDate(expiresAt)) {
      errors.push(`${prefix}.expires_at must be a valid ISO timestamp when present.`);
    }
    if (createdAt && expiresAt && isValidIsoDate(createdAt) && isValidIsoDate(expiresAt)) {
      if (Date.parse(expiresAt) < Date.parse(createdAt)) {
        errors.push(`${prefix}.expires_at must be >= created_at.`);
      }
    }
    if (expiresAt && isValidIsoDate(expiresAt) && Date.parse(expiresAt) < Date.now()) {
      errors.push(
        `${prefix}.expires_at is in the past. Remove or extend the override before running verification.`,
      );
    }

    if ("adjustments" in entry) {
      if (
        !entry.adjustments ||
        typeof entry.adjustments !== "object" ||
        Array.isArray(entry.adjustments)
      ) {
        errors.push(`${prefix}.adjustments must be an object when present.`);
      } else {
        const severity = toNonEmptyString(entry.adjustments.severity);
        if (severity && !ADJUSTED_SEVERITY_VALUES.has(severity)) {
          errors.push(
            `${prefix}.adjustments.severity must be one of ${[...ADJUSTED_SEVERITY_VALUES].join(", ")}.`,
          );
        }
      }
    }
  }

  if (entries.length === 0) {
    warnings.push(`${overridesFile} has no override entries.`);
  }

  return { errors, warnings };
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function verifyCanonicalRuleset({
  repoRoot = resolveRepoRoot(),
  policyFile = DEFAULT_POLICY_FILE,
  rulesFile = DEFAULT_RULES_FILE,
  canonicalFile = DEFAULT_CANONICAL_FILE,
  overridesSchemaFile = DEFAULT_OVERRIDES_SCHEMA_FILE,
  overridesFile = DEFAULT_OVERRIDES_FILE,
  mode = "check",
} = {}) {
  const errors = [];
  const warnings = [];
  const absolutePolicyFile = path.resolve(repoRoot, policyFile);
  const absoluteRulesFile = path.resolve(repoRoot, rulesFile);
  const absoluteCanonicalFile = path.resolve(repoRoot, canonicalFile);
  const absoluteOverridesSchemaFile = path.resolve(repoRoot, overridesSchemaFile);
  const absoluteOverridesFile = path.resolve(repoRoot, overridesFile);

  if (!fs.existsSync(absolutePolicyFile)) {
    errors.push(`Missing policy file: ${policyFile}`);
  }
  if (!fs.existsSync(absoluteRulesFile)) {
    errors.push(`Missing rules file: ${rulesFile}`);
  }
  if (!fs.existsSync(absoluteOverridesSchemaFile)) {
    errors.push(`Missing override schema file: ${overridesSchemaFile}`);
  }

  if (errors.length > 0) {
    return {
      ok: false,
      mode,
      errors,
      warnings,
      paths: {
        policyFile,
        rulesFile,
        canonicalFile,
        overridesSchemaFile,
        overridesFile,
      },
    };
  }

  const policy = readJson(absolutePolicyFile);
  const rulesMarkdown = fs.readFileSync(absoluteRulesFile, "utf8");
  const ruleCatalogStatements = parseRuleCatalogStatements(rulesMarkdown);
  const canonicalBaseline = readJsonIfPresent(absoluteCanonicalFile);

  const expectedResult = buildExpectedCanonical({
    policy,
    ruleCatalogStatements,
    canonicalBaseline,
  });
  errors.push(...expectedResult.errors);
  warnings.push(...expectedResult.warnings);

  const expectedCanonical = expectedResult.expectedCanonical;
  const requiredIds = expectedResult.requiredIds;
  let canonical = canonicalBaseline;

  if (mode === "write") {
    ensureParentDir(absoluteCanonicalFile);
    fs.writeFileSync(
      absoluteCanonicalFile,
      `${JSON.stringify(expectedCanonical, null, 2)}\n`,
      "utf8",
    );
    canonical = readJson(absoluteCanonicalFile);
  } else if (!canonical) {
    errors.push(`Missing canonical ruleset file: ${canonicalFile}`);
  }

  if (canonical) {
    const canonicalValidation = validateCanonicalRules({
      canonical,
      expectedCanonical,
      requiredIds,
    });
    errors.push(...canonicalValidation.errors);
    warnings.push(...canonicalValidation.warnings);
  }

  const overrideSchema = readJson(absoluteOverridesSchemaFile);
  errors.push(...validateOverrideSchema(overrideSchema));

  if (canonical) {
    const canonicalRuleById = new Map(
      (Array.isArray(canonical.rules) ? canonical.rules : [])
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => [toNonEmptyString(entry.id), entry])
        .filter(([id]) => Boolean(id)),
    );

    const overrides = readJsonIfPresent(absoluteOverridesFile);
    if (overrides) {
      const overrideValidation = validateOverridesFile({
        overrides,
        canonicalRuleById,
        overridesFile,
      });
      errors.push(...overrideValidation.errors);
      warnings.push(...overrideValidation.warnings);
    }
  }

  return {
    ok: errors.length === 0,
    mode,
    errors,
    warnings,
    generated: mode === "write",
    paths: {
      policyFile: normalizePath(path.relative(repoRoot, absolutePolicyFile)),
      rulesFile: normalizePath(path.relative(repoRoot, absoluteRulesFile)),
      canonicalFile: normalizePath(path.relative(repoRoot, absoluteCanonicalFile)),
      overridesSchemaFile: normalizePath(path.relative(repoRoot, absoluteOverridesSchemaFile)),
      overridesFile: normalizePath(path.relative(repoRoot, absoluteOverridesFile)),
    },
    counts: {
      requiredRuleIds: requiredIds.length,
      ruleCatalogStatements: ruleCatalogStatements.size,
    },
  };
}

function printResult(result, { json = false, quiet = false } = {}) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const prefix = result.ok ? "[PASS]" : "[FAIL]";
  console.log(
    `${prefix} canonical ruleset verification (${result.mode}) :: ${result.paths.canonicalFile}`,
  );
  if (result.generated) {
    console.log(`Wrote canonical ruleset: ${result.paths.canonicalFile}`);
  }
  if (!quiet) {
    console.log(
      `Required rule IDs: ${result.counts.requiredRuleIds}, documented catalog statements: ${result.counts.ruleCatalogStatements}`,
    );
  }
  for (const warning of result.warnings) {
    console.log(`[WARN] ${warning}`);
  }
  for (const error of result.errors) {
    console.log(`[ERROR] ${error}`);
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[ERROR] ${error.message}`);
    process.exit(1);
    return;
  }

  const repoRoot = resolveRepoRoot();
  const result = verifyCanonicalRuleset({
    repoRoot,
    policyFile: args.policyFile,
    rulesFile: args.rulesFile,
    canonicalFile: args.canonicalFile,
    overridesSchemaFile: args.overridesSchemaFile,
    overridesFile: args.overridesFile,
    mode: args.mode,
  });
  printResult(result, { json: args.json, quiet: args.quiet });
  process.exit(result.ok ? 0 : 1);
}

const isCliEntry =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isCliEntry) {
  main();
}
