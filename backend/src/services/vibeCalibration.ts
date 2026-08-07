import { prisma } from "../utils/db";
import { parseEmbedding } from "../utils/embedding";

/**
 * vibeCalibration — bounded sampling of pairwise CLAP cosine distances.
 *
 * Feeds `GET /api/vibe/calibration`: a p0..p100 quantile ladder of pairwise
 * distance over a random sample of embedded tracks, so the UI can express
 * match strength as "closer than N% of random pairs in your library" instead
 * of a fixed linear mapping that reads as inflated on libraries where
 * unrelated tracks rarely exceed distance ~1.0.
 *
 * Sampling strategy (deliberately NOT `ORDER BY random()`): a full-table
 * random sort would read and sort every row *including the wide vector
 * column*. Instead the sample is drawn in two bounded, index-friendly steps:
 *   1. an id-only Prisma scan (primary-key order, capped at
 *      CALIBRATION_ID_SCAN_CAP ids) — narrow, no vector column touched;
 *   2. a Fisher-Yates pick of CALIBRATION_SAMPLE_SIZE ids, fetched with one
 *      primary-key `= ANY` query.
 * The vector column is `Unsupported("vector")`, so step 2 is a raw query —
 * kept here in the service layer (beside the other blessed pgvector read
 * sites), never in a route file.
 */

export const CALIBRATION_SAMPLE_SIZE = 200;
export const CALIBRATION_MIN_EMBEDDED_TRACKS = 10;
export const CALIBRATION_QUANTILE_COUNT = 101; // p0..p100 inclusive
/**
 * Upper bound on the id-only scan backing the sample. Libraries beyond this
 * cap sample from their first CALIBRATION_ID_SCAN_CAP ids (primary-key
 * order) — a documented bias accepted in exchange for a hard allocation
 * bound; at this repo's single-operator scale (~15k tracks) the cap is never
 * reached.
 */
export const CALIBRATION_ID_SCAN_CAP = 50_000;

export interface CalibrationPayload {
    sampleSize: number;
    updatedAt: string;
    quantiles: number[];
}

function isValidQuantileLadder(value: unknown): value is number[] {
    if (!Array.isArray(value) || value.length !== CALIBRATION_QUANTILE_COUNT) {
        return false;
    }
    return value.every(
        (entry, index) =>
            typeof entry === "number" &&
            Number.isFinite(entry) &&
            (index === 0 || entry >= value[index - 1])
    );
}

/**
 * Parse and validate a cached calibration payload. Cache contents are treated
 * as untrusted: malformed JSON, an out-of-range sample size, a missing
 * timestamp, or a non-finite/non-monotonic quantile ladder returns `null` so
 * the caller recomputes instead of forwarding corrupt data to clients.
 */
export function parseCachedCalibration(value: string): CalibrationPayload | null {
    try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        if (
            !parsed ||
            typeof parsed !== "object" ||
            !Number.isInteger(parsed.sampleSize) ||
            (parsed.sampleSize as number) < CALIBRATION_MIN_EMBEDDED_TRACKS ||
            (parsed.sampleSize as number) > CALIBRATION_SAMPLE_SIZE ||
            typeof parsed.updatedAt !== "string" ||
            parsed.updatedAt.length === 0 ||
            !isValidQuantileLadder(parsed.quantiles)
        ) {
            return null;
        }
        return parsed as unknown as CalibrationPayload;
    } catch {
        return null;
    }
}

function validateEmbeddings(embeddings: number[][]): void {
    const dimensions = embeddings[0]?.length ?? 0;
    const valid =
        embeddings.length >= CALIBRATION_MIN_EMBEDDED_TRACKS &&
        dimensions > 0 &&
        embeddings.every(
            (embedding) =>
                embedding.length === dimensions && embedding.every(Number.isFinite)
        );
    if (!valid) {
        throw new Error("Calibration sample contains insufficient or invalid embeddings");
    }
}

/** Number of tracks with a CLAP embedding row (pure Prisma count). */
export async function countEmbeddedTracks(): Promise<number> {
    return prisma.trackEmbedding.count();
}

/**
 * True cosine distance between two vectors (1 - cosine similarity), matching
 * pgvector's `<=>` operator semantics used everywhere else in the vibe
 * routes. Embeddings aren't guaranteed unit-norm, so this normalizes
 * explicitly rather than assuming a dot product is already a cosine distance.
 */
export function cosineDistance(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 1;
    return 1 - dot / denom;
}

/**
 * p0..p100 percentiles (101 values) of an already-sorted-ascending array,
 * via nearest-rank indexing. Monotonic non-decreasing by construction since
 * the source is sorted and the index is non-decreasing in p.
 */
export function computeQuantiles(sortedAscending: number[]): number[] {
    const n = sortedAscending.length;
    const quantiles: number[] = [];
    for (let p = 0; p < CALIBRATION_QUANTILE_COUNT; p++) {
        const idx = Math.min(n - 1, Math.round((p / 100) * (n - 1)));
        quantiles.push(sortedAscending[idx]);
    }
    return quantiles;
}

/** In-place Fisher-Yates; returns the first `count` elements. */
function pickRandom<T>(items: T[], count: number): T[] {
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items.slice(0, count);
}

/**
 * Compute the calibration payload from a bounded random sample of embedded
 * tracks. Assumes the caller already verified the
 * CALIBRATION_MIN_EMBEDDED_TRACKS floor; the O(sample²) pairwise loop is
 * bounded by CALIBRATION_SAMPLE_SIZE (≤ 200 ⇒ ≤ 19,900 distance pairs).
 */
export async function computeCalibration(): Promise<CalibrationPayload> {
    const idRows = await prisma.trackEmbedding.findMany({
        select: { trackId: true },
        orderBy: { trackId: "asc" },
        take: CALIBRATION_ID_SCAN_CAP,
    });
    const sampledIds = pickRandom(
        idRows.map((row) => row.trackId),
        CALIBRATION_SAMPLE_SIZE
    );

    const rows = await prisma.$queryRaw<{ embedding: string }[]>`
        SELECT embedding::text AS embedding
        FROM track_embeddings
        WHERE track_id = ANY(${sampledIds})
    `;

    const embeddings = rows.map((row) => parseEmbedding(row.embedding));
    validateEmbeddings(embeddings);
    const distances: number[] = [];
    for (let i = 0; i < embeddings.length; i++) {
        for (let j = i + 1; j < embeddings.length; j++) {
            distances.push(cosineDistance(embeddings[i], embeddings[j]));
        }
    }
    distances.sort((a, b) => a - b);

    return {
        sampleSize: embeddings.length,
        updatedAt: new Date().toISOString(),
        quantiles: computeQuantiles(distances),
    };
}
