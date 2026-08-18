#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

const MINIMUM_NODE_MAJOR = 24;

/** Returns upgrade guidance when a Node.js version is unsupported. */
export function getUnsupportedNodeMessage(version) {
    if (typeof version !== "string" || version.trim() === "") {
        throw new TypeError("version must be a non-empty string");
    }

    const normalizedVersion = version.startsWith("v") ? version : `v${version}`;
    const major = Number.parseInt(normalizedVersion.slice(1).split(".")[0], 10);
    if (Number.isInteger(major) && major >= MINIMUM_NODE_MAJOR) {
        return null;
    }

    return `Component tests require Node.js 24 or newer per the root .nvmrc. Current version: ${normalizedVersion}. Run \`nvm use\` or select Node 24 with your version manager.`;
}

function main(version) {
    const message = getUnsupportedNodeMessage(version);
    if (message === null) return;

    console.error(message);
    process.exitCode = 1;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    main(process.argv[2] ?? process.versions.node);
}
