import { type ApiClientConstructor, type ApiData } from "./core";

/** Provider and migration state returned by the system features endpoint. */
export interface VibeSystemStatus {
    provider: {
        configured: boolean;
        reachable: boolean | null;
        checkedAt: string | null;
        fresh: boolean;
    };
    activeSpace: { id: string; family: string } | null;
    migration: {
        spaceId: string;
        family: string;
        coverage: {
            embedded: number;
            pending: number;
            failed: number;
        } | null;
        cutoverThreshold: number;
    } | null;
}

/** Feature flags and typed vibe status returned by the backend. */
export interface SystemFeatures {
    musicCNN: boolean;
    vibeEmbeddings: boolean;
    audioAnalysis: boolean;
    discovery: boolean;
    autoPlaylists: boolean;
    federation: boolean;
    vibe: VibeSystemStatus;
    /** Loudness normalization reference in LUFS (LOUDNESS_TARGET_LUFS). */
    loudnessTargetLufs?: number;
}

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
                const err = await res
                    .json()
                    .catch(() => ({ error: "Upload failed" }));
                throw new Error(err.error || "Upload failed");
            }
            return res.json();
        }

        async deleteProfilePicture(): Promise<{ success: boolean }> {
            return this.request<{ success: boolean }>(
                "/settings/profile-picture",
                {
                    method: "DELETE",
                },
            );
        }

        getProfilePictureUrl(userId: string): string {
            const baseUrl = this.getBaseUrl();
            const token = this.getCurrentToken();
            const params = token ? `?token=${encodeURIComponent(token)}` : "";
            return `${baseUrl}/api/social/profile-picture/${encodeURIComponent(userId)}${params}`;
        }

        // System Features
        async getFeatures(): Promise<SystemFeatures> {
            return this.request<SystemFeatures>("/system/features");
        }

        // System UI Settings (non-sensitive, available to all authenticated users)
        async getUiSettings(): Promise<{ showVersion: boolean }> {
            return this.request<{ showVersion: boolean }>(
                "/system/ui-settings",
            );
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
