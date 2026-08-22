import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { createFrontendLogger } from "@/lib/logger";
import {
    resolveDownloadErrorBackoffMs,
    resolveDownloadPollDelayMs,
} from "@/hooks/downloadStatusPolling";

const logger = createFrontendLogger("Hooks.useDownloadStatus");

export interface DownloadJob {
    id: string;
    type: "artist" | "album";
    subject: string;
    targetMbid: string;
    status: "pending" | "processing" | "completed" | "failed";
    createdAt: string;
    completedAt?: string;
    error?: string;
    metadata?: {
        statusText?: string;
        currentSource?: "lidarr" | "soulseek" | "tidal" | "youtube";
        lidarrAttempts?: number;
        soulseekAttempts?: number;
    };
}

export interface DownloadStatus {
    activeDownloads: DownloadJob[];
    recentDownloads: DownloadJob[];
    hasActiveDownloads: boolean;
    failedDownloads: DownloadJob[];
}

function classifyDownloads(
    downloads: DownloadJob[],
    now: Date,
): DownloadStatus {
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const activeDownloads = downloads.filter(
        (job) => job.status === "pending" || job.status === "processing",
    );
    const isRecent = (job: DownloadJob) =>
        new Date(job.completedAt || job.createdAt) > fiveMinutesAgo;
    const recentDownloads = downloads.filter(
        (job) =>
            (job.status === "completed" || job.status === "failed") &&
            isRecent(job),
    );
    const failedDownloads = downloads.filter(
        (job) => job.status === "failed" && isRecent(job),
    );

    return {
        activeDownloads,
        recentDownloads,
        hasActiveDownloads: activeDownloads.length > 0,
        failedDownloads,
    };
}

interface DownloadPollingState {
    active: boolean;
    errorCount: number;
    pollTimeout: ReturnType<typeof setTimeout> | null;
    pollingInterval: number;
    publishStatus: (status: DownloadStatus) => void;
    poll: () => void;
}

function scheduleDownloadPoll(
    state: DownloadPollingState,
    delayMs: number,
): void {
    if (state.pollTimeout !== null) {
        clearTimeout(state.pollTimeout);
    }
    state.pollTimeout = setTimeout(state.poll, delayMs);
}

function handleDownloadPollError(
    state: DownloadPollingState,
    error: unknown,
): void {
    state.errorCount += 1;
    const backoffDelay = resolveDownloadErrorBackoffMs(
        state.pollingInterval,
        state.errorCount,
    );
    if (!(error instanceof Error) || error.message !== "Too Many Requests") {
        logger.error("Download polling error", {
            errorCount: state.errorCount,
            backoffDelay,
            error,
        });
    }
    if (state.active) scheduleDownloadPoll(state, backoffDelay);
}

function handleDownloadPollSuccess(
    state: DownloadPollingState,
    response: DownloadJob[],
): void {
    state.errorCount = 0;
    const nextStatus = classifyDownloads(response, new Date());
    state.publishStatus(nextStatus);
    if (state.active) {
        scheduleDownloadPoll(
            state,
            resolveDownloadPollDelayMs(
                nextStatus.activeDownloads.length,
                response.length,
            ),
        );
    }
}

async function pollDownloads(state: DownloadPollingState): Promise<void> {
    try {
        const response = await api.getDownloads(50);
        if (state.active) handleDownloadPollSuccess(state, response);
    } catch (error: unknown) {
        handleDownloadPollError(state, error);
    }
}

function startDownloadPolling(
    pollingInterval: number,
    publishStatus: (status: DownloadStatus) => void,
): () => void {
    const state: DownloadPollingState = {
        active: true,
        errorCount: 0,
        pollTimeout: null,
        pollingInterval,
        publishStatus,
        poll: () => undefined,
    };
    state.poll = () => void pollDownloads(state);
    const handleStatusChanged = () => {
        if (state.active) scheduleDownloadPoll(state, 0);
    };

    state.poll();
    window.addEventListener("download-status-changed", handleStatusChanged);
    return () => {
        state.active = false;
        if (state.pollTimeout !== null) clearTimeout(state.pollTimeout);
        window.removeEventListener(
            "download-status-changed",
            handleStatusChanged,
        );
    };
}

/**
 * Hook to monitor download job status
 * Polls for active downloads and keeps track of recent completions/failures
 * @param pollingInterval - How often to poll in milliseconds (default: 15000)
 * @param isAuthenticated - Whether the user is authenticated (required to prevent polling when logged out)
 */
export function useDownloadStatus(
    pollingInterval: number = 15000,
    isAuthenticated: boolean = false,
): DownloadStatus {
    const [status, setStatus] = useState<DownloadStatus>({
        activeDownloads: [],
        recentDownloads: [],
        hasActiveDownloads: false,
        failedDownloads: [],
    });

    useEffect(() => {
        if (!isAuthenticated) return;
        return startDownloadPolling(pollingInterval, setStatus);
    }, [pollingInterval, isAuthenticated]);

    return status;
}
