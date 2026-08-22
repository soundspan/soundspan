import type { ApiClientConstructor } from "./core";
import type { PlaylistDetailTrack } from "../api";

/** Consumer-visible failure class for a peer playlist operation. */
export type PeerPlaylistErrorClass =
    | "timeout"
    | "offline"
    | "unauthorized"
    | "not_found"
    | "invalid_response"
    | "failure";

/** One public playlist advertised by a federated peer. */
export interface PeerPlaylistSummary {
    remoteId: string;
    name: string;
    trackCount: number;
    updatedAt: string;
    owner: { displayName: string };
    peer: { id: string; name: string };
}

/** Per-peer browse failure surfaced alongside partial results. */
export interface PeerPlaylistBrowseError {
    peerId: string;
    peerName: string;
    errorClass: PeerPlaylistErrorClass;
}

/** One resolved track row inside a peer playlist. */
export interface PeerPlaylistTrack {
    remoteTrackId: string;
    title: string;
    artist: string;
    album: string;
    duration: number;
    trackId: string | null;
    resolution: "local" | "federated" | "unresolvable";
    isResolvable: boolean;
    track?: PlaylistDetailTrack | null;
    playback: {
        isPlayable: boolean;
        reason: string | null;
        message: string | null;
    };
}

/** A fetched-and-resolved peer playlist. */
export interface PeerPlaylistDetail {
    peer: { id: string; name: string };
    playlist: {
        remoteId: string;
        name: string;
        updatedAt: string;
        owner: { displayName: string };
        tracks: PeerPlaylistTrack[];
    };
}

/** One followed peer playlist with its live resolution state. */
export interface FollowedPeerPlaylist {
    id: string;
    peerId: string;
    peerName: string;
    remoteId: string;
    name: string;
    createdAt: string;
    playlist: PeerPlaylistDetail["playlist"] | null;
    errorClass: PeerPlaylistErrorClass | null;
}

/** Add peer public playlist browsing to an API client base class. */
export function WithPeerPlaylists<TBase extends ApiClientConstructor>(
    Base: TBase,
) {
    abstract class PeerPlaylistsApi extends Base {
        async getPeerPlaylists(): Promise<{
            playlists: PeerPlaylistSummary[];
            errors: PeerPlaylistBrowseError[];
        }> {
            return this.request("/social/peer-playlists");
        }

        async getFollowedPeerPlaylists(): Promise<{
            playlists: FollowedPeerPlaylist[];
        }> {
            return this.request("/social/peer-playlists/followed");
        }

        async getPeerPlaylist(
            peerId: string,
            remoteId: string,
        ): Promise<PeerPlaylistDetail> {
            return this.request(
                `/social/peer-playlists/${encodeURIComponent(peerId)}/${encodeURIComponent(remoteId)}`,
            );
        }

        async followPeerPlaylist(
            peerId: string,
            remoteId: string,
        ): Promise<{ followed: boolean }> {
            return this.request(
                `/social/peer-playlists/${encodeURIComponent(peerId)}/${encodeURIComponent(remoteId)}/follow`,
                { method: "POST" },
            );
        }

        async unfollowPeerPlaylist(
            peerId: string,
            remoteId: string,
        ): Promise<{ followed: boolean }> {
            return this.request(
                `/social/peer-playlists/${encodeURIComponent(peerId)}/${encodeURIComponent(remoteId)}/follow`,
                { method: "DELETE" },
            );
        }

        async copyPeerPlaylist(
            peerId: string,
            remoteId: string,
        ): Promise<{ playlistId: string; copied: number; skipped: number }> {
            return this.request(
                `/social/peer-playlists/${encodeURIComponent(peerId)}/${encodeURIComponent(remoteId)}/copy`,
                { method: "POST" },
            );
        }
    }
    return PeerPlaylistsApi;
}
