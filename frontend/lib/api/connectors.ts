import { type ApiClientConstructor, type ServiceTestResult } from "./core";

/** Add connector operations to an API client base class. */
export function WithConnectors<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class ConnectorsApi extends Base {

    // System Settings Tests
    async testLidarr(url: string, apiKey: string) {
        return this.request<ServiceTestResult>("/system-settings/test-lidarr", {
            method: "POST",
            body: JSON.stringify({ url, apiKey }),
        });
    }

    async testLastfm(apiKey: string) {
        return this.request<ServiceTestResult>("/system-settings/test-lastfm", {
            method: "POST",
            body: JSON.stringify({ lastfmApiKey: apiKey }),
        });
    }

    async testOpenai(apiKey: string, model: string) {
        return this.request<ServiceTestResult>("/system-settings/test-openai", {
            method: "POST",
            body: JSON.stringify({ apiKey, model }),
        });
    }

    async testFanart(apiKey: string) {
        return this.request<ServiceTestResult>("/system-settings/test-fanart", {
            method: "POST",
            body: JSON.stringify({ fanartApiKey: apiKey }),
        });
    }

    async testAudiobookshelf(url: string, apiKey: string) {
        return this.request<ServiceTestResult>("/system-settings/test-audiobookshelf", {
            method: "POST",
            body: JSON.stringify({ url, apiKey }),
        });
    }

    async testSoulseek(username: string, password: string) {
        return this.request<ServiceTestResult>("/system-settings/test-soulseek", {
            method: "POST",
            body: JSON.stringify({ username, password }),
        });
    }

    async testSpotify(clientId: string, clientSecret: string) {
        return this.request<ServiceTestResult>("/system-settings/test-spotify", {
            method: "POST",
            body: JSON.stringify({ clientId, clientSecret }),
        });
    }

    async testTidal() {
        return this.request<ServiceTestResult>("/system-settings/test-tidal", {
            method: "POST",
        });
    }

    async tidalDeviceAuth() {
        return this.request<{
            device_code: string;
            user_code: string;
            verification_uri: string;
            verification_uri_complete: string;
            expires_in: number;
            interval: number;
        }>("/system-settings/tidal-auth/device", {
            method: "POST",
        });
    }

    async tidalPollAuth(deviceCode: string) {
        return this.request<{
            status?: "pending";
            success?: boolean;
            user_id?: string;
            country_code?: string;
            username?: string;
        }>("/system-settings/tidal-auth/token", {
            method: "POST",
            body: JSON.stringify({ device_code: deviceCode }),
        });
    }
    }
    return ConnectorsApi;
}
