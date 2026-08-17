/** Default real-library sample size for provider fidelity validation. */
export const DEFAULT_PROVIDER_FIDELITY_SAMPLE = 1_000;
/** Hard cap for the quadratic within-sample neighbor comparison. */
export const MAX_PROVIDER_FIDELITY_SAMPLE = 2_000;
const MAX_EMBEDDING_DIMENSION = 8_192;

/** One track embedding in a named provider space. */
export interface TrackVector {
    trackId: string;
    vector: readonly number[];
}

/** Aggregate statistics shared by overlap measurements. */
export interface OverlapSummary {
    mean: number;
    median: number;
    p05: number;
}

/** Aggregate statistics for paired audio-vector cosine. */
export interface AudioCosineSummary extends OverlapSummary {
    min: number;
}

/** Gate inputs produced by a complete provider fidelity run. */
export interface ProviderFidelitySummary {
    audio: AudioCosineSummary;
    topK: OverlapSummary;
    textQuery: OverlapSummary;
}

/** Inclusive adoption thresholds. */
export interface ProviderFidelityThresholds {
    medianCosine: number;
    meanTopKOverlap: number;
}

function requireFiniteValues(values: readonly number[], label: string): void {
    if (values.length === 0 || values.length > MAX_EMBEDDING_DIMENSION) {
        throw new RangeError(`${label} has an invalid dimension`);
    }
    if (!values.every(Number.isFinite)) {
        throw new TypeError(`${label} contains a non-finite value`);
    }
}

/** Compute cosine similarity for two finite, non-zero vectors. */
export function cosineSimilarity(
    a: readonly number[],
    b: readonly number[],
): number {
    requireFiniteValues(a, "left vector");
    requireFiniteValues(b, "right vector");
    if (a.length !== b.length) throw new RangeError("vector dimensions differ");
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let index = 0; index < a.length; index += 1) {
        dot += a[index] * b[index];
        normA += a[index] * a[index];
        normB += b[index] * b[index];
    }
    if (normA === 0 || normB === 0) throw new RangeError("vector norm is zero");
    return Math.max(-1, Math.min(1, dot / Math.sqrt(normA * normB)));
}

/** Compute a linearly interpolated percentile over a non-empty sample. */
export function percentile(
    values: readonly number[],
    quantile: number,
): number {
    if (values.length === 0) throw new RangeError("sample must not be empty");
    if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
        throw new RangeError("quantile must be between zero and one");
    }
    if (!values.every(Number.isFinite))
        throw new TypeError("sample is not finite");
    const sorted = [...values].sort((left, right) => left - right);
    const rank = (sorted.length - 1) * quantile;
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

/** Compute the median using the shared interpolated-percentile definition. */
export function median(values: readonly number[]): number {
    return percentile(values, 0.5);
}

