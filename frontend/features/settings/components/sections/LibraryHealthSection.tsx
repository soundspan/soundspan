"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type LibraryHealthRecord } from "@/lib/api";
import { SettingsSection } from "../ui";
import { LibraryHealthDetails } from "./libraryHealthDetails";

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
    const [error, setError] = useState<string | null>(null);

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

    const handleRefresh = () => {
        setIsLoading(true);
        setError(null);
        loadRecords();
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
                error={error}
                onRefresh={handleRefresh}
                onDismiss={(recordId) => void handleDismiss(recordId)}
            />
        </SettingsSection>
    );
}
