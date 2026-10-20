import { readFileSync } from "node:fs";
import path from "node:path";
import { safeResolvePath } from "../utils/safeResolvePath";

/** Resolve the image version from the backend package manifest. */
export function resolveAppVersion(): string {
    const backendRoot = path.resolve(__dirname, "..", "..");
    const manifestPath = safeResolvePath(backendRoot, "package.json");
    if (!manifestPath)
        throw new Error("backend package.json path escaped its root");
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        version?: unknown;
    };
    if (typeof parsed.version !== "string" || parsed.version.length === 0) {
        throw new Error("backend package.json is missing a string version");
    }
    return parsed.version;
}
