import assert from "node:assert/strict";
import { test } from "node:test";

import {
    lastFmDescription,
    missingLastFmValues,
} from "../../features/settings/lastFmScrobblingCopy";

function status(overrides: {
    connected?: boolean;
    serverConfigured?: boolean;
    apiKeyConfigured?: boolean;
    sharedSecretConfigured?: boolean;
}) {
    return {
        connected: false,
        enabled: false,
        username: null,
        serverConfigured: false,
        apiKeyConfigured: false,
        sharedSecretConfigured: false,
        ...overrides,
    };
}

test("names only the shared secret when the API key is present", () => {
    assert.equal(
        missingLastFmValues(status({ apiKeyConfigured: true })),
        "LASTFM_SHARED_SECRET",
    );
});

test("names only the API key when the shared secret is present", () => {
    assert.equal(
        missingLastFmValues(status({ sharedSecretConfigured: true })),
        "LASTFM_API_KEY",
    );
});

test("names both values when neither is present", () => {
    assert.equal(
        missingLastFmValues(status({})),
        "LASTFM_API_KEY and LASTFM_SHARED_SECRET",
    );
});

test("falls back to naming both values when flags claim configured but serverConfigured is false", () => {
    assert.equal(
        missingLastFmValues(
            status({ apiKeyConfigured: true, sharedSecretConfigured: true }),
        ),
        "LASTFM_API_KEY and LASTFM_SHARED_SECRET",
    );
});

test("unconfigured and disconnected asks the admin for the missing value", () => {
    assert.equal(
        lastFmDescription(status({ apiKeyConfigured: true })),
        "Last.fm scrobbling is unavailable: this server is missing LASTFM_SHARED_SECRET. Ask your server admin to set it.",
    );
});

test("unconfigured but connected warns that scrobbling may fail", () => {
    assert.equal(
        lastFmDescription(status({ connected: true, apiKeyConfigured: true })),
        "This server is missing LASTFM_SHARED_SECRET; existing scrobbling may fail. You can still disconnect.",
    );
});

test("configured invites the user to sign in", () => {
    assert.equal(
        lastFmDescription(
            status({
                serverConfigured: true,
                apiKeyConfigured: true,
                sharedSecretConfigured: true,
            }),
        ),
        "Sign in with your Last.fm account to scrobble plays",
    );
});
