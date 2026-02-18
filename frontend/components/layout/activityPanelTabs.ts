export type ActivityTab = "notifications" | "active" | "history" | "social";

const ALL_ACTIVITY_TAB_IDS: ActivityTab[] = [
    "notifications",
    "active",
    "history",
    "social",
];

export interface ActivityPanelBadgeState {
    notificationBadge: number | null;
    activeBadge: number | null;
    socialBadge: number | null;
    hasActivity: boolean;
}

interface ActivityPanelBadgeInput {
    unreadCount: number;
    activeDownloadCount: number;
    socialUserCount: number;
    isAdmin: boolean;
}

export function getActivityPanelBadgeState({
    unreadCount,
    activeDownloadCount,
    socialUserCount,
    isAdmin,
}: ActivityPanelBadgeInput): ActivityPanelBadgeState {
    const notificationBadge = unreadCount > 0 ? unreadCount : null;
    const activeBadge =
        isAdmin && activeDownloadCount > 0 ? activeDownloadCount : null;
    const socialBadge = socialUserCount > 0 ? socialUserCount : null;

    return {
        notificationBadge,
        activeBadge,
        socialBadge,
        hasActivity:
            notificationBadge !== null ||
            activeBadge !== null ||
            socialBadge !== null,
    };
}

export function getActivityTabBadge(
    tab: ActivityTab,
    badgeState: ActivityPanelBadgeState
): number | null {
    if (tab === "notifications") {
        return badgeState.notificationBadge;
    }

    if (tab === "active") {
        return badgeState.activeBadge;
    }

    if (tab === "social") {
        return badgeState.socialBadge;
    }

    return null;
}

export function isActivityTabVisible(
    tab: ActivityTab,
    isAdmin: boolean
): boolean {
    if (isAdmin) {
        return true;
    }

    return tab !== "active" && tab !== "history";
}

export function getVisibleActivityTabIds(isAdmin: boolean): ActivityTab[] {
    return ALL_ACTIVITY_TAB_IDS.filter((tab) => isActivityTabVisible(tab, isAdmin));
}

export function resolveActivityTab(
    requestedTab: ActivityTab,
    visibleTabs: readonly ActivityTab[],
    fallbackTab: ActivityTab = "notifications"
): ActivityTab {
    if (visibleTabs.includes(requestedTab)) {
        return requestedTab;
    }

    return visibleTabs[0] ?? fallbackTab;
}
