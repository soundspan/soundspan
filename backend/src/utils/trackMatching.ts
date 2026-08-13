/**
 * Shared track matching utilities.
 *
 * Extracted from spotifyImport.ts for reuse across import flows
 * (Spotify, Deezer, YT Music, Tidal).
 */

import { normalizeQuotes, normalizeFullwidth } from "./stringNormalization";
import type { M3UEntry } from "../services/m3uParser";

// ── String normalization helpers ──────────────────────────────────

/**
 * Normalizes quote and apostrophe variants to improve cross-source matching.
 */
export function normalizeApostrophes(str: string): string {
    return normalizeQuotes(normalizeFullwidth(str));
}

/**
 * Produces a lowercase, accent-free, punctuation-stripped comparison string.
 */
export function normalizeString(str: string): string {
    const normalizedInput = normalizeFullwidth(normalizeQuotes(str));

    return normalizedInput
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\w\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Removes common release suffixes (remaster/live/version/etc.) from titles.
 */
export function stripTrackSuffix(str: string): string {
    return normalizeApostrophes(str)
        .replace(
            /\s*-\s*(\d{4}\s+)?(remaster(ed)?|deluxe|bonus|single|radio edit|remix|acoustic|live|mono|stereo|version|edition|mix)(\s+\d{4})?(\s+(version|edition|mix))?.*$/i,
            "",
        )
        .replace(/\s*-\s*\d{4}\s*$/, "")
        .replace(
            /\s*\([^)]*(?:live at|live from|recorded at|performed at)[^)]*\)\s*/gi,
            " ",
        )
        .replace(/\s*\([^)]*remaster[^)]*\)\s*/gi, " ")
        .replace(/\s*\([^)]*version[^)]*\)\s*/gi, " ")
        .replace(/\s*\([^)]*edition[^)]*\)\s*/gi, " ")
        .replace(/\s*\(\s*live\s*(\d{4})?\s*\)\s*/gi, " ")
        .replace(/\s*\[[^\]]*\]\s*/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Canonicalizes a track title for deterministic matching.
 */
export function normalizeTrackTitle(str: string): string {
    return normalizeString(stripTrackSuffix(str));
}

/**
 * Normalizes album titles using the same suffix-stripping strategy as tracks.
 */
export function normalizeAlbumForMatching(str: string): string {
    return stripTrackSuffix(str).trim();
}

// ── Similarity scoring ────────────────────────────────────────────

/**
 * Computes a 0-100 similarity score between two strings.
 */
export function stringSimilarity(a: string, b: string): number {
    return normalizedStringSimilarity(normalizeString(a), normalizeString(b));
}

function normalizedStringSimilarity(s1: string, s2: string): number {
    if (s1 === s2) return 100;

    if (s1.includes(s2) || s2.includes(s1)) {
        const longer = Math.max(s1.length, s2.length);
        const shorter = Math.min(s1.length, s2.length);
        return Math.round((shorter / longer) * 100);
    }

    const words1 = new Set(s1.split(" "));
    const words2 = new Set(s2.split(" "));
    const intersection = [...words1].filter((w) => words2.has(w)).length;
    const union = new Set([...words1, ...words2]).size;

    return Math.round((intersection / union) * 100);
}

// ── Local library matching ────────────────────────────────────────

export interface TrackMatchInput {
    artist: string;
    title: string;
    album?: string;
    duration?: number;
    isrc?: string;
}

export interface LocalTrackCandidate {
    id: string;
    title: string;
    duration: number;
    albumTitle: string;
    artistName: string;
    filePath?: string;
}

export interface TrackMatchResult {
    trackId: string;
    matchType: "path" | "filename" | "exact" | "fuzzy";
    matchConfidence: number;
}

function normalizePathForMatching(filePath: string): string {
    return filePath
        .replace(/\\/g, "/")
        .replace(/\/+/g, "/")
        .trim()
        .toLowerCase();
}

function getFilenameStem(filePath: string): string {
    const normalizedPath = filePath.replace(/\\/g, "/");
    const segments = normalizedPath.split("/");
    const filename = segments[segments.length - 1] || "";
    return filename.replace(/\.[^.]+$/, "");
}

/**
 * Match a track against a list of local library candidates.
 * Uses the same strategy cascade as the Spotify import:
 * 1. Exact match (artist + album + title)
 * 2. Normalized album match (strip suffixes)
 * 3. Artist + title match (ignore album)
 * 4. Fuzzy match (70% threshold)
 */
