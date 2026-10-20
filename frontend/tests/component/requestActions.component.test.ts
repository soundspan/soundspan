import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { toast } from "sonner";

type ToastCall = { kind: string; message: string };
const toastCalls: ToastCall[] = [];

// sonner ships separate CJS and ESM builds, so `mock.module("sonner")` can miss
// the copy the hook loads. Patch the shared `toast` object instead.
for (const kind of ["loading", "success", "error"] as const) {
    mock.method(toast, kind, (message: string) => {
        toastCalls.push({ kind, message });
    });
}

const httpError = (status: number, message: string) =>
    Object.assign(new Error(message), { status });

const results: {
    review: () => Promise<unknown>;
    bulkApprove: () => Promise<unknown>;
    denyStale: () => Promise<unknown>;
} = {
    review: async () => ({ status: "approved" }),
    bulkApprove: async () => ({}),
    denyStale: async () => ({}),
};

const mutation = (run: () => Promise<unknown>) => ({
    isPending: false,
    mutateAsync: () => run(),
});

mock.module("@/hooks/useMusicRequests", {
    namedExports: {
        useReviewMusicRequest: () => mutation(() => results.review()),
        useCancelMusicRequest: () => mutation(async () => ({})),
        useBulkApproveMusicRequests: () =>
            mutation(() => results.bulkApprove()),
        useDenyStaleMusicRequests: () => mutation(() => results.denyStale()),
    },
});

beforeEach(() => {
    toastCalls.length = 0;
});

type Actions = ReturnType<
    typeof import("../../features/requests/hooks/useRequestActions").useRequestActions
>;

async function loadActions(): Promise<Actions> {
    const { useRequestActions } =
        await import("../../features/requests/hooks/useRequestActions");
    const captured: { current: Actions | null } = { current: null };
    function Probe() {
        captured.current = useRequestActions();
        return null;
    }
    renderToStaticMarkup(React.createElement(Probe));
    assert.ok(captured.current, "hook did not render");
    return captured.current;
}

async function flush(): Promise<void> {
    for (let index = 0; index < 5; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

const STILL_RUNNING =
    "This is taking a while. The server keeps working on it — refresh the list in a minute to see the result.";

test("a timed-out approve-all says the batch is still running", async () => {
    results.bulkApprove = async () => {
        throw httpError(408, "Request timed out after 85000ms");
    };
    const actions = await loadActions();
    actions.approveAll("user-1", "alice");
    await flush();

    assert.deepEqual(toastCalls.at(-1), {
        kind: "error",
        message: STILL_RUNNING,
    });
});

test("a proxy timeout on decline-stale says the batch is still running", async () => {
    results.denyStale = async () => {
        throw httpError(504, "Upstream request timed out");
    };
    const actions = await loadActions();
    actions.declineStale(30, "");
    await flush();

    assert.deepEqual(toastCalls.at(-1), {
        kind: "error",
        message: STILL_RUNNING,
    });
});

test("other bulk failures keep the server's message", async () => {
    results.bulkApprove = async () => {
        throw httpError(403, "Admin access required");
    };
    const actions = await loadActions();
    actions.approveAll("user-1", "alice");
    await flush();

    assert.deepEqual(toastCalls.at(-1), {
        kind: "error",
        message: "Admin access required",
    });
});

test("approving an album that is already owned says it was fulfilled", async () => {
    results.review = async () => ({ status: "fulfilled" });
    const actions = await loadActions();
    actions.approve({
        id: "req-1",
        status: "pending",
    } as Parameters<Actions["approve"]>[0]);
    await flush();

    assert.deepEqual(toastCalls.at(-1), {
        kind: "success",
        message: "Already in the library — request fulfilled",
    });
});
