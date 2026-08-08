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

type ParsedTarget = Pick<JourneyRequest, "toTrackId" | "mood">;
type FieldResult<T> = { ok: true; value: T } | { ok: false; error: string };

function reject(status: number, error: string): JourneyRequestResult {
    return { ok: false, status, error };
}

function parseTarget(
    fromTrackId: string,
    toTrackId: unknown,
    mood: unknown
): FieldResult<ParsedTarget> {
    const hasTrack = typeof toTrackId === "string" && toTrackId.length > 0;
    const hasMood = typeof mood === "string" && mood.length > 0;
    if (hasTrack === hasMood) {
        return { ok: false, error: "Provide exactly one of toTrackId or mood" };
    }
    if (hasMood && !VALID_MOODS.includes(mood as MoodType)) {
        return {
            ok: false,
            error: `Invalid mood. Must be one of: ${VALID_MOODS.join(", ")}`,
        };
    }
    if (hasTrack && toTrackId === fromTrackId) {
        return { ok: false, error: "Origin and destination are the same track" };
    }
    return {
        ok: true,
        value: {
            toTrackId: hasTrack ? (toTrackId as string) : null,
            mood: hasMood ? (mood as MoodType) : null,
        },
    };
}

function parseExcludeTrackIds(value: unknown): FieldResult<string[]> {
    if (value === undefined) return { ok: true, value: [] };
    if (!Array.isArray(value)) {
        return { ok: false, error: "excludeTrackIds must be an array of strings" };
    }
    if (value.length > MAX_JOURNEY_EXCLUDE_TRACK_IDS) {
        return {
            ok: false,
            error: `excludeTrackIds cannot exceed ${MAX_JOURNEY_EXCLUDE_TRACK_IDS} entries`,
        };
    }
    if (value.some((id) => typeof id !== "string" || id.length === 0)) {
        return {
            ok: false,
            error: "excludeTrackIds must contain non-empty strings",
        };
    }
    return { ok: true, value };
}

function parseSteps(value: unknown): FieldResult<number> {
    if (value === undefined) {
        return { ok: true, value: DEFAULT_JOURNEY_STEPS };
    }
    if (!Number.isInteger(value)) {
        return { ok: false, error: "steps must be an integer" };
    }
    return {
        ok: true,
        value: Math.min(
            Math.max(MIN_JOURNEY_STEPS, value as number),
            MAX_JOURNEY_STEPS
        ),
    };
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
    const record =
        typeof body === "object" && body !== null && !Array.isArray(body)
            ? (body as Record<string, unknown>)
            : {};
    const {
        fromTrackId,
        toTrackId,
        mood,
        steps: requestedSteps,
        excludeTrackIds,
    } = record;

    if (typeof fromTrackId !== "string" || !fromTrackId) {
        return reject(400, "fromTrackId is required");
    }

    const target = parseTarget(fromTrackId, toTrackId, mood);
    if (!target.ok) return reject(400, target.error);
    const excludes = parseExcludeTrackIds(excludeTrackIds);
    if (!excludes.ok) return reject(400, excludes.error);
    const steps = parseSteps(requestedSteps);
    if (!steps.ok) return reject(400, steps.error);

    return {
        ok: true,
        value: {
            fromTrackId,
            ...target.value,
            steps: steps.value,
            excludeTrackIds: excludes.value,
        },
    };
}
