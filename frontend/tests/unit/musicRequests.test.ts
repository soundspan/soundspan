import { test } from "node:test";
import assert from "node:assert/strict";
import {
    REQUEST_FILTER_OPTIONS,
    albumRequestState,
    canCancelRequest,
    canReviewRequest,
    describeRequestSubmitError,
    formatCountBadge,
    isFinalRequestError,
    isOpenRequestStatus,
    requestAvailabilityFlags,
    requestPollInterval,
    shouldRetryRequestQuery,
    isRequestableMbid,
    requestStatusBadgeVariant,
    requestStatusLabel,
    requestsNavEntry,
    toMusicRequestStatus,
} from "@/lib/musicRequests";

const row = (userId: string, status: string) => ({ userId, status });

test("toMusicRequestStatus narrows known statuses and rejects unknowns", () => {
    assert.equal(toMusicRequestStatus("pending"), "pending");
    assert.equal(toMusicRequestStatus("fulfilled"), "fulfilled");
    assert.equal(toMusicRequestStatus("bogus"), null);
    assert.equal(toMusicRequestStatus(""), null);
});

test("requestStatusLabel maps the vocabulary and passes unknowns through", () => {
    assert.equal(requestStatusLabel("pending"), "Pending");
    assert.equal(requestStatusLabel("denied"), "Declined");
    assert.equal(requestStatusLabel("fulfilled"), "In library");
    assert.equal(requestStatusLabel("mystery"), "mystery");
});

test("requestStatusBadgeVariant maps statuses to chip variants", () => {
    assert.equal(requestStatusBadgeVariant("pending"), "warning");
    assert.equal(requestStatusBadgeVariant("approved"), "info");
    assert.equal(requestStatusBadgeVariant("fulfilled"), "success");
    assert.equal(requestStatusBadgeVariant("denied"), "error");
    assert.equal(requestStatusBadgeVariant("failed"), "error");
    assert.equal(requestStatusBadgeVariant("cancelled"), "default");
    assert.equal(requestStatusBadgeVariant("unknown"), "default");
});

test("canCancelRequest requires ownership and pending status", () => {
    assert.equal(canCancelRequest(row("u1", "pending"), "u1"), true);
    assert.equal(canCancelRequest(row("u1", "approved"), "u1"), false);
    assert.equal(canCancelRequest(row("u1", "pending"), "u2"), false);
    assert.equal(canCancelRequest(row("u1", "pending"), undefined), false);
});

test("canReviewRequest lets admins review pending and failed requests", () => {
    assert.equal(canReviewRequest(row("u1", "pending"), true), true);
    assert.equal(canReviewRequest(row("u1", "failed"), true), true);
    assert.equal(canReviewRequest(row("u1", "pending"), false), false);
    assert.equal(canReviewRequest(row("u1", "failed"), false), false);
    assert.equal(canReviewRequest(row("u1", "denied"), true), false);
    assert.equal(canReviewRequest(row("u1", "approved"), true), false);
    assert.equal(canReviewRequest(row("u1", "fulfilled"), true), false);
});

test("isOpenRequestStatus treats pending and approved as open", () => {
    assert.equal(isOpenRequestStatus("pending"), true);
    assert.equal(isOpenRequestStatus("approved"), true);
    assert.equal(isOpenRequestStatus("fulfilled"), false);
    assert.equal(isOpenRequestStatus("denied"), false);
    assert.equal(isOpenRequestStatus("cancelled"), false);
});

test("isRequestableMbid accepts real MBIDs and rejects synthetic ids", () => {
    assert.equal(
        isRequestableMbid("0befee0f-2b0b-4b52-9d41-38f0f1f74ea5"),
        true,
    );
    assert.equal(
        isRequestableMbid("0BEFEE0F-2B0B-4B52-9D41-38F0F1F74EA5"),
        true,
    );
    assert.equal(isRequestableMbid("temp-1724448000-0.123"), false);
    assert.equal(isRequestableMbid("remote:generated-hash"), false);
    assert.equal(isRequestableMbid("federation:peer:album"), false);
    assert.equal(isRequestableMbid(""), false);
    assert.equal(isRequestableMbid(null), false);
    assert.equal(isRequestableMbid(undefined), false);
});

