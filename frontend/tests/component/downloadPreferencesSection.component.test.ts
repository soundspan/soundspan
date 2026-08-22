import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SystemSettings } from "../../features/settings/types";

const Icon = () => React.createElement("i");

mock.module("lucide-react", {
    namedExports: {
        ChevronDown: Icon,
    },
});

const baseSettings: SystemSettings = {
    lidarrEnabled: false,
    lidarrUrl: "",
    lidarrApiKey: "",
    openaiEnabled: false,
    openaiApiKey: "",
    openaiModel: "",
    fanartEnabled: false,
    fanartApiKey: "",
    lastfmApiKey: "",
    audiobookshelfEnabled: false,
    audiobookshelfUrl: "",
    audiobookshelfApiKey: "",
    soulseekUsername: "",
    soulseekPassword: "",
    tidalEnabled: false,
    tidalConnected: false,
    tidalUserId: "",
    tidalCountryCode: "US",
    tidalQuality: "HIGH",
    tidalFileTemplate: "",
    musicPath: "/music",
    downloadPath: "/downloads",
    transcodeCacheMaxGb: 10,
    maxCacheSizeMb: 512,
    autoSync: false,
    autoEnrichMetadata: false,
    libraryDeletionEnabled: false,
    audioAnalyzerWorkers: 1,
    soulseekConcurrentDownloads: 4,
    downloadSource: "soulseek",
    federationInstanceName: null,
    playbackSourceOrder: "library,peers,tidal,ytmusic",
    federationShowPeerStatus: false,
    primaryFailureFallback: "none",
    ytMusicEnabled: false,
    ytMusicClientId: "",
    ytMusicClientSecret: "",
    showVersion: false,
};

async function renderSection(overrides: Partial<SystemSettings>) {
    const { DownloadPreferencesSection } =
        await import("../../features/settings/components/sections/DownloadPreferencesSection");
    return renderToStaticMarkup(
        React.createElement(DownloadPreferencesSection, {
            settings: { ...baseSettings, ...overrides },
            onUpdate: () => undefined,
        }),
    );
}

test("renders disabled state when no download service is configured", async () => {
    const html = await renderSection({});

    assert.match(html, /Download Preferences/);
    assert.match(html, /Requires at least one download service/);
    assert.match(html, />Soulseek \(Per-track\)</);
    assert.doesNotMatch(html, /YouTube Music \(Albums\)/);
});

test("offers YouTube Music as a source when YT Music is enabled", async () => {
    const html = await renderSection({
        ytMusicEnabled: true,
        tidalEnabled: true,
        tidalConnected: true,
        downloadSource: "youtube",
    });

    assert.match(html, />YouTube Music \(Albums\)</);
    assert.match(html, />TIDAL \(Per-track \/ album\)</);
    assert.doesNotMatch(html, /Requires at least one download service/);
});

test("fallback options exclude the current primary and include Try YouTube Music", async () => {
    const html = await renderSection({
        ytMusicEnabled: true,
        soulseekUsername: "user",
        soulseekPassword: "pass",
        downloadSource: "soulseek",
    });

    assert.match(html, />Skip</);
    assert.match(html, />Try YouTube Music</);
    assert.doesNotMatch(html, />Try Soulseek</);
});
