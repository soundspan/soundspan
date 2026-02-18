import assert from "node:assert/strict";
import test from "node:test";
import {
    hasMyHistoryLink,
    MOBILE_QUICK_LINKS,
    SIDEBAR_NAVIGATION,
} from "../../components/layout/socialNavigation.ts";

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
