"use client";

import { useEffect, useRef } from "react";
import {
    Bell,
    Check,
    Trash2,
    ListMusic,
    AlertCircle,
    CheckCircle,
    ExternalLink,
} from "lucide-react";
import { cn } from "@/utils/cn";
import Link from "next/link";
import {
    useNotifications,
    type Notification,
} from "@/hooks/useNotifications";
import { createFrontendLogger } from "@/lib/logger";

const logger = createFrontendLogger("Activity.NotificationsTab");

interface NotificationsTabProps {
    notifications?: Notification[];
    loading?: boolean;
    error?: string | null;
    markAsRead?: (id: string) => void;
    clearNotification?: (id: string) => void;
    clearAll?: () => void;
    queryEnabled?: boolean;
}

export function NotificationsTab({
    notifications: notificationsProp,
    loading: loadingProp,
    error: errorProp,
    markAsRead: markAsReadProp,
    clearNotification: clearNotificationProp,
    clearAll: clearAllProp,
    queryEnabled = true,
}: NotificationsTabProps = {}) {
    const previousNotificationIds = useRef<Set<string>>(new Set());
    const notificationsQuery = useNotifications({ enabled: queryEnabled });
    const notifications = notificationsProp ?? notificationsQuery.notifications;
    const loading = loadingProp ?? notificationsQuery.isLoading;
    const error = errorProp ?? notificationsQuery.error;
    const markAsRead = markAsReadProp ?? notificationsQuery.markAsRead;
    const clearNotification =
        clearNotificationProp ?? notificationsQuery.clearNotification;
    const clearAll = clearAllProp ?? notificationsQuery.clearAll;

    // Dispatch events when new playlist-related notifications arrive
    useEffect(() => {
        if (!notifications || notifications.length === 0) return;

        const currentIds = new Set(notifications.map((n) => n.id));

        // Check for new playlist-related notifications
        for (const notification of notifications) {
            if (!previousNotificationIds.current.has(notification.id)) {
                // This is a new notification
                if (
                    notification.type === "playlist_ready" ||
                    notification.type === "import_complete"
                ) {
                    window.dispatchEvent(new CustomEvent("playlist-created"));
                }
            }
        }

        previousNotificationIds.current = currentIds;
    }, [notifications]);

    // Log error if any
    if (error) {
        logger.error("Error fetching notifications", { error });
    }

    const handleMarkAsRead = (id: string) => markAsRead(id);
    const handleClear = (id: string) => clearNotification(id);
    const handleClearAll = () => clearAll();

    const getIcon = (type: string) => {
        switch (type) {
            case "download_complete":
                return <CheckCircle className="w-4 h-4 text-green-400" />;
            case "download_failed":
                return <AlertCircle className="w-4 h-4 text-red-400" />;
            case "playlist_ready":
            case "import_complete":
                return <ListMusic className="w-4 h-4 text-[#3b82f6]" />;
            case "system":
            default:
                return <Bell className="w-4 h-4 text-white/60" />;
        }
    };

    const getLink = (notification: Notification): string | null => {
        const metadata = notification.metadata as Record<string, unknown> | undefined;
        if (typeof metadata?.playlistId === "string") {
            return `/playlist/${metadata.playlistId}`;
        }
        if (typeof metadata?.albumId === "string") {
            return `/album/${metadata.albumId}`;
        }
        if (typeof metadata?.artistId === "string") {
            return `/artist/${metadata.artistId}`;
        }
        return null;
    };

    const formatTime = (dateStr: string) => {
        const date = new Date(dateStr);
        const now = new Date();
        const diff = now.getTime() - date.getTime();

        if (diff < 60000) return "Just now";
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        return date.toLocaleDateString();
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
            </div>
        );
    }

    if (notifications.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-center">
                <Bell className="w-8 h-8 text-white/20 mb-3" />
                <p className="text-sm text-white/40">No notifications</p>
                <p className="text-xs text-white/30 mt-1">
                    You&apos;re all caught up!
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Header with clear all */}
            {notifications.length > 0 && (
                <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                    <span className="text-xs text-white/40">
                        {notifications.length} notification
                        {notifications.length !== 1 ? "s" : ""}
                    </span>
                    <button
                        onClick={handleClearAll}
                        className="text-xs text-white/40 hover:text-white transition-colors"
                    >
                        Clear all
                    </button>
                </div>
            )}

            {/* Notification list */}
            <div className="flex-1 overflow-y-auto">
                {notifications.map((notification) => {
                    const link = getLink(notification);

                    return (
                        <div
                            key={notification.id}
                            className={cn(
                                "px-3 py-3 border-b border-white/5 hover:bg-white/5 transition-colors group",
                                !notification.read && "bg-white/[0.02]"
                            )}
                        >
                            <div className="flex items-start gap-3">
                                <div className="mt-0.5 flex-shrink-0">
                                    {getIcon(notification.type)}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <p
                                            className={cn(
                                                "text-sm font-medium truncate",
                                                notification.read
                                                    ? "text-white/70"
                                                    : "text-white"
                                            )}
                                        >
                                            {notification.title}
                                        </p>
                                        {!notification.read && (
                                            <span className="w-1.5 h-1.5 rounded-full bg-[#3b82f6] flex-shrink-0" />
                                        )}
                                    </div>
                                    {notification.message && (
                                        <p className="text-xs text-white/50 mt-0.5 line-clamp-2">
                                            {notification.message}
                                        </p>
                                    )}
                                    <div className="flex items-center gap-2 mt-1.5">
                                        <span className="text-[10px] text-white/30">
                                            {formatTime(notification.createdAt)}
                                        </span>
                                        {link && (
                                            <Link
                                                href={link}
                                                className="text-[10px] text-[#3b82f6] hover:underline flex items-center gap-0.5"
                                            >
                                                View{" "}
                                                <ExternalLink className="w-2.5 h-2.5" />
                                            </Link>
                                        )}
                                    </div>
                                </div>
                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    {!notification.read && (
                                        <button
                                            onClick={() =>
                                                handleMarkAsRead(
                                                    notification.id
                                                )
                                            }
                                            className="p-1 hover:bg-white/10 rounded transition-colors"
                                            title="Mark as read"
                                        >
                                            <Check className="w-3.5 h-3.5 text-white/40 hover:text-white" />
                                        </button>
                                    )}
                                    <button
                                        onClick={() =>
                                            handleClear(notification.id)
                                        }
                                        className="p-1 hover:bg-white/10 rounded transition-colors"
                                        title="Dismiss"
                                    >
                                        <Trash2 className="w-3.5 h-3.5 text-white/40 hover:text-red-400" />
                                    </button>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
