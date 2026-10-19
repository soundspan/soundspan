import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
    installTrackOverflowHarness,
    trackOverflowIcon,
} from "../trackOverflowHarness";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Search's "From your streaming services" group: labeled, badged, played as
 * remote tracks, with the add-to-library action in the row menu.
 */

const ICONS = [
    "EllipsisVertical",
    "Link",
    "ListEnd",
    "ListPlus",
    "Map",
    "Plus",
    "Share2",
    "User",
    "Disc3",
    "AudioWaveform",
    "Radio",
    "AudioLines",
    "Music",
    "Play",
    "GripVertical",
    "Network",
    "Download",
    "Send",
    "Trash2",
    "Copy",
    "Link2",
    "Loader2",
];
mock.module("lucide-react", {
    namedExports: Object.fromEntries(
        ICONS.map((name) => [name, trackOverflowIcon]),
    ),
});

const played: Array<{ tracks: unknown[]; index: number }> = [];
const playerState = {
    currentTrack: null as { id: string } | null,
    isPlaying: false,
    pauses: 0,
    resumes: 0,
};
installTrackOverflowHarness(mock, {
    useAudioControls: () => ({
        playNext: () => undefined,
        addToQueue: () => undefined,
        playTracks: (tracks: unknown[], index: number) => {
            played.push({ tracks, index });
        },
        pause: () => {
            playerState.pauses += 1;
        },
        resume: () => {
            playerState.resumes += 1;
        },
    }),
    useAudioState: () => ({
        playbackType: "track",
        currentTrack: playerState.currentTrack,
    }),
});
mock.module("@/lib/audio-playback-context", {
    namedExports: {
        usePlaybackStatus: () => ({ isPlaying: playerState.isPlaying }),
    },
});

mock.module("@/hooks/useQueuedTrackIds", {
    namedExports: { useQueuedTrackIds: () => new Set<string>() },
});
mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (url: string) => `/cover/${url}`,
            getTidalBrowseImageUrl: (url: string) => `/tidal-image/${url}`,
            getBrowseImageUrl: (url: string) => `/yt-image/${url}`,
        },
    },
});
mock.module("@/components/player/TrackPreferenceButtons", {
    namedExports: { TrackPreferenceButtons: () => null },
});
mock.module("@/components/ui/ShareLinkModal", {
    namedExports: { ShareLinkModal: () => null },
});
mock.module("@/components/ui/CachedImage", {
    namedExports: {
        CachedImage: (props: Record<string, unknown>) =>
            React.createElement("img", { src: props.src as string }),
    },
});
mock.module("@/components/ui/EmptyState", {
    namedExports: {
        EmptyState: (props: { title: string; description: string }) =>
            React.createElement(
                "div",
                null,
                `${props.title}|${props.description}`,
            ),
    },
});
mock.module("@/components/ui/GradientSpinner", {
    namedExports: { GradientSpinner: () => null },
});
mock.module("next/link", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement(
            "a",
            { href: props.href as string },
            props.children as React.ReactNode,
        ),
});
mock.module("next/navigation", {
    namedExports: { useRouter: () => ({ push: () => undefined }) },
});
mock.module("@tanstack/react-query", {
    namedExports: {
        useQueryClient: () => ({ invalidateQueries: async () => undefined }),
        useQuery: () => ({ data: undefined }),
        useMutation: () => ({ mutateAsync: async () => undefined }),
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // best-effort teardown
    }
});

const ytRow = {
    id: "yt:abc",
    title: "Liked Video Song",
    duration: 180,
    source: "youtube" as const,
    streamSource: "youtube" as const,
    youtubeVideoId: "abc",
    album: {
        id: "album-remote",
        title: "Remote Album",
        coverArt: "https://img.example/yt.jpg",
        rgMbid: "8e8a6f1c-0000-4000-8000-000000000002",
        artist: { id: "artist-9", name: "Streamer" },
    },
};

