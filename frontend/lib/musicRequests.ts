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

/** Only the requester may cancel, and only while the request is pending. */
export function canCancelRequest(
    row: MusicRequestRowInput,
    viewerId: string | undefined,
): boolean {
    return Boolean(viewerId) && row.userId === viewerId
        ? row.status === "pending"
        : false;
}

/**
 * Admins review pending requests and failed ones (approve retries the
 * download, decline closes it); every other state is settled.
 */
export function canReviewRequest(
    row: MusicRequestRowInput,
    isAdmin: boolean,
): boolean {
    return isAdmin && (row.status === "pending" || row.status === "failed");
}

/** Open requests block a duplicate submission for the same album. */
export function isOpenRequestStatus(status: string): boolean {
    return status === "pending" || status === "approved";
}

const MBID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Only real MusicBrainz release-group ids are requestable; the scanner's
 * synthetic ids (temp-*, remote:*, federation:*) would be rejected by the
 * API's MBID validation.
 */
export function isRequestableMbid(value: string | null | undefined): boolean {
    return Boolean(value && MBID_PATTERN.test(value));
}

/** The caller's request progress for one album, as the album page shows it. */
export type AlbumRequestState = "requested" | "approved" | "downloading";

/** Minimal open-request row needed to derive an album's request state. */
export interface AlbumRequestRowInput {
    rgMbid: string;
    status: string;
    downloadStatus?: string | null;
}

const ALBUM_REQUEST_STATE_RANK: Record<AlbumRequestState, number> = {
    requested: 1,
    approved: 2,
    downloading: 3,
};

function toAlbumRequestState(
    row: AlbumRequestRowInput,
): AlbumRequestState | null {
    if (row.status === "pending") return "requested";
    if (row.status !== "approved") return null;
    return row.downloadStatus === "processing" ? "downloading" : "approved";
}

/**
 * The most advanced open request the caller has for an album, matched
 * case-insensitively on the release-group id; null when there is none.
 */
export function albumRequestState(
    rows: AlbumRequestRowInput[] | undefined,
    rgMbid: string | null | undefined,
): AlbumRequestState | null {
    if (!rows || !rgMbid) return null;
    const target = rgMbid.toLowerCase();
    let best: AlbumRequestState | null = null;
    for (const row of rows) {
        if (row.rgMbid.toLowerCase() !== target) continue;
        const state = toAlbumRequestState(row);
        if (!state) continue;
        if (
            !best ||
            ALBUM_REQUEST_STATE_RANK[state] > ALBUM_REQUEST_STATE_RANK[best]
        ) {
            best = state;
        }
    }
    return best;
}

/** Short, locale-aware calendar date used across the request surfaces. */
export function formatRequestDate(value: string | Date): string {
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) return "";
    return parsed.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

function readErrorData(error: unknown): Record<string, unknown> | null {
    if (typeof error !== "object" || error === null) return null;
    const data = (error as { data?: unknown }).data;
    return typeof data === "object" && data !== null
        ? (data as Record<string, unknown>)
        : null;
}

function parseRetryAfter(value: unknown): Date | null {
    if (typeof value !== "string") return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Human message for a failed request submission. A decline cooldown names
 * the day the album can be requested again; anything else keeps the API's
 * message.
 */
export function describeRequestSubmitError(
    error: unknown,
    formatDate: (date: Date) => string,
): string {
    const data = readErrorData(error);
    if (data?.code === "recently_denied") {
        const retryAfter = parseRetryAfter(data.retryAfter);
        return retryAfter
            ? `An admin declined this album recently. You can request it again after ${formatDate(retryAfter)}.`
            : "An admin declined this album recently. Try again later.";
    }
    return error instanceof Error
        ? error.message
        : "Failed to submit the request";
}

/** Count-bubble text: hidden at zero, capped at 99+. */
export function formatCountBadge(
    count: number | null | undefined,
): string | null {
    if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
        return null;
    }
    return count > 99 ? "99+" : String(count);
}

/** Navigation entry for the requests page, or null when it is hidden. */
export interface RequestsNavEntry {
    label: "Requests" | "My Requests";
    badge: string | null;
    /** Screen-reader noun read after the badge count. */
    badgeLabel: "pending request" | "pending requests";
}

/**
 * While the request feature is on, admins get the review queue with a
 * pending-count badge and other users get their own list; otherwise hidden.
 */
export function requestsNavEntry(input: {
    isAdmin: boolean;
    requestsEnabled: boolean;
    pendingCount: number;
}): RequestsNavEntry | null {
    if (!input.requestsEnabled) return null;
    if (!input.isAdmin) {
        return {
            label: "My Requests",
            badge: null,
            badgeLabel: "pending requests",
        };
    }
    return {
        label: "Requests",
        badge: formatCountBadge(input.pendingCount),
        badgeLabel:
            input.pendingCount === 1 ? "pending request" : "pending requests",
    };
}

function errorStatus(error: unknown): number | null {
    if (typeof error !== "object" || error === null) return null;
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : null;
}

/**
 * A 403 or 404 from a request endpoint is a settled answer (no access, or
 * the feature is off); anything else may be transient.
 */
export function isFinalRequestError(error: unknown): boolean {
    const status = errorStatus(error);
    return status === 403 || status === 404;
}

/** Most retries a request query makes after a transient failure. */
const MAX_REQUEST_QUERY_RETRIES = 3;

/** React Query retry policy: retry transient failures, never settled ones. */
export function shouldRetryRequestQuery(
    failureCount: number,
    error: unknown,
): boolean {
    return (
        !isFinalRequestError(error) && failureCount < MAX_REQUEST_QUERY_RETRIES
    );
}

/**
 * Poll interval for a request query: keep polling while enabled, through
 * transient errors, and stop after a settled 403/404.
 */
export function requestPollInterval(
    enabled: boolean,
    status: string,
    error: unknown,
    intervalMs: number,
): number | false {
    if (!enabled) return false;
    if (status === "error" && isFinalRequestError(error)) return false;
    return intervalMs;
}

/**
 * Feature flags from the availability probe. A settled "off" answer (a
 * false flag, or a 403/404) wins over data cached from an earlier "on".
 */
export function requestAvailabilityFlags(
    data: { enabled?: boolean } | undefined,
    isError: boolean,
    error: unknown,
): { enabled: boolean; off: boolean } {
    const off =
        data?.enabled === false || (isError && isFinalRequestError(error));
    return { enabled: !off && data?.enabled === true, off };
}
