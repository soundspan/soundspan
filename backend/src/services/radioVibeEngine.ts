/**
 * @module radioVibeEngine
 *
 * Reusable vibe-matching engine for multi-track seeded radio.
 * Extracts the pure math functions used by the single-track vibe case
 * into standalone, testable utilities, plus new aggregate functions for
 * computing a centroid feature vector from multiple seed tracks.
 */

const RELIABLE_ENHANCED_ANALYSIS_VERSION_PREFIX = "2.1b6-enhanced-v3";

/** Maximum number of seed tracks sampled for centroid calculation. */
const MAX_SEED_SAMPLE = 100;

/**
 * Checks whether a track has reliable enhanced analysis data.
 *
 * @param analysisMode - The track's analysis mode field.
 * @param analysisVersion - The track's analysis version field.
 * @returns True if the track was analyzed in enhanced mode with a reliable version.
 */
export const hasReliableEnhanced = (
    analysisMode: string | null | undefined,
    analysisVersion: string | null | undefined
): boolean =>
    analysisMode === "enhanced" &&
    typeof analysisVersion === "string" &&
    analysisVersion.startsWith(RELIABLE_ENHANCED_ANALYSIS_VERSION_PREFIX);

/**
 * Computes enhanced valence from mode/tonality, mood predictions, and audio features.
 *
 * @param track - Track object with mood and audio analysis fields.
 * @returns Clamped 0-1 valence score.
 */
export const calculateEnhancedValence = (track: any): number => {
    const happy = track.moodHappy ?? 0.5;
    const sad = track.moodSad ?? 0.5;
    const party = (track as any).moodParty ?? 0.5;
    const isMajor = track.keyScale === "major";
    const isMinor = track.keyScale === "minor";
    const modeValence = isMajor ? 0.3 : isMinor ? -0.2 : 0;
    const moodValence = happy * 0.35 + party * 0.25 + (1 - sad) * 0.2;
    const audioValence =
        (track.energy ?? 0.5) * 0.1 +
        (track.danceabilityMl ?? track.danceability ?? 0.5) * 0.1;

    return Math.max(0, Math.min(1, moodValence + modeValence + audioValence));
};

/**
 * Computes enhanced arousal from mood predictions, energy, and tempo.
 *
 * @param track - Track object with mood and audio analysis fields.
 * @returns Clamped 0-1 arousal score.
 */
export const calculateEnhancedArousal = (track: any): number => {
    const aggressive = track.moodAggressive ?? 0.5;
    const party = (track as any).moodParty ?? 0.5;
    const relaxed = track.moodRelaxed ?? 0.5;
    const acoustic = (track as any).moodAcoustic ?? 0.5;
    const energy = track.energy ?? 0.5;
    const bpm = track.bpm ?? 120;
    const moodArousal = aggressive * 0.3 + party * 0.2;
    const energyArousal = energy * 0.25;
    const tempoArousal =
        Math.max(0, Math.min(1, (bpm - 60) / 120)) * 0.15;
    const calmReduction =
        (1 - relaxed) * 0.05 + (1 - acoustic) * 0.05;

    return Math.max(
        0,
        Math.min(1, moodArousal + energyArousal + tempoArousal + calmReduction)
    );
};

/**
 * Out-of-distribution mood detection using energy-based scoring.
 * Flags tracks where all core moods are uniformly high or uniformly neutral.
 *
 * @param track - Track object with mood analysis fields.
 * @returns True if the track's mood predictions appear out-of-distribution.
 */
export const detectOOD = (track: any): boolean => {
    const coreMoods = [
        track.moodHappy ?? 0.5,
        track.moodSad ?? 0.5,
        track.moodRelaxed ?? 0.5,
        track.moodAggressive ?? 0.5,
    ];

    const minMood = Math.min(...coreMoods);
    const maxMood = Math.max(...coreMoods);

    const allHigh = minMood > 0.7 && maxMood - minMood < 0.3;
    const allNeutral =
        Math.abs(maxMood - 0.5) < 0.15 && Math.abs(minMood - 0.5) < 0.15;

    return allHigh || allNeutral;
};

