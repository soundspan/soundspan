import { test } from "node:test";
import assert from "node:assert/strict";
import {
    STALE_REQUEST_AGE_OPTIONS,
    DEFAULT_STALE_REQUEST_AGE_DAYS,
    activeCooldownEnd,
    approveSuccessMessage,
    bulkActionErrorMessage,
    bulkApproveConfirmMessage,
    clampRequestPage,
    declineCooldownNotice,
    requestActionLabel,
    bulkApproveSummary,
    canApproveAllFromRequester,
    failedRequestHint,
    requestAlbumHref,
    requestArtistHref,
    requestPageCount,
    requestRowStatusLabel,
    staleDenySummary,
} from "@/features/requests/requestViewModel";

const statusRow = (status: string, downloadStatus?: string | null) => ({
    status,
    downloadStatus,
});

test("approved rows say whether the download is queued or running", () => {
    assert.equal(
        requestRowStatusLabel(statusRow("approved", "processing"), false),
        "Approved — downloading",
    );
    assert.equal(
        requestRowStatusLabel(statusRow("approved", "pending"), true),
        "Approved — queued",
    );
    assert.equal(
        requestRowStatusLabel(statusRow("approved", null), false),
        "Approved",
    );
    assert.equal(
        requestRowStatusLabel(statusRow("approved", "completed"), false),
        "Approved",
    );
});

test("fulfilled rows read as the viewer's library", () => {
    assert.equal(
        requestRowStatusLabel(statusRow("fulfilled"), false),
        "In your library",
    );
    assert.equal(
        requestRowStatusLabel(statusRow("fulfilled"), true),
        "In library",
    );
});

test("other statuses keep the shared labels", () => {
    assert.equal(requestRowStatusLabel(statusRow("pending"), false), "Pending");
    assert.equal(requestRowStatusLabel(statusRow("denied"), true), "Declined");
    assert.equal(requestRowStatusLabel(statusRow("failed"), true), "Failed");
    assert.equal(requestRowStatusLabel(statusRow("weird"), true), "weird");
});

const now = new Date("2026-10-19T12:00:00.000Z");

test("activeCooldownEnd returns the end of a running decline cooldown", () => {
    const end = activeCooldownEnd(
        { status: "denied", cooldownUntil: "2026-11-18T12:00:00.000Z" },
        now,
    );
    assert.equal(end?.toISOString(), "2026-11-18T12:00:00.000Z");
});

test("activeCooldownEnd is hidden when the server turned cooldowns off", () => {
    const row = { status: "denied", cooldownUntil: "2026-11-18T12:00:00.000Z" };
    assert.equal(activeCooldownEnd(row, now, 0), null);
    assert.equal(
        activeCooldownEnd(row, now, 30)?.toISOString(),
        "2026-11-18T12:00:00.000Z",
    );
    assert.equal(
        activeCooldownEnd(row, now, null)?.toISOString(),
        "2026-11-18T12:00:00.000Z",
    );
});

test("activeCooldownEnd ignores expired, missing, invalid, and non-denied rows", () => {
    const cases = [
        { status: "denied", cooldownUntil: "2026-10-01T00:00:00.000Z" },
        { status: "denied", cooldownUntil: null },
        { status: "denied" },
        { status: "denied", cooldownUntil: "garbage" },
        { status: "failed", cooldownUntil: "2026-11-18T12:00:00.000Z" },
    ];
    for (const row of cases) {
        assert.equal(activeCooldownEnd(row, now), null);
    }
});

test("failedRequestHint tells each role what happens next", () => {
    assert.equal(
        failedRequestHint(true),
        "The download did not finish. Retry the download, or decline the request.",
    );
    assert.equal(
        failedRequestHint(false),
        "The download did not finish. An admin can retry it or decline the request.",
    );
});

test("requestPageCount stops at the last page the API can serve", () => {
    assert.equal(requestPageCount(20_000, 25), 401);
    assert.equal(requestPageCount(10_025, 25), 401);
    assert.equal(requestPageCount(10_000, 25), 400);
    assert.equal(clampRequestPage(500, 20_000, 25), 401);
});

test("requestPageCount always has at least one page", () => {
    assert.equal(requestPageCount(0, 25), 1);
    assert.equal(requestPageCount(25, 25), 1);
    assert.equal(requestPageCount(26, 25), 2);
    assert.equal(requestPageCount(Number.NaN, 25), 1);
    assert.equal(requestPageCount(10, 0), 1);
});

test("approve-all is offered on pending rows that name their requester", () => {
    const pending = { status: "pending", user: { id: "u1", username: "a" } };
    assert.equal(canApproveAllFromRequester(pending, true), true);
    assert.equal(canApproveAllFromRequester(pending, false), false);
    assert.equal(
        canApproveAllFromRequester({ ...pending, status: "failed" }, true),
        false,
    );
    assert.equal(
        canApproveAllFromRequester({ status: "pending" }, true),
        false,
    );
});

