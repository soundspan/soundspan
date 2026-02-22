"use client";

import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { createFrontendLogger } from "@/lib/logger";
import {
    resolveAdaptivePollingInterval,
    resolveFixedPollingInterval,
    resolvePollingEnabled,
} from "@/hooks/pollingCadence";

const logger = createFrontendLogger("Hooks.useNotifications");
const NOTIFICATIONS_POLL_INTERVAL_MS = 30_000;
const ACTIVE_DOWNLOADS_POLL_ACTIVE_MS = 10_000;
const ACTIVE_DOWNLOADS_POLL_IDLE_MS = 30_000;

export interface Notification {
    id: string;
    userId: string;
    type: string;
    title: string;
    message?: string;
    metadata?: Record<string, unknown>;
    read: boolean;
    cleared: boolean;
    createdAt: string;
}

export interface DownloadHistoryItem {
    id: string;
    subject: string;
    type: string;
    status: string;
    error?: string;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    metadata?: Record<string, unknown>;
}

export interface UseNotificationsReturn {
    notifications: Notification[];
    unreadCount: number;
    isLoading: boolean;
    error: string | null;
    refetch: () => Promise<unknown>;
    markAsRead: (id: string) => void;
    markAllAsRead: () => void;
    clearNotification: (id: string) => void;
    clearAll: () => void;
}

export interface UseDownloadHistoryReturn {
    history: DownloadHistoryItem[];
    isLoading: boolean;
    error: string | null;
    refetch: () => Promise<unknown>;
    clearDownload: (id: string) => Promise<void>;
    clearAll: () => Promise<void>;
    retryDownload: (id: string) => Promise<void>;
}

export interface UseActiveDownloadsReturn {
    downloads: DownloadHistoryItem[];
    isLoading: boolean;
    error: string | null;
    refetch: () => Promise<unknown>;
}

interface PollingOptions {
    enabled?: boolean;
}

/**
 * Hook for managing notifications using React Query as single source of truth.
 * All components using this hook share the same cache and update together.
 */
export function useNotifications(options: PollingOptions = {}): UseNotificationsReturn {
    const enabled = resolvePollingEnabled(options.enabled);
    const queryClient = useQueryClient();

    // Single source of truth - React Query cache
    const {
        data: notifications = [],
        isLoading,
        error,
        refetch,
    } = useQuery<Notification[]>({
        queryKey: ["notifications"],
        queryFn: () => api.get<Notification[]>("/notifications"),
        enabled,
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchInterval: resolveFixedPollingInterval(
            enabled,
            NOTIFICATIONS_POLL_INTERVAL_MS
        ),
    });

    // Derive unread count from data (computed, not stored)
    const unreadCount = notifications.filter((n) => !n.read).length;

    // Mark as read mutation with optimistic update
    const markAsReadMutation = useMutation({
        mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
        onMutate: async (id: string) => {
            await queryClient.cancelQueries({ queryKey: ["notifications"] });
            const previous = queryClient.getQueryData<Notification[]>(["notifications"]);

            queryClient.setQueryData<Notification[]>(["notifications"], (old) =>
                old?.map((n) => (n.id === id ? { ...n, read: true } : n)) || []
            );

            return { previous };
        },
        onError: (_err, _id, context) => {
            if (context?.previous) {
                queryClient.setQueryData(["notifications"], context.previous);
            }
        },
    });

    // Mark all as read mutation with optimistic update
    const markAllAsReadMutation = useMutation({
        mutationFn: () => api.post("/notifications/read-all"),
        onMutate: async () => {
            await queryClient.cancelQueries({ queryKey: ["notifications"] });
            const previous = queryClient.getQueryData<Notification[]>(["notifications"]);

            queryClient.setQueryData<Notification[]>(["notifications"], (old) =>
                old?.map((n) => ({ ...n, read: true })) || []
            );

            return { previous };
        },
        onError: (_err, _vars, context) => {
            if (context?.previous) {
                queryClient.setQueryData(["notifications"], context.previous);
            }
        },
    });

    // Clear notification mutation with optimistic update
    const clearMutation = useMutation({
        mutationFn: (id: string) => api.post(`/notifications/${id}/clear`),
        onMutate: async (id: string) => {
            await queryClient.cancelQueries({ queryKey: ["notifications"] });
            const previous = queryClient.getQueryData<Notification[]>(["notifications"]);

            queryClient.setQueryData<Notification[]>(["notifications"], (old) =>
                old?.filter((n) => n.id !== id) || []
            );

            return { previous };
        },
        onError: (_err, _id, context) => {
            if (context?.previous) {
                queryClient.setQueryData(["notifications"], context.previous);
            }
        },
    });

    // Clear all mutation with optimistic update
    const clearAllMutation = useMutation({
        mutationFn: () => api.post("/notifications/clear-all"),
        onMutate: async () => {
            await queryClient.cancelQueries({ queryKey: ["notifications"] });
            const previous = queryClient.getQueryData<Notification[]>(["notifications"]);

            queryClient.setQueryData<Notification[]>(["notifications"], []);

            return { previous };
        },
        onError: (_err, _vars, context) => {
            if (context?.previous) {
                queryClient.setQueryData(["notifications"], context.previous);
            }
        },
    });

    return {
        notifications,
        unreadCount,
        isLoading,
        error: error instanceof Error ? error.message : null,
        refetch,
        markAsRead: (id: string) => markAsReadMutation.mutate(id),
        markAllAsRead: () => markAllAsReadMutation.mutate(),
        clearNotification: (id: string) => clearMutation.mutate(id),
        clearAll: () => clearAllMutation.mutate(),
    };
}