/**
 * Octave-aware BPM distance calculation.
 * Normalizes BPMs to the standard octave range (77-154) before computing
 * logarithmic distance, treating half/double time as equivalent.
 *
 * @param bpm1 - First BPM value.
 * @param bpm2 - Second BPM value.
 * @returns Distance in 0-1 range (0 = identical, 1 = maximum distance).
 */
export const octaveAwareBPMDistance = (bpm1: number, bpm2: number): number => {
    if (!bpm1 || !bpm2) return 0;

    const normalizeToOctave = (bpm: number): number => {
        while (bpm < 77) bpm *= 2;
        while (bpm > 154) bpm /= 2;
        return bpm;
    };

    const norm1 = normalizeToOctave(bpm1);
    const norm2 = normalizeToOctave(bpm2);

    const logDistance = Math.abs(Math.log2(norm1) - Math.log2(norm2));
    return Math.min(logDistance, 1);
};

/**
 * Builds a 13-element weighted feature vector from a track's analysis data.
 * The vector consists of 7 ML mood features (1.3x weight) and 5 audio features.
 *
 * @param track - Track object with full analysis fields.
 * @returns 13-element numeric feature vector.
 */
export const buildFeatureVector = (track: any): number[] => {
    const trackHasReliable = hasReliableEnhanced(
        track.analysisMode,
        track.analysisVersion
    );
    const isOOD = trackHasReliable && detectOOD(track);

    const getMoodValue = (
        value: number | null,
        defaultValue: number
    ): number => {
        if (!value) return defaultValue;
        if (!isOOD) return value;
        return 0.2 + Math.max(0, Math.min(0.6, value - 0.2));
    };

    const enhancedValence = trackHasReliable
        ? calculateEnhancedValence(track)
        : (track.valence ?? 0.5);
    const enhancedArousal = trackHasReliable
        ? calculateEnhancedArousal(track)
        : (track.arousal ?? track.energy ?? 0.5);

    return [
        // ML Mood predictions (7 features) — enhanced weighting and OOD handling
        getMoodValue(trackHasReliable ? track.moodHappy : null, 0.5) * 1.3,
        getMoodValue(trackHasReliable ? track.moodSad : null, 0.5) * 1.3,
        getMoodValue(trackHasReliable ? track.moodRelaxed : null, 0.5) * 1.3,
        getMoodValue(trackHasReliable ? track.moodAggressive : null, 0.5) * 1.3,
        getMoodValue(trackHasReliable ? (track as any).moodParty : null, 0.5) * 1.3,
        getMoodValue(trackHasReliable ? (track as any).moodAcoustic : null, 0.5) * 1.3,
        getMoodValue(trackHasReliable ? (track as any).moodElectronic : null, 0.5) * 1.3,
        // Audio features (5 features) — standard weight
        track.energy ?? 0.5,
        enhancedArousal,
        track.danceabilityMl ?? track.danceability ?? 0.5,
        track.instrumentalness ?? 0.5,
        1 - octaveAwareBPMDistance(track.bpm ?? 120, 120),
        enhancedValence,
    ];
};

/**
 * Computes cosine similarity between two numeric vectors.
 *
 * @param a - First vector.
 * @param b - Second vector (must be same length as a).
 * @returns Similarity score in 0-1 range.
 */
export const cosineSimilarity = (a: number[], b: number[]): number => {
    let dot = 0,
        magA = 0,
        magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    if (magA === 0 || magB === 0) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
};

/**
 * Computes a tag/genre overlap bonus between source and candidate tracks.
 * Merges lastfmTags and essentiaGenres, then counts overlap.
 *
 * @param sourceTags - Source track's Last.fm tags.
 * @param sourceGenres - Source track's Essentia genres.
 * @param trackTags - Candidate track's Last.fm tags.
 * @param trackGenres - Candidate track's Essentia genres.
 * @returns Bonus score capped at 0.05 (5%).
 */