test("filter options start with all and cover the reviewable states", () => {
    assert.equal(REQUEST_FILTER_OPTIONS[0]?.value, "all");
    const values = REQUEST_FILTER_OPTIONS.map((option) => option.value);
    for (const status of ["pending", "approved", "denied", "fulfilled"]) {
        assert.ok(values.includes(status as (typeof values)[number]));
    }
});

const openRow = (rgMbid: string, status: string, downloadStatus?: string) => ({
    rgMbid,
    status,
    downloadStatus: downloadStatus ?? null,
});

test("albumRequestState reports the caller's open request for an album", () => {
    const rows = [
        openRow("AAAA", "pending"),
        openRow("bbbb", "approved", "pending"),
        openRow("cccc", "approved", "processing"),
        openRow("dddd", "denied"),
    ];
    assert.equal(albumRequestState(rows, "aaaa"), "requested");
    assert.equal(albumRequestState(rows, "BBBB"), "approved");
    assert.equal(albumRequestState(rows, "cccc"), "downloading");
    assert.equal(albumRequestState(rows, "dddd"), null);
    assert.equal(albumRequestState(rows, "eeee"), null);
    assert.equal(albumRequestState(rows, null), null);
    assert.equal(albumRequestState(undefined, "aaaa"), null);
});

test("albumRequestState prefers the most advanced open request", () => {
    const rows = [
        openRow("aaaa", "pending"),
        openRow("aaaa", "approved", "processing"),
    ];
    assert.equal(albumRequestState(rows, "aaaa"), "downloading");
});

const formatDay = (date: Date) => date.toISOString().slice(0, 10);

function apiError(message: string, data: unknown): Error {
    return Object.assign(new Error(message), { status: 409, data });
}

test("describeRequestSubmitError explains an active decline cooldown", () => {
    const error = apiError("declined", {
        code: "recently_denied",
        retryAfter: "2026-11-18T10:00:00.000Z",
    });
    assert.equal(
        describeRequestSubmitError(error, formatDay),
        "An admin declined this album recently. You can request it again after 2026-11-18.",
    );
});

test("describeRequestSubmitError tolerates a cooldown without a usable date", () => {
    for (const retryAfter of [undefined, "not-a-date", 42]) {
        const error = apiError("declined", {
            code: "recently_denied",
            retryAfter,
        });
        assert.equal(
            describeRequestSubmitError(error, formatDay),
            "An admin declined this album recently. Try again later.",
        );
    }
});

test("describeRequestSubmitError falls back to the error message", () => {
    assert.equal(
        describeRequestSubmitError(
            apiError("Daily request limit reached", { code: "daily_cap" }),
            formatDay,
        ),
        "Daily request limit reached",
    );
    assert.equal(
        describeRequestSubmitError(new Error("boom"), formatDay),
        "boom",
    );
    assert.equal(
        describeRequestSubmitError("nope", formatDay),
        "Failed to submit the request",
    );
});

test("formatCountBadge hides empty counts and caps large ones", () => {
    assert.equal(formatCountBadge(0), null);
    assert.equal(formatCountBadge(-3), null);
    assert.equal(formatCountBadge(Number.NaN), null);
    assert.equal(formatCountBadge(undefined), null);
    assert.equal(formatCountBadge(1), "1");
    assert.equal(formatCountBadge(99), "99");
    assert.equal(formatCountBadge(100), "99+");
});

