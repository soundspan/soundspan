/**
 * Loudness Normalization Gain Policy
 *
 * Pure decision module for issue #526: converts a track's stored EBU R128
 * measurements into one playback gain factor, composited multiplicatively
 * with the user volume by the output pipeline. Attenuation is unlimited
 * (cutting cannot clip); boosts are limited to +3 dB and to the true-peak
 * headroom below 0 dBTP, and are denied entirely when no peak measurement
 * exists for the scope in use.
 */

export type LoudnessMode = "off" | "track" | "album" | "auto";

export const LOUDNESS_MODES: readonly LoudnessMode[] = [
    "off",
    "track",
    "album",
    "auto",
];

/** ReplayGain 2 reference level; mirrors the backend default target. */
export const DEFAULT_LOUDNESS_TARGET_LUFS = -18;

/** Maximum boost applied to quiet tracks, independent of headroom. */
export const MAX_BOOST_DB = 3;

export interface LoudnessTrackMeasurements {
    loudnessLufs?: number | null;
    truePeakDb?: number | null;
    // Album measurements arrive flattened on the track in some payloads and
    // nested under the album object in others; both shapes are honored.
    albumLoudnessLufs?: number | null;
    albumTruePeakDb?: number | null;
    album?: {
        albumLoudnessLufs?: number | null;
        albumTruePeakDb?: number | null;
    };
}

export interface LoudnessGainInput {
    mode: LoudnessMode;
    /** Server-configured normalization target (LOUDNESS_TARGET_LUFS). */
    targetLufs: number;
    /** True when the queue is an album played in order (auto → album gain). */
    isAlbumContext: boolean;
    track: LoudnessTrackMeasurements | null;
}

export interface LoudnessGainDecision {
    /** Applied gain in dB after clamping. 0 means pass-through. */
    gainDb: number;
    /** Linear factor for volume compositing: 10^(gainDb/20). */
    gainFactor: number;
    reason:
        | "mode_off"
        | "no_track"
        | "invalid_target"
        | "unmeasured"
        | "leveled"
        | "boost_clamped"
        | "boost_denied_no_peak";
}

const PASS_THROUGH: Omit<LoudnessGainDecision, "reason"> = {
    gainDb: 0,
    gainFactor: 1,
};

function isFiniteNumber(value: number | null | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

interface ResolvedScope {
    measuredLufs: number | null;
    truePeakDb: number | null;
}

/**
 * Picks the measurement scope for the active mode. Album scopes fall back
 * to track values when the album aggregate has not been computed yet, so
 * playback stays leveled while a library's rollups converge.
 */
function resolveScope(input: LoudnessGainInput): ResolvedScope {
    const track = input.track;
    if (!track) return { measuredLufs: null, truePeakDb: null };

    const trackScope: ResolvedScope = {
        measuredLufs: isFiniteNumber(track.loudnessLufs)
            ? track.loudnessLufs
            : null,
        truePeakDb: isFiniteNumber(track.truePeakDb) ? track.truePeakDb : null,
    };
    const albumLufs = isFiniteNumber(track.albumLoudnessLufs)
        ? track.albumLoudnessLufs
        : track.album?.albumLoudnessLufs;
    const albumPeak = isFiniteNumber(track.albumTruePeakDb)
        ? track.albumTruePeakDb
        : track.album?.albumTruePeakDb;
    const albumScope: ResolvedScope = {
        measuredLufs: isFiniteNumber(albumLufs) ? albumLufs : null,
        // Album boosts fall back to the track's own peak when the album
        // aggregate is missing: the track peak may under-represent the
        // loudest sibling, but the +3 dB cap bounds the worst case.
        truePeakDb: isFiniteNumber(albumPeak)
            ? albumPeak
            : trackScope.truePeakDb,
    };

    const wantsAlbum =
        input.mode === "album" ||
        (input.mode === "auto" && input.isAlbumContext);
    if (wantsAlbum && albumScope.measuredLufs !== null) return albumScope;
    return trackScope;
}

/**
 * Queues larger than this are never treated as one album; real albums stay
 * far below it and the cap bounds the per-change scan.
 */
const MAX_ALBUM_QUEUE_SCAN = 500;

/**
 * An "album context" (auto mode → album gain) is an unshuffled queue whose
 * tracks all belong to one identified album. Shuffle, radio, and mixed
 * queues level per track instead.
 */
export function isAlbumOrderedQueue(
    queue: readonly { album?: { id?: string } }[],
    isShuffle: boolean,
): boolean {
    if (
        isShuffle ||
        queue.length === 0 ||
        queue.length > MAX_ALBUM_QUEUE_SCAN
    ) {
        return false;
    }
    const albumId = queue[0].album?.id;
    if (!albumId) return false;
    return queue.every((entry) => entry.album?.id === albumId);
}

/** Resolves the playback gain for one track under the user's mode. */
export function resolveLoudnessGain(
    input: LoudnessGainInput,
): LoudnessGainDecision {
    if (input.mode === "off") return { ...PASS_THROUGH, reason: "mode_off" };
    if (!input.track) return { ...PASS_THROUGH, reason: "no_track" };
    if (!isFiniteNumber(input.targetLufs)) {
        return { ...PASS_THROUGH, reason: "invalid_target" };
    }

    const scope = resolveScope(input);
    if (scope.measuredLufs === null) {
        return { ...PASS_THROUGH, reason: "unmeasured" };
    }

    const desiredDb = input.targetLufs - scope.measuredLufs;
    if (desiredDb <= 0) {
        return {
            gainDb: desiredDb,
            gainFactor: 10 ** (desiredDb / 20),
            reason: "leveled",
        };
    }

    if (scope.truePeakDb === null) {
        return { ...PASS_THROUGH, reason: "boost_denied_no_peak" };
    }

    const headroomDb = Math.max(0, -scope.truePeakDb);
    const grantedDb = Math.min(desiredDb, MAX_BOOST_DB, headroomDb);
    return {
        gainDb: grantedDb,
        gainFactor: 10 ** (grantedDb / 20),
        reason: grantedDb < desiredDb ? "boost_clamped" : "leveled",
    };
}
