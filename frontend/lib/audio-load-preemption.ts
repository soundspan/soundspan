export interface AudioLoadPreemptionDecisionInput {
    currentMediaId: string | null;
    previousMediaId: string | null;
    isLoading: boolean;
}

export interface InitialPersistedResumeDecisionInput {
    isInitialTrackLoad: boolean;
    segmentedStartupEligible: boolean;
    listenTogetherActiveOrPending: boolean;
}

export const shouldPreemptInFlightAudioLoad = (
    input: AudioLoadPreemptionDecisionInput,
): boolean =>
    input.isLoading &&
    input.currentMediaId !== null &&
    input.previousMediaId !== null &&
    input.currentMediaId !== input.previousMediaId;

export const shouldAllowInitialPersistedTrackResume = (
    input: InitialPersistedResumeDecisionInput,
): boolean =>
    input.isInitialTrackLoad &&
    !input.segmentedStartupEligible &&
    !input.listenTogetherActiveOrPending;
