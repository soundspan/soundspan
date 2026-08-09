import { type ApiClientConstructor, type ApiData } from "./core";

/** Add Listen Together group operations to an API client base class. */
export function WithListenGroups<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class ListenGroupsApi extends Base {

    // -----------------------------------------------------------------------
    // Listen Together (cold path — create, join, discover, leave, end)
    // -----------------------------------------------------------------------

    async createListenGroup(options: {
        name?: string;
        visibility?: "public" | "private";
        queueTrackIds?: string[];
        queueTracks?: Array<{
            trackId?: string;
            tidalTrackId?: number;
            youtubeVideoId?: string;
            title?: string;
            artist?: string;
            album?: string;
            duration?: number;
            thumbnailUrl?: string;
            isrc?: string;
        }>;
        currentTrackId?: string;
        currentTimeMs?: number;
        isPlaying?: boolean;
    } = {}): Promise<ApiData> {
        return this.post("/listen-together", options);
    }

    async joinListenGroup(joinCode: string): Promise<ApiData> {
        return this.post("/listen-together/join", { joinCode });
    }

    async discoverListenGroups(): Promise<ApiData> {
        return this.get("/listen-together/discover");
    }

    async getActiveListenGroupCount(): Promise<{ count: number }> {
        return this.get("/listen-together/active-count");
    }

    async getMyListenGroup(): Promise<ApiData> {
        return this.get("/listen-together/mine");
    }

    async leaveListenGroup(groupId: string): Promise<ApiData> {
        return this.post(`/listen-together/${groupId}/leave`);
    }

    async endListenGroup(groupId: string): Promise<ApiData> {
        return this.post(`/listen-together/${groupId}/end`);
    }
    }
    return ListenGroupsApi;
}
