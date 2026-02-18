import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";

export type JobType = "scan" | "discover";

export interface JobStatus {
    status: "waiting" | "active" | "completed" | "failed" | "delayed";
    progress: number;
    result?: Record<string, unknown>;
    error?: string;
}

export function useJobStatus(
    jobId: string | null,
    jobType: JobType,
    options?: {
        pollInterval?: number;
        onComplete?: (result: Record<string, unknown>) => void;
        onError?: (error: string) => void;
    }
) {
    const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
    const [isPolling, setIsPolling] = useState(false);
    const pollInterval = options?.pollInterval || 5000;
    const cancelledRef = useRef(false);

    // Store latest options in ref to avoid stale closures
    const optionsRef = useRef(options);
    useEffect(() => {
        optionsRef.current = options;
    });

    const checkStatus = useCallback(async () => {
        if (!jobId || cancelledRef.current) return;

        try {
            let statusData;
            if (jobType === "scan") {
                statusData = await api.getScanStatus(jobId);
            } else if (jobType === "discover") {
                statusData = await api.getDiscoverGenerationStatus(jobId);
            }

            if (!statusData || cancelledRef.current) return;

            setJobStatus(statusData as JobStatus);

            if (statusData.status === "completed") {
                setIsPolling(false);
                if (optionsRef.current?.onComplete && statusData.result) {
                    optionsRef.current.onComplete(statusData.result);
                }
            } else if (statusData.status === "failed") {
                setIsPolling(false);
                if (optionsRef.current?.onError) {
                    const errorMsg =
                        statusData.result?.error ||
                        "Job failed with unknown error";
                    optionsRef.current.onError(errorMsg);
                }
            }
        } catch (error: unknown) {
            if (cancelledRef.current) return;
            console.error("Error checking job status:", error);
            setIsPolling(false);
            if (optionsRef.current?.onError) {
                optionsRef.current.onError(error instanceof Error ? error.message : "Failed to check job status");
            }
        }
    }, [jobId, jobType]);

    // Start polling when jobId is set (render-time adjustment)
    const [prevJobId, setPrevJobId] = useState(jobId);
    if (jobId !== prevJobId) {
        setPrevJobId(jobId);
        if (jobId) {
            setIsPolling(true);
        }
    }

    // Poll for status updates
    useEffect(() => {
        if (!isPolling || !jobId) return;

        cancelledRef.current = false;

        // Defer initial check to avoid synchronous setState in effect
        const initialTimeout = setTimeout(checkStatus, 0);
        const interval = setInterval(checkStatus, pollInterval);

        return () => {
            cancelledRef.current = true;
            clearTimeout(initialTimeout);
            clearInterval(interval);
        };
    }, [isPolling, jobId, checkStatus, pollInterval]);

    return {
        jobStatus,
        isPolling,
        checkStatus,
    };
}