test("bulkApproveSummary reports every outcome and what is left", () => {
    assert.equal(
        bulkApproveSummary("alice", {
            approved: 3,
            fulfilled: 1,
            skipped: 0,
            failed: 2,
            remaining: 4,
        }),
        "Approved 3 of alice's requests. 1 was already in the library. 2 could not be approved. 4 are still pending — run it again to continue.",
    );
    assert.equal(
        bulkApproveSummary("bob", {
            approved: 1,
            fulfilled: 0,
            skipped: 2,
            failed: 0,
            remaining: 0,
        }),
        "Approved 1 of bob's requests. 2 had already changed.",
    );
    assert.equal(
        bulkApproveSummary("cy", {
            approved: 0,
            fulfilled: 2,
            skipped: 0,
            failed: 0,
            remaining: 0,
        }),
        "Approved 0 of cy's requests. 2 were already in the library.",
    );
});

test("staleDenySummary reports declines and what is left", () => {
    assert.equal(
        staleDenySummary({ denied: 1, remaining: 0 }),
        "Declined 1 stale request.",
    );
    assert.equal(
        staleDenySummary({ denied: 200, remaining: 7 }),
        "Declined 200 stale requests. 7 more are still waiting — run it again to continue.",
    );
    assert.equal(
        staleDenySummary({ denied: 0, remaining: 0 }),
        "No pending requests were old enough to decline.",
    );
});

test("stale age presets include the default", () => {
    assert.ok(
        (STALE_REQUEST_AGE_OPTIONS as readonly number[]).includes(
            DEFAULT_STALE_REQUEST_AGE_DAYS,
        ),
    );
});

const linkRow = (overrides: Record<string, unknown> = {}) => ({
    artistName: "Boards of Canada",
    albumTitle: "Geogaddi",
    artistId: null,
    albumId: null,
    ...overrides,
});

test("request links use local pages when resolved and search otherwise", () => {
    assert.equal(
        requestArtistHref(linkRow({ artistId: "ar-1" })),
        "/artist/ar-1",
    );
    assert.equal(requestAlbumHref(linkRow({ albumId: "al-1" })), "/album/al-1");
    assert.equal(
        requestArtistHref(linkRow()),
        "/search?q=Boards%20of%20Canada",
    );
    assert.equal(
        requestAlbumHref(linkRow()),
        "/search?q=Boards%20of%20Canada%20Geogaddi",
    );
});

test("clampRequestPage pulls a page past the end back to the last page", () => {
    assert.equal(clampRequestPage(3, 50, 25), 2);
    assert.equal(clampRequestPage(2, 25, 25), 1);
    assert.equal(clampRequestPage(2, 0, 25), 1);
    assert.equal(clampRequestPage(2, 60, 25), 2);
    assert.equal(clampRequestPage(0, 60, 25), 1);
});

test("declineCooldownNotice states the cooldown the server applies", () => {
    assert.equal(
        declineCooldownNotice(30),
        "The requester is notified, and nobody can request this album again for 30 days.",
    );
    assert.equal(
        declineCooldownNotice(1),
        "The requester is notified, and nobody can request this album again for 1 day.",
    );
    assert.equal(declineCooldownNotice(0), "The requester is notified.");
    assert.equal(
        declineCooldownNotice(null),
        "The requester is notified. A re-request cooldown may also apply.",
    );
});

test("approveSuccessMessage reports an already-owned album honestly", () => {
    assert.equal(
        approveSuccessMessage("fulfilled"),
        "Already in the library — request fulfilled",
    );
    assert.equal(
        approveSuccessMessage("approved"),
        "Approved — the download is queued",
    );
});

test("bulkApproveConfirmMessage names the user and the per-run limit", () => {
    assert.equal(
        bulkApproveConfirmMessage("alice"),
        "Approve every pending request from alice? Up to 25 are approved at a time. Each one queues a download, or is marked fulfilled when the album is already in the library.",
    );
});

test("requestActionLabel names the album each row button acts on", () => {
    const request = { artistName: "Boards of Canada", albumTitle: "Geogaddi" };
    assert.equal(
        requestActionLabel("Approve", request),
        "Approve Boards of Canada — Geogaddi",
    );
    assert.equal(
        requestActionLabel("Decline", request),
        "Decline Boards of Canada — Geogaddi",
    );
});

test("bulkActionErrorMessage explains a timeout instead of implying failure", () => {
    const timeout = Object.assign(new Error("Request timed out"), {
        status: 408,
    });
    const gateway = Object.assign(new Error("Upstream timed out"), {
        status: 504,
    });
    const expected =
        "This is taking a while. The server keeps working on it — refresh the list in a minute to see the result.";
    assert.equal(bulkActionErrorMessage(timeout), expected);
    assert.equal(bulkActionErrorMessage(gateway), expected);
    assert.equal(
        bulkActionErrorMessage(
            Object.assign(new Error("Admin access required"), { status: 403 }),
        ),
        "Admin access required",
    );
    assert.equal(bulkActionErrorMessage("nope"), "Something went wrong");
});
