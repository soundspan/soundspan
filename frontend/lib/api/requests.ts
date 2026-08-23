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
    downloadJobId: string | null;
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

/** Availability + quota answer for the request feature gate. */
export interface RequestAvailability {
    enabled: boolean;
    remainingToday: number;
    dailyCap: number;
}

/** Add music-request operations to an API client base class. */
export function WithRequests<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class RequestsApi extends Base {
        async getRequestAvailability(): Promise<RequestAvailability> {
            return this.get("/requests/availability");
        }

        async createMusicRequest(
            input: CreateMusicRequestInput,
        ): Promise<MusicRequest> {
            return this.post("/requests", input);
        }

        async getMyMusicRequests(): Promise<MusicRequest[]> {
            return this.get("/requests/mine");
        }

        async cancelMusicRequest(id: string): Promise<{ success: boolean }> {
            return this.delete(`/requests/${id}`);
        }

        async getMusicRequests(status?: string): Promise<MusicRequest[]> {
            const query = status ? `?status=${encodeURIComponent(status)}` : "";
            return this.get(`/requests${query}`);
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
