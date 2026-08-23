import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const icon = (name: string) => {
    const MockIcon = (props: Record<string, unknown> = {}) =>
        React.createElement("svg", { ...props, "data-icon": name });
    MockIcon.displayName = `MockIcon${name}`;
    return MockIcon;
};

mock.module("lucide-react", {
    namedExports: {
        Play: icon("play"),
        Pause: icon("pause"),
        Check: icon("check"),
        Download: icon("download"),
        Loader2: icon("loader2"),
        Search: icon("search"),
        Send: icon("send"),
        Disc3: icon("disc3"),
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
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
    } & Record<string, unknown>) =>
        React.createElement("a", { href, ...rest }, children),
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (url: string) => url,
            request: async () => ({ coverUrl: null }),
        },
    },
});

mock.module("@/components/ui/CachedImage", {
    namedExports: {
        CachedImage: ({ src, alt }: { src: string; alt: string }) =>
            React.createElement("img", { src, alt }),
    },
});

mock.module("@/hooks/usePlayButtonFeedback", {
    namedExports: {
        usePlayButtonFeedback: () => ({
            showSpinner: false,
            trigger: () => undefined,
        }),
    },
});

const noop = () => undefined;

const REAL_MBID = "0befee0f-2b0b-4b52-9d41-38f0f1f74ea5";

const album = (overrides: Record<string, unknown> = {}) => ({
    id: "album-1",
    title: "Geogaddi",
    type: "album",
    rgMbid: REAL_MBID,
    ...overrides,
});

const requestControls = (overrides: Record<string, unknown> = {}) => ({
    enabled: true,
    isRequestable: (candidate: { rgMbid?: string }) =>
        Boolean(candidate.rgMbid?.startsWith("0befee0f")),
    isRequested: () => false,
    isSubmitting: false,
    request: noop,
    ...overrides,
});

const baseProps = {
    artistName: "Boards of Canada",
    source: "library" as const,
    colors: null,
    onDownloadAlbum: noop,
    onSearchAlbum: noop,
    isPendingDownload: () => false,
};

test("admins keep the download badge even when request controls exist", async () => {
    const { AvailableAlbums } =
        await import("../../features/artist/components/AvailableAlbums");
    const html = renderToStaticMarkup(
        React.createElement(AvailableAlbums, {
            ...baseProps,
            albums: [album()],
            downloadsEnabled: true,
            requestControls: requestControls(),
        }),
    );
    assert.match(html, />Download</);
    assert.doesNotMatch(html, />Request</);
});

test("non-admins with the gate open see the Request badge", async () => {
    const { AvailableAlbums } =
        await import("../../features/artist/components/AvailableAlbums");
    const html = renderToStaticMarkup(
        React.createElement(AvailableAlbums, {
            ...baseProps,
            albums: [album()],
            downloadsEnabled: false,
            requestControls: requestControls(),
        }),
    );
    assert.match(html, />Request</);
    assert.doesNotMatch(html, />Download</);
});

test("albums with an open request render the Requested state", async () => {
    const { AvailableAlbums } =
        await import("../../features/artist/components/AvailableAlbums");
    const html = renderToStaticMarkup(
        React.createElement(AvailableAlbums, {
            ...baseProps,
            albums: [album()],
            downloadsEnabled: false,
            requestControls: requestControls({ isRequested: () => true }),
        }),
    );
    assert.match(html, />Requested</);
    assert.doesNotMatch(html, />Request</);
});

test("synthetic release-group ids never show a request affordance", async () => {
    const { AvailableAlbums } =
        await import("../../features/artist/components/AvailableAlbums");
    const html = renderToStaticMarkup(
        React.createElement(AvailableAlbums, {
            ...baseProps,
            albums: [album({ rgMbid: "temp-172444-0.5" })],
            downloadsEnabled: false,
            requestControls: requestControls(),
        }),
    );
    assert.doesNotMatch(html, />Request</);
    assert.doesNotMatch(html, />Requested</);
});

test("closed gate renders no acquisition badge at all", async () => {
    const { AvailableAlbums } =
        await import("../../features/artist/components/AvailableAlbums");
    const html = renderToStaticMarkup(
        React.createElement(AvailableAlbums, {
            ...baseProps,
            albums: [album()],
            downloadsEnabled: false,
            requestControls: requestControls({ enabled: false }),
        }),
    );
    assert.doesNotMatch(html, />Request</);
    assert.doesNotMatch(html, />Download</);
});
