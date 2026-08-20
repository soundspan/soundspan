import { Shuffle } from "lucide-react";
import { toast } from "sonner";
import { api, type RadioPlaylistFilter } from "@/lib/api";
import type { Track } from "@/lib/audio-state-context";
import { shuffleArray } from "@/utils/shuffle";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

const SHUFFLE_ALL_TRACK_LIMIT = 100;
const DEFAULT_MIN_TRACKS = 10;

/** The station fields the open flow needs, shared by Explore and /radio. */
export interface OpenableRadioStation {
    id: string;
    name: string;
    minTracks?: number;
    filter: { type: "all" } | RadioPlaylistFilter;
}

/** User-facing feedback seams, injectable for tests. */
export interface RadioStationNotifier {
    error: (message: string, options?: { description?: string }) => void;
    stationStarted: (name: string, trackCount: number) => void;
}

const defaultNotifier: RadioStationNotifier = {
    error: (message, options) => toast.error(message, options),
    stationStarted: (name, trackCount) =>
        toast.success(`${name} Radio`, {
            description: `Shuffling ${trackCount} tracks`,
            icon: <Shuffle className="w-4 h-4" />,
        }),
};

/** Callbacks the calling component provides from its own hooks. */
export interface OpenRadioStationHandlers {
    push: (path: string) => void;
    playTracks: (tracks: Track[], startIndex: number) => void;
    notifier?: RadioStationNotifier;
}

async function startShuffleAll(
    station: OpenableRadioStation,
    playTracks: OpenRadioStationHandlers["playTracks"],
    notifier: RadioStationNotifier,
): Promise<void> {
    const params = new URLSearchParams({
        type: "all",
        limit: String(SHUFFLE_ALL_TRACK_LIMIT),
    });
    const response = await api.get<{ tracks: Track[] }>(
        `/library/radio?${params.toString()}`,
    );

    if (!response.tracks || response.tracks.length === 0) {
        notifier.error(`No tracks found for ${station.name}`);
        return;
    }

    const minTracks = station.minTracks || DEFAULT_MIN_TRACKS;
    if (response.tracks.length < minTracks) {
        notifier.error(`Not enough tracks for ${station.name} radio`, {
            description: `Found ${response.tracks.length}, need at least ${minTracks}`,
        });
        return;
    }

    const shuffled = shuffleArray(response.tracks);
    playTracks(shuffled, 0);
    notifier.stationStarted(station.name, shuffled.length);
}

/**
 * Opens a radio station: Shuffle All starts instant playback of the whole
 * library; every other station creates a generated playlist and navigates
 * to its page. Errors surface as a toast; the promise always resolves.
 */
export async function openRadioStation(
    station: OpenableRadioStation,
    { push, playTracks, notifier = defaultNotifier }: OpenRadioStationHandlers,
): Promise<void> {
    try {
        if (station.filter.type === "all") {
            await startShuffleAll(station, playTracks, notifier);
            return;
        }
        const response = await api.createRadioPlaylist({
            filter: station.filter,
        });
        push(`/playlist/${response.playlistId}`);
    } catch (error) {
        sharedFrontendLogger.error("Failed to open radio station:", error);
        notifier.error("Failed to open radio station");
    }
}
