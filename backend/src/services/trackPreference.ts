export const TRACK_DISLIKE_ENTITY_TYPE = "track" as const;

export type TrackPreferenceSignal = "thumbs_up" | "thumbs_down" | "clear";
export type TrackPreferenceState = "liked" | "disliked" | "neutral";

export const TRACK_PREFERENCE_SIGNAL_SCORE: Record<TrackPreferenceSignal, number> = {
    thumbs_up: 1,
    thumbs_down: -1,
    clear: 0,
};

export interface ResolvedTrackPreference {
    signal: TrackPreferenceSignal;
    state: TrackPreferenceState;
    score: number;
    likedAt: Date | null;
    dislikedAt: Date | null;
    updatedAt: Date | null;
}

export interface TrackPreferenceSimilarityBiasConfig {
    likedBoost: number;
    dislikedPenalty: number;
}

export interface TrackPreferenceOrderBiasConfig {
    likedLiftSlots: number;
    dislikedDropSlots: number;
}

export const TRACK_PREFERENCE_SIMILARITY_BIAS: TrackPreferenceSimilarityBiasConfig = {
    likedBoost: 0.025,
    dislikedPenalty: 0.04,
};

export const TRACK_PREFERENCE_ORDER_BIAS: TrackPreferenceOrderBiasConfig = {
    likedLiftSlots: 1.35,
    dislikedDropSlots: 2.0,
};

export const resolveTrackPreference = ({
    likedAt,
    dislikedAt,
}: {
    likedAt?: Date | null;
    dislikedAt?: Date | null;
}): ResolvedTrackPreference => {
    const normalizedLikedAt = likedAt ?? null;
    const normalizedDislikedAt = dislikedAt ?? null;

    if (normalizedLikedAt && normalizedDislikedAt) {
        const preferLiked = normalizedLikedAt >= normalizedDislikedAt;
        const signal: TrackPreferenceSignal =
            preferLiked ? "thumbs_up" : "thumbs_down";
        const state: TrackPreferenceState = preferLiked ? "liked" : "disliked";
        const updatedAt = preferLiked ? normalizedLikedAt : normalizedDislikedAt;
        return {
            signal,
            state,
            score: TRACK_PREFERENCE_SIGNAL_SCORE[signal],
            likedAt: normalizedLikedAt,
            dislikedAt: normalizedDislikedAt,
            updatedAt,
        };
    }

    if (normalizedLikedAt) {
        return {
            signal: "thumbs_up",
            state: "liked",
            score: TRACK_PREFERENCE_SIGNAL_SCORE.thumbs_up,
            likedAt: normalizedLikedAt,
            dislikedAt: null,
            updatedAt: normalizedLikedAt,
        };
    }

    if (normalizedDislikedAt) {
        return {
            signal: "thumbs_down",
            state: "disliked",
            score: TRACK_PREFERENCE_SIGNAL_SCORE.thumbs_down,
            likedAt: null,
            dislikedAt: normalizedDislikedAt,
            updatedAt: normalizedDislikedAt,
        };
    }

    return {
        signal: "clear",
        state: "neutral",
        score: TRACK_PREFERENCE_SIGNAL_SCORE.clear,
        likedAt: null,
        dislikedAt: null,
        updatedAt: null,
    };
};

export const normalizeTrackPreferenceSignal = (
    value: unknown
): TrackPreferenceSignal | null => {
    if (typeof value === "number") {
        if (value > 0) return "thumbs_up";
        if (value < 0) return "thumbs_down";
        if (value === 0) return "clear";
        return null;
    }

    if (typeof value !== "string") {
        return null;
    }

    const normalized = value.trim().toLowerCase();

    if (
        normalized === "thumbs_up" ||
        normalized === "up" ||
        normalized === "liked" ||
        normalized === "like" ||
        normalized === "1"
    ) {
        return "thumbs_up";
    }

    if (
        normalized === "thumbs_down" ||
        normalized === "down" ||
        normalized === "disliked" ||
        normalized === "dislike" ||
        normalized === "-1"
    ) {
        return "thumbs_down";
    }

    if (
        normalized === "clear" ||
        normalized === "neutral" ||
        normalized === "none" ||
        normalized === "0"
    ) {
        return "clear";
    }

    return null;
};

export const applyTrackPreferenceSimilarityBias = (
    baseScore: number,
    preferenceScore: number,
    config: TrackPreferenceSimilarityBiasConfig = TRACK_PREFERENCE_SIMILARITY_BIAS
): number => {
    if (!Number.isFinite(baseScore) || !Number.isFinite(preferenceScore)) {
        return baseScore;
    }

    if (preferenceScore > 0) {
        return baseScore + config.likedBoost * preferenceScore;
    }

    if (preferenceScore < 0) {
        return baseScore - config.dislikedPenalty * Math.abs(preferenceScore);
    }

    return baseScore;
};

export const applyTrackPreferenceOrderBias = (
    trackIds: string[],
    preferenceScores: Map<string, number>,
    config: TrackPreferenceOrderBiasConfig = TRACK_PREFERENCE_ORDER_BIAS
): string[] => {
    if (trackIds.length <= 1 || preferenceScores.size === 0) {
        return trackIds;
    }

    const ranked = trackIds.map((trackId, baseIndex) => {
        const preferenceScore = preferenceScores.get(trackId) ?? 0;
        const adjustedIndex =
            baseIndex -
            Math.max(preferenceScore, 0) * config.likedLiftSlots +
            Math.abs(Math.min(preferenceScore, 0)) * config.dislikedDropSlots;

        return {
            trackId,
            baseIndex,
            adjustedIndex,
        };
    });

    ranked.sort((left, right) => {
        if (left.adjustedIndex !== right.adjustedIndex) {
            return left.adjustedIndex - right.adjustedIndex;
        }
        return left.baseIndex - right.baseIndex;
    });

    return ranked.map((entry) => entry.trackId);
};
