import assert from "node:assert/strict";
import test from "node:test";
import {
    hasMyHistoryLink,
    MOBILE_QUICK_LINKS,
    SIDEBAR_NAVIGATION,
} from "../../components/layout/socialNavigation";

test("sidebar and mobile navigation do not include my-history", () => {
    assert.equal(hasMyHistoryLink(SIDEBAR_NAVIGATION), false);
    assert.equal(hasMyHistoryLink(MOBILE_QUICK_LINKS), false);
});

test("hasMyHistoryLink returns true when my-history entry exists", () => {
    assert.equal(
        hasMyHistoryLink([
            { href: "/library" },
            { href: "/my-history" },
            { href: "/settings" },
        ]),
        true
    );
});

test("hasMyHistoryLink short-circuits when my-history is the first entry", () => {
    assert.equal(
        hasMyHistoryLink([
            { href: "/my-history" },
            { href: "/library" },
        ]),
        true
    );
});

test("hasMyHistoryLink returns false for empty navigation", () => {
    assert.equal(hasMyHistoryLink([]), false);
});

test("quick links and sidebar include listen together destination", () => {
    assert.equal(
        MOBILE_QUICK_LINKS.some((link) => link.href === "/listen-together"),
        true
    );
    assert.equal(
        SIDEBAR_NAVIGATION.some((link) => link.href === "/listen-together"),
        true
    );
});

test("navigation exposes explore as default landing destination", () => {
    assert.equal(
        SIDEBAR_NAVIGATION.some((link) => link.href === "/explore"),
        true
    );
    assert.equal(
        MOBILE_QUICK_LINKS.some((link) => link.href === "/explore"),
        true
    );
});

test("SIDEBAR_NAVIGATION does not include /import", () => {
    const importItem = SIDEBAR_NAVIGATION.find(
        (item) => item.href === "/import"
    );
    assert.equal(importItem, undefined, "Import should not be in sidebar");
});

test("MOBILE_QUICK_LINKS does not include /import", () => {
    const importItem = MOBILE_QUICK_LINKS.find(
        (item) => item.href === "/import"
    );
    assert.equal(importItem, undefined, "Import should not be in mobile links");
});
