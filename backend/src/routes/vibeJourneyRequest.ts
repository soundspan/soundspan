import { VALID_MOODS, MoodType } from "../services/moodBucketService";

/**
 * vibeJourneyRequest — pure request validation for `POST /api/vibe/journey`.
 *
 * No DB, no Express: takes an untrusted request body and returns either a
 * `{ ok: false, status, error }` rejection or the fully-validated,
 * clamped journey parameters. Keeping this decision logic out of the route
 * handler keeps the handler a thin orchestration function and makes every
 * validation branch unit-testable without HTTP plumbing.
 */

export const MIN_JOURNEY_STEPS = 2;
export const MAX_JOURNEY_STEPS = 20;
export const DEFAULT_JOURNEY_STEPS = 8;
export const MAX_JOURNEY_EXCLUDE_TRACK_IDS = 200;

/** A validated journey request: exactly one of `toTrackId` / `mood` is set. */
export interface JourneyRequest {
    fromTrackId: string;
    toTrackId: string | null;
    mood: MoodType | null;
    /** Clamped into [MIN_JOURNEY_STEPS, MAX_JOURNEY_STEPS]. */
    steps: number;
    excludeTrackIds: string[];
}

export type JourneyRequestResult =
    | { ok: true; value: JourneyRequest }
    | { ok: false; status: number; error: string };

function reject(status: number, error: string): JourneyRequestResult {
    return { ok: false, status, error };
}

/**
 * Validate an untrusted `/journey` request body. Rules (each with a 400):
 * `fromTrackId` required; exactly one of `toTrackId`/`mood`; `mood` must be
 * canonical; origin ≠ destination; `excludeTrackIds` an all-string array of
 * at most MAX_JOURNEY_EXCLUDE_TRACK_IDS; `steps` an integer (then clamped
 * into range rather than rejected — an out-of-range but well-typed value is
 * a UI slider quirk, not a protocol violation).
 */
export function parseJourneyRequest(body: unknown): JourneyRequestResult {
    const {
        fromTrackId,
        toTrackId,
        mood,
        steps: requestedSteps,
        excludeTrackIds,
    } = (body ?? {}) as Record<string, unknown>;

    if (typeof fromTrackId !== "string" || !fromTrackId) {
        return reject(400, "fromTrackId is required");
    }

    const hasToTrackId = typeof toTrackId === "string" && toTrackId.length > 0;
    const hasMood = typeof mood === "string" && mood.length > 0;
    if (hasToTrackId === hasMood) {
        return reject(400, "Provide exactly one of toTrackId or mood");
    }

    if (hasMood && !VALID_MOODS.includes(mood as MoodType)) {
        return reject(
            400,
            `Invalid mood. Must be one of: ${VALID_MOODS.join(", ")}`
        );
    }

    if (hasToTrackId && toTrackId === fromTrackId) {
        return reject(400, "Origin and destination are the same track");
    }

    let excludeIds: string[] = [];
    if (excludeTrackIds !== undefined) {
        if (
            !Array.isArray(excludeTrackIds) ||
            excludeTrackIds.some((id: unknown) => typeof id !== "string")
        ) {
            return reject(400, "excludeTrackIds must be an array of strings");
        }
        if (excludeTrackIds.length > MAX_JOURNEY_EXCLUDE_TRACK_IDS) {
            return reject(
                400,
                `excludeTrackIds cannot exceed ${MAX_JOURNEY_EXCLUDE_TRACK_IDS} entries`
            );
        }
        excludeIds = excludeTrackIds;
    }

    let steps = DEFAULT_JOURNEY_STEPS;
    if (requestedSteps !== undefined) {
        if (!Number.isInteger(requestedSteps)) {
            return reject(400, "steps must be an integer");
        }
        steps = Math.min(
            Math.max(MIN_JOURNEY_STEPS, requestedSteps as number),
            MAX_JOURNEY_STEPS
        );
    }

    return {
        ok: true,
        value: {
            fromTrackId,
            toTrackId: hasToTrackId ? (toTrackId as string) : null,
            mood: hasMood ? (mood as MoodType) : null,
            steps,
            excludeTrackIds: excludeIds,
        },
    };
}
