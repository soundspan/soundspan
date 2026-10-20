import { type ApiClientConstructor } from "./core";

/** A music request row as returned by /api/requests endpoints. */
export interface MusicRequest {
    id: string;
    userId: string;
    type: string;
    artistName: string;
    albumTitle: string;
    artistMbid: string | null;
    rgMbid: string;
    status: string;
    note: string | null;
    deniedReason: string | null;
    reviewedAt: string | null;
    /** End of the album's re-request cooldown after a decline, if any. */
    cooldownUntil?: string | null;
    downloadJobId: string | null;
    /** Status of the linked download job, or null when it has none. */
    downloadStatus?: string | null;
    albumId?: string | null;
    artistId?: string | null;
    createdAt: string;
    updatedAt: string;
    user?: {
        id: string;
        username: string;
    };
}

/** Input for submitting a new album request. */
export interface CreateMusicRequestInput {
    artistName: string;
    albumTitle: string;
    rgMbid: string;
    artistMbid?: string;
    note?: string;
}

/**
 * Client timeout for bulk request actions, which run many rows per call.
 * Kept just under the frontend proxy's 90 s budget for these paths so the
 * client, not the proxy, reports a slow batch.
 */
const BULK_REQUEST_TIMEOUT_MS = 85_000;

/** Filters and paging for the request list endpoints. */
export interface MusicRequestListParams {
    status?: string;
    limit?: number;
    offset?: number;
}

/** One page of request rows with the filtered total. */
export interface MusicRequestPage {
    requests: MusicRequest[];
    total: number;
    offset: number;
    limit: number;
}

/** Request totals per status for the admin queue. */
export interface MusicRequestCounts {
    pending: number;
    approved: number;
    denied: number;
    fulfilled: number;
    failed: number;
    cancelled: number;
}

/** Outcome of approving one requester's pending requests in bulk. */
export interface BulkApproveMusicRequestsResult {
    approved: number;
    fulfilled: number;
    skipped: number;
    failed: number;
    remaining: number;
}

/** Input for declining pending requests older than a cutoff. */
export interface DenyStaleMusicRequestsInput {
    olderThanDays: number;
    reason?: string;
}

/** Outcome of declining stale pending requests. */
export interface DenyStaleMusicRequestsResult {
    denied: number;
    remaining: number;
}

/** Query string for the request list endpoints; empty when unfiltered. */
export function buildRequestListQuery(
    params: MusicRequestListParams = {},
): string {
    const query = new URLSearchParams();
    if (params.status) query.set("status", params.status);
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.offset !== undefined) query.set("offset", String(params.offset));
    const encoded = query.toString();
    return encoded ? `?${encoded}` : "";
}

/** Availability + quota answer for the request feature gate. */
export interface RequestAvailability {
    enabled: boolean;
    remainingToday: number;
    dailyCap: number;
    /** Days a declined album cannot be requested again; 0 means no cooldown. */
    deniedCooldownDays?: number;
}

/** Add music-request operations to an API client base class. */
export function WithRequests<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class RequestsApi extends Base {
        async getRequestAvailability(): Promise<RequestAvailability> {
            // 404 means the feature is off; callers treat any failure as closed.
            return this.request<RequestAvailability>("/requests/availability", {
                silent404: true,
            });
        }

        async createMusicRequest(
            input: CreateMusicRequestInput,
        ): Promise<MusicRequest> {
            return this.post("/requests", input);
        }

        async getMyMusicRequests(
            params?: MusicRequestListParams,
        ): Promise<MusicRequestPage> {
            return this.request<MusicRequestPage>(
                `/requests/mine${buildRequestListQuery(params)}`,
                { silent404: true },
            );
        }

        async cancelMusicRequest(id: string): Promise<{ success: boolean }> {
            return this.delete(`/requests/${id}`);
        }

        async getMusicRequests(
            params?: MusicRequestListParams,
        ): Promise<MusicRequestPage> {
            return this.request<MusicRequestPage>(
                `/requests${buildRequestListQuery(params)}`,
                { silent404: true },
            );
        }

        async getMusicRequestCounts(): Promise<MusicRequestCounts> {
            return this.request<MusicRequestCounts>("/requests/counts", {
                silent404: true,
            });
        }

        async bulkApproveMusicRequests(
            userId: string,
        ): Promise<BulkApproveMusicRequestsResult> {
            // Each approval may look up the artist name, so allow far more
            // than the default request timeout for a batch.
            return this.request<BulkApproveMusicRequestsResult>(
                "/requests/bulk/approve",
                {
                    method: "POST",
                    body: JSON.stringify({ userId }),
                    timeoutMs: BULK_REQUEST_TIMEOUT_MS,
                },
            );
        }

        async denyStaleMusicRequests(
            input: DenyStaleMusicRequestsInput,
        ): Promise<DenyStaleMusicRequestsResult> {
            return this.request<DenyStaleMusicRequestsResult>(
                "/requests/bulk/deny-stale",
                {
                    method: "POST",
                    body: JSON.stringify({
                        olderThanDays: input.olderThanDays,
                        ...(input.reason ? { reason: input.reason } : {}),
                    }),
                    timeoutMs: BULK_REQUEST_TIMEOUT_MS,
                },
            );
        }

        async approveMusicRequest(id: string): Promise<MusicRequest> {
            return this.post(`/requests/${id}/approve`);
        }

        async denyMusicRequest(
            id: string,
            reason?: string,
        ): Promise<MusicRequest> {
            return this.post(`/requests/${id}/deny`, reason ? { reason } : {});
        }
    }
    return RequestsApi;
}
