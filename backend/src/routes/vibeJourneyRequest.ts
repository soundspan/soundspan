import { z } from "zod";
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

const requestBodySchema = z.custom<Record<string, unknown>>(
    (value) => typeof value === "object" && value !== null && !Array.isArray(value)
);
const nonEmptyStringSchema = z.string().min(1);
const moodSchema = z.enum(VALID_MOODS);
const excludeArraySchema = z.array(z.unknown()).default([]);
const boundedExcludeArraySchema = z
    .array(z.unknown())
    .max(MAX_JOURNEY_EXCLUDE_TRACK_IDS);
const excludeTrackIdsSchema = z.array(nonEmptyStringSchema);
const stepsSchema = z
    .number()
    .refine(Number.isInteger)
    .transform((value) =>
        Math.min(Math.max(MIN_JOURNEY_STEPS, value), MAX_JOURNEY_STEPS)
    )
    .default(DEFAULT_JOURNEY_STEPS);

function reject(status: number, error: string): JourneyRequestResult {
    return { ok: false, status, error };
}

function normalizeBody(body: unknown): Record<string, unknown> {
    const parsed = requestBodySchema.safeParse(body);
    return parsed.success ? parsed.data : {};
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
    const record = normalizeBody(body);
    const fromTrackId = nonEmptyStringSchema.safeParse(record.fromTrackId);
    if (!fromTrackId.success) {
        return reject(400, "fromTrackId is required");
    }

    const toTrackId = nonEmptyStringSchema.safeParse(record.toTrackId);
    const suppliedMood = nonEmptyStringSchema.safeParse(record.mood);
    if (toTrackId.success === suppliedMood.success) {
        return reject(400, "Provide exactly one of toTrackId or mood");
    }

    const mood = moodSchema.safeParse(suppliedMood.success ? suppliedMood.data : null);
    if (suppliedMood.success && !mood.success) {
        return reject(400, `Invalid mood. Must be one of: ${VALID_MOODS.join(", ")}`);
    }
    if (toTrackId.success && toTrackId.data === fromTrackId.data) {
        return reject(400, "Origin and destination are the same track");
    }

    const excludeArray = excludeArraySchema.safeParse(record.excludeTrackIds);
    if (!excludeArray.success) {
        return reject(400, "excludeTrackIds must be an array of strings");
    }
    if (!boundedExcludeArraySchema.safeParse(excludeArray.data).success) {
        return reject(400, `excludeTrackIds cannot exceed ${MAX_JOURNEY_EXCLUDE_TRACK_IDS} entries`);
    }
    const excludeTrackIds = excludeTrackIdsSchema.safeParse(excludeArray.data);
    if (!excludeTrackIds.success) {
        return reject(400, "excludeTrackIds must contain non-empty strings");
    }

    const steps = stepsSchema.safeParse(record.steps);
    if (!steps.success) return reject(400, "steps must be an integer");

    return {
        ok: true,
        value: {
            fromTrackId: fromTrackId.data,
            toTrackId: toTrackId.success ? toTrackId.data : null,
            mood: mood.success ? mood.data : null,
            steps: steps.data,
            excludeTrackIds: excludeTrackIds.data,
        },
    };
}
