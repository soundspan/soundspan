import assert from "node:assert/strict";
import test from "node:test";
import {
    TV_NAVIGATION,
    getTvNavigation,
} from "../../components/layout/tvNavigation";

test("TV navigation includes the Discovery link by default", () => {
    assert.equal(
        TV_NAVIGATION.some((item) => item.href === "/discover"),
        true
    );
});

test("getTvNavigation keeps Discovery when the discovery feature is enabled", () => {
    assert.deepEqual(getTvNavigation(true), TV_NAVIGATION);
});

test("getTvNavigation removes Discovery when the discovery feature is disabled", () => {
    const items = getTvNavigation(false);
    assert.equal(
        items.some((item) => item.href === "/discover"),
        false
    );
    assert.equal(items.length, TV_NAVIGATION.length - 1);
});

test("getTvNavigation preserves the order of remaining links", () => {
    const items = getTvNavigation(false);
    assert.deepEqual(
        items,
        TV_NAVIGATION.filter((item) => item.href !== "/discover")
    );
});
