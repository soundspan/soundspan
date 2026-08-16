import { useCallback } from "react";
import { api, type SegmentedStreamingSessionResponse } from "@/lib/api";
import { resolveSegmentedPrewarmMaxRetries } from "@/lib/audio-engine/segmentedStartupPolicy";
import {
    SEGMENTED_PREWARM_RETRY_DELAY_MS,
    SEGMENTED_PREWARM_VALIDATION_TIMEOUT_MS,
} from "@/lib/audio-engine/audioPlaybackOrchestratorConstants";
import {
    buildSegmentedSessionKey,
    isSegmentedSessionPrewarmEnabled,
    isSegmentedSessionUsable,
    resolveStartupChunkNamesFromManifest,
} from "@/lib/audio-engine/audioPlaybackRuntimePolicy";
import { logPlaybackClientMetric } from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import type { SegmentedTrackContext } from "@/lib/audio-engine/audioPlaybackTrackPolicy";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import type { SegmentedSessionPrewarmOptions } from "./audioPlaybackOrchestratorTypes";

interface UseSegmentedPrewarmOptions {
    refs: PlaybackOrchestratorRefs;
    abortSegmentedPrewarmValidation: (
        sessionId: string,
        reason: "superseded" | "track_change" | "unmount",
    ) => void;
    clearSegmentedPrewarmRetry: (sessionKey: string) => void;
}

