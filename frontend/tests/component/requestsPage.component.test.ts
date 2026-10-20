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
        AlertTriangle: icon("alert-triangle"),
        Check: icon("check"),
        CheckCheck: icon("check-check"),
        Inbox: icon("inbox"),
        RotateCcw: icon("rotate-ccw"),
        Timer: icon("timer"),
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

interface PageQueryState {
    data:
        | {
              requests: unknown[];
              total: number;
              offset: number;
              limit: number;
          }
        | undefined;
    isLoading: boolean;
    isFetching: boolean;
    isError?: boolean;
    refetch?: () => Promise<unknown>;
}

const state: {
    auth: {
        user: { id: string; role: string } | null;
        isAuthenticated: boolean;
        isLoading: boolean;
    };
    pageQuery: PageQueryState;
    counts: { pending: number } | undefined;
    openRequests: unknown[];
    deniedCooldownDays: number | null;
    featureOff: boolean;
    calls: {
        page: Array<Record<string, unknown>>;
        counts: boolean[];
        open: boolean[];
    };
} = {
    auth: {
        user: { id: "admin-1", role: "admin" },
        isAuthenticated: true,
        isLoading: false,
    },
    pageQuery: { data: undefined, isLoading: false, isFetching: false },
    counts: undefined,
    openRequests: [],
    deniedCooldownDays: 30,
    featureOff: false,
    calls: { page: [], counts: [], open: [] },
};

function resetCalls() {
    state.calls = { page: [], counts: [], open: [] };
}

const mutation = { isPending: false, mutateAsync: async () => ({}) };

function pageOf(requests: unknown[], total = requests.length) {
    return {
        data: { requests, total, offset: 0, limit: 25 },
        isLoading: false,
        isFetching: false,
    };
}

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => state.auth,
    },
});

