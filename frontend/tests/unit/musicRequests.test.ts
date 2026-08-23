import { test } from "node:test";
import assert from "node:assert/strict";
import {
    REQUEST_FILTER_OPTIONS,
    canCancelRequest,
    canReviewRequest,
    filterRequestRows,
    isOpenRequestStatus,
    isRequestableMbid,
    requestStatusBadgeVariant,
    requestStatusLabel,
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

test("filterRequestRows returns everything for all and filters by status", () => {
    const rows = [
        row("u1", "pending"),
        row("u2", "denied"),
        row("u1", "fulfilled"),
    ];
    assert.equal(filterRequestRows(rows, "all").length, 3);
    assert.deepEqual(filterRequestRows(rows, "pending"), [
        row("u1", "pending"),
    ]);
    assert.deepEqual(filterRequestRows(rows, "failed"), []);
});

test("canCancelRequest requires ownership and pending status", () => {
    assert.equal(canCancelRequest(row("u1", "pending"), "u1"), true);
    assert.equal(canCancelRequest(row("u1", "approved"), "u1"), false);
    assert.equal(canCancelRequest(row("u1", "pending"), "u2"), false);
    assert.equal(canCancelRequest(row("u1", "pending"), undefined), false);
});

test("canReviewRequest requires admin and pending status", () => {
    assert.equal(canReviewRequest(row("u1", "pending"), true), true);
    assert.equal(canReviewRequest(row("u1", "pending"), false), false);
    assert.equal(canReviewRequest(row("u1", "denied"), true), false);
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
