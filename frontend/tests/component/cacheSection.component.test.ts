import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SystemSettings } from "../../features/settings/types";

mock.module("@/lib/features-context", {
    namedExports: {
        useFeatures: () => ({
            musicCNN: true,
            vibeEmbeddings: true,
            audioAnalysis: true,
            discovery: true,
            autoPlaylists: true,
            federation: false,
            vibe: {
                provider: {
                    configured: true,
                    reachable: true,
                    checkedAt: "2026-08-17T12:00:00.000Z",
                    fresh: true,
                },
                activeSpace: { id: "space-active", family: "teacher" },
                migration: null,
            },
            showVersion: false,
            loading: false,
        }),
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        createFrontendLogger: () => ({
            error: () => undefined,
            warn: () => undefined,
            info: () => undefined,
            debug: () => undefined,
        }),
    },
});

mock.module("@/components/EnrichmentFailuresModal", {
    namedExports: {
        EnrichmentFailuresModal: () => null,
    },
});

const settings: SystemSettings = {
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
    maxCacheSizeMb: 1024,
    autoSync: true,
    autoEnrichMetadata: true,
    libraryDeletionEnabled: false,
    audioAnalyzerWorkers: 2,
    soulseekConcurrentDownloads: 4,
    downloadSource: "soulseek",
    primaryFailureFallback: "none",
    ytMusicEnabled: false,
    ytMusicClientId: "",
    ytMusicClientSecret: "",
    showVersion: false,
};

test("renders live vibe embedding progress without the retired worker control", async () => {
    const { CacheSection } =
        await import("../../features/settings/components/sections/CacheSection");
    const queryClient = new QueryClient();
    queryClient.setQueryData(["enrichment-progress"], {
        artists: { completed: 2, total: 2, progress: 100, failed: 0 },
        trackTags: { completed: 2, total: 2, progress: 100, failed: 0 },
        audioAnalysis: {
            completed: 2,
            total: 2,
            progress: 100,
            processing: 0,
            failed: 0,
        },
        clapEmbeddings: {
            completed: 1,
            total: 2,
            progress: 50,
            processing: 1,
            failed: 0,
        },
        coreComplete: true,
        isFullyComplete: false,
    });

    const html = renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(CacheSection, {
                settings,
                onUpdate: () => undefined,
            }),
        ),
    );

    assert.match(html, /Vibe Embeddings/);
    assert.match(html, /Provider\s+reachable/);
    assert.match(html, /Re-run/);
    assert.doesNotMatch(html, /Vibe Embedding Workers/);
});