test("requestsNavEntry shows the queue to admins and own lists to users only while requests are on", () => {
    assert.deepEqual(
        requestsNavEntry({
            isAdmin: true,
            requestsEnabled: true,
            pendingCount: 4,
        }),
        { label: "Requests", badge: "4", badgeLabel: "pending requests" },
    );
    assert.deepEqual(
        requestsNavEntry({
            isAdmin: true,
            requestsEnabled: true,
            pendingCount: 1,
        }),
        { label: "Requests", badge: "1", badgeLabel: "pending request" },
    );
    assert.deepEqual(
        requestsNavEntry({
            isAdmin: true,
            requestsEnabled: true,
            pendingCount: 0,
        }),
        { label: "Requests", badge: null, badgeLabel: "pending requests" },
    );
    assert.equal(
        requestsNavEntry({
            isAdmin: true,
            requestsEnabled: false,
            pendingCount: 4,
        }),
        null,
    );
    assert.deepEqual(
        requestsNavEntry({
            isAdmin: false,
            requestsEnabled: true,
            pendingCount: 9,
        }),
        { label: "My Requests", badge: null, badgeLabel: "pending requests" },
    );
    assert.equal(
        requestsNavEntry({
            isAdmin: false,
            requestsEnabled: false,
            pendingCount: 0,
        }),
        null,
    );
});

test("buildRequestListQuery encodes only the supplied list params", async () => {
    const { buildRequestListQuery } = await import("@/lib/api/requests");
    assert.equal(buildRequestListQuery(), "");
    assert.equal(buildRequestListQuery({}), "");
    assert.equal(
        buildRequestListQuery({ status: "pending", limit: 25, offset: 50 }),
        "?status=pending&limit=25&offset=50",
    );
    assert.equal(buildRequestListQuery({ offset: 0 }), "?offset=0");
});

const httpError = (status: number) =>
    Object.assign(new Error(`HTTP ${status}`), { status });

test("isFinalRequestError treats only 403 and 404 as settled answers", () => {
    assert.equal(isFinalRequestError(httpError(404)), true);
    assert.equal(isFinalRequestError(httpError(403)), true);
    assert.equal(isFinalRequestError(httpError(500)), false);
    assert.equal(isFinalRequestError(httpError(408)), false);
    assert.equal(isFinalRequestError(new Error("network")), false);
    assert.equal(isFinalRequestError(null), false);
});

test("shouldRetryRequestQuery retries transient failures a bounded number of times", () => {
    assert.equal(shouldRetryRequestQuery(0, httpError(502)), true);
    assert.equal(shouldRetryRequestQuery(2, httpError(502)), true);
    assert.equal(shouldRetryRequestQuery(3, httpError(502)), false);
    assert.equal(shouldRetryRequestQuery(0, httpError(404)), false);
    assert.equal(shouldRetryRequestQuery(0, httpError(403)), false);
});

test("requestPollInterval keeps polling through transient errors only", () => {
    assert.equal(requestPollInterval(true, "success", null, 60_000), 60_000);
    assert.equal(
        requestPollInterval(true, "error", httpError(502), 60_000),
        60_000,
    );
    assert.equal(
        requestPollInterval(true, "error", httpError(404), 60_000),
        false,
    );
    assert.equal(requestPollInterval(false, "success", null, 60_000), false);
});

test("requestAvailabilityFlags lets a settled off answer win over cached data", () => {
    assert.deepEqual(requestAvailabilityFlags({ enabled: true }, false, null), {
        enabled: true,
        off: false,
    });
    assert.deepEqual(
        requestAvailabilityFlags({ enabled: true }, true, httpError(404)),
        { enabled: false, off: true },
    );
    assert.deepEqual(
        requestAvailabilityFlags({ enabled: true }, true, httpError(502)),
        { enabled: true, off: false },
    );
    assert.deepEqual(
        requestAvailabilityFlags({ enabled: false }, false, null),
        {
            enabled: false,
            off: true,
        },
    );
    assert.deepEqual(requestAvailabilityFlags(undefined, false, null), {
        enabled: false,
        off: false,
    });
});
