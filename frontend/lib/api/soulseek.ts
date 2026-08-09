import { type ApiClientConstructor, type ApiData } from "./core";

/** Add Soulseek-domain operations to an API client base class. */
export function WithSoulseek<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class SoulseekApi extends Base {

    // Soulseek - P2P Music Search & Download
    async getSlskdStatus() {
        return this.request<{
            enabled: boolean;
            connected: boolean;
            username?: string;
            message?: string;
        }>("/soulseek/status");
    }

    async searchSoulseek(query: string) {
        return this.request<{ searchId: string; message: string }>(
            "/soulseek/search",
            {
                method: "POST",
                body: JSON.stringify({ query }),
            }
        );
    }

    async getSoulseekResults(searchId: string) {
        return this.request<{ results: ApiData[]; count: number }>(
            `/soulseek/search/${searchId}`
        );
    }

    async downloadFromSoulseek(
        username: string,
        filepath: string,
        filename?: string,
        size?: number,
        artist?: string,
        album?: string,
        title?: string
    ) {
        return this.request<{
            success: boolean;
            message: string;
            filename: string;
        }>("/soulseek/download", {
            method: "POST",
            body: JSON.stringify({
                username,
                filepath,
                filename,
                size,
                artist,
                album,
                title,
            }),
        });
    }
    }
    return SoulseekApi;
}
