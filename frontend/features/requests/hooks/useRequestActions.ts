"use client";

import { toast } from "sonner";
import {
    useBulkApproveMusicRequests,
    useCancelMusicRequest,
    useDenyStaleMusicRequests,
    useReviewMusicRequest,
} from "@/hooks/useMusicRequests";
import type { MusicRequest } from "@/lib/api/requests";
import {
    approveSuccessMessage,
    bulkActionErrorMessage,
    bulkApproveSummary,
    staleDenySummary,
} from "../requestViewModel";

interface ToastMessages<T> {
    loading: string;
    success: (result: T) => string;
    error?: (error: unknown) => string;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Something went wrong";
}

/** Run one request mutation behind a loading → success/error toast. */
function runWithToast<T>(
    toastId: string,
    run: () => Promise<T>,
    messages: ToastMessages<T>,
): void {
    toast.loading(messages.loading, { id: toastId });
    run()
        .then((result) =>
            toast.success(messages.success(result), { id: toastId }),
        )
        .catch((error: unknown) =>
            toast.error((messages.error ?? errorMessage)(error), {
                id: toastId,
            }),
        );
}

/** Toast-wrapped request actions shared by the requests page rows and dialogs. */
export function useRequestActions() {
    const review = useReviewMusicRequest();
    const cancel = useCancelMusicRequest();
    const bulkApprove = useBulkApproveMusicRequests();
    const denyStale = useDenyStaleMusicRequests();

    return {
        busy:
            review.isPending ||
            cancel.isPending ||
            bulkApprove.isPending ||
            denyStale.isPending,
        approve: (request: MusicRequest) =>
            runWithToast(
                `request-approve-${request.id}`,
                () => review.mutateAsync({ id: request.id, action: "approve" }),
                {
                    loading:
                        request.status === "failed"
                            ? "Retrying the download..."
                            : "Approving request...",
                    success: (result) => approveSuccessMessage(result.status),
                },
            ),
        decline: (request: MusicRequest, reason: string) =>
            runWithToast(
                `request-deny-${request.id}`,
                () =>
                    review.mutateAsync({
                        id: request.id,
                        action: "deny",
                        reason: reason || undefined,
                    }),
                {
                    loading: "Declining request...",
                    success: () => "Request declined",
                },
            ),
        cancel: (request: MusicRequest) =>
            runWithToast(
                `request-cancel-${request.id}`,
                () => cancel.mutateAsync(request.id),
                {
                    loading: "Cancelling request...",
                    success: () => "Request cancelled",
                },
            ),
        approveAll: (userId: string, username: string) =>
            runWithToast(
                `request-approve-all-${userId}`,
                () => bulkApprove.mutateAsync(userId),
                {
                    loading: `Approving ${username}'s requests...`,
                    success: (result) => bulkApproveSummary(username, result),
                    error: bulkActionErrorMessage,
                },
            ),
        declineStale: (olderThanDays: number, reason: string) =>
            runWithToast(
                "request-deny-stale",
                () =>
                    denyStale.mutateAsync({
                        olderThanDays,
                        reason: reason || undefined,
                    }),
                {
                    loading: "Declining stale requests...",
                    success: staleDenySummary,
                    error: bulkActionErrorMessage,
                },
            ),
    };
}