mock.module("@/hooks/useMusicRequests", {
    namedExports: {
        useMusicRequestsPage: (query: Record<string, unknown>) => {
            state.calls.page.push(query);
            return state.pageQuery;
        },
        useMusicRequestCounts: (enabled: boolean) => {
            state.calls.counts.push(enabled);
            return { data: state.counts };
        },
        useMyOpenMusicRequests: (enabled: boolean) => {
            state.calls.open.push(enabled);
            return { data: state.openRequests };
        },
        useRequestsFeature: () => ({
            enabled: !state.featureOff,
            off: state.featureOff,
            deniedCooldownDays: state.deniedCooldownDays,
        }),
        useReviewMusicRequest: () => mutation,
        useCancelMusicRequest: () => mutation,
        useBulkApproveMusicRequests: () => mutation,
        useDenyStaleMusicRequests: () => mutation,
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

async function renderPage(): Promise<string> {
    resetCalls();
    const { default: RequestsPage } = await import("../../app/requests/page");
    return renderToStaticMarkup(React.createElement(RequestsPage));
}

function asAdmin() {
    state.auth = {
        user: { id: "admin-1", role: "admin" },
        isAuthenticated: true,
        isLoading: false,
    };
}

function asUser() {
    state.auth = {
        user: { id: "user-1", role: "user" },
        isAuthenticated: true,
        isLoading: false,
    };
}

test("admin view lists requests with requester and review actions", async () => {
    asAdmin();
    state.counts = { pending: 4 };
    state.pageQuery = pageOf([requestRow()]);

    const html = await renderPage();

    assert.match(html, />Requests</);
    assert.match(html, />Boards of Canada</);
    assert.match(html, />Geogaddi</);
    assert.match(html, /Requested by alice/);
    assert.match(html, />Approve</);
    assert.match(html, />Decline</);
    assert.match(html, /Approve all from alice/);
    assert.match(html, />Decline stale</);
    assert.match(html, /4 pending/);
    assert.doesNotMatch(html, />Cancel</);
    assert.match(html, /aria-label="Approve Boards of Canada — Geogaddi"/);
    assert.match(html, /aria-label="Decline Boards of Canada — Geogaddi"/);
    assert.equal(state.calls.page[0]?.scope, "all");
    assert.deepEqual(state.calls.counts, [true]);
    assert.deepEqual(state.calls.open, [false]);
});

test("failed requests offer admins a retry or a decline", async () => {
    asAdmin();
    state.pageQuery = pageOf([requestRow({ status: "failed" })]);

    const html = await renderPage();

    assert.match(html, />Failed</);
    assert.match(html, />Retry</);
    assert.match(html, />Decline</);
    assert.match(html, /Retry the download, or decline the request/);
    assert.doesNotMatch(html, /Approve all from/);
});

test("admin review actions disappear for settled requests", async () => {
    asAdmin();
    state.pageQuery = pageOf([
        requestRow({ status: "fulfilled", albumId: "album-9" }),
    ]);

    const html = await renderPage();

    assert.match(html, />In library</);
    assert.match(html, /href="\/album\/album-9"[^>]*>Open album</);
    assert.doesNotMatch(html, />Approve</);
    assert.doesNotMatch(html, />Decline</);
    assert.doesNotMatch(html, />Retry</);
});

test("non-admin view shows own requests with cancel for pending", async () => {
    asUser();
    state.openRequests = [requestRow()];
    state.pageQuery = pageOf([
        requestRow(),
        requestRow({ id: "req-2", status: "denied" }),
    ]);

    const html = await renderPage();

    assert.match(html, />My Requests</);
    assert.match(html, />Cancel</);
    assert.match(html, />Declined</);
    assert.match(html, /1 pending/);
    assert.doesNotMatch(html, />Approve</);
    assert.doesNotMatch(html, /Requested by/);
    assert.doesNotMatch(html, />Decline stale</);
    assert.equal(state.calls.page[0]?.scope, "mine");
    assert.deepEqual(state.calls.counts, [false]);
    assert.deepEqual(state.calls.open, [true]);
});

test("requesters see download progress and a link once the album lands", async () => {
    asUser();
    state.pageQuery = pageOf([
        requestRow({ status: "approved", downloadStatus: "processing" }),
        requestRow({
            id: "req-2",
            status: "approved",
            downloadStatus: "pending",
        }),
        requestRow({ id: "req-3", status: "fulfilled", albumId: "album-7" }),
        requestRow({ id: "req-4", status: "failed" }),
    ]);

    const html = await renderPage();

    assert.match(html, />Approved — downloading</);
    assert.match(html, />Approved — queued</);
    assert.match(html, />In your library</);
    assert.match(html, /href="\/album\/album-7"[^>]*>Open album</);
    assert.match(html, /An admin can retry it or decline the request/);
    assert.doesNotMatch(html, />Retry</);
});

test("declined rows say when the album can be requested again", async () => {
    asUser();
    state.pageQuery = pageOf([
        requestRow({
            status: "denied",
            deniedReason: "Not this one",
            cooldownUntil: "2999-01-01T00:00:00.000Z",
        }),
    ]);

    const html = await renderPage();

    assert.match(html, /Declined: Not this one/);
    assert.match(html, /Can be requested again after/);
});

test("cooldown hints disappear when the server turned cooldowns off", async () => {
    asUser();
    state.deniedCooldownDays = 0;
    state.pageQuery = pageOf([
        requestRow({
            status: "denied",
            cooldownUntil: "2999-01-01T00:00:00.000Z",
        }),
    ]);

    const html = await renderPage();
    state.deniedCooldownDays = 30;

    assert.match(html, />Declined</);
    assert.doesNotMatch(html, /Can be requested again after/);
});

test("a server with requests turned off says so and loads nothing", async () => {
    asUser();
    state.featureOff = true;
    state.pageQuery = pageOf([]);

    const html = await renderPage();
    state.featureOff = false;

    assert.match(html, /Music requests are turned off on this server/);
    assert.doesNotMatch(html, /Try again/);
    assert.doesNotMatch(html, /Request status filter/);
    assert.equal(state.calls.page[0]?.enabled, false);
    assert.deepEqual(state.calls.open, [false]);
});

test("the fulfilled row's album link names the album", async () => {
    asUser();
    state.pageQuery = pageOf([
        requestRow({ status: "fulfilled", albumId: "album-7" }),
    ]);

    const html = await renderPage();

    assert.match(html, /aria-label="Open album Boards of Canada — Geogaddi"/);
});

test("admins get no stale-decline action while requests are off", async () => {
    asAdmin();
    state.featureOff = true;
    state.counts = { pending: 4 };
    state.pageQuery = pageOf([]);

    const html = await renderPage();
    state.featureOff = false;

    assert.match(html, /Music requests are turned off on this server/);
    assert.doesNotMatch(html, />Decline stale</);
    assert.doesNotMatch(html, /\d+ pending/);
    assert.deepEqual(state.calls.counts, [false]);
});

test("a failed list load offers a retry instead of an empty queue", async () => {
    asAdmin();
    state.pageQuery = {
        data: undefined,
        isLoading: false,
        isFetching: false,
        isError: true,
        refetch: async () => undefined,
    };

    const html = await renderPage();

    assert.match(html, /role="alert"/);
    assert.match(html, /could not be loaded/);
    assert.match(html, />Try again</);
    assert.doesNotMatch(html, /No requests yet/);
});

test("long lists page through the results", async () => {
    asAdmin();
    state.pageQuery = pageOf([requestRow()], 60);

    const html = await renderPage();

    assert.match(html, />1 \/ 3</);
    assert.match(html, />Next</);
    assert.match(html, />Last</);
});

test("request rows link to resolved artist and album pages", async () => {
    asAdmin();
    state.pageQuery = pageOf([
        requestRow({ artistId: "artist-9", albumId: "album-9" }),
    ]);

    const html = await renderPage();

    assert.match(html, /href="\/artist\/artist-9"/);
    assert.match(html, /href="\/album\/album-9"/);
});

test("unresolved request rows fall back to search links", async () => {
    asAdmin();
    state.pageQuery = pageOf([requestRow({ artistId: null, albumId: null })]);

    const html = await renderPage();

    assert.match(html, /href="\/search\?q=Boards%20of%20Canada"/);
    assert.match(html, /href="\/search\?q=Boards%20of%20Canada%20Geogaddi"/);
});

test("empty state guides users toward the library", async () => {
    asUser();
    state.openRequests = [];
    state.pageQuery = pageOf([]);

    const html = await renderPage();

    assert.match(html, /haven(&#x27;|')t requested anything yet/);
    assert.match(html, /href="\/library"/);
});