export const computeTagBonus = (
    sourceTags: string[],
    sourceGenres: string[],
    trackTags: string[],
    trackGenres: string[]
): number => {
    const sourceSet = new Set(
        [...sourceTags, ...sourceGenres].map((t) => t.toLowerCase())
    );
    const trackSet = new Set(
        [...trackTags, ...trackGenres].map((t) => t.toLowerCase())
    );
    if (sourceSet.size === 0 || trackSet.size === 0) return 0;
    const overlap = [...sourceSet].filter((tag) => trackSet.has(tag)).length;
    return Math.min(0.05, overlap * 0.01);
};

/**
 * Computes the element-wise mean (centroid) of feature vectors from multiple seed tracks.
 * Caps input at MAX_SEED_SAMPLE random samples to prevent over-averaging.
 *
 * @param seedTracks - Array of track objects with analysis fields.
 * @returns Centroid feature vector, or null if no seeds have analysis data.
 */
export const computeAggregateFeatureVector = (
    seedTracks: any[]
): number[] | null => {
    if (!seedTracks || seedTracks.length === 0) return null;

    // Filter to tracks that have at least some audio data
    // Use explicit null checks since 0 is a valid value for these fields
    const analyzable = seedTracks.filter(
        (t) => t.bpm != null || t.energy != null || t.valence != null
    );
    if (analyzable.length === 0) return null;

    // Sample if we have too many seeds
    let sampled = analyzable;
    if (sampled.length > MAX_SEED_SAMPLE) {
        // Fisher-Yates partial shuffle for random sample
        const copy = [...sampled];
        for (let i = copy.length - 1; i > copy.length - MAX_SEED_SAMPLE - 1 && i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        sampled = copy.slice(copy.length - MAX_SEED_SAMPLE);
    }

    // Build vectors and compute element-wise mean
    const vectors = sampled.map((t) => buildFeatureVector(t));
    const dim = vectors[0].length;
    const centroid = new Array(dim).fill(0);

    for (const vec of vectors) {
        for (let i = 0; i < dim; i++) {
            centroid[i] += vec[i];
        }
    }

    for (let i = 0; i < dim; i++) {
        centroid[i] /= vectors.length;
    }

    return centroid;
};

/** A scored candidate track with its similarity score. */
export interface ScoredTrack {
    /** Track ID. */
    id: string;
    /** Final similarity score (0-1). */
    score: number;
}

/**
 * Scores candidate tracks against a seed feature vector using cosine similarity,
 * tag overlap bonus, and preference bias. Returns sorted results above the threshold.
 *
 * @param seedVector - Centroid feature vector from seed tracks.
 * @param seedTags - Merged Last.fm tags from all seed tracks.
 * @param seedGenres - Merged Essentia genres from all seed tracks.
 * @param candidates - Analyzed candidate tracks to score.
 * @param preferenceScores - Map of trackId to preference score for bias.
 * @param applyPreferenceBias - Function to apply preference bias to similarity score.
 * @returns Sorted array of scored tracks above the similarity threshold.
 */
export const scoreTracksAgainstSeed = (
    seedVector: number[],
    seedTags: string[],
    seedGenres: string[],
    candidates: any[],
    preferenceScores: Map<string, number>,
    applyPreferenceBias: (score: number, preference: number) => number
): ScoredTrack[] => {
    // Use lower threshold when we have enhanced data in the centroid
    const minThreshold = 0.40;

    const scored: ScoredTrack[] = [];
    for (const t of candidates) {
        const targetVector = buildFeatureVector(t);
        let score = cosineSimilarity(seedVector, targetVector);

        const tagBonus = computeTagBonus(
            seedTags,
            seedGenres,
            t.lastfmTags || [],
            t.essentiaGenres || []
        );

        const finalScore = Math.max(
            0,
            Math.min(
                1,
                applyPreferenceBias(
                    score * 0.95 + tagBonus,
                    preferenceScores.get(t.id) ?? 0
                )
            )
        );

        if (finalScore > minThreshold) {
            scored.push({ id: t.id, score: finalScore });
        }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored;
};
