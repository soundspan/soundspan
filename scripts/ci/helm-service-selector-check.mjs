#!/usr/bin/env node

import { readFileSync } from "node:fs";

const MAX_DOCUMENTS = 128;
const MAX_LABELS = 64;
const MAX_RESOURCES = 64;

function fail(message) {
    throw new Error(message);
}

function parseLabels(block, indent) {
    if (block === undefined) fail("label block is undefined");
    if (![4, 6, 8].includes(indent)) fail("label indentation is invalid");

    const labels = new Map();
    const pattern = new RegExp(
        `^ {${indent}}([A-Za-z0-9][A-Za-z0-9_./-]*):\\s*["']?([^"'\\s]+)["']?\\s*$`,
        "gm",
    );
    let reachedEnd = false;
    for (let index = 0; index < MAX_LABELS; index += 1) {
        const match = pattern.exec(block);
        if (match === null) {
            reachedEnd = true;
            break;
        }
        labels.set(match[1], match[2]);
    }
    if (!reachedEnd && pattern.exec(block) !== null) {
        fail(`label map exceeds ${MAX_LABELS} entries`);
    }
    if (labels.size === 0) fail("label map is empty");
    return labels;
}

function selectorMatches(selector, labels) {
    if (selector === undefined) fail("selector is undefined");
    if (labels === undefined) fail("pod labels are undefined");

    const keys = [...selector.keys()];
    if (keys.length === 0) return false;
    for (let index = 0; index < MAX_LABELS; index += 1) {
        if (index >= keys.length) return true;
        const key = keys[index];
        if (!labels.has(key) || labels.get(key) !== selector.get(key)) {
            return false;
        }
    }
    fail(`service selector exceeds ${MAX_LABELS} entries`);
}

function parseDocument(document) {
    if (document === undefined) fail("YAML document is undefined");
    if (typeof document !== "string") fail("YAML document is not a scalar");

    const kind = document.match(/^kind:\s*(\S+)\s*$/m)?.[1];
    const name = document.match(
        /^metadata:\s*\n  name:\s*["']?([^"'\s]+)["']?\s*$/m,
    )?.[1];
    if (kind === undefined || name === undefined) return undefined;
    if (kind === "Service") return parseService(document, name);
    if (!/^(?:Deployment|StatefulSet|DaemonSet)$/.test(kind)) return undefined;
    return parseWorkload(document, kind, name);
}

function parseService(document, name) {
    const block = document.match(
        /^  selector:\s*\n((?:^    \S[^\n]*\n?)*)/m,
    )?.[1];
    if (block === undefined) return undefined;
    return {
        type: "service",
        resource: { name, labels: parseLabels(block, 4) },
    };
}

function parseWorkload(document, kind, name) {
    const selectorBlock = document.match(
        /^  selector:\s*\n    matchLabels:\s*\n((?:^      \S[^\n]*\n?)*)/m,
    )?.[1];
    if (selectorBlock === undefined)
        fail(`${kind} ${name} is missing matchLabels`);
    const podLabelBlock = document.match(
        /^  template:\s*\n    metadata:\s*\n      labels:\s*\n((?:^        \S[^\n]*\n?)*)/m,
    )?.[1];
    if (podLabelBlock === undefined)
        fail(`${kind} ${name} is missing pod template labels`);
    return {
        type: "workload",
        resource: {
            kind,
            name,
            labels: parseLabels(podLabelBlock, 8),
            selector: parseLabels(selectorBlock, 6),
        },
    };
}

function parseResources(yaml) {
    if (yaml === undefined) fail("rendered YAML is undefined");
    if (yaml.length === 0) fail("rendered YAML is empty");

    const documents = yaml.split(/^---\s*$/m);
    if (documents.length > MAX_DOCUMENTS) {
        fail(`render exceeds ${MAX_DOCUMENTS} YAML documents`);
    }
    const services = [];
    const workloads = [];
    for (let index = 0; index < documents.length; index += 1) {
        const parsed = parseDocument(documents[index]);
        if (parsed?.type === "service") services.push(parsed.resource);
        if (parsed?.type === "workload") workloads.push(parsed.resource);
    }
    if (services.length > MAX_RESOURCES || workloads.length > MAX_RESOURCES) {
        fail(`render exceeds ${MAX_RESOURCES} Services or workloads`);
    }
    return { services, workloads };
}

function matchingTargets(service, workloads) {
    const targets = [];
    for (let index = 0; index < workloads.length; index += 1) {
        const workload = workloads[index];
        if (
            workload.name === service.name &&
            selectorMatches(service.labels, workload.labels)
        ) {
            targets.push(workload);
        }
    }
    return targets;
}

function assertServiceIsolated(service, workloads) {
    if (service === undefined) fail("service is undefined");
    if (workloads === undefined) fail("workloads are undefined");

    const targets = matchingTargets(service, workloads);
    if (targets.length !== 1) {
        fail(
            `Service ${service.name} selector does not match its same-name workload`,
        );
    }
    const targetComponent = componentOf(targets[0]);
    for (let index = 0; index < workloads.length; index += 1) {
        assertWorkloadIsolated(service, workloads[index], targetComponent);
    }
}

function assertWorkloadSelectorMatchesPod(workload) {
    if (workload === undefined) fail("workload is undefined");
    if (selectorMatches(workload.selector, workload.labels)) return;
    fail(`${workload.kind} ${workload.name} selector does not match its pods`);
}

function componentOf(workload) {
    return workload.labels.get("app.kubernetes.io/component") ?? "<unlabeled>";
}

function assertWorkloadIsolated(service, workload, targetComponent) {
    const component = componentOf(workload);
    if (component === targetComponent) return;
    if (!selectorMatches(service.labels, workload.labels)) return;
    fail(
        `Service ${service.name} selector also matches ${workload.kind} ${workload.name} ` +
            `from component ${component} (intended component: ${targetComponent})`,
    );
}

function readManifest(manifestFile) {
    try {
        return readFileSync(manifestFile, "utf8");
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        fail(`cannot open ${manifestFile}: ${detail}`);
    }
}

function main(args) {
    if (args.length !== 1) {
        fail(`usage: ${process.argv[1]} <rendered-manifest>`);
    }
    const yaml = readManifest(args[0]);
    const { services, workloads } = parseResources(yaml);
    for (let index = 0; index < MAX_RESOURCES; index += 1) {
        if (index >= workloads.length) break;
        assertWorkloadSelectorMatchesPod(workloads[index]);
    }
    for (let index = 0; index < services.length; index += 1) {
        assertServiceIsolated(services[index], workloads);
    }
}

try {
    main(process.argv.slice(2));
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 255;
}
