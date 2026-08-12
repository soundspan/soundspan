#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MAX_DOCUMENTS = 128;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_LINES = 65_536;
const MAX_SCRIPT_LINES = 32;
const POSTGRES_KEYS = ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"];

function fail(message) {
    throw new Error(message);
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readManifest(manifestFile) {
    const manifest = readFileSync(manifestFile, "utf8");
    if (manifest.length === 0) fail("rendered manifest is empty");
    if (Buffer.byteLength(manifest) > MAX_MANIFEST_BYTES) {
        fail("rendered manifest exceeds size limit");
    }
    return manifest;
}

function findDeployment(manifest, deploymentName) {
    const documents = manifest.split(/^---\s*$/m);
    if (documents.length > MAX_DOCUMENTS) fail("render has too many documents");
    for (let index = 0; index < MAX_DOCUMENTS; index += 1) {
        if (index >= documents.length) break;
        const document = documents[index];
        if (!/^kind:\s*Deployment\s*$/m.test(document)) continue;
        const name = document.match(
            /^metadata:\s*\n  name:\s*([^\s]+)\s*$/m,
        )?.[1];
        if (name === deploymentName) return document;
    }
    fail(`Deployment ${deploymentName} is missing`);
}

function extractEnvScalar(document, key) {
    const escapedKey = escapeRegExp(key);
    const match = document.match(
        new RegExp(
            `^\\s*- name: ${escapedKey}\\s*\\n\\s+value: ("(?:\\\\.|[^"\\\\])*")\\s*$`,
            "m",
        ),
    );
    if (match === null) fail(`${key} scalar env value is missing`);
    return JSON.parse(match[1]);
}

function assertPostgresSecretRefs(document) {
    for (let index = 0; index < 3; index += 1) {
        const key = POSTGRES_KEYS[index];
        const pattern = new RegExp(
            `^\\s*- name: ${key}\\s*\\n\\s+valueFrom:\\s*\\n\\s+secretKeyRef:`,
            "m",
        );
        if (!pattern.test(document)) fail(`${key} secretKeyRef is missing`);
    }
}

function extractStartupScript(document) {
    const lines = document.split("\n");
    if (lines.length > MAX_MANIFEST_LINES)
        fail("Deployment has too many lines");
    let start = -1;
    const collected = [];
    for (let index = 0; index < MAX_MANIFEST_LINES; index += 1) {
        if (index >= lines.length) break;
        if (lines[index].trim() === "# soundspan-database-url-start") {
            start = index;
            break;
        }
    }
    if (start < 0) fail("DATABASE_URL startup builder is missing");
    const indentation = lines[start].match(/^\s*/)?.[0].length ?? 0;
    for (let offset = 0; offset < MAX_SCRIPT_LINES; offset += 1) {
        const line = lines[start + offset];
        if (line === undefined) break;
        collected.push(line.slice(indentation));
        if (line.trim() === 'exec "$@"') return collected.join("\n");
    }
    fail("DATABASE_URL startup builder is incomplete or too long");
}

function expectedComponentUrl(env, host, port) {
    for (let index = 0; index < 3; index += 1) {
        const key = POSTGRES_KEYS[index];
        if (env[key] === undefined || env[key] === "")
            fail(`${key} is required`);
    }
    return (
        `postgresql://${encodeURIComponent(env.POSTGRES_USER)}:` +
        `${encodeURIComponent(env.POSTGRES_PASSWORD)}@${host}:${port}/` +
        env.POSTGRES_DB
    );
}

function executeStartupScript(script, env) {
    try {
        return execFileSync(
            "/bin/sh",
            [
                "-c",
                script,
                "soundspan-database-url-check",
                process.execPath,
                "-e",
                "process.stdout.write(process.env.DATABASE_URL)",
            ],
            { encoding: "utf8", env, timeout: 5_000, maxBuffer: 16_384 },
        );
    } catch {
        fail("DATABASE_URL startup builder execution failed");
    }
}

function assertComponentDeployment(manifest, deploymentName) {
    const document = findDeployment(manifest, deploymentName);
    assertPostgresSecretRefs(document);
    if (/^\s*- name: DATABASE_URL\s*$/m.test(document)) {
        fail(`${deploymentName} must construct DATABASE_URL at startup`);
    }
    const host = extractEnvScalar(document, "SOUNDSPAN_DATABASE_HOST");
    const port = extractEnvScalar(document, "SOUNDSPAN_DATABASE_PORT");
    const env = {
        ...process.env,
        SOUNDSPAN_DATABASE_HOST: host,
        SOUNDSPAN_DATABASE_PORT: port,
    };
    const actual = executeStartupScript(extractStartupScript(document), env);
    if (actual !== expectedComponentUrl(env, host, port)) {
        fail(
            `${deploymentName} did not construct a percent-encoded DATABASE_URL`,
        );
    }
}

function assertExternalDeployment(manifest, deploymentName, expectedUrl) {
    const document = findDeployment(manifest, deploymentName);
    if (/# soundspan-database-url-start/.test(document)) {
        fail(`${deploymentName} rebuilt the external DATABASE_URL`);
    }
    if (/^\s*- name: POSTGRES_(?:USER|PASSWORD|DB)\s*$/m.test(document)) {
        fail(`${deploymentName} rendered POSTGRES_* env with an external URL`);
    }
    if (extractEnvScalar(document, "DATABASE_URL") !== expectedUrl) {
        fail(`${deploymentName} changed the external DATABASE_URL`);
    }
}

function main(args) {
    if (args.length < 3 || !["component", "external"].includes(args[0])) {
        fail(
            `usage: ${process.argv[1]} {component|external} <manifest> <deployment>...`,
        );
    }
    const [mode, manifestFile, ...deploymentNames] = args;
    const manifest = readManifest(manifestFile);
    if (mode === "component") {
        for (let index = 0; index < MAX_DOCUMENTS; index += 1) {
            if (index >= deploymentNames.length) return;
            assertComponentDeployment(manifest, deploymentNames[index]);
        }
        fail("too many component deployments");
    }
    const expectedUrl = process.env.EXPECTED_DATABASE_URL;
    if (expectedUrl === undefined) fail("EXPECTED_DATABASE_URL is required");
    for (let index = 0; index < MAX_DOCUMENTS; index += 1) {
        if (index >= deploymentNames.length) return;
        assertExternalDeployment(manifest, deploymentNames[index], expectedUrl);
    }
    fail("too many external deployments");
}

try {
    main(process.argv.slice(2));
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 255;
}
