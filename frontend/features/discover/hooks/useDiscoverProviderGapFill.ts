import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { DiscoverTrack } from "../types";

interface TidalMatch {
    id: number;
}

interface YtMatch {
    videoId: string;
}

interface GapFillResult {
    tracks: DiscoverTrack[];
    isMatching: boolean;
    providerCounts: {
        local: number;
        tidal: number;
        youtube: number;
    };
}

interface ProviderMatchState {
    key: string;
    tracks: DiscoverTrack[];
    isMatching: boolean;
}

const MAX_PROVIDER_SLOTS = 8;
const PROVIDER_SHARE = 0.3;

export function getProviderSlotCount(totalTracks: number): number {
    if (totalTracks < 4) return 0;
    return Math.min(MAX_PROVIDER_SLOTS, Math.floor(totalTracks * PROVIDER_SHARE));
}

function getTracksKey(tracks: DiscoverTrack[]): string {
    return tracks
        .map((track) => `${track.id}:${track.similarity}:${track.duration}`)
        .join("|");
}

export function applyDiscoverProviderGapFill(
    sourceTracks: DiscoverTrack[],
    tidalMatches: Array<TidalMatch | null>,
    ytMatches: Array<YtMatch | null>
): DiscoverTrack[] {
    const providerSlots = getProviderSlotCount(sourceTracks.length);
    const candidateIndices = sourceTracks
        .map((track, index) => ({
            index,
            similarity: track.similarity || 0,
        }))
        .sort((left, right) => right.similarity - left.similarity)
        .map((entry) => entry.index);

    const assigned = new Set<number>();
    for (const index of candidateIndices) {
        if (assigned.size >= providerSlots) break;
        if (!tidalMatches[index] && !ytMatches[index]) continue;
        assigned.add(index);
    }

    return sourceTracks.map((track, index) => {
        if (!assigned.has(index)) {
            return {
                ...track,
                sourceType: "local" as const,
                streamSource: undefined,
                tidalTrackId: undefined,
                youtubeVideoId: undefined,
            };
        }

        const tidalMatch = tidalMatches[index];
        if (tidalMatch) {
            return {
                ...track,
                sourceType: "tidal" as const,
                streamSource: "tidal" as const,
                tidalTrackId: tidalMatch.id,
                youtubeVideoId: undefined,
            };
        }

        const ytMatch = ytMatches[index];
        if (ytMatch) {
            return {
                ...track,
                sourceType: "youtube" as const,
                streamSource: "youtube" as const,
                youtubeVideoId: ytMatch.videoId,
                tidalTrackId: undefined,
            };
        }

        return {
            ...track,
            sourceType: "local" as const,
            streamSource: undefined,
            tidalTrackId: undefined,
            youtubeVideoId: undefined,
        };
    });
}

export function useDiscoverProviderGapFill(
    tracks: DiscoverTrack[] | undefined
): GapFillResult {
    const sourceTracks = useMemo(() => tracks || [], [tracks]);
    const tracksKey = useMemo(() => getTracksKey(sourceTracks), [sourceTracks]);

    const [matchState, setMatchState] = useState<ProviderMatchState>({
        key: "",
        tracks: [],
        isMatching: false,
    });

    useEffect(() => {
        if (sourceTracks.length === 0) {
            return;
        }

        let cancelled = false;

        const matchProviders = async () => {
            setMatchState((prev) => ({
                ...prev,
                key: tracksKey,
                isMatching: true,
            }));

            const [tidalStatus, ytStatus] = await Promise.all([
                api.getTidalStreamingStatus().catch(() => null),
                api.getYtMusicStatus().catch(() => null),
            ]);

            if (cancelled) return;

            const tidalAvailable =
                !!tidalStatus?.enabled &&
                !!tidalStatus?.available &&
                !!tidalStatus?.authenticated;
            const ytAvailable =
                !!ytStatus?.enabled &&
                !!ytStatus?.available &&
                !!ytStatus?.authenticated;

            if (!tidalAvailable && !ytAvailable) {
                setMatchState({
                    key: tracksKey,
                    tracks: sourceTracks.map((track) => ({
                        ...track,
                        sourceType: "local",
                        streamSource: undefined,
                        tidalTrackId: undefined,
                        youtubeVideoId: undefined,
                    })),
                    isMatching: false,
                });
                return;
            }

            const payload = sourceTracks.map((track) => ({
                artist: track.artist,
                title: track.title,
                albumTitle: track.album,
                duration:
                    typeof track.duration === "number" && track.duration > 0
                        ? track.duration
                        : undefined,
            }));

            const [tidalMatchesResponse, ytMatchesResponse] = await Promise.all([
                tidalAvailable
                    ? api.matchTidalBatch(payload).catch(() => ({ matches: [] }))
                    : Promise.resolve({ matches: [] }),
                ytAvailable
                    ? api.matchYtMusicBatch(payload).catch(() => ({ matches: [] }))
                    : Promise.resolve({ matches: [] }),
            ]);

            if (cancelled) return;

            const tidalMatches = tidalMatchesResponse.matches as Array<
                TidalMatch | null
            >;
            const ytMatches = ytMatchesResponse.matches as Array<YtMatch | null>;
            const nextTracks = applyDiscoverProviderGapFill(
                sourceTracks,
                tidalMatches,
                ytMatches
            );

            setMatchState({
                key: tracksKey,
                tracks: nextTracks,
                isMatching: false,
            });
        };

        matchProviders().catch((error) => {
            console.error("[DiscoverGapFill] Provider matching failed:", error);
            if (!cancelled) {
                setMatchState({
                    key: tracksKey,
                    tracks: sourceTracks,
                    isMatching: false,
                });
            }
        });

        return () => {
            cancelled = true;
        };
    }, [tracksKey, sourceTracks]);

    const effectiveTracks = useMemo(
        () =>
            sourceTracks.length === 0
                ? []
                : matchState.key === tracksKey
                  ? matchState.tracks
                  : sourceTracks,
        [matchState.key, matchState.tracks, sourceTracks, tracksKey]
    );
    const isMatching = matchState.key === tracksKey && matchState.isMatching;

    const providerCounts = useMemo(() => {
        const counts = {
            local: 0,
            tidal: 0,
            youtube: 0,
        };

        for (const track of effectiveTracks) {
            if (track.sourceType === "tidal") {
                counts.tidal += 1;
            } else if (track.sourceType === "youtube") {
                counts.youtube += 1;
            } else {
                counts.local += 1;
            }
        }

        return counts;
    }, [effectiveTracks]);

    return {
        tracks: effectiveTracks,
        isMatching,
        providerCounts,
    };
}
