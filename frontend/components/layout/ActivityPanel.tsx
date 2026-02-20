"use client";

import { useCallback, useMemo, useState } from "react";
import {
    useNotifications,
    type DownloadHistoryItem,
} from "@/hooks/useNotifications";
import { NotificationsTab } from "@/components/activity/NotificationsTab";
import { ActiveDownloadsTab } from "@/components/activity/ActiveDownloadsTab";
import { HistoryTab } from "@/components/activity/HistoryTab";
import { SocialTab } from "@/components/activity/SocialTab";
import { useSocialPresence } from "@/hooks/useSocialPresence";
import { useAuth } from "@/lib/auth-context";
import { useDownloadContext } from "@/lib/download-context";
import {
    getActivityPanelBadgeState,
    getActivityTabBadge,
    getVisibleActivityTabIds,
    resolveActivityTab,
    type ActivityTab,
} from "@/components/layout/activityPanelTabs";
import {
    Bell,
    Download,
    History,
    Users,
    ChevronLeft,
    ChevronRight,
    X,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";

const TABS: { id: ActivityTab; label: string; icon: React.ElementType }[] = [
    { id: "notifications", label: "Notifications", icon: Bell },
    { id: "active", label: "Active", icon: Download },
    { id: "history", label: "History", icon: History },
    { id: "social", label: "Social", icon: Users },
];
const DESKTOP_PANEL_WIDTH = 380;
const DESKTOP_COLLAPSED_STRIP_WIDTH = 48;
const DESKTOP_COLLAPSED_OFFSET =
    DESKTOP_PANEL_WIDTH - DESKTOP_COLLAPSED_STRIP_WIDTH;

interface ActivityPanelProps {
    isOpen: boolean;
    onToggle: () => void;
    activeTab?: ActivityTab;
    onTabChange?: (tab: ActivityTab) => void;
}

export function ActivityPanel({
    isOpen,
    onToggle,
    activeTab,
    onTabChange,
}: ActivityPanelProps) {
    const { user } = useAuth();
    const isAdmin = user?.role === "admin";
    const [internalActiveTab, setInternalActiveTab] =
        useState<ActivityTab>("notifications");
    const resolvedActiveTab = activeTab ?? internalActiveTab;
    const setResolvedActiveTab = onTabChange ?? setInternalActiveTab;
    const visibleTabIds = useMemo(
        () => getVisibleActivityTabIds(isAdmin),
        [isAdmin]
    );
    const visibleTabs = useMemo(
        () => TABS.filter((tab) => visibleTabIds.includes(tab.id)),
        [visibleTabIds]
    );
    const fallbackTab = visibleTabs[0]?.id ?? "notifications";
    const effectiveActiveTab = resolveActivityTab(
        resolvedActiveTab,
        visibleTabIds,
        fallbackTab
    );
    const { downloadStatus } = useDownloadContext();
    const activeDownloadsForTab = useMemo<DownloadHistoryItem[]>(
        () =>
            downloadStatus.activeDownloads.map((download) => ({
                ...download,
                updatedAt: download.completedAt ?? download.createdAt,
            })),
        [downloadStatus.activeDownloads]
    );
    const pollingEnabled = isOpen;
    const {
        notifications,
        unreadCount,
        isLoading: isNotificationsLoading,
        error: notificationsError,
        markAsRead,
        clearNotification,
        clearAll,
    } = useNotifications({ enabled: pollingEnabled });
    const {
        users: socialUsers,
        isLoading: isSocialLoading,
        error: socialError,
    } = useSocialPresence({ enabled: pollingEnabled });
    const refetchActiveDownloads = useCallback(async () => {
        window.dispatchEvent(new CustomEvent("download-status-changed"));
    }, []);
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    const badgeState = getActivityPanelBadgeState({
        unreadCount,
        activeDownloadCount: downloadStatus.activeDownloads.length,
        socialUserCount: socialUsers.length,
        isAdmin,
    });
    const { hasActivity } = badgeState;

    // Mobile/Tablet: Full-screen overlay
    if (isMobileOrTablet) {
        if (!isOpen) return null;

        return (
            <>
                {/* Backdrop */}
                <div
                    className="fixed inset-0 bg-black/60  z-[100]"
                    onClick={onToggle}
                />

                {/* Panel - slides in from right */}
                <div
                    className="fixed inset-y-0 right-0 w-full max-w-md bg-[#0a0a0a] z-[101] flex flex-col"
                    style={{ paddingTop: "env(safe-area-inset-top)" }}
                >
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-4 border-b border-white/10">
                        <h2 className="text-lg font-semibold text-white">
                            Activity
                        </h2>
                        <button
                            onClick={onToggle}
                            className="p-2 hover:bg-white/10 rounded-full transition-colors"
                            title="Close"
                        >
                            <X className="w-5 h-5 text-white/60" />
                        </button>
                    </div>

                    {/* Tabs */}
                    <div className="flex border-b border-white/10">
                        {visibleTabs.map((tab) => {
                            const Icon = tab.icon;
                            const badge = getActivityTabBadge(
                                tab.id,
                                badgeState
                            );

                            return (
                                <button
                                    key={tab.id}
                                    onClick={() => setResolvedActiveTab(tab.id)}
                                    className={cn(
                                        "flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors relative",
                                        effectiveActiveTab === tab.id
                                            ? "text-white border-b-2 border-[#60a5fa]"
                                            : "text-white/50 hover:text-white/70"
                                    )}
                                >
                                    <Icon className="w-4 h-4" />
                                    <span>{tab.label}</span>
                                    {badge && (
                                        <span
                                            className={cn(
                                                "min-w-[18px] h-[18px] px-1 rounded-full text-xs font-bold flex items-center justify-center ml-1",
                                                tab.id === "active"
                                                    ? "bg-blue-500 text-white"
                                                    : "bg-[#60a5fa] text-black"
                                            )}
                                        >
                                            {badge > 99 ? "99+" : badge}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>

                    {/* Tab Content */}
                    <div className="flex-1 overflow-hidden">
                        {effectiveActiveTab === "notifications" && (
                            <NotificationsTab
                                notifications={notifications}
                                loading={isNotificationsLoading}
                                error={notificationsError}
                                markAsRead={markAsRead}
                                clearNotification={clearNotification}
                                clearAll={clearAll}
                                queryEnabled={false}
                            />
                        )}
                        {effectiveActiveTab === "active" && (
                            <ActiveDownloadsTab
                                downloads={activeDownloadsForTab}
                                loading={false}
                                refetch={refetchActiveDownloads}
                                queryEnabled={false}
                            />
                        )}
                        {effectiveActiveTab === "history" && <HistoryTab />}
                        {effectiveActiveTab === "social" && (
                            <SocialTab
                                users={socialUsers}
                                isLoading={isSocialLoading}
                                error={socialError}
                                queryEnabled={false}
                            />
                        )}
                    </div>
                </div>
            </>
        );
    }

    // Desktop: Side panel - uses transform instead of width for GPU-accelerated animation
    return (
        <div
            className="shrink-0 h-full relative z-10"
            style={{
                width: isOpen
                    ? DESKTOP_PANEL_WIDTH
                    : DESKTOP_COLLAPSED_STRIP_WIDTH,
            }}
        >
            {/* Panel container - slides via transform (GPU-accelerated, no layout recalc) */}
            <div
                className="absolute inset-y-0 right-0 bg-[#0d0d0d] rounded-tl-lg rounded-bl-lg border-l border-white/5 flex flex-col overflow-hidden transition-transform duration-200 ease-out"
                style={{
                    width: DESKTOP_PANEL_WIDTH,
                    transform: isOpen
                        ? "translateX(0)"
                        : `translateX(${DESKTOP_COLLAPSED_OFFSET}px)`,
                    willChange: "transform",
                }}
            >
                {/* Collapsed state overlay - clickable strip on left */}
                <div
                    onClick={onToggle}
                    className={cn(
                        "absolute left-0 top-0 bottom-0 w-12 flex items-center justify-center cursor-pointer hover:bg-[#141414] transition-colors z-10",
                        isOpen && "pointer-events-none opacity-0"
                    )}
                    title="Open activity panel"
                >
                    <ChevronLeft className="w-5 h-5 text-white/40" />

                    {/* Activity badge */}
                    {hasActivity && (
                        <span className="absolute top-4 right-3 w-2.5 h-2.5 rounded-full bg-[#3b82f6]" />
                    )}
                </div>

                {/* Expanded content */}
                <div
                    className={cn(
                        "flex flex-col h-full transition-opacity duration-150",
                        isOpen ? "opacity-100" : "opacity-0 pointer-events-none"
                    )}
                >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
                    <h2 className="text-base font-semibold text-white whitespace-nowrap">
                        Activity
                    </h2>
                    <button
                        onClick={onToggle}
                        className="p-1.5 hover:bg-white/10 rounded transition-colors"
                        title="Close panel"
                    >
                        <ChevronRight className="w-5 h-5 text-white/60" />
                    </button>
                </div>

                {/* Tabs — icon-only, expand to show label on hover/active */}
                <div className="flex border-b border-white/10 px-2 gap-1">
                    {visibleTabs.map((tab) => {
                        const Icon = tab.icon;
                        const badge = getActivityTabBadge(tab.id, badgeState);
                        const isActive = effectiveActiveTab === tab.id;

                        return (
                            <button
                                key={tab.id}
                                onClick={() => setResolvedActiveTab(tab.id)}
                                className={cn(
                                    "group flex items-center justify-center gap-2 py-3 px-3 transition-all duration-200 relative",
                                    isActive
                                        ? "text-white border-b-2 border-[#3b82f6] flex-[2]"
                                        : "text-white/50 hover:text-white/70 hover:flex-[2] flex-1"
                                )}
                                title={tab.label}
                            >
                                <Icon className="w-5 h-5 shrink-0" />
                                <span
                                    className={cn(
                                        "text-sm font-medium whitespace-nowrap overflow-hidden transition-all duration-200",
                                        isActive
                                            ? "max-w-[100px] opacity-100"
                                            : "max-w-0 opacity-0 group-hover:max-w-[100px] group-hover:opacity-100"
                                    )}
                                >
                                    {tab.label}
                                </span>
                                {badge && (
                                    <span
                                        className={cn(
                                            "absolute top-1.5 right-1 min-w-[16px] h-[16px] px-0.5 rounded-full text-[10px] font-bold flex items-center justify-center",
                                            tab.id === "active"
                                                ? "bg-blue-500 text-white"
                                                : "bg-[#3b82f6] text-black"
                                        )}
                                    >
                                        {badge > 99 ? "99+" : badge}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>

                {/* Tab Content */}
                <div className="flex-1 overflow-hidden">
                    {effectiveActiveTab === "notifications" && (
                        <NotificationsTab
                            notifications={notifications}
                            loading={isNotificationsLoading}
                            error={notificationsError}
                            markAsRead={markAsRead}
                            clearNotification={clearNotification}
                            clearAll={clearAll}
                            queryEnabled={false}
                        />
                    )}
                    {effectiveActiveTab === "active" && (
                        <ActiveDownloadsTab
                            downloads={activeDownloadsForTab}
                            loading={false}
                            refetch={refetchActiveDownloads}
                            queryEnabled={false}
                        />
                    )}
                    {effectiveActiveTab === "history" && <HistoryTab />}
                    {effectiveActiveTab === "social" && (
                        <SocialTab
                            users={socialUsers}
                            isLoading={isSocialLoading}
                            error={socialError}
                            queryEnabled={false}
                        />
                    )}
                </div>
                </div>
            </div>
        </div>
    );
}

// Toggle button for TopBar
export function ActivityPanelToggle({
    pollingEnabled = true,
}: { pollingEnabled?: boolean } = {}) {
    const { downloadStatus } = useDownloadContext();
    const { unreadCount } = useNotifications({ enabled: pollingEnabled });
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();

    if (isMobile || isTablet) {
        return null;
    }

    const hasActivity =
        unreadCount > 0 || downloadStatus.activeDownloads.length > 0;

    return (
        <button
            onClick={() =>
                window.dispatchEvent(new CustomEvent("toggle-activity-panel"))
            }
            className={cn(
                "relative p-2 rounded-full transition-all",
                "text-white/60 hover:text-white"
            )}
            title="Toggle activity panel"
        >
            <Bell className="w-5 h-5" />
            {hasActivity && (
                <span className="absolute top-1.5 right-2 w-1 h-1 rounded-full bg-[#3b82f6]" />
            )}
        </button>
    );
}