function mean(values: readonly number[]): number {
    if (values.length === 0) throw new RangeError("sample must not be empty");
    if (!values.every(Number.isFinite))
        throw new TypeError("sample is not finite");
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarizeOverlap(values: readonly number[]): OverlapSummary {
    return {
        mean: mean(values),
        median: median(values),
        p05: percentile(values, 0.05),
    };
}

/** Compare paired provider audio embeddings track by track. */
export function compareAudioEmbeddings(
    pairs: readonly {
        trackId: string;
        a: readonly number[];
        b: readonly number[];
    }[],
): {
    perTrack: Array<{ trackId: string; cosine: number }>;
    summary: AudioCosineSummary;
} {
    requireBoundedSample(pairs.length, "audio pairs");
    const perTrack = pairs.map(({ trackId, a, b }) => ({
        trackId,
        cosine: cosineSimilarity(a, b),
    }));
    const values = perTrack.map(({ cosine }) => cosine);
    return {
        perTrack,
        summary: { ...summarizeOverlap(values), min: Math.min(...values) },
    };
}

function requireBoundedSample(size: number, label: string): void {
    if (!Number.isInteger(size) || size < 1) {
        throw new RangeError(`${label} must not be empty`);
    }
    if (size > MAX_PROVIDER_FIDELITY_SAMPLE) {
        throw new RangeError(
            `${label} exceeds ${MAX_PROVIDER_FIDELITY_SAMPLE}`,
        );
    }
}

function trackVectorMap(
    vectors: readonly TrackVector[],
): Map<string, TrackVector> {
    requireBoundedSample(vectors.length, "vectors");
    const byId = new Map(vectors.map((value) => [value.trackId, value]));
    if (byId.size !== vectors.length)
        throw new RangeError("track IDs must be unique");
    return byId;
}

function topTrackIds(
    query: readonly number[],
    index: readonly TrackVector[],
    k: number,
    excludedTrackId?: string,
): string[] {
    const candidates = index.filter(
        ({ trackId }) => trackId !== excludedTrackId,
    );
    if (!Number.isInteger(k) || k < 1 || k > candidates.length) {
        throw new RangeError("k exceeds the available comparison set");
    }
    return candidates
        .map(({ trackId, vector }) => ({
            trackId,
            similarity: cosineSimilarity(query, vector),
        }))
        .sort(
            (left, right) =>
                right.similarity - left.similarity ||
                left.trackId.localeCompare(right.trackId),
        )
        .slice(0, k)
        .map(({ trackId }) => trackId);
}

function overlapRatio(a: readonly string[], b: readonly string[]): number {
    if (a.length === 0 || a.length !== b.length) {
        throw new RangeError("neighbor lists must have equal positive length");
    }
    const right = new Set(b);
    const matches = a.reduce(
        (count, trackId) => count + Number(right.has(trackId)),
        0,
    );
    return matches / a.length;
}

/**
 * Compare teacher-query and candidate-query kNN against the teacher index.
 * The deterministic implementation is O(n²) and rejects samples above 2,000.
 */
export function topKOverlap(
    vectorsA: readonly TrackVector[],
    vectorsB: readonly TrackVector[],
    k: number,
): {
    perTrack: Array<{ trackId: string; overlap: number }>;
    summary: OverlapSummary;
} {
    const candidateById = trackVectorMap(vectorsB);
    requireBoundedSample(vectorsA.length, "baseline vectors");
    if (candidateById.size !== vectorsA.length) {
        throw new RangeError("provider track sets differ");
    }
    const perTrack = vectorsA.map(({ trackId, vector }) => {
        const candidate = candidateById.get(trackId);
        if (!candidate) throw new RangeError("provider track sets differ");
        const teacher = topTrackIds(vector, vectorsA, k, trackId);
        const student = topTrackIds(candidate.vector, vectorsA, k, trackId);
        return { trackId, overlap: overlapRatio(teacher, student) };
    });
    return {
        perTrack,
        summary: summarizeOverlap(perTrack.map((v) => v.overlap)),
    };
}

/** Compare both text towers' top-k results against the baseline audio index. */
export async function textQueryOverlap(
    queries: readonly string[],
    embedA: (query: string) => Promise<readonly number[]>,
    embedB: (query: string) => Promise<readonly number[]>,
    audioVectorsA: readonly TrackVector[],
    k: number,
): Promise<{
    perQuery: Array<{ query: string; overlap: number }>;
    summary: OverlapSummary;
}> {
    requireBoundedSample(queries.length, "text queries");
    requireBoundedSample(audioVectorsA.length, "audio vectors");
    const perQuery: Array<{ query: string; overlap: number }> = [];
    for (let index = 0; index < queries.length; index += 1) {
        const query = queries[index];
        const [vectorA, vectorB] = await Promise.all([
            embedA(query),
            embedB(query),
        ]);
        const resultsA = topTrackIds(vectorA, audioVectorsA, k);
        const resultsB = topTrackIds(vectorB, audioVectorsA, k);
        perQuery.push({ query, overlap: overlapRatio(resultsA, resultsB) });
    }
    return {
        perQuery,
        summary: summarizeOverlap(perQuery.map((v) => v.overlap)),
    };
}

/** Apply the inclusive same-space adoption thresholds to measured summaries. */
export function evaluateGate(
    summary: ProviderFidelitySummary,
    thresholds: ProviderFidelityThresholds,
): {
    verdict: "same_space_pass" | "distinct_space_required";
    reasons: string[];
} {
    if (!Number.isFinite(thresholds.medianCosine)) {
        throw new TypeError("median cosine threshold must be finite");
    }
    if (!Number.isFinite(thresholds.meanTopKOverlap)) {
        throw new TypeError("top-k overlap threshold must be finite");
    }
    const reasons: string[] = [];
    if (summary.audio.median < thresholds.medianCosine) {
        reasons.push(
            `median cosine ${summary.audio.median} is below ${thresholds.medianCosine}`,
        );
    }
    if (summary.topK.mean < thresholds.meanTopKOverlap) {
        reasons.push(
            `mean top-k overlap ${summary.topK.mean} is below ${thresholds.meanTopKOverlap}`,
        );
    }
    return {
        verdict:
            reasons.length === 0
                ? "same_space_pass"
                : "distinct_space_required",
        reasons,
    };
}
