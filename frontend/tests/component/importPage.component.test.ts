import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const executeCalls: Array<{ previewData: any; name?: string }> = [];
const previewCalls: string[] = [];
const toastErrors: string[] = [];

const previewResponse = {
    playlistName: "Test Playlist",
    resolved: [
        {
            index: 0,
            artist: "Local Artist",
            title: "Local Song",
            source: "local" as const,
            confidence: 100,
            trackId: "track-1",
        },
    ],
    summary: { total: 1, local: 1, youtube: 0, tidal: 0, unresolved: 0 },
};

mock.module("@/lib/api", {
    namedExports: {
        api: {
            previewPlaylistImport: async (url: string) => {
                previewCalls.push(url);
                return previewResponse;
            },
            executePlaylistImport: async (input: {
                previewData: any;
                name?: string;
            }) => {
                executeCalls.push(input);
                return {
                    playlistId: "playlist-123",
                    summary: {
                        total: 4,
                        local: 1,
                        youtube: 1,
                        tidal: 1,
                        unresolved: 1,
                    },
                };
            },
        },
    },
});

mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({
            back: () => undefined,
            push: () => undefined,
        }),
        useSearchParams: () => new URLSearchParams(),
    },
});

mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({
            toast: {
                error: (message: string) => toastErrors.push(message),
                info: () => undefined,
                success: () => undefined,
            },
        }),
    },
});

mock.module("@/components/ui/TidalBadge", {
    namedExports: {
        TidalBadge: () => React.createElement("span", null, "TIDAL"),
    },
});

mock.module("@/components/ui/YouTubeBadge", {
    namedExports: {
        YouTubeBadge: () => React.createElement("span", null, "YOUTUBE"),
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    executeCalls.length = 0;
    previewCalls.length = 0;
    toastErrors.length = 0;
    document.body.replaceChildren();
});

async function mountImportPage() {
    const { default: ImportPage } = await import("../../app/import/page");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(React.createElement(ImportPage));
    });

    return {
        container,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

function typeInto(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
    )?.set;
    assert.ok(setter, "expected the input value setter");
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function click(button: HTMLButtonElement): Promise<void> {
    await React.act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
    });
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.includes(text),
    );
    assert.ok(button instanceof HTMLButtonElement, `button not found: ${text}`);
    return button;
}

test("preview list renders provider resolution badges per track", async () => {
    const { PreviewTrackResolutionList } =
        await import("../../app/import/page");

    const html = renderToStaticMarkup(
        React.createElement(PreviewTrackResolutionList, {
            tracks: [
                {
                    index: 0,
                    artist: "Local Artist",
                    title: "Local Song",
                    source: "local",
                    confidence: 98,
                },
                {
                    index: 1,
                    artist: "YT Artist",
                    title: "YT Song",
                    source: "youtube",
                    confidence: 85,
                },
                {
                    index: 2,
                    artist: "Tidal Artist",
                    title: "Tidal Song",
                    source: "tidal",
                    confidence: 85,
                },
                {
                    index: 3,
                    artist: "Unknown Artist",
                    title: "Unknown Song",
                    source: "unresolved",
                    confidence: 0,
                },
            ],
        }),
    );

    assert.match(html, /LOCAL/);
    assert.match(html, /YOUTUBE/);
    assert.match(html, /TIDAL/);
    assert.match(html, /UNRESOLVED/);
    assert.match(html, /No provider match/);
});

test("execute import action sends previewData instead of URL", async () => {
    const { executeImportAction } = await import("../../app/import/page");

    const previewData = {
        playlistName: "Test Playlist",
        resolved: [
            {
                index: 0,
                artist: "A1",
                title: "T1",
                source: "local" as const,
                confidence: 100,
                trackId: "track_1",
            },
        ],
        summary: { total: 1, local: 1, youtube: 0, tidal: 0, unresolved: 0 },
    };

    await executeImportAction({
        previewData,
        name: "  Imported Playlist  ",
    });

    assert.equal(executeCalls.length, 1);
    assert.deepEqual(executeCalls[0].previewData, previewData);
    assert.equal(executeCalls[0].name, "Imported Playlist");
});

test("isSupportedPlaylistUrl accepts Spotify intl playlist URLs", async () => {
    const { isSupportedPlaylistUrl } = await import("../../app/import/page");
    const intlSpotifyUrl =
        "https://open.spotify.com/intl-en/playlist/37i9dQZF1DXcBWIGoYBM5M";

    assert.equal(isSupportedPlaylistUrl(intlSpotifyUrl), true);
});

test("isSupportedPlaylistUrl rejects arbitrary text containing provider host fragments", async () => {
    const { isSupportedPlaylistUrl } = await import("../../app/import/page");
    const malformedValue =
        "not-a-url open.spotify.com/playlist/ definitely-not-valid";

    assert.equal(isSupportedPlaylistUrl(malformedValue), false);
});

test("isSupportedPlaylistUrl rejects non-HTTP executable URL schemes", async () => {
    const { isSupportedPlaylistUrl } = await import("../../app/import/page");
    const unsafeUrls = [
        "javascript://open.spotify.com/playlist/playlist123",
        "data://open.spotify.com/playlist/playlist123",
        "vbscript://open.spotify.com/playlist/playlist123",
    ];

    for (const unsafeUrl of unsafeUrls) {
        assert.equal(isSupportedPlaylistUrl(unsafeUrl), false, unsafeUrl);
    }
});

test("playlist preview anchor renders only the canonical HTTP(S) URL", async () => {
    const cases = [
        {
            input: "  HTTP://OPEN.SPOTIFY.COM:80/playlist/AbC123  ",
            canonical: "http://open.spotify.com/playlist/AbC123",
        },
        {
            input: "HTTPS://MUSIC.YOUTUBE.COM:443/playlist?list=PL123",
            canonical: "https://music.youtube.com/playlist?list=PL123",
        },
    ];

    for (const testCase of cases) {
        const harness = await mountImportPage();
        try {
            const input = harness.container.querySelector(
                'input[placeholder^="Paste a Spotify"]',
            );
            assert.ok(
                input instanceof HTMLInputElement,
                "playlist input missing",
            );

            await React.act(async () => {
                typeInto(input, testCase.input);
            });
            await click(findButton(harness.container, "Preview Import"));

            assert.equal(previewCalls.at(-1), testCase.canonical);
            const anchor = harness.container.querySelector(
                'a[target="_blank"]',
            );
            assert.ok(
                anchor instanceof HTMLAnchorElement,
                "preview anchor missing",
            );
            assert.equal(anchor.getAttribute("href"), testCase.canonical);
        } finally {
            await harness.unmount();
        }
    }
});
