import { type ApiClientConstructor } from "./core";

/** Scopes supported by the federation v1 host API. */
export type FederationScope =
    | "library:read"
    | "stream:read"
    | "embeddings:read";

export type FederationPeerDirection = "HOST" | "CONSUMER" | "BOTH";

export type FederationPeerStatus = "PENDING" | "ACTIVE" | "OFFLINE" | "REVOKED";

/** Public federation peer data returned without credential material. */
export interface FederationPeer {
    id: string;
    name: string;
    direction: FederationPeerDirection;
    baseUrl: string | null;
    scopes: FederationScope[];
    inboundStatus: FederationPeerStatus | null;
    outboundStatus: FederationPeerStatus | null;
    showDedupedCopies: boolean;
    maxConcurrentStreams: number | null;
    maxStreamKbps: number | null;
    lastSeenAt: string | null;
    lastSyncSuccessAt: string | null;
    lastSyncDurationMs: number | null;
    lastErrorAt: string | null;
    lastError: string | null;
    lastSyncCursor: string | null;
    catalogEpoch: string | null;
    createdAt: string;
    updatedAt: string;
}

export type FederationHealthState = "green" | "amber" | "red" | "revoked";

/** Per-peer federation health read model returned to administrators. */
export interface FederationPeerHealth {
    id: string;
    name: string;
    direction: FederationPeerDirection;
    inboundStatus: FederationPeerStatus | null;
    outboundStatus: FederationPeerStatus | null;
    lastSeenAt: string | null;
    lastSyncSuccessAt: string | null;
    lastSyncDurationMs: number | null;
    syncLagSeconds: number | null;
    catalog: {
        artist: number;
        album: number;
        track: number;
        audiobook: number;
        podcast: number;
    };
    activeStreamLeases: number;
    maxConcurrentStreams: number | null;
    lastError: string | null;
    lastErrorAt: string | null;
    health: FederationHealthState;
}

export interface FederationPeerSettingsInput {
    showDedupedCopies?: boolean;
    maxConcurrentStreams?: number | null;
    maxStreamKbps?: number | null;
}

export interface FederationDedupTrack {
    id: string;
    title: string;
    album: { title: string };
    artist: { name: string };
}

export interface FederationDedupEntry {
    federatedTrack: FederationDedupTrack;
    localTrack: FederationDedupTrack | null;
    tier: string | null;
    confidence: number | null;
    pinned: boolean;
}

export type FederationDedupActionInput =
    | { action: "link"; localTrackId: string }
    | { action: "unlink" }
    | { action: "reset" };

export interface CreateFederationPeerInput {
    name: string;
    scopes: FederationScope[];
    baseUrl?: string;
    direction?: "HOST" | "BOTH";
    token?: string;
}

export interface LinkFederationPeerInput {
    baseUrl: string;
    token: string;
    name?: string;
    direction?: "CONSUMER" | "BOTH";
    scopes?: FederationScope[];
}

export interface PairFederationPeerInput {
    baseUrl: string;
    code: string;
    name: string;
    direction?: "CONSUMER" | "BOTH";
    scopes?: FederationScope[];
}

export interface FederationCredentialResponse {
    peer: FederationPeer;
    token: string;
}

/** Add federation administration operations to an API client base class. */
export function WithFederation<TBase extends ApiClientConstructor>(
    Base: TBase,
) {
    abstract class FederationApi extends Base {
        async getFederationPeers(): Promise<{ peers: FederationPeer[] }> {
            return this.request<{ peers: FederationPeer[] }>(
                "/federation/admin/peers",
            );
        }

        async getFederationPeerHealth(): Promise<{
            peers: FederationPeerHealth[];
        }> {
            return this.request<{ peers: FederationPeerHealth[] }>(
                "/federation/admin/peers/health",
            );
        }

        async createFederationPeer(
            input: CreateFederationPeerInput,
        ): Promise<FederationCredentialResponse> {
            return this.request<FederationCredentialResponse>(
                "/federation/admin/peers",
                { method: "POST", body: JSON.stringify(input) },
            );
        }

        async linkFederationPeer(
            input: LinkFederationPeerInput,
        ): Promise<{ peer: FederationPeer }> {
            return this.request<{ peer: FederationPeer }>(
                "/federation/admin/peers/link",
                { method: "POST", body: JSON.stringify(input) },
            );
        }

        async pairFederationPeer(
            input: PairFederationPeerInput,
        ): Promise<{ peer: FederationPeer }> {
            return this.request<{ peer: FederationPeer }>(
                "/federation/admin/peers/link/pair",
                { method: "POST", body: JSON.stringify(input) },
            );
        }

        async rotateFederationPeerCredential(
            peerId: string,
        ): Promise<FederationCredentialResponse> {
            return this.request<FederationCredentialResponse>(
                `/federation/admin/peers/${encodeURIComponent(peerId)}/rotate`,
                { method: "POST" },
            );
        }

        async revokeFederationPeer(
            peerId: string,
        ): Promise<{ success: boolean }> {
            return this.request<{ success: boolean }>(
                `/federation/admin/peers/${encodeURIComponent(peerId)}/revoke`,
                { method: "POST" },
            );
        }

        async deleteFederationPeer(peerId: string): Promise<void> {
            await this.request<void>(
                `/federation/admin/peers/${encodeURIComponent(peerId)}`,
                { method: "DELETE" },
            );
        }

        async syncFederationPeer(peerId: string): Promise<{ queued: boolean }> {
            return this.request<{ queued: boolean }>(
                `/federation/admin/peers/${encodeURIComponent(peerId)}/sync`,
                { method: "POST" },
            );
        }

        async createFederationPairingCode(
            scopes: FederationScope[],
        ): Promise<{ code: string; expiresAt: string }> {
            return this.request<{ code: string; expiresAt: string }>(
                "/federation/admin/pairing-codes",
                { method: "POST", body: JSON.stringify({ scopes }) },
            );
        }

        async updateFederationPeerSettings(
            peerId: string,
            settings: FederationPeerSettingsInput,
        ): Promise<FederationPeer> {
            return this.request<FederationPeer>(
                `/federation/admin/peers/${encodeURIComponent(peerId)}/settings`,
                { method: "PATCH", body: JSON.stringify(settings) },
            );
        }

        async getFederationPeerDedup(
            peerId: string,
            cursor?: string,
        ): Promise<{
            items: FederationDedupEntry[];
            nextCursor: string | null;
        }> {
            const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
            return this.request<{
                items: FederationDedupEntry[];
                nextCursor: string | null;
            }>(
                `/federation/admin/peers/${encodeURIComponent(peerId)}/dedup${query}`,
            );
        }

        async arbitrateFederationTrackDedup(
            trackId: string,
            input: FederationDedupActionInput,
        ): Promise<FederationDedupEntry> {
            return this.request<FederationDedupEntry>(
                `/federation/admin/tracks/${encodeURIComponent(trackId)}/dedup`,
                { method: "POST", body: JSON.stringify(input) },
            );
        }
    }
    return FederationApi;
}
