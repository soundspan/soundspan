"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type LibraryHealthRecord } from "@/lib/api";
import { SettingsSection } from "../ui";
import { LibraryHealthDetails } from "./libraryHealthDetails";
import { usePurgeProgress } from "./usePurgeProgress";

/**
 * Admin section showing library health records for corrupt or missing tracks.
 */
export function LibraryHealthSection() {
    const [records, setRecords] = useState<LibraryHealthRecord[]>([]);
    const [total, setTotal] = useState(0);
    const [removedPendingPurgeCount, setRemovedPendingPurgeCount] = useState(0);
    const [trackRemovalRetentionDays, setTrackRemovalRetentionDays] =
        useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [isPurging, setIsPurging] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [purgeNotice, setPurgeNotice] = useState<string | null>(null);

    const loadRecords = useCallback(() => {
        void api
            .getLibraryHealth()
            .then((data) => {
                setRecords(data.records);
                setTotal(data.total);
                setRemovedPendingPurgeCount(data.removedPendingPurgeCount);
                setTrackRemovalRetentionDays(data.trackRemovalRetentionDays);
            })
            .catch(() => {
                setError("Failed to load library health records");
            })
            .finally(() => {
                setIsLoading(false);
            });
    }, []);

    useEffect(() => {
        loadRecords();
    }, [loadRecords]);

    const { progress: purgeProgress, startTracking } = usePurgeProgress(
        (finalStatus) => {
            setPurgeNotice(
                finalStatus.remaining === 0
                    ? "Purge complete."
                    : `Purge stopped with ${finalStatus.remaining} track` +
                          `${finalStatus.remaining === 1 ? "" : "s"} remaining.`,
            );
            loadRecords();
        },
    );

    const handleRefresh = () => {
        setIsLoading(true);
        setError(null);
        setPurgeNotice(null);
        loadRecords();
    };

    const handlePurgeAll = async () => {
        setIsPurging(true);
        setError(null);
        setPurgeNotice(null);
        try {
            const result = await api.purgeRemovedTracks();
            if (result.enqueued) {
                startTracking();
            } else {
                setPurgeNotice("No removed tracks to purge.");
            }
            loadRecords();
        } catch {
            setError("Failed to start the purge");
        } finally {
            setIsPurging(false);
        }
    };

    const handleDismiss = async (recordId: string) => {
        try {
            await api.dismissLibraryHealthRecord(recordId);
            const removedRecord = records.find(
                (record) => record.id === recordId,
            );
            setRecords((previous) =>
                previous.filter((record) => record.id !== recordId),
            );
            setTotal((previous) => Math.max(0, previous - 1));
            if (removedRecord?.track?.removedAt) {
                setRemovedPendingPurgeCount((previous) =>
                    Math.max(0, previous - 1),
                );
            }
        } catch {
            // Preserve the server-backed record when dismissal fails.
        }
    };

    return (
        <SettingsSection
            id="library-health"
            title="Library Health"
            description="Tracks flagged during library scans as missing from disk or having unreadable metadata."
        >
            <LibraryHealthDetails
                records={records}
                total={total}
                removedPendingPurgeCount={removedPendingPurgeCount}
                trackRemovalRetentionDays={trackRemovalRetentionDays}
                isLoading={isLoading}
                isPurging={isPurging}
                error={error}
                purgeNotice={purgeNotice}
                purgeProgress={purgeProgress}
                onRefresh={handleRefresh}
                onDismiss={(recordId) => void handleDismiss(recordId)}
                onPurgeAll={() => void handlePurgeAll()}
            />
        </SettingsSection>
    );
}
