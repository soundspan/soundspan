/**
 * Shared legacy-discovery track payload builder.
 *
 * The two call sites in discover.ts (DiscoveryTrack-backed and
 * library-fallback) emitted near-identical objects; extracted so the legacy
 * route stays inside its file-size baseline and the shapes cannot drift.
 */

// The legacy discovery route works with loosely typed Prisma rows and an
// untyped response payload; the builder mirrors that.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildDiscoveryTrackPayload(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    discoveryAlbum: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    track: any,
    extras: {
        artistId: string | null;
        coverUrl: string | null | undefined;
        albumLoudnessLufs: number | null;
        albumTruePeakDb: number | null;
    },
) {
    return {
        id: track.id,
        title: track.title,
        artist: discoveryAlbum.artistName,
        artistId: extras.artistId,
        album: discoveryAlbum.albumTitle,
        albumId: discoveryAlbum.rgMbid,
        isLiked: discoveryAlbum.status === "LIKED",
        likedAt: discoveryAlbum.likedAt,
        similarity: discoveryAlbum.similarity,
        tier: discoveryAlbum.tier,
        coverUrl: extras.coverUrl,
        available: true,
        duration: track.duration,
        loudnessLufs: track.loudnessLufs,
        truePeakDb: track.truePeakDb,
        albumLoudnessLufs: extras.albumLoudnessLufs,
        albumTruePeakDb: extras.albumTruePeakDb,
    };
}
