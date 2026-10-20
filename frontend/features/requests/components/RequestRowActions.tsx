"use client";

import { Check, CheckCheck, RotateCcw, X } from "lucide-react";
import type { MusicRequest } from "@/lib/api/requests";
import { canCancelRequest, canReviewRequest } from "@/lib/musicRequests";
import {
    canApproveAllFromRequester,
    requestActionLabel,
} from "../requestViewModel";

/** Row-level handlers; each receives the row it was clicked on. */
export interface RequestRowHandlers {
    onApprove: (request: MusicRequest) => void;
    onDecline: (request: MusicRequest) => void;
    onCancel: (request: MusicRequest) => void;
    onApproveAll: (request: MusicRequest) => void;
}

interface RequestRowActionsProps extends RequestRowHandlers {
    request: MusicRequest;
    isAdmin: boolean;
    viewerId: string | undefined;
    busy: boolean;
}

const PILL =
    "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50";

function ReviewButtons(props: RequestRowActionsProps) {
    const retry = props.request.status === "failed";
    return (
        <>
            <button
                type="button"
                onClick={() => props.onApprove(props.request)}
                disabled={props.busy}
                aria-label={requestActionLabel(
                    retry ? "Retry" : "Approve",
                    props.request,
                )}
                className={`${PILL} bg-brand text-black hover:scale-105`}
                title={
                    retry ? "Start a new download for this request" : undefined
                }
            >
                {retry ? (
                    <RotateCcw className="h-3.5 w-3.5" />
                ) : (
                    <Check className="h-3.5 w-3.5" />
                )}
                {retry ? "Retry" : "Approve"}
            </button>
            <button
                type="button"
                onClick={() => props.onDecline(props.request)}
                disabled={props.busy}
                aria-label={requestActionLabel("Decline", props.request)}
                className={`${PILL} bg-white/10 text-white hover:bg-red-500/20 hover:text-red-300`}
            >
                <X className="h-3.5 w-3.5" />
                Decline
            </button>
        </>
    );
}

function ApproveAllButton(props: RequestRowActionsProps) {
    const username = props.request.user?.username ?? "";
    return (
        <button
            type="button"
            onClick={() => props.onApproveAll(props.request)}
            disabled={props.busy}
            className={`${PILL} bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white`}
            title={`Approve every pending request from ${username}`}
        >
            <CheckCheck className="h-3.5 w-3.5" />
            Approve all from {username}
        </button>
    );
}

/** Approve/retry, decline, approve-all, or cancel, as the viewer may. */
export function RequestRowActions(props: RequestRowActionsProps) {
    const showReview = canReviewRequest(props.request, props.isAdmin);
    const showApproveAll = canApproveAllFromRequester(
        props.request,
        props.isAdmin,
    );
    const showCancel =
        !props.isAdmin && canCancelRequest(props.request, props.viewerId);
    if (!showReview && !showApproveAll && !showCancel) return null;
    return (
        <div className="flex flex-wrap items-center gap-2">
            {showReview && <ReviewButtons {...props} />}
            {showApproveAll && <ApproveAllButton {...props} />}
            {showCancel && (
                <button
                    type="button"
                    onClick={() => props.onCancel(props.request)}
                    disabled={props.busy}
                    aria-label={requestActionLabel("Cancel", props.request)}
                    className={`${PILL} bg-white/10 text-white hover:bg-white/15`}
                >
                    Cancel
                </button>
            )}
        </div>
    );
}
