import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { Root } from "react-dom/client";

GlobalRegistrator.register();

type PreferenceSignal = "thumbs_up" | "thumbs_down" | "clear";

interface PreferenceResponse {
    trackId: string;
    signal: PreferenceSignal;
    state: "liked" | "disliked" | "neutral";
    score: number;
    likedAt: string | null;
    dislikedAt: string | null;
    updatedAt: string;
}

interface PreferenceCall {
    trackId: string;
    signal: PreferenceSignal;
    metadata?: Record<string, unknown>;
}

interface TestTrack {
    id: string;
    title: string;
    duration: number;
    artist: { name: string };
    album: { title: string };
    streamSource: "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
    hasLocalFile: boolean;
}

interface MountedPreferences {
    container: HTMLDivElement;
    root: Root;
    queryClient: QueryClient;
    localPreferenceId: string;
    remotePreferenceId: string;
}

type PreferenceButtonComponent =
    typeof import("../../components/player/TrackPreferenceButtons").TrackPreferenceButtons;
type MetadataBuilder =
    typeof import("../../hooks/useTrackPreference").buildPreferenceMetadata;

const localTrack: TestTrack = {
    id: "local-track-id",
    title: "Local Match",
    duration: 180,
    artist: { name: "Artist" },
    album: { title: "Unknown Album" },
    streamSource: "tidal",
    tidalTrackId: 101,
    hasLocalFile: true,
};

const remoteTrack: TestTrack = {
    id: "provider-result-id",
    title: "Remote Match",
    duration: 200,
    artist: { name: "Artist" },
    album: { title: "Unknown Album" },
    streamSource: "youtube",
    youtubeVideoId: "video-202",
    hasLocalFile: false,
};

const preferences = new Map<string, PreferenceResponse>();
const getCalls: string[] = [];
const setCalls: PreferenceCall[] = [];

function preferenceResponse(
    trackId: string,
    signal: PreferenceSignal,
): PreferenceResponse {
    const isLiked = signal === "thumbs_up";
    const isDisliked = signal === "thumbs_down";

    return {
        trackId,
        signal,
        state: isLiked ? "liked" : isDisliked ? "disliked" : "neutral",
        score: isLiked ? 1 : isDisliked ? -1 : 0,
        likedAt: isLiked ? "2026-08-19T12:00:00.000Z" : null,
        dislikedAt: isDisliked ? "2026-08-19T12:00:00.000Z" : null,
        updatedAt: "2026-08-19T12:00:00.000Z",
    };
}

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getTrackPreference: async (trackId: string) => {
                getCalls.push(trackId);
                return (
                    preferences.get(trackId) ??
                    preferenceResponse(trackId, "clear")
                );
            },
            setTrackPreference: async (
                trackId: string,
                signal: PreferenceSignal,
                metadata?: Record<string, unknown>,
            ) => {
                setCalls.push({ trackId, signal, metadata });
                const response = preferenceResponse(trackId, signal);
                preferences.set(trackId, response);
                return response;
            },
        },
    },
});

after(() => {
    GlobalRegistrator.unregister();
});

beforeEach(() => {
    preferences.clear();
    preferences.set(
        "local-track-id",
        preferenceResponse("local-track-id", "thumbs_up"),
    );
    getCalls.length = 0;
    setCalls.length = 0;
});

async function flushQueries() {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        await React.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

function preferenceControl(
    Component: PreferenceButtonComponent,
    buildMetadata: MetadataBuilder,
    track: TestTrack,
    trackId: string,
    testId: string,
) {
    return React.createElement(
        "div",
        { "data-testid": testId },
        React.createElement(Component, {
            trackId,
            metadata: buildMetadata({ ...track, id: trackId }),
        }),
    );
}

async function mountPreferences(): Promise<MountedPreferences> {
    const { resolvePreferenceTrackId } = await import("../../lib/trackRef");
    const { buildPreferenceMetadata } =
        await import("../../hooks/useTrackPreference");
    const { TrackPreferenceButtons } =
        await import("../../components/player/TrackPreferenceButtons");
    const { createRoot } = await import("react-dom/client");
    const localPreferenceId = resolvePreferenceTrackId(localTrack);
    const remotePreferenceId = resolvePreferenceTrackId(remoteTrack);
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(
                QueryClientProvider,
                { client: queryClient },
                React.createElement(
                    React.Fragment,
                    null,
                    preferenceControl(
                        TrackPreferenceButtons,
                        buildPreferenceMetadata,
                        localTrack,
                        localPreferenceId,
                        "local-preference",
                    ),
                    preferenceControl(
                        TrackPreferenceButtons,
                        buildPreferenceMetadata,
                        remoteTrack,
                        remotePreferenceId,
                        "remote-preference",
                    ),
                ),
            ),
        );
    });

    return {
        container,
        root,
        queryClient,
        localPreferenceId,
        remotePreferenceId,
    };
}

async function cleanupPreferences(mounted: MountedPreferences) {
    await React.act(async () => mounted.root.unmount());
    mounted.container.remove();
    mounted.queryClient.clear();
}

function getPreferenceButton(container: HTMLDivElement, testId: string) {
    const button = container.querySelector<HTMLButtonElement>(
        `[data-testid="${testId}"] button`,
    );
    assert.ok(button);
    return button;
}

test("artist preferences preserve local identity and persist remote provider identity", async (testContext) => {
    const mounted = await mountPreferences();
    testContext.after(() => cleanupPreferences(mounted));
    await flushQueries();

    const localButton = getPreferenceButton(
        mounted.container,
        "local-preference",
    );
    const remoteButton = getPreferenceButton(
        mounted.container,
        "remote-preference",
    );
    assert.equal(mounted.localPreferenceId, "local-track-id");
    assert.equal(mounted.remotePreferenceId, "yt:video-202");
    assert.equal(localButton.getAttribute("aria-label"), "Unlike");
    assert.equal(remoteButton.getAttribute("aria-label"), "Like");
    assert.deepEqual(getCalls.sort(), ["local-track-id", "yt:video-202"]);

    await React.act(async () => remoteButton.click());
    await flushQueries();

    assert.equal(remoteButton.getAttribute("aria-label"), "Unlike");
    assert.deepEqual(setCalls, [
        {
            trackId: "yt:video-202",
            signal: "thumbs_up",
            metadata: {
                title: "Remote Match",
                artist: "Artist",
                album: "Unknown Album",
                duration: 200,
                thumbnailUrl: undefined,
            },
        },
    ]);
});
