/**
 * Pure presentation helpers for the requests page.
 *
 * No I/O: callers pass request rows, viewer role, and the current time; these
 * functions answer labels, links, paging, and summary text so the page stays
 * thin and the wording stays unit-tested.
 */
import { requestStatusLabel } from "@/lib/musicRequests";

/** Rows shown per page on the requests page. */
export const REQUEST_PAGE_SIZE = 25;

/** Age presets, in days, offered when declining stale pending requests. */
export const STALE_REQUEST_AGE_OPTIONS = [7, 14, 30, 90] as const;

/** Preselected age for declining stale pending requests. */
export const DEFAULT_STALE_REQUEST_AGE_DAYS = 30;

/** Longest decline reason the API accepts. */
export const MAX_DECLINE_REASON_LENGTH = 500;

/** Status fields a request row needs for its status chip. */
export interface RequestStatusInput {
    status: string;
    downloadStatus?: string | null;
}

function approvedStatusLabel(downloadStatus?: string | null): string {
    if (downloadStatus === "processing") return "Approved — downloading";
    if (downloadStatus === "pending") return "Approved — queued";
    return "Approved";
}

/**
 * Status chip text. Approved rows say whether their download is queued or
 * running; fulfilled rows say the album is in the viewer's library.
 */
export function requestRowStatusLabel(
    row: RequestStatusInput,
    isAdmin: boolean,
): string {
    if (row.status === "approved") {
        return approvedStatusLabel(row.downloadStatus);
    }
    if (row.status === "fulfilled") {
        return isAdmin ? "In library" : "In your library";
    }
    return requestStatusLabel(row.status);
}

/**
 * End of a declined album's re-request cooldown, or null when none runs.
 * A server cooldown setting of 0 means stored end dates are not enforced.
 */
export function activeCooldownEnd(
    row: { status: string; cooldownUntil?: string | null },
    now: Date,
    deniedCooldownDays: number | null = null,
): Date | null {
    if (deniedCooldownDays === 0) return null;
    if (row.status !== "denied" || !row.cooldownUntil) return null;
    const end = new Date(row.cooldownUntil);
    if (Number.isNaN(end.getTime())) return null;
    return end.getTime() > now.getTime() ? end : null;
}

/** What happens next for a failed request, worded for the viewer's role. */
export function failedRequestHint(isAdmin: boolean): string {
    return isAdmin
        ? "The download did not finish. Retry the download, or decline the request."
        : "The download did not finish. An admin can retry it or decline the request.";
}

/** Largest list offset the request API accepts. */
export const MAX_REQUEST_OFFSET = 10_000;

/**
 * Number of pages for a result total; never less than one, and never past
 * the last page the API's offset limit can serve.
 */
export function requestPageCount(total: number, pageSize: number): number {
    if (!Number.isFinite(total) || total <= 0 || pageSize <= 0) return 1;
    const lastServablePage = Math.floor(MAX_REQUEST_OFFSET / pageSize) + 1;
    return Math.min(lastServablePage, Math.max(1, Math.ceil(total / pageSize)));
}

/** The page to show when the current one is past the end of the results. */
export function clampRequestPage(
    page: number,
    total: number,
    pageSize: number,
): number {
    return Math.min(Math.max(1, page), requestPageCount(total, pageSize));
}

/** What declining one request does, given the server's cooldown setting. */
export function declineCooldownNotice(
    deniedCooldownDays: number | null,
): string {
    if (deniedCooldownDays === null) {
        return "The requester is notified. A re-request cooldown may also apply.";
    }
    if (deniedCooldownDays <= 0) return "The requester is notified.";
    const days =
        deniedCooldownDays === 1 ? "1 day" : `${deniedCooldownDays} days`;
    return `The requester is notified, and nobody can request this album again for ${days}.`;
}

/**
 * Error text for a bulk action. A client or proxy timeout does not mean the
 * batch failed: the server keeps processing it, so say that instead.
 */
