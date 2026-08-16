/** Tracks retry attempts for each segmented-startup recovery stage. */
export interface SegmentedStartupRecoveryStageAttempts {
    session_create: number;
    manifest_readiness: number;
    engine_load: number;
}

/** Defines the retry limit for each segmented-startup recovery stage. */
export type SegmentedStartupRecoveryStageLimits =
    SegmentedStartupRecoveryStageAttempts;
