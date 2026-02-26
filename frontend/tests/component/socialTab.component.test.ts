import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

type MockSocialUser = {
    id: string;
    username: string;
    displayName: string;
    isInListenTogetherGroup: boolean;
    listeningStatus: "playing" | "paused" | "idle";
    listeningTrack: {
        id: string;
        title: string;
        duration: number;
        artistName: string;
        artistId: string | null;
        albumTitle: string;
        albumId: string | null;
        coverArt: string | null;
    } | null;
    lastHeartbeatAt: string;
};

const state = {
    users: [] as MockSocialUser[],
    isLoading: false,
    error: null as Error | null,
};

const Icon = () => React.createElement("i");

mock.module("next/image", {
    defaultExport: ({
        src,
        alt,
        ...rest
    }: {
        src: string;
        alt: string;
    }) => React.createElement("img", { src, alt, ...rest }),
});

mock.module("next/link", {
    defaultExport: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    }) => React.createElement("a", { href, ...rest }, children),
});

mock.module("@/hooks/useSocialPresence", {
    namedExports: {
        useSocialPresence: () => ({
            users: state.users,
            isLoading: state.isLoading,
            error: state.error,
        }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (coverArt: string, size: number) =>
                `/api/cover/${coverArt}?size=${size}`,
        },
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

mock.module("lucide-react", {
    namedExports: {
        Music2: Icon,
        Users: Icon,
        Radio: Icon,
    },
});

beforeEach(() => {
    state.users = [];
    state.isLoading = false;
    state.error = null;
});

test("renders unavailable state when initial fetch fails", async () => {
    state.error = new Error("network");

    const { SocialTab } = await import(
        "../../components/activity/SocialTab.tsx"
    );
    const html = renderToStaticMarkup(React.createElement(SocialTab));

    assert.match(html, /Social status unavailable/);
});

test("keeps rendering social users when a refetch error occurs", async () => {
    state.users = [
        {
            id: "u-1",
            username: "listener",
            displayName: "Listener",
            isInListenTogetherGroup: false,
            listeningStatus: "idle",
            listeningTrack: null,
            lastHeartbeatAt: "2026-02-18T13:00:00.000Z",
        },
    ];
    state.error = new Error("transient");

    const { SocialTab } = await import(
        "../../components/activity/SocialTab.tsx"
    );
    const html = renderToStaticMarkup(React.createElement(SocialTab));

    assert.match(html, /Listener/);
    assert.doesNotMatch(html, /Social status unavailable/);
});

test("renders playing state with song and artist links when ids are present", async () => {
    state.users = [
        {
            id: "u-1",
            username: "listener",
            displayName: "Listener",
            isInListenTogetherGroup: false,
            listeningStatus: "playing",
            listeningTrack: {
                id: "track-1",
                title: "Song One",
                duration: 180,
                artistName: "Artist One",
                artistId: "artist-1",
                albumTitle: "Album One",
                albumId: "album-1",
                coverArt: null,
            },
            lastHeartbeatAt: "2026-02-18T13:00:00.000Z",
        },
    ];

    const { SocialTab } = await import(
        "../../components/activity/SocialTab.tsx"
    );
    const html = renderToStaticMarkup(React.createElement(SocialTab));

    assert.match(html, /Playing/);
    assert.match(html, /href=\"\/album\/album-1\"/);
    assert.match(html, /href=\"\/artist\/artist-1\"/);
    assert.doesNotMatch(html, /Not currently playing/);
});

test("renders idle users as not currently playing", async () => {
    state.users = [
        {
            id: "u-1",
            username: "listener",
            displayName: "Listener",
            isInListenTogetherGroup: false,
            listeningStatus: "idle",
            listeningTrack: {
                id: "track-1",
                title: "Song One",
                duration: 180,
                artistName: "Artist One",
                artistId: "artist-1",
                albumTitle: "Album One",
                albumId: "album-1",
                coverArt: null,
            },
            lastHeartbeatAt: "2026-02-18T13:00:00.000Z",
        },
    ];

    const { SocialTab } = await import(
        "../../components/activity/SocialTab.tsx"
    );
    const html = renderToStaticMarkup(React.createElement(SocialTab));

    assert.match(html, /Idle/);
    assert.match(html, /Not currently playing/);
    assert.doesNotMatch(html, /href=\"\/album\/album-1\"/);
    assert.doesNotMatch(html, /href=\"\/artist\/artist-1\"/);
});