export function bulkActionErrorMessage(error: unknown): string {
    const status =
        typeof error === "object" && error !== null
            ? (error as { status?: unknown }).status
            : undefined;
    if (status === 408 || status === 504) {
        return "This is taking a while. The server keeps working on it — refresh the list in a minute to see the result.";
    }
    return error instanceof Error ? error.message : "Something went wrong";
}

/** Toast text after a single approval, honest about already-owned albums. */
export function approveSuccessMessage(status: string): string {
    return status === "fulfilled"
        ? "Already in the library — request fulfilled"
        : "Approved — the download is queued";
}

/** Requests one bulk approval handles; mirrors the API's per-call limit. */
export const BULK_APPROVE_BATCH_SIZE = 25;

/** Confirmation text for approving every pending request from one user. */
export function bulkApproveConfirmMessage(username: string): string {
    return `Approve every pending request from ${username}? Up to ${BULK_APPROVE_BATCH_SIZE} are approved at a time. Each one queues a download, or is marked fulfilled when the album is already in the library.`;
}

/** Accessible name for a row button: the action plus the album it acts on. */
export function requestActionLabel(
    action: string,
    request: { artistName: string; albumTitle: string },
): string {
    return `${action} ${request.artistName} — ${request.albumTitle}`;
}

/** Approve-all is offered on pending rows that identify their requester. */
export function canApproveAllFromRequester(
    row: { status: string; user?: { id: string; username: string } },
    isAdmin: boolean,
): boolean {
    return isAdmin && row.status === "pending" && Boolean(row.user);
}

/** Outcome counts returned by the bulk-approve endpoint. */
export interface BulkApproveOutcome {
    approved: number;
    fulfilled: number;
    skipped: number;
    failed: number;
    remaining: number;
}

function countPhrase(count: number, singular: string, plural: string) {
    return `${count} ${count === 1 ? singular : plural}`;
}

/** Toast text for a bulk approval, including what is still pending. */
export function bulkApproveSummary(
    username: string,
    outcome: BulkApproveOutcome,
): string {
    const parts = [`Approved ${outcome.approved} of ${username}'s requests.`];
    if (outcome.fulfilled > 0) {
        parts.push(
            `${countPhrase(outcome.fulfilled, "was", "were")} already in the library.`,
        );
    }
    if (outcome.skipped > 0) {
        parts.push(`${outcome.skipped} had already changed.`);
    }
    if (outcome.failed > 0) {
        parts.push(`${outcome.failed} could not be approved.`);
    }
    if (outcome.remaining > 0) {
        parts.push(
            `${countPhrase(outcome.remaining, "is", "are")} still pending — run it again to continue.`,
        );
    }
    return parts.join(" ");
}

/** Outcome counts returned by the stale-decline endpoint. */
export interface StaleDenyOutcome {
    denied: number;
    remaining: number;
}

/** Toast text for declining stale requests, including what is left. */
export function staleDenySummary(outcome: StaleDenyOutcome): string {
    if (outcome.denied === 0 && outcome.remaining === 0) {
        return "No pending requests were old enough to decline.";
    }
    const declined = `Declined ${countPhrase(outcome.denied, "stale request", "stale requests")}.`;
    if (outcome.remaining <= 0) return declined;
    return `${declined} ${outcome.remaining} more ${outcome.remaining === 1 ? "is" : "are"} still waiting — run it again to continue.`;
}

/** Link fields a request row needs for its artist and album links. */
export interface RequestLinkInput {
    artistName: string;
    albumTitle: string;
    artistId?: string | null;
    albumId?: string | null;
}

/** Deep link for a request's artist: local page when resolved, search otherwise. */
export function requestArtistHref(request: RequestLinkInput): string {
    if (request.artistId) return `/artist/${request.artistId}`;
    return `/search?q=${encodeURIComponent(request.artistName)}`;
}

/** Deep link for a request's album: local page when resolved, search otherwise. */
export function requestAlbumHref(request: RequestLinkInput): string {
    if (request.albumId) return `/album/${request.albumId}`;
    return `/search?q=${encodeURIComponent(
        `${request.artistName} ${request.albumTitle}`,
    )}`;
}
