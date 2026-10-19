"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { restoreHoldsFirstRun } from "../backupRestoreModel";

const RESTORE_HOLD_QUERY_KEY = ["restore", "status", "hold"] as const;

/**
 * While a restore runs or waits for its restart, the server answers sign-in
 * requests with 503. When `enabled` (a sign-in request failed), check the
 * restore status and send the visitor to the first-run screen, which shows
 * the restore's progress or its restart prompt. Returns true while that
 * redirect is in progress.
 */
export function useRestoreHoldRedirect(enabled: boolean): boolean {
    const router = useRouter();
    const restore = useQuery({
        queryKey: RESTORE_HOLD_QUERY_KEY,
        queryFn: () => api.getRestoreStatus(),
        enabled,
        retry: false,
    });
    const holds = Boolean(restore.data && restoreHoldsFirstRun(restore.data));

    useEffect(() => {
        if (holds) router.replace("/onboarding");
    }, [holds, router]);

    return holds;
}
