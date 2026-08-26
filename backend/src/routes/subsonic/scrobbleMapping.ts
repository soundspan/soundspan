import type { ScrobbleKind } from "../../services/scrobbleTypes";

export interface SubsonicScrobbleEvent {
    trackId: string;
    kind: ScrobbleKind;
    listenedAt: Date;
}

function repeatedValue(values: string[], index: number): string | undefined {
    if (values.length === 0) return undefined;
    return values[Math.min(index, values.length - 1)];
}

function parsePlayedAt(rawTime: string | undefined, now: Date): Date {
    const milliseconds = rawTime ? Number.parseInt(rawTime, 10) : Number.NaN;
    return Number.isFinite(milliseconds) && milliseconds > 0
        ? new Date(milliseconds)
        : new Date(now.getTime());
}

/** Maps OpenSubsonic parallel query values into bounded forwarding events. */
export function mapSubsonicScrobbleEvents(
    trackIds: string[],
    submissionValues: string[],
    times: string[],
    now: Date,
): SubsonicScrobbleEvent[] {
    return trackIds.map((trackId, index) => {
        const submission = repeatedValue(submissionValues, index);
        const isSubmission = submission
            ? !["false", "0"].includes(submission.toLowerCase())
            : true;
        return {
            trackId,
            kind: isSubmission ? "scrobble" : "now_playing",
            listenedAt: parsePlayedAt(repeatedValue(times, index), now),
        };
    });
}
