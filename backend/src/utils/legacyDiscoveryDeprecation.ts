import { config } from "../config";
import { logger } from "./logger";

const LEGACY_DISCOVERY_DEPRECATION_MESSAGE =
    "Legacy discovery mode is deprecated, no longer receives fixes, and will be removed in a future release; migrate by unsetting DISCOVERY_MODE.";

/** Warns once from a process entrypoint when deprecated discovery is enabled. */
export function warnIfLegacyDiscoveryMode(processType: "API" | "Worker"): void {
    if (config.discover.mode !== "legacy") return;
    logger.warn(
        `[${processType} Startup] ${LEGACY_DISCOVERY_DEPRECATION_MESSAGE}`,
    );
}
