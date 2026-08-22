/** Minimum confidence accepted for automatic provider mapping playback. */
export const MIN_PROVIDER_MAPPING_CONFIDENCE = 0.7;

const DURATION_MISMATCH_THRESHOLD_SECONDS = 15;

/** Returns whether a provider mapping is safe to use for playback. */
export function isProviderMappingEligible(input: {
    confidence: number;
    expectedDurationSeconds: number;
    actualDurationSeconds: number;
}): boolean {
    if (
        !Number.isFinite(input.confidence) ||
        input.confidence < MIN_PROVIDER_MAPPING_CONFIDENCE
    ) {
        return false;
    }
    if (
        !Number.isFinite(input.expectedDurationSeconds) ||
        !Number.isFinite(input.actualDurationSeconds)
    ) {
        return true;
    }
    return (
        Math.abs(
            Math.trunc(input.expectedDurationSeconds) -
                Math.trunc(input.actualDurationSeconds),
        ) <= DURATION_MISMATCH_THRESHOLD_SECONDS
    );
}
