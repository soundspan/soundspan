import { frontendLogger, type FrontendLogger } from "../logger";

export const TAURI_DEPRECATION_MESSAGE =
    "The Tauri desktop integration is deprecated, no longer receives fixes, and will be removed in a future release; playback continues on the standard web engines.";

let warnedTauriDeprecation = false;

/**
 * Warns once per process/session when the deprecated Tauri desktop path
 * engages (issue #607 phase 1). The single-fire guard keeps the warning
 * visible without spamming per-request or per-render call sites.
 */
export function warnTauriDeprecationOnce(
    context: string,
    logger: FrontendLogger = frontendLogger,
): void {
    if (warnedTauriDeprecation) {
        return;
    }
    warnedTauriDeprecation = true;
    logger.warn(`[TauriDeprecation] (${context}) ${TAURI_DEPRECATION_MESSAGE}`);
}

/** Resets the single-fire guard so tests can exercise the warning path. */
export function resetTauriDeprecationWarningForTests(): void {
    warnedTauriDeprecation = false;
}
