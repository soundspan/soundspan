import assert from "node:assert/strict";
import test from "node:test";
import {
    SETTINGS_BACKGROUND_RETRY_COOLDOWN_MS,
    shouldRetryFailedSettingsLoad,
    shouldShowSettingsPageLoading,
} from "../../features/settings/hooks/settingsHydration.ts";

test("shouldRetryFailedSettingsLoad only retries failed loads after cooldown", () => {
    const now = 1_000_000;

    assert.equal(shouldRetryFailedSettingsLoad(false, now, now), false);
    assert.equal(shouldRetryFailedSettingsLoad(true, 0, now), true);
    assert.equal(
        shouldRetryFailedSettingsLoad(
            true,
            now - SETTINGS_BACKGROUND_RETRY_COOLDOWN_MS + 1,
            now
        ),
        false
    );
    assert.equal(
        shouldRetryFailedSettingsLoad(
            true,
            now - SETTINGS_BACKGROUND_RETRY_COOLDOWN_MS,
            now
        ),
        true
    );
});

test("shouldShowSettingsPageLoading gates rendering until required payloads hydrate", () => {
    assert.equal(
        shouldShowSettingsPageLoading({
            authLoading: true,
            isAuthenticated: false,
            isUserSettingsLoading: false,
            isAdmin: false,
            isSystemSettingsLoading: false,
        }),
        true
    );

    assert.equal(
        shouldShowSettingsPageLoading({
            authLoading: false,
            isAuthenticated: false,
            isUserSettingsLoading: true,
            isAdmin: true,
            isSystemSettingsLoading: true,
        }),
        false
    );

    assert.equal(
        shouldShowSettingsPageLoading({
            authLoading: false,
            isAuthenticated: true,
            isUserSettingsLoading: true,
            isAdmin: false,
            isSystemSettingsLoading: false,
        }),
        true
    );

    assert.equal(
        shouldShowSettingsPageLoading({
            authLoading: false,
            isAuthenticated: true,
            isUserSettingsLoading: false,
            isAdmin: true,
            isSystemSettingsLoading: true,
        }),
        true
    );

    assert.equal(
        shouldShowSettingsPageLoading({
            authLoading: false,
            isAuthenticated: true,
            isUserSettingsLoading: false,
            isAdmin: true,
            isSystemSettingsLoading: false,
        }),
        false
    );
});
