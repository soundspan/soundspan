export const SETTINGS_BACKGROUND_RETRY_COOLDOWN_MS = 15_000;

/**
 * Determines whether a failed settings load should be retried from a
 * background visibility/focus trigger.
 */
export function shouldRetryFailedSettingsLoad(
    hasLoadError: boolean,
    lastAttemptAt: number,
    now: number = Date.now()
): boolean {
    if (!hasLoadError) return false;
    if (!Number.isFinite(lastAttemptAt) || lastAttemptAt <= 0) return true;
    return now - lastAttemptAt >= SETTINGS_BACKGROUND_RETRY_COOLDOWN_MS;
}

export interface SettingsPageLoadingInput {
    authLoading: boolean;
    isAuthenticated: boolean;
    isUserSettingsLoading: boolean;
    isAdmin: boolean;
    isSystemSettingsLoading: boolean;
}

/**
 * Keep settings surfaces in loading state until required settings payloads
 * are hydrated, preventing default-value flashes.
 */
export function shouldShowSettingsPageLoading(
    input: SettingsPageLoadingInput
): boolean {
    if (input.authLoading) return true;
    if (!input.isAuthenticated) return false;
    if (input.isUserSettingsLoading) return true;
    if (input.isAdmin && input.isSystemSettingsLoading) return true;
    return false;
}
