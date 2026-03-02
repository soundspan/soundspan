import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const authState = {
    isAuthenticated: true,
    isLoading: false,
};

const Icon = () => React.createElement("i");

mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({
            push: () => undefined,
        }),
    },
});

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

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => authState,
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            get: async () => ({
                charts: {},
                country: "US",
                source: "ytmusic",
            }),
            post: async () => ({
                source: "spotify",
                id: "playlist-1",
                url: "https://open.spotify.com/playlist/playlist-1",
            }),
            getTidalStreamingStatus: async () => ({
                enabled: true,
                available: true,
                authenticated: true,
                credentialsConfigured: true,
            }),
        },
    },
});

mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({
            toast: {
                error: () => undefined,
            },
        }),
    },
});

mock.module("@/hooks/usePlayButtonFeedback", {
    namedExports: {
        usePlayButtonFeedback: () => ({
            showSpinner: false,
            triggerPlayFeedback: () => undefined,
        }),
    },
});

mock.module("@/components/layout/PageHeader", {
    namedExports: {
        PageHeader: ({
            title,
            subtitle,
        }: {
            title: string;
            subtitle: string;
        }) => React.createElement("header", null, `${title} ${subtitle}`),
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            error: () => undefined,
        },
    },
});

mock.module("lucide-react", {
    namedExports: {
        Loader2: Icon,
        Music2: Icon,
        Link2: Icon,
        X: Icon,
        ChevronRight: Icon,
        Globe: Icon,
        TrendingUp: Icon,
        Sparkles: Icon,
        Lock: Icon,
        CheckCircle2: Icon,
        ArrowRight: Icon,
        Home: Icon,
    },
});

beforeEach(() => {
    authState.isAuthenticated = true;
    authState.isLoading = false;
});

test("browse provider tabs include YouTube Music and TIDAL", async () => {
    const BrowsePage = (await import("../../app/browse/playlists/page.tsx"))
        .default;
    const html = renderToStaticMarkup(React.createElement(BrowsePage));

    assert.match(html, /YouTube Music/);
    assert.match(html, /TIDAL/);
});

test("connected tidal status exposes unlocked connected browse tab", async () => {
    const { resolveTidalBrowseAccessState, getBrowseProviderTabs } = await import(
        "../../app/browse/playlists/page.tsx"
    );
    const tidalState = resolveTidalBrowseAccessState({
        authLoading: false,
        isAuthenticated: true,
        statusResolved: true,
        enabled: true,
        available: true,
        authenticated: true,
    });
    const tabs = getBrowseProviderTabs(tidalState);
    const tidalTab = tabs.find((tab) => tab.provider === "tidal");

    assert.equal(tidalState.state, "connected");
    assert.equal(tidalState.canBrowse, true);
    assert.equal(tidalTab?.locked, false);
    assert.equal(tidalTab?.statusLabel, "Connected");
});

test("disconnected authenticated users receive explicit connect CTA state", async () => {
    const { resolveTidalBrowseAccessState, getBrowseProviderTabs } = await import(
        "../../app/browse/playlists/page.tsx"
    );
    const tidalState = resolveTidalBrowseAccessState({
        authLoading: false,
        isAuthenticated: true,
        statusResolved: true,
        enabled: true,
        available: true,
        authenticated: false,
    });
    const tabs = getBrowseProviderTabs(tidalState);
    const tidalTab = tabs.find((tab) => tab.provider === "tidal");

    assert.equal(tidalState.state, "disconnected");
    assert.equal(tidalState.canBrowse, false);
    assert.equal(tidalState.ctaLabel, "Connect TIDAL");
    assert.equal(tidalState.ctaHref, "/settings#integrations");
    assert.equal(tidalTab?.statusLabel, "Connect");
    assert.equal(tidalTab?.locked, true);
});

test("unauthenticated users receive sign-in CTA state", async () => {
    const { resolveTidalBrowseAccessState } = await import(
        "../../app/browse/playlists/page.tsx"
    );
    const tidalState = resolveTidalBrowseAccessState({
        authLoading: false,
        isAuthenticated: false,
        statusResolved: true,
        enabled: false,
        available: false,
        authenticated: false,
    });

    assert.equal(tidalState.state, "disconnected");
    assert.equal(tidalState.canBrowse, false);
    assert.equal(tidalState.statusLabel, "Sign in");
    assert.equal(tidalState.ctaLabel, "Sign In");
    assert.equal(tidalState.ctaHref, "/login");
});
