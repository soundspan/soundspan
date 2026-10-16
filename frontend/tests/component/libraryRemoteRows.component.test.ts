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
 * Library Songs rows for liked TIDAL / YouTube Music tracks: provider badge,
 * provider-proxied artwork, "add to library" instead of delete.
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

installTrackOverflowHarness(mock, {
    useAudioControls: () => ({
        playNext: () => undefined,
        addToQueue: () => undefined,
        playTracks: () => undefined,
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

const realMbid = "8e8a6f1c-0000-4000-8000-000000000001";

const tidalRow = {
    id: "tidal:9001",
    title: "Streaming Song",
    duration: 200,
    source: "tidal" as const,
    streamSource: "tidal" as const,
    tidalTrackId: 9001,
    album: {
        id: "album-remote",
        title: "Streaming Album",
        coverArt: "https://img.example/cover.jpg",
        rgMbid: realMbid,
        artist: { id: "artist-1", name: "Artist" },
    },
};

const localRow = {
    id: "local-1",
    title: "Local Song",
    duration: 180,
    source: "local" as const,
    album: {
        id: "album-local",
        title: "Local Album",
        coverArt: "local-cover",
        artist: { id: "artist-2", name: "Local Artist" },
    },
};

async function mountTracksList(props: Record<string, unknown>) {
    const { createRoot } = await import("react-dom/client");
    const { TracksList } =
        await import("../../features/library/components/TracksList");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(TracksList, {
                onPlay: () => undefined,
                onDelete: () => undefined,
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

async function openMenu(container: HTMLElement, rowIndex: number) {
    const triggers = container.querySelectorAll(
        'button[aria-label="Track actions"]',
    );
    await React.act(async () => {
        (triggers[rowIndex] as HTMLElement).dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
        );
    });
    return Array.from(container.querySelectorAll('[role="menuitem"]')).map(
        (item) => item.textContent?.trim() ?? "",
    );
}

test("remote rows show a provider badge and provider-proxied artwork", async () => {
    const mounted = await mountTracksList({ tracks: [tidalRow, localRow] });
    const html = mounted.container.innerHTML;
    assert.match(html, /From TIDAL/);
    assert.match(html, /\/tidal-image\/https:\/\/img\.example\/cover\.jpg/);
    assert.match(html, /\/cover\/local-cover/);
    await mounted.unmount();
});

test("admins get 'Add album to library' and no delete on remote rows", async () => {
    const acquired: unknown[] = [];
    const mounted = await mountTracksList({
        tracks: [tidalRow],
        canDelete: true,
        acquisitionPolicy: { downloadsEnabled: true, requestsEnabled: false },
        onAcquire: (action: unknown) => acquired.push(action),
    });
    const items = await openMenu(mounted.container, 0);
    assert.ok(items.includes("Add album to library"), items.join(","));
    assert.ok(!items.includes("Delete track"), items.join(","));

    const addItem = Array.from(
        mounted.container.querySelectorAll('[role="menuitem"]'),
    ).find((item) => item.textContent?.includes("Add album to library"));
    await React.act(async () => {
        (addItem as HTMLElement).dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
        );
    });
    assert.deepEqual(acquired, [
        {
            kind: "download-album",
            rgMbid: realMbid,
            artistName: "Artist",
            albumTitle: "Streaming Album",
        },
    ]);
    await mounted.unmount();
});

test("local rows keep delete and get no acquisition item", async () => {
    const mounted = await mountTracksList({
        tracks: [localRow],
        canDelete: true,
        acquisitionPolicy: { downloadsEnabled: true, requestsEnabled: false },
        onAcquire: () => undefined,
    });
    const items = await openMenu(mounted.container, 0);
    assert.ok(items.includes("Delete track"), items.join(","));
    assert.ok(!items.some((item) => item.includes("to library")));
    await mounted.unmount();
});

test("the Remote empty state explains how songs get there", async () => {
    const mounted = await mountTracksList({
        tracks: [],
        emptyCopy: {
            title: "No streaming songs yet",
            description: "Like songs",
        },
    });
    assert.match(
        mounted.container.innerHTML,
        /No streaming songs yet\|Like songs/,
    );
    await mounted.unmount();
});
