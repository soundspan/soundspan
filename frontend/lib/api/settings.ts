import { type ApiClientConstructor, type ApiData } from "./core";

/** Add settings-domain operations to an API client base class. */
export function WithSettings<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class SettingsApi extends Base {

    // Settings
    async getSettings() {
        return this.request<ApiData>("/settings");
    }

    async updateSettings(settings: ApiData) {
        return this.request<ApiData>("/settings", {
            method: "POST",
            body: JSON.stringify(settings),
        });
    }

    // Profile Picture
    async uploadProfilePicture(file: File): Promise<{ success: boolean }> {
        const formData = new FormData();
        formData.append("file", file);
        const baseUrl = this.getBaseUrl();
        const token = this.getCurrentToken();
        const res = await fetch(`${baseUrl}/api/settings/profile-picture`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: formData,
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: "Upload failed" }));
            throw new Error(err.error || "Upload failed");
        }
        return res.json();
    }

    async deleteProfilePicture(): Promise<{ success: boolean }> {
        return this.request<{ success: boolean }>("/settings/profile-picture", {
            method: "DELETE",
        });
    }

    getProfilePictureUrl(userId: string): string {
        const baseUrl = this.getBaseUrl();
        const token = this.getCurrentToken();
        const params = token ? `?token=${encodeURIComponent(token)}` : "";
        return `${baseUrl}/api/social/profile-picture/${encodeURIComponent(userId)}${params}`;
    }

    // System Features
    async getFeatures(): Promise<{
        musicCNN: boolean;
        vibeEmbeddings: boolean;
        audioAnalysis: boolean;
        discovery: boolean;
        autoPlaylists: boolean;
    }> {
        return this.request<{
            musicCNN: boolean;
            vibeEmbeddings: boolean;
            audioAnalysis: boolean;
            discovery: boolean;
            autoPlaylists: boolean;
        }>("/system/features");
    }

    // System UI Settings (non-sensitive, available to all authenticated users)
    async getUiSettings(): Promise<{ showVersion: boolean }> {
        return this.request<{ showVersion: boolean }>("/system/ui-settings");
    }

    // System Settings
    async getSystemSettings() {
        return this.request<ApiData>("/system-settings");
    }

    async updateSystemSettings(settings: ApiData) {
        return this.request<ApiData>("/system-settings", {
            method: "POST",
            body: JSON.stringify(settings),
        });
    }

    async clearAllCaches() {
        return this.request<ApiData>("/system-settings/clear-caches", {
            method: "POST",
        });
    }

    async cleanupStaleJobs() {
        return this.request<{
            success: boolean;
            cleaned: {
                discoveryBatches: { cleaned: number; ids: string[] };
                downloadJobs: { cleaned: number; ids: string[] };
                spotifyImportJobs: { cleaned: number; ids: string[] };
                bullQueues: { cleaned: number; queues: string[] };
            };
            totalCleaned: number;
        }>("/settings/cleanup-stale-jobs", {
            method: "POST",
        });
    }
    }
    return SettingsApi;
}