export function matchTrackAgainstLibrary(
    input: TrackMatchInput,
    candidates: LocalTrackCandidate[],
): TrackMatchResult | null {
    if (!candidates.length) return null;

    const normArtist = normalizeString(input.artist);
    const normTitle = normalizeTrackTitle(input.title);
    const normAlbum = input.album
        ? normalizeString(normalizeAlbumForMatching(input.album))
        : undefined;

    // Strategy 1: Exact match (artist + album + title)
    for (const c of candidates) {
        if (
            normalizeString(c.artistName) === normArtist &&
            normalizeTrackTitle(c.title) === normTitle &&
            normAlbum &&
            normalizeString(normalizeAlbumForMatching(c.albumTitle)) ===
                normAlbum
        ) {
            return {
                trackId: c.id,
                matchType: "exact",
                matchConfidence: 100,
            };
        }
    }

    // Strategy 2: Normalized album match (handles "Album (Deluxe)" vs "Album")
    if (normAlbum) {
        for (const c of candidates) {
            if (
                normalizeString(c.artistName) === normArtist &&
                normalizeTrackTitle(c.title) === normTitle
            ) {
                const cAlbum = normalizeString(
                    normalizeAlbumForMatching(c.albumTitle),
                );
                if (
                    cAlbum.length > 0 &&
                    normAlbum.length > 0 &&
                    (cAlbum.includes(normAlbum) || normAlbum.includes(cAlbum))
                ) {
                    return {
                        trackId: c.id,
                        matchType: "exact",
                        matchConfidence: 95,
                    };
                }
            }
        }
    }

    // Strategy 3: Artist + title match (ignoring album)
    for (const c of candidates) {
        if (
            normalizeString(c.artistName) === normArtist &&
            normalizeTrackTitle(c.title) === normTitle
        ) {
            return {
                trackId: c.id,
                matchType: "exact",
                matchConfidence: 85,
            };
        }
    }

    // Strategy 4: Fuzzy match (70% threshold)
    let bestScore = 0;
    let bestMatch: LocalTrackCandidate | null = null;

    for (const c of candidates) {
        const titleScore = stringSimilarity(input.title, c.title);
        const artistScore = stringSimilarity(input.artist, c.artistName);
        // Title weighted 60%, artist 40%
        const score = titleScore * 0.6 + artistScore * 0.4;

        if (score > bestScore && score >= 70) {
            bestScore = score;
            bestMatch = c;
        }
    }

    if (bestMatch) {
        return {
            trackId: bestMatch.id,
            matchType: "fuzzy",
            matchConfidence: Math.round(bestScore),
        };
    }

    return null;
}

// ── M3U match index ───────────────────────────────────────────────

/**
 * A library candidate with its match-tier normalizations precomputed.
 */
export interface IndexedM3UCandidate {
    candidate: LocalTrackCandidate;
    /** Normalized file path; empty string when the candidate has no path. */
    normalizedPath: string;
    /** `normalizeString` of the artist name (exact and fuzzy tiers). */
    normalizedArtist: string;
    /** `normalizeTrackTitle` of the track title (exact tier). */
    normalizedExactTitle: string;
    /** `normalizeString` of the track title (fuzzy tier). */
    normalizedFuzzyTitle: string;
}

/**
 * Precomputed lookup structures for matching many M3U entries against the
 * same library snapshot. Build once per playlist with `buildM3UMatchIndex`.
 */
export interface M3UMatchIndex {
    /** All candidates in deterministic (filePath, id) order. */
    sorted: IndexedM3UCandidate[];
    /**
     * Path-tier buckets keyed by the final normalized path segment. Every
     * path-tier condition (equality or `/`-boundary suffix in either
     * direction) requires the entry and candidate to share their final path
     * segment, so a match can only live in the entry's own bucket.
     */
    pathBuckets: Map<string, IndexedM3UCandidate[]>;
    /** First sorted candidate per normalized filename stem. */
    byFilenameStem: Map<string, LocalTrackCandidate>;
    /** First sorted candidate per normalized `artist\u0000title` pair. */
    byArtistTitle: Map<string, LocalTrackCandidate>;
}

function lastPathSegment(normalizedPath: string): string {
    const separatorIndex = normalizedPath.lastIndexOf("/");
    if (separatorIndex === -1) return normalizedPath;
    return normalizedPath.slice(separatorIndex + 1);
}

function artistTitleKey(normalizedArtist: string, normalizedTitle: string) {
    return `${normalizedArtist}\u0000${normalizedTitle}`;
}

/**
 * Builds the reusable match index for `matchM3UEntryAgainstLibrary`.
 * Sorting and normalization happen once here instead of once per entry.
 */
