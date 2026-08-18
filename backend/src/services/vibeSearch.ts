import { logger } from "../utils/logger";
import {
    findTracksByTextEmbedding,
    type TextSearchResult,
} from "./trackEmbeddings";
import { resolveTextEmbedding } from "./textEmbedding";
import {
    expandQueryWithVocabulary,
    getVocabularyForSpace,
    rerankWithFeatures,
    type VocabTerm,
} from "./vibeVocabulary";

const MAX_TEXT_SEARCH_QUERY_LENGTH = 512;
const MIN_SEARCH_SIMILARITY = 0.6;

interface ParsedVibeSearchRequest {
    normalizedQuery: string;
    limit: number;
    similarityThreshold: number;
}

/** Result of validating and normalizing an untrusted vibe-search body. */
export type VibeSearchRequestResult =
    | { ok: true; value: ParsedVibeSearchRequest }
    | { ok: false; error: string };

interface RankedSearchTrack extends TextSearchResult {
    finalScore?: number;
}

interface SearchExpansion {
    embedding: number[];
    genreConfidence: number;
    matchedTerms: VocabTerm[];
}

/** Convert CLAP cosine distance to the route's zero-to-one similarity. */
export function distanceToSearchSimilarity(distance: number): number {
    return Math.max(0, 1 - distance / 2);
}

/** Validate and normalize a vibe-search request without I/O. */
export function parseVibeSearchRequest(body: unknown): VibeSearchRequestResult {
    const input = body as Record<string, unknown> | null;
    const query = input?.query;
    if (typeof query !== "string") {
        return { ok: false, error: "Query must be at least 2 characters" };
    }
    if (query.length > MAX_TEXT_SEARCH_QUERY_LENGTH) {
        return {
            ok: false,
            error: `Query must be at most ${MAX_TEXT_SEARCH_QUERY_LENGTH} characters`,
        };
    }
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 2) {
        return { ok: false, error: "Query must be at least 2 characters" };
    }
    const requestedLimit = Number(input?.limit || 20);
    const limit = Math.min(Math.max(1, requestedLimit), 100);
    const requestedSimilarity = input?.minSimilarity;
    const similarityThreshold =
        typeof requestedSimilarity === "number"
            ? Math.max(0, Math.min(1, requestedSimilarity))
            : MIN_SEARCH_SIMILARITY;
    return { ok: true, value: { normalizedQuery, limit, similarityThreshold } };
}

function expandSearch(
    embedding: number[],
    normalizedQuery: string,
    spaceIdentity: { family: string; checkpointHash: string },
): SearchExpansion {
    const vocabulary = getVocabularyForSpace(spaceIdentity);
    if (!vocabulary) {
        return { embedding, genreConfidence: 0, matchedTerms: [] };
    }
    const expansion = expandQueryWithVocabulary(
        embedding,
        normalizedQuery,
        vocabulary,
    );
    logger.info(
        `[VIBE-SEARCH] Query "${normalizedQuery}" expanded with terms: ${expansion.matchedTerms.map((term) => term.name).join(", ") || "none"}, genre confidence: ${(expansion.genreConfidence * 100).toFixed(0)}%`,
    );
    return expansion;
}

function rankTracks(
    tracks: TextSearchResult[],
    expansion: SearchExpansion,
    limit: number,
): RankedSearchTrack[] {
    if (expansion.matchedTerms.length === 0) return tracks.slice(0, limit);
    const reranked = rerankWithFeatures(
        tracks,
        expansion.matchedTerms,
        expansion.genreConfidence,
    );
    const ranked = reranked.slice(0, limit);
    logger.info(
        `[VIBE-SEARCH] Re-ranked ${tracks.length} candidates, top result: ${ranked[0]?.title || "none"}`,
    );
    return ranked;
}

function searchSimilarity(track: RankedSearchTrack): number {
    return track.finalScore ?? distanceToSearchSimilarity(track.distance);
}

function logSimilarityRange(tracks: RankedSearchTrack[]): void {
    if (tracks.length === 0) return;
    const best = searchSimilarity(tracks[0]);
    const worst = searchSimilarity(tracks[tracks.length - 1]);
    logger.info(
        `Vibe search similarity range: ${Math.round(best * 100)}% - ${Math.round(worst * 100)}%`,
    );
}

function serializeTrack(row: RankedSearchTrack) {
    return {
        id: row.id,
        title: row.title,
        duration: row.duration,
        trackNo: row.trackNo,
        loudnessLufs: row.loudnessLufs ?? null,
        truePeakDb: row.truePeakDb ?? null,
        distance: row.distance,
        similarity: searchSimilarity(row),
        album: {
            id: row.albumId,
            title: row.albumTitle,
            coverUrl: row.albumCoverUrl,
            albumLoudnessLufs: row.albumLoudnessLufs ?? null,
            albumTruePeakDb: row.albumTruePeakDb ?? null,
        },
        artist: { id: row.artistId, name: row.artistName },
    };
}

/** Execute validated provider-backed vibe search and build its response body. */
export async function executeVibeSearch(input: ParsedVibeSearchRequest) {
    const textEmbedding = await resolveTextEmbedding(input.normalizedQuery);
    const expansion = expandSearch(
        textEmbedding.embedding,
        input.normalizedQuery,
        {
            family: textEmbedding.family,
            checkpointHash: textEmbedding.checkpointHash,
        },
    );
    const maxDistance = 2 * (1 - input.similarityThreshold);
    const candidates = await findTracksByTextEmbedding(
        expansion.embedding,
        maxDistance,
        input.limit * 3,
        textEmbedding.spaceId,
    );
    logger.info(
        `Vibe search "${input.normalizedQuery}": found ${candidates.length} candidates above ${Math.round(input.similarityThreshold * 100)}% similarity (max distance: ${maxDistance.toFixed(2)})`,
    );
    const ranked = rankTracks(candidates, expansion, input.limit);
    logSimilarityRange(ranked);
    const tracks = ranked.map(serializeTrack);
    return {
        query: input.normalizedQuery,
        tracks,
        minSimilarity: input.similarityThreshold,
        totalAboveThreshold: tracks.length,
        debug: {
            matchedTerms: expansion.matchedTerms.map((term) => term.name),
            genreConfidence: expansion.genreConfidence,
            featureWeight:
                expansion.matchedTerms.length > 0
                    ? 0.2 + expansion.genreConfidence * 0.5
                    : 0,
        },
    };
}
