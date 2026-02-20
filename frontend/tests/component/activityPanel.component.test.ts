import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = {
    userRole: "admin" as "admin" | "user",
    unreadCount: 0,
    downloads: [] as Array<{ id: string }>,
    socialUsers: [] as Array<{ id: string }>,
    isMobile: false,
    isTablet: false,
    notificationHookOptions: [] as Array<{ enabled?: boolean } | undefined>,
    activeDownloadsHookOptions: [] as Array<{ enabled?: boolean } | undefined>,
    socialPresenceHookOptions: [] as Array<{ enabled?: boolean } | undefined>,
};

const Icon = () => React.createElement("i");
const tab = (name: string) => {
    const MockTab = function MockTab() {
        return React.createElement("div", null, name);
    };
    MockTab.displayName = `Mock${name}`;
    return MockTab;
};

mock.module("@/hooks/useNotifications", {
    namedExports: {
        useNotifications: (options?: { enabled?: boolean }) => {
            state.notificationHookOptions.push(options);
            return { unreadCount: state.unreadCount };
        },
        useActiveDownloads: (options?: { enabled?: boolean }) => {
            state.activeDownloadsHookOptions.push(options);
            return { downloads: state.downloads };
        },
    },
});

mock.module("@/hooks/useSocialPresence", {
    namedExports: {
        useSocialPresence: (options?: { enabled?: boolean }) => {
            state.socialPresenceHookOptions.push(options);
            return { users: state.socialUsers };
        },
    },
});

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({ user: { role: state.userRole } }),
    },
});

mock.module("@/lib/download-context", {
    namedExports: {
        useDownloadContext: () => ({
            pendingDownloads: [],
            downloadStatus: {
                activeDownloads: state.downloads,
                recentDownloads: [],
                hasActiveDownloads: state.downloads.length > 0,
                failedDownloads: [],
            },
            downloadsEnabled: true,
        }),
    },
});

mock.module("@/hooks/useMediaQuery", {
    namedExports: {
        useIsMobile: () => state.isMobile,
        useIsTablet: () => state.isTablet,
    },
});

mock.module("@/components/activity/NotificationsTab", {
    namedExports: {
        NotificationsTab: tab("notifications-tab"),
    },
});

mock.module("@/components/activity/ActiveDownloadsTab", {
    namedExports: {
        ActiveDownloadsTab: tab("active-tab"),
    },
});

mock.module("@/components/activity/HistoryTab", {
    namedExports: {
        HistoryTab: tab("history-tab"),
    },
});

