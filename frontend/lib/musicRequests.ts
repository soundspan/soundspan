/**
 * Pure view-model helpers for the music request queue.
 *
 * No I/O — callers feed it request rows and viewer identity; it answers
 * presentation and permission questions so pages stay thin and the policy
 * stays unit-testable.
 */

export type MusicRequestStatus =
    | "pending"
    | "approved"
    | "denied"
    | "fulfilled"
    | "failed"
    | "cancelled";

export type MusicRequestFilter = "all" | MusicRequestStatus;

/** The row shape the requests surfaces need; API payloads satisfy it. */
export interface MusicRequestRowInput {
    userId: string;
    status: string;
}

export const REQUEST_STATUS_LABELS: Record<MusicRequestStatus, string> = {
    pending: "Pending",
    approved: "Approved",
    denied: "Declined",
    fulfilled: "In library",
    failed: "Failed",
    cancelled: "Cancelled",
};

export type RequestBadgeVariant =
    | "success"
    | "warning"
    | "error"
    | "info"
    | "default";

const STATUS_BADGE_VARIANTS: Record<MusicRequestStatus, RequestBadgeVariant> = {
    pending: "warning",
    approved: "info",
    fulfilled: "success",
    denied: "error",
    failed: "error",
    cancelled: "default",
};

/** Narrow an untrusted status string to the known vocabulary. */
export function toMusicRequestStatus(value: string): MusicRequestStatus | null {
    return value in REQUEST_STATUS_LABELS
        ? (value as MusicRequestStatus)
        : null;
}

/** Human label for a request status; falls back to the raw value. */
export function requestStatusLabel(status: string): string {
    const known = toMusicRequestStatus(status);
    return known ? REQUEST_STATUS_LABELS[known] : status;
}

/** Badge variant for a request status chip. */
export function requestStatusBadgeVariant(status: string): RequestBadgeVariant {
    const known = toMusicRequestStatus(status);
    return known ? STATUS_BADGE_VARIANTS[known] : "default";
}

/** Filter options for the requests page pills, in display order. */
export const REQUEST_FILTER_OPTIONS: ReadonlyArray<{
    value: MusicRequestFilter;
    label: string;
}> = [
    { value: "all", label: "All" },
    { value: "pending", label: "Pending" },
    { value: "approved", label: "Approved" },
    { value: "denied", label: "Declined" },
    { value: "fulfilled", label: "Fulfilled" },
    { value: "failed", label: "Failed" },
];

/** Applies the status filter to a request list. */
export function filterRequestRows<T extends MusicRequestRowInput>(
    rows: T[],
    filter: MusicRequestFilter,
): T[] {
    if (filter === "all") return rows;
    return rows.filter((row) => row.status === filter);
}

/** Only the requester may cancel, and only while the request is pending. */
export function canCancelRequest(
    row: MusicRequestRowInput,
    viewerId: string | undefined,
): boolean {
    return Boolean(viewerId) && row.userId === viewerId
        ? row.status === "pending"
        : false;
}

/** Admins review pending requests; every other state is settled. */
export function canReviewRequest(
    row: MusicRequestRowInput,
    isAdmin: boolean,
): boolean {
    return isAdmin && row.status === "pending";
}

/** Open requests block a duplicate submission for the same album. */
export function isOpenRequestStatus(status: string): boolean {
    return status === "pending" || status === "approved";
}
