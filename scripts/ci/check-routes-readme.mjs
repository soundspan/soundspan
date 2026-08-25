#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_ROUTE_ENTRIES = 1_000;

function routeModules(directory) {
    const entries = fs.readdirSync(directory, {
        recursive: true,
        withFileTypes: true,
    });
    if (entries.length > MAX_ROUTE_ENTRIES) {
        throw new Error(`Route scan exceeded ${MAX_ROUTE_ENTRIES} entries`);
    }
    return entries
        .filter(
            (entry) =>
                entry.isFile() &&
                entry.name.endsWith(".ts") &&
                !entry.name.endsWith(".test.ts") &&
                !entry.name.endsWith(".spec.ts") &&
                !entry.parentPath.split(path.sep).includes("__tests__"),
        )
        .map((entry) => path.join(entry.parentPath, entry.name));
}

export function findMissingRouteModules(repoRoot) {
    const routesRoot = path.join(repoRoot, "backend/src/routes");
    const readme = fs.readFileSync(path.join(routesRoot, "README.md"), "utf8");
    return routeModules(routesRoot)
        .map((file) => path.relative(repoRoot, file).split(path.sep).join("/"))
        .filter((file) => !readme.includes(`\`${file}\``))
        .sort();
}

function runCli() {
    const repoRoot = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../..",
    );
    const missing = findMissingRouteModules(repoRoot);
    if (missing.length === 0) {
        console.log(
            "Routes README index passed (all route modules documented).",
        );
        return;
    }
    console.error("Routes README index failed; missing modules:");
    console.error(missing.join("\n"));
    process.exitCode = 1;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    runCli();
}
