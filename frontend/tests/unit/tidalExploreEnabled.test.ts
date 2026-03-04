/**
 * Unit tests for TIDAL explore gating logic.
 *
 * Verifies that TIDAL explore content is only enabled when
 * TIDAL streaming is enabled, available, and authenticated.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { deriveTidalExploreEnabled } from "../../features/explore/hooks/useTidalExploreEnabled";

test("tidalExploreEnabled: returns false while status is loading (isFetched=false)", () => {
    assert.equal(
        deriveTidalExploreEnabled({
            enabled: true,
            available: true,
            authenticated: true,
            isFetched: false,
        }),
        false
    );
});

test("tidalExploreEnabled: returns true when enabled + available + authenticated", () => {
    assert.equal(
        deriveTidalExploreEnabled({
            enabled: true,
            available: true,
            authenticated: true,
            isFetched: true,
        }),
        true
    );
});

test("tidalExploreEnabled: returns false when not enabled", () => {
    assert.equal(
        deriveTidalExploreEnabled({
            enabled: false,
            available: true,
            authenticated: true,
            isFetched: true,
        }),
        false
    );
});

test("tidalExploreEnabled: returns false when not available", () => {
    assert.equal(
        deriveTidalExploreEnabled({
            enabled: true,
            available: false,
            authenticated: true,
            isFetched: true,
        }),
        false
    );
});

test("tidalExploreEnabled: returns false when not authenticated", () => {
    assert.equal(
        deriveTidalExploreEnabled({
            enabled: true,
            available: true,
            authenticated: false,
            isFetched: true,
        }),
        false
    );
});

test("tidalExploreEnabled: returns false when all flags are false", () => {
    assert.equal(
        deriveTidalExploreEnabled({
            enabled: false,
            available: false,
            authenticated: false,
            isFetched: true,
        }),
        false
    );
});

test("tidalExploreEnabled: returns false when userSettingEnabled is false even with auth OK", () => {
    assert.equal(
        deriveTidalExploreEnabled({
            enabled: true,
            available: true,
            authenticated: true,
            isFetched: true,
            userSettingEnabled: false,
        }),
        false
    );
});

test("tidalExploreEnabled: returns true when userSettingEnabled is true and auth OK", () => {
    assert.equal(
        deriveTidalExploreEnabled({
            enabled: true,
            available: true,
            authenticated: true,
            isFetched: true,
            userSettingEnabled: true,
        }),
        true
    );
});

test("tidalExploreEnabled: returns true when userSettingEnabled is undefined (legacy)", () => {
    assert.equal(
        deriveTidalExploreEnabled({
            enabled: true,
            available: true,
            authenticated: true,
            isFetched: true,
            userSettingEnabled: undefined,
        }),
        true
    );
});

test("tidalExploreEnabled: userSettingEnabled cannot override disabled service", () => {
    assert.equal(
        deriveTidalExploreEnabled({
            enabled: false,
            available: true,
            authenticated: true,
            isFetched: true,
            userSettingEnabled: true,
        }),
        false
    );
});

test("tidalExploreEnabled: unauthenticated overrides userSettingEnabled", () => {
    assert.equal(
        deriveTidalExploreEnabled({
            enabled: true,
            available: true,
            authenticated: false,
            isFetched: true,
            userSettingEnabled: true,
        }),
        false
    );
});
