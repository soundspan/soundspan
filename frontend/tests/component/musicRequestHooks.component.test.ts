import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
// Static import so the test and the hooks share one React Query build (a
// dynamic import would load the ESM build and miss the hooks' context).
import {
    environmentManager,
    QueryClient,
    QueryClientProvider,
    type QueryKey,
} from "@tanstack/react-query";

GlobalRegistrator.register({ url: "http://localhost/requests" });
// React Query decided it runs on a server when it loaded (before happy-dom
// created `window`); force client mode so polling and retry behave as in a
// browser.
environmentManager.setIsServer(() => false);
(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const httpError = (status: number) =>
    Object.assign(new Error(`HTTP ${status}`), { status });

const state: {
    user: { id: string; role: string };
    availability: () => Promise<unknown>;
    availabilityCalls: number;
    counts: () => Promise<unknown>;
    calls: {
        counts: number;
        mine: Array<Record<string, unknown>>;
        all: Array<Record<string, unknown>>;
    };
} = {
    user: { id: "admin-1", role: "admin" },
    availability: async () => ({ enabled: true, deniedCooldownDays: 30 }),
    availabilityCalls: 0,
    counts: async () => ({ pending: 3 }),
    calls: { counts: 0, mine: [], all: [] },
};

const page = (requests: unknown[]) => ({
    requests,
    total: requests.length,
    offset: 0,
    limit: 100,
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getRequestAvailability: () => {
                state.availabilityCalls += 1;
                return state.availability();
            },
            getMusicRequestCounts: () => {
                state.calls.counts += 1;
                return state.counts();
            },
            getMyMusicRequests: async (params: Record<string, unknown>) => {
                state.calls.mine.push(params);
                return page([
                    { id: `mine-${String(params.status)}`, rgMbid: "rg" },
                ]);
            },
            getMusicRequests: async (params: Record<string, unknown>) => {
                state.calls.all.push(params);
                return page([]);
            },
        },
    },
});

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({ user: state.user, isAuthenticated: true }),
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
    state.user = { id: "admin-1", role: "admin" };
    state.availability = async () => ({
        enabled: true,
        deniedCooldownDays: 30,
    });
    state.availabilityCalls = 0;
    state.counts = async () => ({ pending: 3 });
    state.calls = { counts: 0, mine: [], all: [] };
});

/** The refetch interval a mounted hook wired into a query, as it stands now. */
function wiredPollInterval(client: QueryClient, queryKey: QueryKey) {
    const query = client.getQueryCache().find({ queryKey });
    assert.ok(query, "query was not created");
    const interval = query.observers[0]?.options.refetchInterval;
    return typeof interval === "function" ? interval(query) : interval;
}

async function settle(done: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 50 && !done(); attempt += 1) {
        await React.act(
            async () => new Promise((resolve) => setTimeout(resolve, 5)),
        );
    }
}

async function mountHook<T>(useHook: () => T) {
    const { createRoot } = await import("react-dom/client");
    const client = new QueryClient({
        defaultOptions: { queries: { retryDelay: 0 } },
    });
    const latest: { current: T | undefined } = { current: undefined };
    function Probe() {
        latest.current = useHook();
        return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () =>
        root.render(
            React.createElement(
                QueryClientProvider,
                { client },
                React.createElement(Probe),
            ),
        ),
    );
    return {
        client,
        latest: () => latest.current,
        unmount: async () => {
            await React.act(async () => root.unmount());
            client.clear();
            container.remove();
        },
    };
}

test("admins get the Requests entry with the pending count while requests are on", async () => {
    const { useRequestsNavEntry } =
        await import("../../hooks/useMusicRequests");
    const harness = await mountHook(useRequestsNavEntry);
    await settle(() => harness.latest()?.badge === "3");

    assert.deepEqual(harness.latest(), {
        label: "Requests",
        badge: "3",
        badgeLabel: "pending requests",
    });
    assert.equal(state.calls.counts, 1);
    await harness.unmount();
});

test("a server with requests off hides the entry and never polls counts", async () => {
    state.availability = async () => {
        throw httpError(404);
    };
    const { useRequestsNavEntry } =
        await import("../../hooks/useMusicRequests");
    const harness = await mountHook(useRequestsNavEntry);
    await settle(() => false);

    assert.equal(harness.latest(), null);
    assert.equal(state.calls.counts, 0);
    await harness.unmount();
});

test("other users get My Requests and no admin counts", async () => {
    state.user = { id: "user-1", role: "user" };
    const { useRequestsNavEntry } =
        await import("../../hooks/useMusicRequests");
    const harness = await mountHook(useRequestsNavEntry);
    await settle(() => harness.latest() !== null);

    assert.deepEqual(harness.latest(), {
        label: "My Requests",
        badge: null,
        badgeLabel: "pending requests",
    });
    assert.equal(state.calls.counts, 0);
    await harness.unmount();
});

test("open requests merge the caller's pending and approved pages", async () => {
    state.user = { id: "user-1", role: "user" };
    const { useMyOpenMusicRequests } =
        await import("../../hooks/useMusicRequests");
    const harness = await mountHook(() => useMyOpenMusicRequests(true));
    await settle(() => harness.latest()?.data !== undefined);

    assert.deepEqual(
        harness.latest()?.data?.map((row) => row.id),
        ["mine-pending", "mine-approved"],
    );
    assert.deepEqual(state.calls.mine, [
        { status: "pending", limit: 100 },
        { status: "approved", limit: 100 },
    ]);
    await harness.unmount();
});