/** Preserves segmented prewarm and startup-session callbacks verbatim. */
export function useSegmentedPrewarm({
    refs,
    abortSegmentedPrewarmValidation,
    clearSegmentedPrewarmRetry,
}: UseSegmentedPrewarmOptions) {
    const {
        segmentedPrewarmValidatedSessionIdsRef,
        segmentedPrewarmValidationInFlightRef,
        segmentedPrewarmValidationSessionByKeyRef,
        segmentedPrewarmValidationAbortControllersRef,
        lastPreloadedTrackIdRef,
        prewarmedSegmentedSessionRef,
        segmentedPrewarmInFlightRef,
        segmentedPrewarmRetryTimeoutsRef,
        startupSegmentedSessionRef,
        startupSegmentedSessionPromisesRef,
        startupSegmentedSessionInFlightRef,
        currentTrackRef,
    } = refs;

    const validatePrewarmedSegmentedSession = useCallback(
        async ({
            session,
            sessionKey,
            context,
            trackId,
            trigger,
        }: {
            session: SegmentedStreamingSessionResponse;
            sessionKey: string;
            context: SegmentedTrackContext;
            trackId: string;
            trigger: SegmentedSessionPrewarmOptions["reason"];
        }): Promise<"validated" | "aborted" | "failed"> => {
            const sessionId = session.sessionId;
            if (segmentedPrewarmValidatedSessionIdsRef.current.has(sessionId)) {
                return "validated";
            }
            if (segmentedPrewarmValidationInFlightRef.current.has(sessionId)) {
                return "aborted";
            }

            const priorSessionIdForKey =
                segmentedPrewarmValidationSessionByKeyRef.current.get(
                    sessionKey,
                );
            if (priorSessionIdForKey && priorSessionIdForKey !== sessionId) {
                abortSegmentedPrewarmValidation(
                    priorSessionIdForKey,
                    "superseded",
                );
            }

            const staleController =
                segmentedPrewarmValidationAbortControllersRef.current.get(
                    sessionId,
                );
            if (staleController) {
                abortSegmentedPrewarmValidation(sessionId, "superseded");
            }

            segmentedPrewarmValidationInFlightRef.current.add(sessionId);
            segmentedPrewarmValidationSessionByKeyRef.current.set(
                sessionKey,
                sessionId,
            );
            const validationController = new AbortController();
            segmentedPrewarmValidationAbortControllersRef.current.set(
                sessionId,
                validationController,
            );
            const sourceType =
                session.playbackProfile?.sourceType ??
                session.engineHints?.sourceType ??
                context.sourceType;

            const timeoutSignal = AbortSignal.timeout(
                SEGMENTED_PREWARM_VALIDATION_TIMEOUT_MS,
            );
            const composedSignal = AbortSignal.any([
                validationController.signal,
                timeoutSignal,
            ]);

            try {
                const manifestResponse =
                    await api.fetchSegmentedStreamingManifest(
                        session.manifestUrl,
                        session.sessionToken,
                        composedSignal,
                    );
                if (!manifestResponse.ok) {
                    throw new Error(`manifest_http_${manifestResponse.status}`);
                }

                const manifestContents = await manifestResponse.text();
                const startupChunkNames =
                    resolveStartupChunkNamesFromManifest(manifestContents);
                for (const chunkName of startupChunkNames) {
                    const segmentResponse =
                        await api.fetchSegmentedStreamingSegment(
                            sessionId,
                            session.sessionToken,
                            chunkName,
                            composedSignal,
                        );
                    if (!segmentResponse.ok) {
                        throw new Error(
                            `segment_http_${segmentResponse.status}:${chunkName}`,
                        );
                    }
                }

                segmentedPrewarmValidatedSessionIdsRef.current.add(sessionId);
                logPlaybackClientMetric("session.prewarm_validated", {
                    trackId,
                    sourceType,
                    sessionId,
                    trigger,
                    validatedChunkCount: startupChunkNames.length,
                });
                return "validated";
            } catch (error) {
                const isTimeout =
                    error instanceof Error && error.name === "TimeoutError";
                if (
                    validationController.signal.aborted ||
                    composedSignal.aborted ||
                    isTimeout ||
                    (error instanceof Error && error.name === "AbortError")
                ) {
                    const abortReason = isTimeout
                        ? "timeout"
                        : typeof validationController.signal.reason === "string"
                          ? validationController.signal.reason
                          : "aborted";
                    logPlaybackClientMetric(
                        "session.prewarm_validation_aborted",
                        {
                            trackId,
                            sourceType,
                            sessionId,
                            trigger,
                            reason: abortReason,
                        },
                    );
                    return "aborted";
                }
                const message =
                    error instanceof Error
                        ? error.message
                        : String(error ?? "unknown");
                const failedChunkMatch = message.match(/:(chunk-[^:]+)$/);
                const failedChunkName = failedChunkMatch
                    ? failedChunkMatch[1]
                    : null;
                logPlaybackClientMetric("session.prewarm_validation_failed", {
                    trackId,
                    sourceType,
                    sessionId,
                    trigger,
                    failedChunkName,
                    error: message,
                });
                return "failed";
            } finally {
                segmentedPrewarmValidationInFlightRef.current.delete(sessionId);
                if (
                    segmentedPrewarmValidationAbortControllersRef.current.get(
                        sessionId,
                    ) === validationController
                ) {
                    segmentedPrewarmValidationAbortControllersRef.current.delete(
                        sessionId,
                    );
                }
                if (
                    segmentedPrewarmValidationSessionByKeyRef.current.get(
                        sessionKey,
                    ) === sessionId
                ) {
                    segmentedPrewarmValidationSessionByKeyRef.current.delete(
                        sessionKey,
                    );
                }
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [abortSegmentedPrewarmValidation],
    );

    const prewarmSegmentedSession = useCallback(
        ({
            sessionKey,
            context,
            trackId,
            reason,
            retryCount = 0,
        }: SegmentedSessionPrewarmOptions): void => {
            if (!isSegmentedSessionPrewarmEnabled()) {
                return;
            }
            if (
                reason === "next_track" &&
                lastPreloadedTrackIdRef.current &&
                trackId !== lastPreloadedTrackIdRef.current
            ) {
                clearSegmentedPrewarmRetry(sessionKey);
                logPlaybackClientMetric("session.prewarm_skip", {
                    trackId,
                    sourceType: context.sourceType,
                    reason: "next_track_changed",
                    trigger: reason,
                    attempt: retryCount,
                });
                return;
            }
            const existingPrewarmedSession =
                prewarmedSegmentedSessionRef.current.get(sessionKey);
            if (
                existingPrewarmedSession &&
                isSegmentedSessionUsable(existingPrewarmedSession)
            ) {
                clearSegmentedPrewarmRetry(sessionKey);
                return;
            }

            if (segmentedPrewarmInFlightRef.current.has(sessionKey)) {
                return;
            }

            const supersededValidationSessionId =
                segmentedPrewarmValidationSessionByKeyRef.current.get(
                    sessionKey,
                );
            if (supersededValidationSessionId) {
                abortSegmentedPrewarmValidation(
                    supersededValidationSessionId,
                    "superseded",
                );
            }

            clearSegmentedPrewarmRetry(sessionKey);
            prewarmedSegmentedSessionRef.current.delete(sessionKey);
            segmentedPrewarmInFlightRef.current.add(sessionKey);

            const schedulePrewarmRetry = (
                session: SegmentedStreamingSessionResponse,
                nextAttempt: number,
            ): void => {
                const retryTimeout = setTimeout(() => {
                    segmentedPrewarmRetryTimeoutsRef.current.delete(sessionKey);
                    // eslint-disable-next-line react-hooks/immutability -- Preserve the relocated bounded recursive retry callback.
                    prewarmSegmentedSession({
                        sessionKey,
                        context,
                        trackId,
                        reason,
                        retryCount: nextAttempt,
                    });
                }, SEGMENTED_PREWARM_RETRY_DELAY_MS);
                segmentedPrewarmRetryTimeoutsRef.current.set(
                    sessionKey,
                    retryTimeout,
                );
                logPlaybackClientMetric("session.prewarm_retry_scheduled", {
                    trackId,
                    sourceType:
                        session.playbackProfile?.sourceType ??
                        session.engineHints?.sourceType ??
                        context.sourceType,
                    trigger: reason,
                    attempt: nextAttempt,
                });
            };

            void api
                .createSegmentedStreamingSession({
                    trackId: context.sessionTrackId,
                    sourceType: context.sourceType,
                    manifestProfile: "steady_state_dual",
                })
                .then(async (session) => {
                    if (!isSegmentedSessionUsable(session)) {
                        return;
                    }
                    if (session.engineHints?.assetBuildInFlight === true) {
                        const maxRetries =
                            resolveSegmentedPrewarmMaxRetries(reason);
                        if (retryCount < maxRetries) {
                            const nextAttempt = retryCount + 1;
                            schedulePrewarmRetry(session, nextAttempt);
                            return;
                        }
                        logPlaybackClientMetric("session.prewarm_skip", {
                            trackId,
                            sourceType:
                                session.playbackProfile?.sourceType ??
                                session.engineHints?.sourceType ??
                                context.sourceType,
                            reason: "backend_asset_build_inflight",
                            trigger: reason,
                            attempt: retryCount,
                        });
                        return;
                    }
                    prewarmedSegmentedSessionRef.current.set(
                        sessionKey,
                        session,
                    );

                    const validationResult =
                        await validatePrewarmedSegmentedSession({
                            session,
                            sessionKey,
                            context,
                            trackId,
                            trigger: reason,
                        });
                    const currentPrewarmedSession =
                        prewarmedSegmentedSessionRef.current.get(sessionKey);
                    const sessionStillPrewarmed =
                        currentPrewarmedSession?.sessionId ===
                        session.sessionId;

                    if (validationResult === "failed") {
                        if (sessionStillPrewarmed) {
                            prewarmedSegmentedSessionRef.current.delete(
                                sessionKey,
                            );
                        }
                        const maxRetries =
                            resolveSegmentedPrewarmMaxRetries(reason);
                        if (sessionStillPrewarmed && retryCount < maxRetries) {
                            const nextAttempt = retryCount + 1;
                            schedulePrewarmRetry(session, nextAttempt);
                        } else if (sessionStillPrewarmed) {
                            logPlaybackClientMetric("session.prewarm_skip", {
                                trackId,
                                sourceType:
                                    session.playbackProfile?.sourceType ??
                                    session.engineHints?.sourceType ??
                                    context.sourceType,
                                reason: "validation_failed",
                                trigger: reason,
                                attempt: retryCount,
                            });
                        }
                        return;
                    }

                    if (validationResult === "aborted") {
                        return;
                    }

                    clearSegmentedPrewarmRetry(sessionKey);
                    logPlaybackClientMetric("session.prewarm_success", {
                        trackId,
                        sourceType:
                            session.playbackProfile?.sourceType ??
                            session.engineHints?.sourceType ??
                            context.sourceType,
                        sessionId: session.sessionId,
                        trigger: reason,
                        attempt: retryCount,
                    });
                })
                .catch((error) => {
                    sharedFrontendLogger.warn(
                        "[AudioPlaybackOrchestrator] Segmented prewarm failed:",
                        error,
                    );
                    logPlaybackClientMetric("session.prewarm_failure", {
                        trackId,
                        sourceType: context.sourceType,
                        trigger: reason,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error ?? "unknown"),
                    });
                })
                .finally(() => {
                    segmentedPrewarmInFlightRef.current.delete(sessionKey);
                });
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [
            abortSegmentedPrewarmValidation,
            clearSegmentedPrewarmRetry,
            validatePrewarmedSegmentedSession,
        ],
    );

    const ensureStartupSegmentedSession = useCallback(
        (
            trackId: string,
            context: SegmentedTrackContext,
            trigger: "load_segmented_startup" | "prewarm_asset_build_inflight",
            startupMetadata?: {
                startupLoadId?: number;
                startupCorrelationId?: string;
            },
        ): Promise<SegmentedStreamingSessionResponse | null> => {
            const existingStartupSession = startupSegmentedSessionRef.current;
            if (
                existingStartupSession &&
                existingStartupSession.trackId === trackId &&
                existingStartupSession.sourceType === context.sourceType &&
                isSegmentedSessionUsable(existingStartupSession.session)
            ) {
                return Promise.resolve(existingStartupSession.session);
            }

            const startupSessionKey = buildSegmentedSessionKey(context);
            const existingStartupPromise =
                startupSegmentedSessionPromisesRef.current.get(
                    startupSessionKey,
                );
            if (existingStartupPromise) {
                return existingStartupPromise;
            }

            startupSegmentedSessionInFlightRef.current.add(startupSessionKey);
            const startupPromise = api
                .createSegmentedStreamingSession({
                    trackId: context.sessionTrackId,
                    sourceType: context.sourceType,
                    startupLoadId: startupMetadata?.startupLoadId,
                    startupCorrelationId: startupMetadata?.startupCorrelationId,
                    manifestProfile: "steady_state_dual",
                })
                .then((session) => {
                    if (!isSegmentedSessionUsable(session)) {
                        return null;
                    }
                    if (currentTrackRef.current?.id !== trackId) {
                        return null;
                    }
                    startupSegmentedSessionRef.current = {
                        trackId,
                        sourceType: context.sourceType,
                        session,
                    };
                    logPlaybackClientMetric("session.startup_ready", {
                        trackId,
                        sourceType:
                            session.playbackProfile?.sourceType ??
                            session.engineHints?.sourceType ??
                            context.sourceType,
                        sessionId: session.sessionId,
                        assetBuildInFlight:
                            session.engineHints?.assetBuildInFlight === true,
                        trigger,
                    });
                    return session;
                })
                .catch((error) => {
                    sharedFrontendLogger.warn(
                        "[AudioPlaybackOrchestrator] Startup segmented session request failed:",
                        error,
                    );
                    logPlaybackClientMetric("session.startup_failure", {
                        trackId,
                        sourceType: context.sourceType,
                        trigger,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error ?? "unknown"),
                    });
                    return null;
                })
                .finally(() => {
                    startupSegmentedSessionInFlightRef.current.delete(
                        startupSessionKey,
                    );
                    startupSegmentedSessionPromisesRef.current.delete(
                        startupSessionKey,
                    );
                });
            startupSegmentedSessionPromisesRef.current.set(
                startupSessionKey,
                startupPromise,
            );
            return startupPromise;
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [],
    );

    return {
        validatePrewarmedSegmentedSession,
        prewarmSegmentedSession,
        ensureStartupSegmentedSession,
    };
}
