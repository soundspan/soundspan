import assert from "node:assert/strict";
import test from "node:test";
import {
    getActivityPanelBadgeState,
    getActivityTabBadge,
    getVisibleActivityTabIds,
    isActivityTabVisible,
    resolveActivityTab,
    type ActivityTab,
} from "../../components/layout/activityPanelTabs.ts";

test("admin sees every activity tab", () => {
    const visibleTabs = getVisibleActivityTabIds(true);
    assert.deepEqual(visibleTabs, [
        "notifications",
        "active",
        "history",
        "social",
    ]);
    assert.equal(isActivityTabVisible("active", true), true);
    assert.equal(isActivityTabVisible("history", true), true);
});

test("non-admin hides active/history tabs", () => {
    const visibleTabs = getVisibleActivityTabIds(false);
    assert.deepEqual(visibleTabs, ["notifications", "social"]);
    assert.equal(isActivityTabVisible("notifications", false), true);
    assert.equal(isActivityTabVisible("social", false), true);
    assert.equal(isActivityTabVisible("active", false), false);
    assert.equal(isActivityTabVisible("history", false), false);
});

test("resolveActivityTab keeps requested tab when visible", () => {
    const visibleTabs: ActivityTab[] = ["notifications", "social"];
    assert.equal(
        resolveActivityTab("social", visibleTabs, "notifications"),
        "social"
    );
});

test("resolveActivityTab falls back to first visible tab when requested tab is hidden", () => {
    const visibleTabs: ActivityTab[] = ["notifications", "social"];
    assert.equal(
        resolveActivityTab("active", visibleTabs, "notifications"),
        "notifications"
    );
});

test("resolveActivityTab uses explicit fallback when no tabs are visible", () => {
    assert.equal(resolveActivityTab("active", [], "social"), "social");
});

test("getActivityPanelBadgeState returns admin badges and activity state", () => {
    assert.deepEqual(
        getActivityPanelBadgeState({
            unreadCount: 4,
            activeDownloadCount: 2,
            socialUserCount: 1,
            isAdmin: true,
        }),
        {
            notificationBadge: 4,
            activeBadge: 2,
            socialBadge: 1,
            hasActivity: true,
        }
    );
});

test("getActivityPanelBadgeState suppresses active badge for non-admin users", () => {
    assert.deepEqual(
        getActivityPanelBadgeState({
            unreadCount: 0,
            activeDownloadCount: 3,
            socialUserCount: 0,
            isAdmin: false,
        }),
        {
            notificationBadge: null,
            activeBadge: null,
            socialBadge: null,
            hasActivity: false,
        }
    );
});

test("getActivityPanelBadgeState counts social-only activity for non-admin users", () => {
    assert.deepEqual(
        getActivityPanelBadgeState({
            unreadCount: 0,
            activeDownloadCount: 0,
            socialUserCount: 5,
            isAdmin: false,
        }),
        {
            notificationBadge: null,
            activeBadge: null,
            socialBadge: 5,
            hasActivity: true,
        }
    );
});

test("getActivityTabBadge returns the right badge for each tab branch", () => {
    const badgeState = getActivityPanelBadgeState({
        unreadCount: 9,
        activeDownloadCount: 7,
        socialUserCount: 6,
        isAdmin: true,
    });

    assert.equal(getActivityTabBadge("notifications", badgeState), 9);
    assert.equal(getActivityTabBadge("active", badgeState), 7);
    assert.equal(getActivityTabBadge("social", badgeState), 6);
    assert.equal(getActivityTabBadge("history", badgeState), null);
});
