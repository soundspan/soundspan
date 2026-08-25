import { config } from "../config";
import { logger } from "./logger";

const LEGACY_DISCOVERY_DEPRECATION_MESSAGE =
    "DISCOVERY_MODE=legacy is deprecated and now serves the modern discovery implementation; unset DISCOVERY_MODE to remove this warning.";

/** Warns once from a process entrypoint when deprecated discovery is enabled. */
export function warnIfLegacyDiscoveryMode(processType: "API" | "Worker"): void {
    if (config.discover.mode !== "legacy") return;
    logger.warn(
        `[${processType} Startup] ${LEGACY_DISCOVERY_DEPRECATION_MESSAGE}`,
    );
}
