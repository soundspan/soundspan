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

const played: unknown[][] = [];
installTrackOverflowHarness(mock, {
    useAudioControls: () => ({
        playNext: () => undefined,
        addToQueue: () => undefined,
        playTracks: (tracks: unknown[]) => {
            played.push(tracks);
        },
    }),
    useAudioState: () => ({ playbackType: "track", currentTrack: null }),
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

test("playing a row queues the group as YouTube Music tracks", async () => {
    played.length = 0;
    const mounted = await mountList({ tracks: [ytRow] });
    const row = mounted.container.querySelector(
        '[data-tv-section="search-streaming-likes"] [role="button"], [data-tv-section="search-streaming-likes"] [tabindex="0"]',
    ) as HTMLElement | null;
    assert.ok(row, "expected a playable row");
    await React.act(async () => {
        row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const queued = played[0] as Array<Record<string, unknown>>;
    assert.equal(queued[0].streamSource, "youtube");
    assert.equal(queued[0].youtubeVideoId, "abc");
    await mounted.unmount();
});