async function mountList(props: Record<string, unknown>) {
    const { createRoot } = await import("react-dom/client");
    const { StreamingLikesList } =
        await import("../../features/search/components/StreamingLikesList");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(StreamingLikesList, {
                acquisitionPolicy: {
                    downloadsEnabled: false,
                    tidalDownloadsEnabled: false,
                    requestsEnabled: true,
                },
                onAcquire: () => undefined,
                ...props,
            } as never),
        );
    });
    return {
        container,
        async unmount() {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

test("renders nothing when there are no liked streaming songs", async () => {
    const mounted = await mountList({ tracks: [] });
    assert.equal(mounted.container.innerHTML, "");
    await mounted.unmount();
});

test("labels the group and badges each song by provider", async () => {
    const mounted = await mountList({ tracks: [ytRow] });
    const html = mounted.container.innerHTML;
    assert.match(html, /From your streaming services/);
    assert.match(html, /From YouTube Music/);
    assert.match(html, /\/yt-image\/https:\/\/img\.example\/yt\.jpg/);
    assert.match(html, /href="\/album\/album-remote"/);
    await mounted.unmount();
});

test("members can request the album from the row menu", async () => {
    const acquired: unknown[] = [];
    const mounted = await mountList({
        tracks: [ytRow],
        onAcquire: (action: unknown) => acquired.push(action),
    });
    const trigger = mounted.container.querySelector(
        'button[aria-label="Track actions"]',
    ) as HTMLElement;
    await React.act(async () => {
        trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const request = Array.from(
        mounted.container.querySelectorAll('[role="menuitem"]'),
    ).find((item) => item.textContent?.includes("Request album"));
    assert.ok(request, "expected a Request album item");
    await React.act(async () => {
        (request as HTMLElement).dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
        );
    });
    assert.deepEqual(acquired, [
        {
            kind: "request-album",
            rgMbid: "8e8a6f1c-0000-4000-8000-000000000002",
            artistName: "Streamer",
            albumTitle: "Remote Album",
        },
    ]);
    await mounted.unmount();
});

const tidalRow = {
    id: "tidal:77",
    title: "Liked Tidal Song",
    duration: 200,
    source: "tidal" as const,
    streamSource: "tidal" as const,
    tidalTrackId: 77,
    album: {
        id: "album-tidal",
        title: "Tidal Album",
        coverArt: null,
        rgMbid: null,
        artist: { id: "artist-7", name: "Tidal Artist" },
    },
};

function rowsOf(container: HTMLElement): HTMLElement[] {
    return Array.from(
        container.querySelectorAll(
            '[data-tv-section="search-streaming-likes"] [data-tv-card]',
        ),
    ) as HTMLElement[];
}

test("playing a row queues the whole group from that row with stream fields", async () => {
    played.length = 0;
    playerState.currentTrack = null;
    const mounted = await mountList({ tracks: [ytRow, tidalRow] });
    const rows = rowsOf(mounted.container);
    assert.equal(rows.length, 2);
    await React.act(async () => {
        rows[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.equal(played.length, 1);
    assert.equal(played[0].index, 1);
    const queued = played[0].tracks as Array<Record<string, unknown>>;
    assert.equal(queued[0].streamSource, "youtube");
    assert.equal(queued[0].youtubeVideoId, "abc");
    assert.equal(queued[1].streamSource, "tidal");
    assert.equal(queued[1].tidalTrackId, 77);
    await mounted.unmount();
});

test("clicking the song that is already playing pauses it instead of restarting", async () => {
    played.length = 0;
    playerState.currentTrack = { id: "tidal:77" };
    playerState.isPlaying = true;
    playerState.pauses = 0;
    const mounted = await mountList({ tracks: [tidalRow] });
    await React.act(async () => {
        rowsOf(mounted.container)[0].dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
        );
    });
    assert.equal(playerState.pauses, 1);
    assert.equal(played.length, 0);
    playerState.currentTrack = null;
    playerState.isPlaying = false;
    await mounted.unmount();
});

test("clicking the paused current song resumes it", async () => {
    played.length = 0;
    playerState.currentTrack = { id: "tidal:77" };
    playerState.isPlaying = false;
    playerState.resumes = 0;
    const mounted = await mountList({ tracks: [tidalRow] });
    await React.act(async () => {
        rowsOf(mounted.container)[0].dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
        );
    });
    assert.equal(playerState.resumes, 1);
    assert.equal(played.length, 0);
    playerState.currentTrack = null;
    await mounted.unmount();
});

test("shows five songs by default", async () => {
    const many = Array.from({ length: 7 }, (_, index) => ({
        ...tidalRow,
        id: `tidal:${100 + index}`,
        tidalTrackId: 100 + index,
    }));
    const mounted = await mountList({ tracks: many });
    assert.equal(rowsOf(mounted.container).length, 5);
    await mounted.unmount();
});
