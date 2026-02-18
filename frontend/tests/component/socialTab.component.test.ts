import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

type MockSocialUser = {
    id: string;
    username: string;
    displayName: string;
    isInListenTogetherGroup: boolean;
    listeningTrack: {
        id: string;
        title: string;
        duration: number;
        artistName: string;
        albumTitle: string;
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
