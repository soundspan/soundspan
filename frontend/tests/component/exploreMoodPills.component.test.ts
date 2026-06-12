import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
// Real provider: module-mocking "@tanstack/react-query" does not intercept the
// component's own import (project files resolve the package in the CJS realm).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const featuresState = {
    musicCNN: false,
    vibeEmbeddings: false,
    audioAnalysis: true,
    discovery: true,
    autoPlaylists: true,
    showVersion: false,
    loading: false,
};

const Icon = () => React.createElement("i");

mock.module("@/lib/features-context", {
    namedExports: {
        useFeatures: () => featuresState,
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getMoodBucketPresets: async () => [],
            getMoodBucketMix: async () => ({ tracks: [] }),
            saveMoodBucketMix: async () => undefined,
        },
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({ playTracks: () => undefined }),
    },
});

mock.module("sonner", {
    namedExports: {
        toast: {
            success: () => undefined,
            error: () => undefined,
        },
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
        },
    },
});

mock.module("next/link", {
    defaultExport: ({ children, href }: { children: React.ReactNode; href: string }) =>
        React.createElement("a", { href }, children),
});

mock.module("lucide-react", {
    namedExports: { AudioWaveform: Icon, Loader2: Icon },
});

async function renderMoodPills() {
    const { MoodPills } = await import(
        "../../features/explore/components/MoodPills"
    );
    return renderToStaticMarkup(
        React.createElement(
            QueryClientProvider,
            { client: new QueryClient() },
            React.createElement(MoodPills)
        )
    );
}

beforeEach(() => {
    featuresState.audioAnalysis = true;
    featuresState.autoPlaylists = true;
});

test("MoodPills renders mood pills and the Vibe Map link when flags are on", async () => {
    const html = await renderMoodPills();

    assert.match(html, /Chill/);
    assert.match(html, /Energetic/);
    assert.match(html, /Vibe Map/);
    assert.match(html, /href="\/vibe"/);
});

test("MoodPills hides mood pills when autoPlaylists is off but keeps the Vibe Map link", async () => {
    featuresState.autoPlaylists = false;
    const html = await renderMoodPills();

    assert.doesNotMatch(html, /Chill/);
    assert.doesNotMatch(html, /<button/);
    assert.match(html, /Vibe Map/);
});

test("MoodPills hides the Vibe Map link when audioAnalysis is off but keeps the pills", async () => {
    featuresState.audioAnalysis = false;
    const html = await renderMoodPills();

    assert.match(html, /Chill/);
    assert.doesNotMatch(html, /Vibe Map/);
    assert.doesNotMatch(html, /href="\/vibe"/);
});

test("MoodPills renders nothing when both flags are off", async () => {
    featuresState.autoPlaylists = false;
    featuresState.audioAnalysis = false;
    const html = await renderMoodPills();

    assert.equal(html, "");
});
