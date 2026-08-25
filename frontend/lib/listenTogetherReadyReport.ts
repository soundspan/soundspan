/**
 * Pure decision math for Listen Together ready reporting (GH #787).
 * When the server says "buffer this track and report ready", the follower
 * must decide on every poll tick whether the local engine has the expected
 * track loaded, whether to keep waiting, or whether to give up and resync.
 * Kept free of React, sockets, and timers so the rules are unit-testable.
 */

export interface ReadyReportSnapshot {
    /** Track id the server's waiting event named, if any. */
    expectedTrackId: string | null;
    /** Track id at the waiting index in the server's queue snapshot. */
    serverQueuedTrackId: string | null;
    /** Local track id the availability map says the index maps to. */
    expectedLocalTrackId: string | null;
    /** Track id the local player currently has active. */
    activeTrackId: string | null;
    /** Track id at the waiting index in the local queue. */
    queuedTrackId: string | null;
    /** Track id the engine last actually loaded. */
    loadedTrackId: string | null;
    engineDurationSec: number;
    engineCurrentTimeSec: number;
    elapsedMs: number;
    maxWaitMs: number;
}

export interface ReadyReportEvaluation {
    /**
     * report — the expected track is ready (or the wait expired with a
     *   matching track): confirm readiness to the server.
     * recover — the wait expired without the expected track: schedule a
     *   group resync instead of blocking the session.
     * poll — keep waiting.
     */
    decision: "report" | "recover" | "poll";
    hasTrackMatch: boolean;
    mediaReady: boolean;
    timedOut: boolean;
}

function presentIds(candidates: Array<string | null>): string[] {
    return Array.from(
        new Set(
            candidates.filter(
                (candidate): candidate is string =>
                    typeof candidate === "string" && candidate.length > 0,
            ),
        ),
    );
}

/** One poll-tick readiness decision from a snapshot of local/server state. */
export function evaluateReadyReport(
    snapshot: ReadyReportSnapshot,
): ReadyReportEvaluation {
    const expectedCandidates = presentIds([
        snapshot.expectedTrackId,
        snapshot.serverQueuedTrackId,
        snapshot.expectedLocalTrackId,
    ]);
    const localCandidates = presentIds([
        snapshot.activeTrackId,
        snapshot.queuedTrackId,
    ]);

    const hasTrackMatch =
        expectedCandidates.length === 0 ||
        localCandidates.some((candidate) =>
            expectedCandidates.includes(candidate),
        );
    const readinessTrackId =
        localCandidates.find(
            (candidate) =>
                expectedCandidates.length === 0 ||
                expectedCandidates.includes(candidate),
        ) ?? null;
    const hasLoadedExpectedTrack =
        Boolean(readinessTrackId) &&
        snapshot.loadedTrackId === readinessTrackId;
    const hasEngineMediaData =
        (Number.isFinite(snapshot.engineDurationSec) &&
            snapshot.engineDurationSec > 0) ||
        (Number.isFinite(snapshot.engineCurrentTimeSec) &&
            snapshot.engineCurrentTimeSec > 0);
    const mediaReady = hasLoadedExpectedTrack && hasEngineMediaData;
    const timedOut = snapshot.elapsedMs >= snapshot.maxWaitMs;

    if (hasTrackMatch && (mediaReady || timedOut)) {
        return { decision: "report", hasTrackMatch, mediaReady, timedOut };
    }
    if (timedOut) {
        return { decision: "recover", hasTrackMatch, mediaReady, timedOut };
    }
    return { decision: "poll", hasTrackMatch, mediaReady, timedOut };
}
