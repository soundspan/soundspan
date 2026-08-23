import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = {
    pathname: "/library",
    isAuthenticated: true,
    hasActiveSessions: false,
    isMobile: false,
    isTablet: false,
    federation: false,
    peerPlaylists: [] as Array<{
        remoteId: string;
        name: string;
        trackCount: number;
        updatedAt: string;
        owner: { displayName: string };
        peer: { id: string; name: string };
    }>,
};

mock.module("next/navigation", {
    namedExports: {
        usePathname: () => state.pathname,
    },
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

mock.module("next/image", {
    defaultExport: ({ src, alt, ...rest }: { src: string; alt: string }) =>
        React.createElement("img", { src, alt, ...rest }),
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            scanLibrary: async () => undefined,
            getPlaylists: async () => [],
        },
    },
});

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({ isAuthenticated: state.isAuthenticated }),
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: null,
            currentAudiobook: null,
            currentPodcast: null,
            playbackType: "track",
        }),
    },
});

mock.module("@/hooks/useActiveListenSessions", {
    namedExports: {
        useActiveListenSessions: () => state.hasActiveSessions,
    },
});

mock.module("@/hooks/useQueries", {
    namedExports: {
        useLikedPlaylistQuery: () => ({
            data: null,
            isLoading: false,
            isError: false,
        }),
    },
});

mock.module("@/hooks/useMediaQuery", {
    namedExports: {
        useIsMobile: () => state.isMobile,
        useIsTablet: () => state.isTablet,
    },
});

mock.module("@/lib/features-context", {
    namedExports: {
        useFeatures: () => ({ federation: state.federation }),
    },
});

mock.module("@/features/social/hooks/usePeerPlaylists", {
    namedExports: {
        usePeerPlaylists: () => ({
            playlists: state.peerPlaylists,
            peerErrors: [],
            enabled: state.federation,
        }),
    },
});

mock.module("@/components/ui/PeerBadge", {
    namedExports: {
        PeerBadge: ({ peerName }: { peerName: string }) =>
            React.createElement("span", null, `peer-badge:${peerName}`),
    },
});

mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({
            toast: {
                error: () => undefined,
                success: () => undefined,
            },
        }),
    },
});

mock.module("@/components/ui/EqBars", {
    namedExports: {
        EqBars: () => React.createElement("span", null, "eq-bars"),
    },
});

mock.module("../../components/layout/MobileSidebar.tsx", {
    namedExports: {
        MobileSidebar: () => React.createElement("div", null, "mobile-sidebar"),
    },
});

beforeEach(() => {
    state.pathname = "/library";
    state.isAuthenticated = true;
    state.hasActiveSessions = false;
    state.isMobile = false;
    state.isTablet = false;
    state.federation = false;
    state.peerPlaylists = [];
});

test("returns null for auth routes", async () => {
    state.pathname = "/login";

    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    assert.equal(html, "");
});

test("renders social navigation without my history link", async () => {
    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    assert.match(html, />Explore</);
    assert.match(html, />Library</);
    assert.match(html, />Listen Together</);
    assert.match(html, />Audiobooks</);
    assert.match(html, />Podcasts</);
    assert.doesNotMatch(html, /My History/);
});

test("shows listen-together equalizer marker when active sessions exist", async () => {
    state.hasActiveSessions = true;
    state.pathname = "/listen-together";

    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    assert.match(html, /eq-bars/);
});

test("keeps prefetch enabled for primary sidebar navigation links", async () => {
    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    const navHrefs = [
        "/explore",
        "/library",
        "/listen-together",
        "/audiobooks",
        "/podcasts",
    ];

    for (const href of navHrefs) {
        const escapedHref = href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const linkMatch = html.match(
            new RegExp(`<a[^>]*href="${escapedHref}"[^>]*>`),
        );
        assert.ok(linkMatch, `Expected link for ${href}`);
        assert.doesNotMatch(
            linkMatch[0],
            /\sprefetch=/,
            `Primary nav link ${href} should not force prefetch off`,
        );
    }
});

test("renders badged peer playlists in the unified list when federated", async () => {
    state.federation = true;
    state.peerPlaylists = [
        {
            remoteId: "remote-1",
            name: "Peer Jams",
            trackCount: 4,
            updatedAt: "2026-08-20T00:00:00.000Z",
            owner: { displayName: "Sam" },
            peer: { id: "peer-a", name: "Family server" },
        },
    ];

    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    assert.match(html, /Peer Jams/);
    assert.match(html, /peer-badge:Family server/);
    assert.match(html, /href="\/peer-playlists\/peer-a\/remote-1"/);
    assert.match(html, /by Sam/);
});

test("hides peer playlists without federation", async () => {
    state.federation = false;
    state.peerPlaylists = [
        {
            remoteId: "remote-1",
            name: "Peer Jams",
            trackCount: 4,
            updatedAt: "2026-08-20T00:00:00.000Z",
            owner: { displayName: "Sam" },
            peer: { id: "peer-a", name: "Family server" },
        },
    ];

    const { Sidebar } = await import("../../components/layout/Sidebar");
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    assert.doesNotMatch(html, /Peer Jams/);
    assert.doesNotMatch(html, /peer-badge:/);
});
