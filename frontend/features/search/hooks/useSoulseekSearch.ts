import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import type { SoulseekResult } from "../types";

interface UseSoulseekSearchProps {
    query: string;
}

interface UseSoulseekSearchReturn {
    soulseekResults: SoulseekResult[];
    isSoulseekSearching: boolean;
    isSoulseekPolling: boolean;
    soulseekEnabled: boolean;
    downloadingFiles: Set<string>;
    handleDownload: (result: SoulseekResult) => Promise<void>;
}

export function useSoulseekSearch({
    query,
}: UseSoulseekSearchProps): UseSoulseekSearchReturn {
    const [soulseekResults, setSoulseekResults] = useState<SoulseekResult[]>([]);
    const [isSoulseekSearching, setIsSoulseekSearching] = useState(false);
    const [isSoulseekPolling, setIsSoulseekPolling] = useState(false);
    const [soulseekEnabled, setSoulseekEnabled] = useState(false);
    const [downloadingFiles, setDownloadingFiles] = useState<Set<string>>(new Set());

    const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        const checkSoulseekStatus = async () => {
            try {
                const status = await api.getSlskdStatus();
                setSoulseekEnabled(Boolean(status.enabled));
            } catch (error) {
                console.error("Failed to check Soulseek status:", error);
                setSoulseekEnabled(false);
            }
        };

        checkSoulseekStatus();
    }, []);

    // Soulseek search with polling
    useEffect(() => {
        if (!query.trim() || !soulseekEnabled) {
            setSoulseekResults([]);
            return;
        }

        const abortController = new AbortController();
        abortRef.current = abortController;

        const cleanup = () => {
            abortController.abort();
            if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
            }
            setIsSoulseekPolling(false);
        };

        const timer = setTimeout(async () => {
            if (abortController.signal.aborted) return;

            setIsSoulseekSearching(true);
            setIsSoulseekPolling(true);

            try {
                const { searchId } = await api.searchSoulseek(query);
                if (abortController.signal.aborted) return;

                setSoulseekResults([]);

                // Wait 3 seconds before polling (give search time to collect)
                await new Promise((resolve) => setTimeout(resolve, 3000));
                if (abortController.signal.aborted) return;

                setIsSoulseekSearching(false);

                let pollCount = 0;
                const maxPolls = 30; // 30 polls * 2s = 60 seconds max

                pollIntervalRef.current = setInterval(async () => {
                    if (abortController.signal.aborted) {
                        if (pollIntervalRef.current) {
                            clearInterval(pollIntervalRef.current);
                            pollIntervalRef.current = null;
                        }
                        return;
                    }

                    try {
                        const { results } = await api.getSoulseekResults(searchId);

                        if (abortController.signal.aborted) return;

                        if (results && results.length > 0) {
                            setSoulseekResults(results);
                            if (results.length >= 10) {
                                if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
                                pollIntervalRef.current = null;
                                setIsSoulseekPolling(false);
                            }
                        }

                        pollCount++;
                        if (pollCount >= maxPolls) {
                            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
                            pollIntervalRef.current = null;
                            setIsSoulseekPolling(false);
                        }
                    } catch (error) {
                        if (abortController.signal.aborted) return;
                        console.error("Error polling Soulseek results:", error);
                        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
                        pollIntervalRef.current = null;
                        setIsSoulseekPolling(false);
                    }
                }, 2000);
            } catch (error) {
                if (abortController.signal.aborted) return;
                console.error("Soulseek search error:", error);
                if (error instanceof Error && error.message?.includes("not enabled")) {
                    setSoulseekEnabled(false);
                }
                setIsSoulseekSearching(false);
                setIsSoulseekPolling(false);
            }
        }, 800);

        return () => {
            clearTimeout(timer);
            cleanup();
        };
    }, [query, soulseekEnabled]);

    const handleDownload = useCallback(async (result: SoulseekResult) => {
        try {
            setDownloadingFiles((prev) => new Set([...prev, result.filename]));

            await api.downloadFromSoulseek(
                result.username,
                result.path,
                result.filename,
                result.size,
                result.parsedArtist,
                result.parsedAlbum,
                result.parsedTitle,
            );

            if (typeof window !== "undefined") {
                window.dispatchEvent(
                    new CustomEvent("set-activity-panel-tab", { detail: { tab: "active" } }),
                );
                window.dispatchEvent(new CustomEvent("open-activity-panel"));
                window.dispatchEvent(new CustomEvent("notifications-changed"));
            }

            setTimeout(() => {
                setDownloadingFiles((prev) => {
                    const newSet = new Set(prev);
                    newSet.delete(result.filename);
                    return newSet;
                });
            }, 5000);
        } catch (error) {
            console.error("Download error:", error);
            const message =
                error instanceof Error ? error.message : "Failed to start download";
            toast.error(message);
            setDownloadingFiles((prev) => {
                const newSet = new Set(prev);
                newSet.delete(result.filename);
                return newSet;
            });
        }
    }, []);

    return {
        soulseekResults,
        isSoulseekSearching,
        isSoulseekPolling,
        soulseekEnabled,
        downloadingFiles,
        handleDownload,
    };
}