test("the page query maps scope to its endpoint and all to no status filter", async () => {
    const { useMusicRequestsPage } =
        await import("../../hooks/useMusicRequests");
    const admin = await mountHook(() =>
        useMusicRequestsPage({
            scope: "all",
            status: "all",
            offset: 25,
            limit: 25,
            enabled: true,
        }),
    );
    await settle(() => state.calls.all.length > 0);
    assert.deepEqual(state.calls.all, [
        { status: undefined, limit: 25, offset: 25 },
    ]);
    await admin.unmount();

    const mine = await mountHook(() =>
        useMusicRequestsPage({
            scope: "mine",
            status: "failed",
            offset: 0,
            limit: 25,
            enabled: true,
        }),
    );
    await settle(() => state.calls.mine.length > 0);
    assert.deepEqual(state.calls.mine, [
        { status: "failed", limit: 25, offset: 0 },
    ]);
    await mine.unmount();
});

test("a 404 availability answer is final: one call, feature reported off", async () => {
    state.availability = async () => {
        throw httpError(404);
    };
    const { useRequestsFeature } = await import("../../hooks/useMusicRequests");
    const harness = await mountHook(useRequestsFeature);
    await settle(() => harness.latest()?.off === true);
    await settle(() => false);

    assert.equal(state.availabilityCalls, 1);
    assert.deepEqual(harness.latest(), {
        enabled: false,
        off: true,
        deniedCooldownDays: null,
    });
    await harness.unmount();
});

test("transient availability failures are retried until the server answers", async () => {
    let attempts = 0;
    state.availability = async () => {
        attempts += 1;
        if (attempts < 3) throw httpError(500);
        return { enabled: true, deniedCooldownDays: 7 };
    };
    const { useRequestsFeature } = await import("../../hooks/useMusicRequests");
    const harness = await mountHook(useRequestsFeature);
    await settle(() => harness.latest()?.enabled === true);

    assert.equal(state.availabilityCalls, 3);
    assert.deepEqual(harness.latest(), {
        enabled: true,
        off: false,
        deniedCooldownDays: 7,
    });
    await harness.unmount();
});

test("availability keeps rechecking each minute after server errors, never after a 404", async () => {
    const { musicRequestKeys, useRequestsFeature } =
        await import("../../hooks/useMusicRequests");
    state.availability = async () => {
        throw httpError(502);
    };
    const failing = await mountHook(useRequestsFeature);
    await settle(() => state.availabilityCalls >= 4);
    await settle(() => false);
    assert.equal(state.availabilityCalls, 4);
    assert.equal(
        wiredPollInterval(failing.client, musicRequestKeys.availability),
        60_000,
    );
    await failing.unmount();

    state.availabilityCalls = 0;
    state.availability = async () => {
        throw httpError(404);
    };
    const off = await mountHook(useRequestsFeature);
    await settle(() => off.latest()?.off === true);
    assert.equal(
        wiredPollInterval(off.client, musicRequestKeys.availability),
        false,
    );
    await off.unmount();
});

test("the admin count poll survives server errors and stops on a 404", async () => {
    const { musicRequestKeys, useMusicRequestCounts } =
        await import("../../hooks/useMusicRequests");
    state.counts = async () => {
        throw httpError(502);
    };
    const failing = await mountHook(() => useMusicRequestCounts(true));
    await settle(() => failing.latest()?.isError === true);
    assert.equal(
        wiredPollInterval(failing.client, musicRequestKeys.counts),
        60_000,
    );
    await failing.unmount();

    state.counts = async () => {
        throw httpError(404);
    };
    const off = await mountHook(() => useMusicRequestCounts(true));
    await settle(() => off.latest()?.isError === true);
    assert.equal(wiredPollInterval(off.client, musicRequestKeys.counts), false);
    await off.unmount();
});

test("a later 404 overrides a cached on answer", async () => {
    const { musicRequestKeys, useRequestsFeature } =
        await import("../../hooks/useMusicRequests");
    const harness = await mountHook(useRequestsFeature);
    await settle(() => harness.latest()?.enabled === true);

    state.availability = async () => {
        throw httpError(404);
    };
    await React.act(async () => {
        await harness.client.refetchQueries({
            queryKey: musicRequestKeys.availability,
        });
    });
    await settle(() => harness.latest()?.off === true);

    assert.deepEqual(harness.latest(), {
        enabled: false,
        off: true,
        deniedCooldownDays: 30,
    });
    await harness.unmount();
});

test("the requester gate also closes when a later 404 overrides a cached on answer", async () => {
    state.user = { id: "user-1", role: "user" };
    const { musicRequestKeys, useRequestsGate } =
        await import("../../hooks/useMusicRequests");
    const harness = await mountHook(useRequestsGate);
    await settle(() => harness.latest()?.requestsEnabled === true);

    state.availability = async () => {
        throw httpError(404);
    };
    await React.act(async () => {
        await harness.client.refetchQueries({
            queryKey: musicRequestKeys.availability,
        });
    });
    await settle(() => harness.latest()?.requestsEnabled === false);

    assert.equal(harness.latest()?.requestsEnabled, false);
    await harness.unmount();
});
