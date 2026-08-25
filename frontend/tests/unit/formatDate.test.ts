import assert from "node:assert/strict";
import test from "node:test";
import { formatDate, formatRelativeDate } from "../../utils/formatTime";

test("formatDate renders a short en-US calendar date", () => {
    assert.equal(formatDate("2026-01-05T12:00:00Z"), "Jan 5, 2026");
});

test("formatDate accepts Date and epoch inputs", () => {
    const date = new Date("2025-12-31T12:00:00Z");
    assert.equal(formatDate(date), formatDate(date.getTime()));
});

test("formatRelativeDate labels today and tomorrow", () => {
    const now = new Date();
    assert.equal(formatRelativeDate(now), "Today");
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    assert.equal(formatRelativeDate(tomorrow), "Tomorrow");
});

test("formatRelativeDate counts near-future and near-past days", () => {
    const now = new Date();
    const inThree = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    assert.equal(formatRelativeDate(inThree), "In 3 days");
    const twoAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000 - 60000);
    assert.equal(formatRelativeDate(twoAgo), "2 days ago");
});

test("formatRelativeDate falls back to a calendar date beyond a week", () => {
    const now = new Date();
    const farPast = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const rendered = formatRelativeDate(farPast);
    // Month + day always present; the year appears only when it differs.
    assert.match(rendered, /^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$/);
    const differentYear = new Date("2000-06-15T12:00:00Z");
    assert.match(formatRelativeDate(differentYear), /, 2000$/);
});
