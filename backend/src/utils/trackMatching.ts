/**
 * Shared track matching utilities.
 *
 * Extracted from spotifyImport.ts for reuse across import flows
 * (Spotify, Deezer, YT Music, Tidal).
 */

import {
    normalizeQuotes,
    normalizeFullwidth,
} from "./stringNormalization";
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

    return (
        normalizedInput
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^\w\s]/g, "")
            .replace(/\s+/g, " ")
            .trim()
    );
}

/**
 * Removes common release suffixes (remaster/live/version/etc.) from titles.
 */
export function stripTrackSuffix(str: string): string {
    return (
        normalizeApostrophes(str)
            .replace(
                /\s*-\s*(\d{4}\s+)?(remaster(ed)?|deluxe|bonus|single|radio edit|remix|acoustic|live|mono|stereo|version|edition|mix)(\s+\d{4})?(\s+(version|edition|mix))?.*$/i,
                ""
            )
            .replace(/\s*-\s*\d{4}\s*$/, "")
            .replace(
                /\s*\([^)]*(?:live at|live from|recorded at|performed at)[^)]*\)\s*/gi,
                " "
            )
            .replace(/\s*\([^)]*remaster[^)]*\)\s*/gi, " ")
            .replace(/\s*\([^)]*version[^)]*\)\s*/gi, " ")
            .replace(/\s*\([^)]*edition[^)]*\)\s*/gi, " ")
            .replace(/\s*\(\s*live\s*(\d{4})?\s*\)\s*/gi, " ")
            .replace(/\s*\[[^\]]*\]\s*/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    );
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
    const s1 = normalizeString(a);
    const s2 = normalizeString(b);

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
    candidates: LocalTrackCandidate[]
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
                    normalizeAlbumForMatching(c.albumTitle)
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

/**
 * Match an M3U entry against the local library using the agreed tier order:
 * 1. Normalized file path suffix match
 * 2. Filename stem match
 * 3. Exact metadata match
 * 4. Fuzzy metadata match
 */
export function matchM3UEntryAgainstLibrary(
    entry: M3UEntry,
    candidates: LocalTrackCandidate[]
): TrackMatchResult | null {
    if (!candidates.length) return null;

    const sortedCandidates = [...candidates].sort((a, b) => {
        const pathCompare = (a.filePath || "").localeCompare(b.filePath || "");
        if (pathCompare !== 0) return pathCompare;
        return a.id.localeCompare(b.id);
    });

    const entryPath = normalizePathForMatching(entry.filePath);

    for (const candidate of sortedCandidates) {
        if (!candidate.filePath) continue;
        const candidatePath = normalizePathForMatching(candidate.filePath);
        if (
            candidatePath === entryPath ||
            entryPath.endsWith(`/${candidatePath}`) ||
            candidatePath.endsWith(`/${entryPath}`)
        ) {
            return {
                trackId: candidate.id,
                matchType: "path",
                matchConfidence: 100,
            };
        }
    }

    const entryFilename = normalizeTrackTitle(getFilenameStem(entry.filePath));
    if (entryFilename.length > 0) {
        for (const candidate of sortedCandidates) {
            if (!candidate.filePath) continue;
            const candidateFilename = normalizeTrackTitle(
                getFilenameStem(candidate.filePath)
            );
            if (candidateFilename === entryFilename) {
                return {
                    trackId: candidate.id,
                    matchType: "filename",
                    matchConfidence: 98,
                };
            }
        }
    }

    if (entry.artist && entry.title) {
        const normalizedArtist = normalizeString(entry.artist);
        const normalizedTitle = normalizeTrackTitle(entry.title);

        for (const candidate of sortedCandidates) {
            if (
                normalizeString(candidate.artistName) === normalizedArtist &&
                normalizeTrackTitle(candidate.title) === normalizedTitle
            ) {
                return {
                    trackId: candidate.id,
                    matchType: "exact",
                    matchConfidence: 100,
                };
            }
        }

        return matchTrackAgainstLibrary(
            {
                artist: entry.artist,
                title: entry.title,
                duration: entry.durationSeconds ?? undefined,
            },
            sortedCandidates
        );
    }

    return null;
}
