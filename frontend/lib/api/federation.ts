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
    lastSeenAt: string | null;
    lastSyncCursor: string | null;
    catalogEpoch: string | null;
    createdAt: string;
    updatedAt: string;
}

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
    }
    return FederationApi;
}
