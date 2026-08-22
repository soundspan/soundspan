import { prisma } from "../utils/db";
import {
    parsePlaybackSourceOrder,
    rankPlaybackSource,
} from "./playbackSourcePriority";
import { isProviderMappingEligible } from "./providerMappingEligibility";

/** One stream-time replacement rung for an unavailable peer track. */
export type PeerPlaybackFallback =
    | { source: "library"; trackId: string }
    | { source: "tidal"; tidalTrackId: number }
    | { source: "ytmusic"; youtubeVideoId: string };

interface PeerFallbackCandidates {
    localTwinId: string | null;
    tidalTrackId: number | null;
    youtubeVideoId: string | null;
}

/** Applies the bounded peer failure ladder without performing I/O. */
export function choosePeerPlaybackFallback(
    candidates: PeerFallbackCandidates,
    playbackSourceOrder?: string,
): PeerPlaybackFallback[] {
    const ladder: PeerPlaybackFallback[] = [];
    if (candidates.localTwinId) {
        ladder.push({ source: "library", trackId: candidates.localTwinId });
    }
    const providers: PeerPlaybackFallback[] = [];
    if (candidates.tidalTrackId) {
        providers.push({
            source: "tidal",
            tidalTrackId: candidates.tidalTrackId,
        });
    }
    if (candidates.youtubeVideoId) {
        providers.push({
            source: "ytmusic",
            youtubeVideoId: candidates.youtubeVideoId,
        });
    }
    const order = parsePlaybackSourceOrder(playbackSourceOrder);
    providers.sort(
        (left, right) =>
            rankPlaybackSource(
                { source: right.source, available: true },
                order,
            ) -
            rankPlaybackSource({ source: left.source, available: true }, order),
    );
    return [...ladder, ...providers];
}

/** Loads the local dedup winner and existing provider mappings for one peer track. */
export async function loadPeerPlaybackFallback(
    trackId: string,
): Promise<PeerPlaybackFallback[]> {
    const [track, systemSettings] = await Promise.all([
        prisma.track.findUnique({
            where: { id: trackId },
            select: { dedupOfTrackId: true, duration: true },
        }),
        prisma.systemSettings.findUnique({
            where: { id: "default" },
            select: { playbackSourceOrder: true },
        }),
    ]);
    const linkedIds = [trackId, track?.dedupOfTrackId].filter(
        (value): value is string => typeof value === "string",
    );
    const mappings = await prisma.trackMapping.findMany({
        where: { stale: false, trackId: { in: linkedIds } },
        select: {
            confidence: true,
            trackTidal: { select: { tidalId: true, duration: true } },
            trackYtMusic: { select: { videoId: true, duration: true } },
        },
        orderBy: { confidence: "desc" },
        take: 20,
    });
    const expectedDurationSeconds = track?.duration ?? Number.NaN;
    const tidal = mappings.find(
        (row) =>
            row.trackTidal &&
            isProviderMappingEligible({
                confidence: row.confidence,
                expectedDurationSeconds,
                actualDurationSeconds: row.trackTidal.duration,
            }),
    )?.trackTidal;
    const youtube = mappings.find(
        (row) =>
            row.trackYtMusic &&
            isProviderMappingEligible({
                confidence: row.confidence,
                expectedDurationSeconds,
                actualDurationSeconds: row.trackYtMusic.duration,
            }),
    )?.trackYtMusic;
    return choosePeerPlaybackFallback(
        {
            localTwinId: track?.dedupOfTrackId ?? null,
            tidalTrackId: tidal?.tidalId ?? null,
            youtubeVideoId: youtube?.videoId ?? null,
        },
        systemSettings?.playbackSourceOrder,
    );
}
