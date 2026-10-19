import type { AlbumLocation } from "@prisma/client";
import type { PlaybackSourceOrder } from "../playbackSourcePriority";

/** Streaming providers represented in the per-user remote library. */
export type RemoteLibraryProvider = "tidal" | "youtube";

/** System and user-level availability for supported remote providers. */
export interface ConnectedRemoteProviders {
    tidal: boolean;
    youtube: boolean;
}

/** Provider access state loaded once for one Library request. */
export interface RemoteLibraryAccess {
    providers: ConnectedRemoteProviders;
    playbackSourceOrder: PlaybackSourceOrder;
}

/** Active mapping identity used to collapse cross-provider duplicates. */
export interface RemoteLibraryMapping {
    id: string;
    trackId: string | null;
}

/** Linked artist fields needed by the Library response adapter. */
export interface RemoteLibraryArtistEntity {
    id: string;
    name: string;
}

/** Linked album fields needed by the Library response adapter. */
export interface RemoteLibraryAlbumEntity {
    id: string;
    title: string;
    rgMbid: string;
    matchedRgMbid: string | null;
    coverUrl: string | null;
    artistId: string;
    location: AlbumLocation;
    artist: RemoteLibraryArtistEntity;
}

interface RemoteProviderTrackBase {
    id: string;
    title: string;
    artist: string;
    album: string;
    duration: number;
    artistId: string | null;
    albumId: string | null;
    artistEntity: RemoteLibraryArtistEntity | null;
    albumEntity: RemoteLibraryAlbumEntity | null;
}

/** Materialized TIDAL fields retained by a remote-library row. */
export interface RemoteLibraryTidalRecord extends RemoteProviderTrackBase {
    tidalId: number;
}

/** Materialized YouTube Music fields retained by a remote-library row. */
export interface RemoteLibraryYtRecord extends RemoteProviderTrackBase {
    videoId: string;
    thumbnailUrl: string | null;
}

interface RemoteLibraryTrackBase {
    providerRowId: string;
    title: string;
    artistId: string | null;
    albumId: string | null;
    albumLocation: AlbumLocation | null;
    albumArtistId: string | null;
    likedAt: Date;
    mappings: RemoteLibraryMapping[];
}

/** One kept provider row in an authenticated user's remote library. */
export type RemoteLibraryTrack =
    | (RemoteLibraryTrackBase & {
          provider: "tidal";
      })
    | (RemoteLibraryTrackBase & {
          provider: "youtube";
      });

/** One remote-library membership row joined to display fields for a page. */
export type HydratedRemoteLibraryTrack =
    | (Extract<RemoteLibraryTrack, { provider: "tidal" }> & {
          track: RemoteLibraryTidalRecord;
      })
    | (Extract<RemoteLibraryTrack, { provider: "youtube" }> & {
          track: RemoteLibraryYtRecord;
      });

/** Per-artist counts and provider identities derived from the remote set. */
export interface RemoteLibraryArtistStats {
    trackCount: number;
    albumCount: number;
    albumIds: Set<string>;
    providers: RemoteLibraryProvider[];
}

/** Derived lookup tables for list and detail response decoration. */
export interface RemoteLibraryLookups {
    byArtistId: Map<string, RemoteLibraryArtistStats>;
    byAlbumId: Map<string, RemoteLibraryProvider[]>;
}

/** Complete bounded remote set and its request-local lookup tables. */
export interface RemoteLibrarySet extends RemoteLibraryLookups {
    tracks: RemoteLibraryTrack[];
}