export function buildM3UMatchIndex(
    candidates: LocalTrackCandidate[],
): M3UMatchIndex {
    const sorted = [...candidates]
        .sort((a, b) => {
            const pathCompare = (a.filePath || "").localeCompare(
                b.filePath || "",
            );
            if (pathCompare !== 0) return pathCompare;
            return a.id.localeCompare(b.id);
        })
        .map((candidate) => ({
            candidate,
            normalizedPath: candidate.filePath
                ? normalizePathForMatching(candidate.filePath)
                : "",
            normalizedArtist: normalizeString(candidate.artistName),
            normalizedExactTitle: normalizeTrackTitle(candidate.title),
            normalizedFuzzyTitle: normalizeString(candidate.title),
        }));

    const pathBuckets = new Map<string, IndexedM3UCandidate[]>();
    const byFilenameStem = new Map<string, LocalTrackCandidate>();
    const byArtistTitle = new Map<string, LocalTrackCandidate>();

    for (const indexed of sorted) {
        const { candidate } = indexed;
        if (candidate.filePath) {
            const segment = lastPathSegment(indexed.normalizedPath);
            const bucket = pathBuckets.get(segment);
            if (bucket) {
                bucket.push(indexed);
            } else {
                pathBuckets.set(segment, [indexed]);
            }

            const stem = normalizeTrackTitle(
                getFilenameStem(candidate.filePath),
            );
            if (stem.length > 0 && !byFilenameStem.has(stem)) {
                byFilenameStem.set(stem, candidate);
            }
        }

        const key = artistTitleKey(
            indexed.normalizedArtist,
            indexed.normalizedExactTitle,
        );
        if (!byArtistTitle.has(key)) {
            byArtistTitle.set(key, candidate);
        }
    }

    return { sorted, pathBuckets, byFilenameStem, byArtistTitle };
}

function matchM3UEntryFuzzy(
    normalizedArtist: string,
    normalizedFuzzyTitle: string,
    index: M3UMatchIndex,
): TrackMatchResult | null {
    let bestScore = 0;
    let bestMatch: LocalTrackCandidate | null = null;

    // Artist names repeat across a library, so score each distinct one once.
    const artistScoreCache = new Map<string, number>();

    for (const indexed of index.sorted) {
        let artistScore = artistScoreCache.get(indexed.normalizedArtist);
        if (artistScore === undefined) {
            artistScore = normalizedStringSimilarity(
                normalizedArtist,
                indexed.normalizedArtist,
            );
            artistScoreCache.set(indexed.normalizedArtist, artistScore);
        }

        // A title score is at most 100, so this bound is exact: candidates
        // that cannot reach the 70 threshold or beat the current best can
        // skip the title comparison without changing the outcome.
        const maxPossibleScore = 100 * 0.6 + artistScore * 0.4;
        if (maxPossibleScore < 70 || maxPossibleScore <= bestScore) {
            continue;
        }

        const titleScore = normalizedStringSimilarity(
            normalizedFuzzyTitle,
            indexed.normalizedFuzzyTitle,
        );
        // Title weighted 60%, artist 40%
        const score = titleScore * 0.6 + artistScore * 0.4;

        if (score > bestScore && score >= 70) {
            bestScore = score;
            bestMatch = indexed.candidate;
        }
    }

    if (!bestMatch) return null;
    return {
        trackId: bestMatch.id,
        matchType: "fuzzy",
        matchConfidence: Math.round(bestScore),
    };
}

/**
 * Match an M3U entry against the local library using the agreed tier order:
 * 1. Normalized file path suffix match
 * 2. Filename stem match
 * 3. Exact metadata match
 * 4. Fuzzy metadata match
 *
 * The album-aware strategies of `matchTrackAgainstLibrary` cannot fire on
 * this path — M3U entries carry no album, and the exact artist+title tier
 * has already missed by the time the fuzzy tier runs — so the fuzzy tier
 * replicates only the fuzzy strategy over the precomputed index.
 */
export function matchM3UEntryAgainstLibrary(
    entry: M3UEntry,
    index: M3UMatchIndex,
): TrackMatchResult | null {
    if (!index.sorted.length) return null;

    const entryPath = normalizePathForMatching(entry.filePath);
    const bucket = index.pathBuckets.get(lastPathSegment(entryPath));
    if (bucket) {
        for (const { candidate, normalizedPath } of bucket) {
            if (
                normalizedPath === entryPath ||
                entryPath.endsWith(`/${normalizedPath}`) ||
                normalizedPath.endsWith(`/${entryPath}`)
            ) {
                return {
                    trackId: candidate.id,
                    matchType: "path",
                    matchConfidence: 100,
                };
            }
        }
    }

    const entryFilename = normalizeTrackTitle(getFilenameStem(entry.filePath));
    if (entryFilename.length > 0) {
        const filenameHit = index.byFilenameStem.get(entryFilename);
        if (filenameHit) {
            return {
                trackId: filenameHit.id,
                matchType: "filename",
                matchConfidence: 98,
            };
        }
    }

    if (entry.artist && entry.title) {
        const normalizedArtist = normalizeString(entry.artist);
        const exactHit = index.byArtistTitle.get(
            artistTitleKey(normalizedArtist, normalizeTrackTitle(entry.title)),
        );
        if (exactHit) {
            return {
                trackId: exactHit.id,
                matchType: "exact",
                matchConfidence: 100,
            };
        }

        return matchM3UEntryFuzzy(
            normalizedArtist,
            normalizeString(entry.title),
            index,
        );
    }

    return null;
}
