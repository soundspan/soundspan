import { type ApiClientConstructor } from "./core";

/** Shape the provider-scoped mutation endpoints return. */
export interface ServiceConnectionState {
    connected: boolean;
    enabled: boolean;
}

export interface ScrobblingStatus {
    lastfm: {
        connected: boolean;
        enabled: boolean;
        username: string | null;
        /** False when the server has no Last.fm API key + shared secret. */
        serverConfigured: boolean;
        /** Whether LASTFM_API_KEY (or a stored key) is present on the server. */
        apiKeyConfigured: boolean;
        /** Whether LASTFM_SHARED_SECRET is present on the server. */
        sharedSecretConfigured: boolean;
    };
    listenbrainz: {
        connected: boolean;
        enabled: boolean;
    };
}

/** Add per-user scrobbling connection operations to an API client. */
export function WithScrobbling<TBase extends ApiClientConstructor>(
    Base: TBase,
) {
    abstract class ScrobblingApi extends Base {
        async getScrobblingStatus() {
            return this.request<ScrobblingStatus>("/scrobbling");
        }

        async connectListenBrainz(token: string) {
            return this.request<ServiceConnectionState>(
                "/scrobbling/listenbrainz",
                {
                    method: "PUT",
                    body: JSON.stringify({ token }),
                },
            );
        }

        async disconnectListenBrainz() {
            return this.request<void>("/scrobbling/listenbrainz", {
                method: "DELETE",
            });
        }

        async setListenBrainzScrobblingEnabled(enabled: boolean) {
            return this.request<ServiceConnectionState>(
                "/scrobbling/listenbrainz/enabled",
                {
                    method: "PATCH",
                    body: JSON.stringify({ enabled }),
                },
            );
        }

        async startLastFmAuth() {
            return this.request<{ approvalUrl: string }>(
                "/scrobbling/lastfm/start-auth",
                { method: "POST" },
            );
        }

        async completeLastFmAuth() {
            return this.request<
                ServiceConnectionState & { username: string | null }
            >("/scrobbling/lastfm/complete-auth", { method: "POST" });
        }

        async disconnectLastFm() {
            return this.request<void>("/scrobbling/lastfm", {
                method: "DELETE",
            });
        }

        async setLastFmScrobblingEnabled(enabled: boolean) {
            return this.request<ServiceConnectionState>(
                "/scrobbling/lastfm/enabled",
                {
                    method: "PATCH",
                    body: JSON.stringify({ enabled }),
                },
            );
        }
    }
    return ScrobblingApi;
}