/**
 * Hook for download history - unchanged from original
 */
export function useDownloadHistory(): UseDownloadHistoryReturn {
    const fetchHistory = useCallback(async () => {
        return api.get<DownloadHistoryItem[]>("/notifications/downloads/history");
    }, []);

    const {
        data: history = [],
        isLoading,
        error,
        refetch,
    } = useQuery<DownloadHistoryItem[]>({
        queryKey: ["download-history"],
        queryFn: fetchHistory,
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchInterval: 30000, // 30s - history doesn't need frequent updates
    });

    const queryClient = useQueryClient();

    const clearDownload = useCallback(async (id: string) => {
        try {
            await api.post(`/notifications/downloads/${id}/clear`);
            queryClient.setQueryData<DownloadHistoryItem[]>(
                ["download-history"],
                (old) => old?.filter((d) => d.id !== id) || []
            );
        } catch (err: unknown) {
            logger.error("Failed to clear download", { id, err });
        }
    }, [queryClient]);

    const clearAll = useCallback(async () => {
        try {
            await api.post("/notifications/downloads/clear-all");
            queryClient.setQueryData<DownloadHistoryItem[]>(["download-history"], []);
        } catch (err: unknown) {
            logger.error("Failed to clear all download history", { err });
        }
    }, [queryClient]);

    const retryDownload = useCallback(async (id: string) => {
        try {
            await api.post(`/notifications/downloads/${id}/retry`);
            queryClient.setQueryData<DownloadHistoryItem[]>(
                ["download-history"],
                (old) => old?.filter((d) => d.id !== id) || []
            );
        } catch (err: unknown) {
            logger.error("Failed to retry download", { id, err });
        }
    }, [queryClient]);

    return {
        history,
        isLoading,
        error: error instanceof Error ? error.message : null,
        refetch,
        clearDownload,
        clearAll,
        retryDownload,
    };
}

/**
 * Hook for active downloads with adaptive polling
 * - Polls every 10s when downloads are active (for progress updates)
 * - Polls every 30s when idle (to catch new downloads)
 */
export function useActiveDownloads(
    options: PollingOptions = {}
): UseActiveDownloadsReturn {
    const enabled = resolvePollingEnabled(options.enabled);
    const fetchDownloads = useCallback(async () => {
        return api.get<DownloadHistoryItem[]>("/notifications/downloads/active");
    }, []);

    const {
        data: downloads = [],
        isLoading,
        error,
        refetch,
    } = useQuery<DownloadHistoryItem[]>({
        queryKey: ["active-downloads"],
        queryFn: fetchDownloads,
        enabled,
        staleTime: 8_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        // Adaptive polling: 10s when active, 30s when idle
        refetchInterval: (query) => {
            const data = query.state.data;
            return resolveAdaptivePollingInterval({
                enabled,
                hasActiveItems: (data?.length ?? 0) > 0,
                activeIntervalMs: ACTIVE_DOWNLOADS_POLL_ACTIVE_MS,
                idleIntervalMs: ACTIVE_DOWNLOADS_POLL_IDLE_MS,
            });
        },
    });

    return {
        downloads,
        isLoading,
        error: error instanceof Error ? error.message : null,
        refetch,
    };
}
