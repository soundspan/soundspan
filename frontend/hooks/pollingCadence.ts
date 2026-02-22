interface AdaptivePollingIntervalOptions {
    enabled: boolean;
    hasActiveItems: boolean;
    activeIntervalMs: number;
    idleIntervalMs: number;
}

/**
 * Normalizes optional polling enable flags to the default-enabled contract.
 */
export function resolvePollingEnabled(enabled?: boolean): boolean {
    return enabled ?? true;
}

/**
 * Resolves a fixed polling interval, returning false when polling is disabled.
 */
export function resolveFixedPollingInterval(
    enabled: boolean,
    intervalMs: number
): number | false {
    return enabled ? intervalMs : false;
}

/**
 * Resolves adaptive polling intervals, switching between active/idle cadences.
 */
export function resolveAdaptivePollingInterval(
    options: AdaptivePollingIntervalOptions
): number | false {
    if (!options.enabled) {
        return false;
    }

    return options.hasActiveItems
        ? options.activeIntervalMs
        : options.idleIntervalMs;
}