mock.module("@/components/activity/SocialTab", {
    namedExports: {
        SocialTab: tab("social-tab"),
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

mock.module("lucide-react", {
    namedExports: {
        Bell: Icon,
        Download: Icon,
        History: Icon,
        Users: Icon,
        ChevronLeft: Icon,
        ChevronRight: Icon,
        X: Icon,
    },
});

beforeEach(() => {
    state.userRole = "admin";
    state.unreadCount = 0;
    state.downloads = [];
    state.socialUsers = [];
    state.isMobile = false;
    state.isTablet = false;
    state.notificationHookOptions = [];
    state.activeDownloadsHookOptions = [];
    state.socialPresenceHookOptions = [];
});

test("shows all tabs for admin users on desktop", async () => {
    state.unreadCount = 3;
    state.downloads = [{ id: "d1" }];
    state.socialUsers = [{ id: "u1" }];

    const { ActivityPanel } = await import(
        "../../components/layout/ActivityPanel.tsx"
    );

    const html = renderToStaticMarkup(
        React.createElement(ActivityPanel, {
            isOpen: true,
            onToggle: () => undefined,
        })
    );

    assert.match(html, />Notifications</);
    assert.match(html, />Active</);
    assert.match(html, />History</);
    assert.match(html, />Social</);
    assert.match(html, /notifications-tab/);
    assert.equal(
        state.notificationHookOptions.some((options) => options?.enabled === true),
        true
    );
    assert.equal(
        state.socialPresenceHookOptions.some((options) => options?.enabled === true),
        true
    );
});

test("hides admin-only tabs for non-admin users and falls back from hidden active tab", async () => {
    state.userRole = "user";
    state.socialUsers = [{ id: "u1" }];

    const { ActivityPanel } = await import(
        "../../components/layout/ActivityPanel.tsx"
    );

    const html = renderToStaticMarkup(
        React.createElement(ActivityPanel, {
            isOpen: true,
            onToggle: () => undefined,
            activeTab: "active",
        })
    );

    assert.match(html, />Notifications</);
    assert.match(html, />Social</);
    assert.doesNotMatch(html, />Active</);
    assert.doesNotMatch(html, />History</);
    assert.match(html, /notifications-tab/);
});

test("renders mobile overlay with social content and capped badges", async () => {
    state.isMobile = true;
    state.unreadCount = 120;
    state.downloads = Array.from({ length: 101 }, (_, index) => ({
        id: `d-${index}`,
    }));
    state.socialUsers = Array.from({ length: 101 }, (_, index) => ({
        id: `u-${index}`,
    }));

    const { ActivityPanel } = await import(
        "../../components/layout/ActivityPanel.tsx"
    );

    const html = renderToStaticMarkup(
        React.createElement(ActivityPanel, {
            isOpen: true,
            onToggle: () => undefined,
            activeTab: "social",
        })
    );

    assert.match(html, /title="Close"/);
    assert.match(html, /social-tab/);
    assert.match(html, /99\+/);
});

test("renders controlled active, history, and social content", async () => {
    const { ActivityPanel } = await import(
        "../../components/layout/ActivityPanel.tsx"
    );

    const tabCases: Array<[string, "active" | "history" | "social"]> = [
        ["active-tab", "active"],
        ["history-tab", "history"],
        ["social-tab", "social"],
    ];

    for (const [expectedMarkup, activeTab] of tabCases) {
        const html = renderToStaticMarkup(
            React.createElement(ActivityPanel, {
                isOpen: true,
                onToggle: () => undefined,
                activeTab,
            })
        );

        assert.match(html, new RegExp(expectedMarkup));
    }
});

test("returns null for closed mobile panel", async () => {
    state.isMobile = true;

    const { ActivityPanel } = await import(
        "../../components/layout/ActivityPanel.tsx"
    );

    const html = renderToStaticMarkup(
        React.createElement(ActivityPanel, {
            isOpen: false,
            onToggle: () => undefined,
        })
    );

    assert.equal(html, "");
});

test("renders collapsed desktop strip without the panel badge when idle", async () => {
    const { ActivityPanel } = await import(
        "../../components/layout/ActivityPanel.tsx"
    );

    const html = renderToStaticMarkup(
        React.createElement(ActivityPanel, {
            isOpen: false,
            onToggle: () => undefined,
        })
    );

    assert.match(html, /Open activity panel/);
    assert.match(html, /translateX\(332px\)/);
    assert.doesNotMatch(html, /w-2\.5 h-2\.5/);
    assert.equal(
        state.notificationHookOptions.some((options) => options?.enabled === false),
        true
    );
    assert.equal(
        state.socialPresenceHookOptions.some((options) => options?.enabled === false),
        true
    );
});

test("activity panel toggle hides on mobile and renders on desktop", async () => {
    const { ActivityPanelToggle } = await import(
        "../../components/layout/ActivityPanel.tsx"
    );

    state.isMobile = true;
    let html = renderToStaticMarkup(React.createElement(ActivityPanelToggle));
    assert.equal(html, "");

    state.isMobile = false;
    state.unreadCount = 1;
    html = renderToStaticMarkup(React.createElement(ActivityPanelToggle));
    assert.match(html, /Toggle activity panel/);
    assert.match(html, /w-1 h-1 rounded-full/);
});

test("activity panel toggle omits badge when idle", async () => {
    const { ActivityPanelToggle } = await import(
        "../../components/layout/ActivityPanel.tsx"
    );

    const html = renderToStaticMarkup(React.createElement(ActivityPanelToggle));
    assert.doesNotMatch(html, /w-1 h-1 rounded-full/);
});

test("activity panel toggle can disable polling when panel is open", async () => {
    const { ActivityPanelToggle } = await import(
        "../../components/layout/ActivityPanel.tsx"
    );

    renderToStaticMarkup(
        React.createElement(ActivityPanelToggle, {
            pollingEnabled: false,
        })
    );

    assert.equal(
        state.notificationHookOptions.some((options) => options?.enabled === false),
        true
    );
});
