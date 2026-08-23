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
        Check: icon("check"),
        Inbox: icon("inbox"),
        X: icon("x"),
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

mock.module("sonner", {
    namedExports: {
        toast: {
            loading: () => undefined,
            success: () => undefined,
            error: () => undefined,
        },
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

interface QueryState {
    data: unknown[] | undefined;
    isLoading: boolean;
}

const state: {
    auth: {
        user: { id: string; role: string } | null;
        isAuthenticated: boolean;
        isLoading: boolean;
    };
    adminQuery: QueryState;
    mineQuery: QueryState;
} = {
    auth: {
        user: { id: "admin-1", role: "admin" },
        isAuthenticated: true,
        isLoading: false,
    },
    adminQuery: { data: [], isLoading: false },
    mineQuery: { data: [], isLoading: false },
};

const mutation = { isPending: false, mutateAsync: async () => ({}) };

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => state.auth,
    },
});

mock.module("@/hooks/useMusicRequests", {
    namedExports: {
        useMusicRequestsAdmin: () => state.adminQuery,
        useMyMusicRequests: () => state.mineQuery,
        useReviewMusicRequest: () => mutation,
        useCancelMusicRequest: () => mutation,
    },
});

const requestRow = (overrides: Record<string, unknown> = {}) => ({
    id: "req-1",
    userId: "user-1",
    type: "album",
    artistName: "Boards of Canada",
    albumTitle: "Geogaddi",
    artistMbid: null,
    rgMbid: "rg-1",
    status: "pending",
    note: null,
    deniedReason: null,
    reviewedAt: null,
    downloadJobId: null,
    createdAt: "2026-08-20T12:00:00.000Z",
    updatedAt: "2026-08-20T12:00:00.000Z",
    user: { id: "user-1", username: "alice" },
    ...overrides,
});

test("admin view lists requests with requester and review actions", async () => {
    state.auth = {
        user: { id: "admin-1", role: "admin" },
        isAuthenticated: true,
        isLoading: false,
    };
    state.adminQuery = { data: [requestRow()], isLoading: false };

    const { default: RequestsPage } = await import("../../app/requests/page");
    const html = renderToStaticMarkup(React.createElement(RequestsPage));

    assert.match(html, />Requests</);
    assert.match(html, />Boards of Canada</);
    assert.match(html, />Geogaddi</);
    assert.match(html, /Requested by alice/);
    assert.match(html, />Approve</);
    assert.match(html, />Decline</);
    assert.match(html, /1 pending/);
    assert.doesNotMatch(html, />Cancel</);
});

test("admin review actions disappear for settled requests", async () => {
    state.adminQuery = {
        data: [requestRow({ status: "fulfilled" })],
        isLoading: false,
    };

    const { default: RequestsPage } = await import("../../app/requests/page");
    const html = renderToStaticMarkup(React.createElement(RequestsPage));

    assert.match(html, /In library/);
    assert.doesNotMatch(html, />Approve</);
    assert.doesNotMatch(html, />Decline</);
});

test("non-admin view shows own requests with cancel for pending", async () => {
    state.auth = {
        user: { id: "user-1", role: "user" },
        isAuthenticated: true,
        isLoading: false,
    };
    state.mineQuery = {
        data: [requestRow(), requestRow({ id: "req-2", status: "denied" })],
        isLoading: false,
    };

    const { default: RequestsPage } = await import("../../app/requests/page");
    const html = renderToStaticMarkup(React.createElement(RequestsPage));

    assert.match(html, />My Requests</);
    assert.match(html, />Cancel</);
    assert.match(html, />Declined</);
    assert.doesNotMatch(html, />Approve</);
    assert.doesNotMatch(html, /Requested by/);
});

test("request rows link to resolved artist and album pages", async () => {
    state.auth = {
        user: { id: "admin-1", role: "admin" },
        isAuthenticated: true,
        isLoading: false,
    };
    state.adminQuery = {
        data: [requestRow({ artistId: "artist-9", albumId: "album-9" })],
        isLoading: false,
    };

    const { default: RequestsPage } = await import("../../app/requests/page");
    const html = renderToStaticMarkup(React.createElement(RequestsPage));

    assert.match(html, /href="\/artist\/artist-9"/);
    assert.match(html, /href="\/album\/album-9"/);
});

test("unresolved request rows fall back to search links", async () => {
    state.adminQuery = {
        data: [requestRow({ artistId: null, albumId: null })],
        isLoading: false,
    };

    const { default: RequestsPage } = await import("../../app/requests/page");
    const html = renderToStaticMarkup(React.createElement(RequestsPage));

    assert.match(html, /href="\/search\?q=Boards%20of%20Canada"/);
    assert.match(html, /href="\/search\?q=Boards%20of%20Canada%20Geogaddi"/);
});

test("empty state guides users toward the library", async () => {
    state.auth = {
        user: { id: "user-1", role: "user" },
        isAuthenticated: true,
        isLoading: false,
    };
    state.mineQuery = { data: [], isLoading: false };

    const { default: RequestsPage } = await import("../../app/requests/page");
    const html = renderToStaticMarkup(React.createElement(RequestsPage));

    assert.match(html, /haven(&#x27;|')t requested anything yet/);
    assert.match(html, /href="\/library"/);
});
