import assert from "node:assert/strict";
import test from "node:test";
import {
    countConfiguredSources,
    getConfiguredSources,
    getFallbackOptions,
    getSourceOptions,
    pickAutoSource,
    type ConfiguredSources,
} from "../../features/settings/components/sections/downloadSourceConfig";

const noSettings = {
    lidarrEnabled: false,
    lidarrUrl: "",
    lidarrApiKey: "",
    soulseekUsername: "",
    soulseekPassword: "",
    tidalEnabled: false,
    tidalConnected: false,
    ytMusicEnabled: false,
};

const allSettings = {
    lidarrEnabled: true,
    lidarrUrl: "http://lidarr:8686",
    lidarrApiKey: "key",
    soulseekUsername: "user",
    soulseekPassword: "pass",
    tidalEnabled: true,
    tidalConnected: true,
    ytMusicEnabled: true,
};

const none: ConfiguredSources = {
    soulseek: false,
    lidarr: false,
    tidal: false,
    youtube: false,
};

test("getConfiguredSources reports nothing configured for empty settings", () => {
    assert.deepEqual(getConfiguredSources(noSettings), none);
});

test("getConfiguredSources reports every source configured", () => {
    assert.deepEqual(getConfiguredSources(allSettings), {
        soulseek: true,
        lidarr: true,
        tidal: true,
        youtube: true,
    });
});

test("lidarr requires enabled flag plus url and api key", () => {
    const partial = { ...noSettings, lidarrEnabled: true, lidarrUrl: "x" };
    assert.equal(getConfiguredSources(partial).lidarr, false);
});

test("soulseek requires non-blank username and password", () => {
    const blank = { ...noSettings, soulseekUsername: "  " };
    assert.equal(getConfiguredSources(blank).soulseek, false);
});

test("tidal requires both enabled and connected", () => {
    const enabledOnly = { ...noSettings, tidalEnabled: true };
    assert.equal(getConfiguredSources(enabledOnly).tidal, false);
});

test("youtube keys off the ytMusicEnabled admin toggle", () => {
    const enabled = { ...noSettings, ytMusicEnabled: true };
    assert.equal(getConfiguredSources(enabled).youtube, true);
});

test("countConfiguredSources counts configured flags", () => {
    assert.equal(countConfiguredSources(none), 0);
    assert.equal(countConfiguredSources({ ...none, youtube: true }), 1);
    assert.equal(
        countConfiguredSources({ ...none, tidal: true, soulseek: true }),
        2,
    );
});

test("pickAutoSource returns null with zero or multiple sources", () => {
    assert.equal(pickAutoSource(none), null);
    assert.equal(pickAutoSource({ ...none, tidal: true, lidarr: true }), null);
});

test("pickAutoSource returns the single configured source", () => {
    assert.equal(pickAutoSource({ ...none, soulseek: true }), "soulseek");
    assert.equal(pickAutoSource({ ...none, lidarr: true }), "lidarr");
    assert.equal(pickAutoSource({ ...none, tidal: true }), "tidal");
    assert.equal(pickAutoSource({ ...none, youtube: true }), "youtube");
});

test("getSourceOptions lists configured sources in stable order", () => {
    const options = getSourceOptions({
        soulseek: true,
        lidarr: false,
        tidal: true,
        youtube: true,
    });
    assert.deepEqual(
        options.map((o) => o.value),
        ["soulseek", "tidal", "youtube"],
    );
    assert.equal(options[2].label, "YouTube Music (Albums)");
});

test("getSourceOptions falls back to soulseek when nothing is configured", () => {
    assert.deepEqual(getSourceOptions(none), [
        { value: "soulseek", label: "Soulseek (Per-track)" },
    ]);
});

test("getFallbackOptions always starts with Skip", () => {
    assert.deepEqual(getFallbackOptions(none, "soulseek"), [
        { value: "none", label: "Skip" },
    ]);
});

test("getFallbackOptions excludes the current primary source", () => {
    const all: ConfiguredSources = {
        soulseek: true,
        lidarr: true,
        tidal: true,
        youtube: true,
    };
    assert.deepEqual(
        getFallbackOptions(all, "youtube").map((o) => o.value),
        ["none", "soulseek", "lidarr", "tidal"],
    );
    assert.deepEqual(
        getFallbackOptions(all, "soulseek").map((o) => o.value),
        ["none", "lidarr", "tidal", "youtube"],
    );
});

test("getFallbackOptions labels youtube as Try YouTube Music", () => {
    const options = getFallbackOptions({ ...none, youtube: true }, "soulseek");
    assert.deepEqual(options[1], {
        value: "youtube",
        label: "Try YouTube Music",
    });
});
