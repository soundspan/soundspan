import { normalizeForFuzzyMatch } from "../../utils/artistNormalization";

const COHERENCE_WEIGHTS = {
    completeness: 0.4,
    folderName: 0.2,
    format: 0.15,
    bitrate: 0.15,
    penaltyAvoidance: 0.1,
} as const;

const COMPILATION_FOLDER_PATTERN =
    /(?:^|\s)(?:v\s*a|various artists?|compilations?|sampler|soundtrack|ost)(?:\s|$)/i;
const UNKNOWN_FOLDER_PATTERN =
    /^(?:unknown|unknown artist|unknown album|artist unknown)$/i;
/** Half-strength CV penalty tolerates ordinary VBR and lossless variation. */
const BITRATE_VARIATION_PENALTY = 0.5;

/** Minimum requested-search coverage required for folder eligibility. */
export const ALBUM_FOLDER_COMPLETENESS_FLOOR = 0.9;

/** Minimum content coherence required for folder eligibility. */
export const ALBUM_FOLDER_COHERENCE_FLOOR = 0.85;

/** Search-result fields used by pure album folder scoring. */
export interface AlbumCandidateFile {
    username: string;
    filename: string;
    fullPath: string;
    size: number;
    bitRate?: number;
    slots?: boolean;
    speed?: number;
    searchIndex?: number;
}

/** Files shared by one Soulseek user from one parent folder. */
export interface AlbumFolderCandidate {
    key: string;
    username: string;
    folderPath: string;
    folderName: string;
    files: AlbumCandidateFile[];
    matchedSearchIndices: number[];
}

/** Requested release identity and number of distinct track searches. */
export interface AlbumFolderTarget {
    artist: string;
    album: string;
    year?: number;
    requestedSearchCount: number;
}

/** Weighted coherence components and the final peer-aware score. */
export interface ScoredAlbumFolder extends AlbumFolderCandidate {
    components: {
        completeness: number;
        folderName: number;
        format: number;
        bitrate: number;
        penaltyAvoidance: number;
    };
    coherenceScore: number;
    peerSignalScore: number;
    compositeScore: number;
}

function normalizedRemotePath(fullPath: string): string {
    return fullPath.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function parentFolder(fullPath: string): string | null {
    const normalized = normalizedRemotePath(fullPath);
    const separator = normalized.lastIndexOf("/");
    if (separator <= 0) return null;
    return normalized.slice(0, separator);
}

/** Build the deterministic identity for a user's remote parent folder. */
export function albumFolderKey(file: AlbumCandidateFile): string | null {
    const folder = parentFolder(file.fullPath);
    return folder ? `${file.username}\u0000${folder}` : null;
}

/** Group and deduplicate search results by user and remote parent folder. */
export function groupFolderCandidates(
    files: readonly AlbumCandidateFile[],
): AlbumFolderCandidate[] {
    const groups = new Map<string, AlbumFolderCandidate>();
    for (const [fallbackIndex, file] of files.entries()) {
        const folderPath = parentFolder(file.fullPath);
        const key = albumFolderKey(file);
        if (!folderPath || !key) continue;
        const candidateSearchIndex = file.searchIndex;
        const searchIndex =
            candidateSearchIndex !== undefined &&
            Number.isSafeInteger(candidateSearchIndex) &&
            candidateSearchIndex >= 0
                ? candidateSearchIndex
                : fallbackIndex;
        const existing = groups.get(key);
        if (existing) {
            if (!existing.matchedSearchIndices.includes(searchIndex)) {
                existing.matchedSearchIndices.push(searchIndex);
            }
            if (
                !existing.files.some((item) => item.fullPath === file.fullPath)
            ) {
                existing.files.push(file);
            }
            continue;
        }
        groups.set(key, {
            key,
            username: file.username,
            folderPath,
            folderName: folderPath.split("/").pop() ?? folderPath,
            files: [file],
            matchedSearchIndices: [searchIndex],
        });
    }
    return [...groups.values()];
}

/** Score distinct requested searches represented inside one candidate folder. */
function requestedSearchCompleteness(
    matchedSearchIndices: readonly number[],
    requestedSearchCount: number,
): number {
    if (
        !Number.isSafeInteger(requestedSearchCount) ||
        requestedSearchCount <= 0
    ) {
        return 0;
    }
    return Math.min(
        new Set(matchedSearchIndices).size / requestedSearchCount,
        1,
    );
}

function extension(filename: string): string {
    const match = /\.([a-z0-9]+)$/i.exec(filename);
    return match?.[1]?.toLowerCase() ?? "unknown";
}

/** Score codec agreement as the dominant codec's share of the folder. */
export function formatConsistency(
    files: readonly AlbumCandidateFile[],
): number {
    if (files.length === 0) return 0;
    const counts = new Map<string, number>();
    for (const file of files) {
        const codec = extension(file.filename);
        counts.set(codec, (counts.get(codec) ?? 0) + 1);
    }
    return Math.max(...counts.values()) / files.length;
}

/** Score bitrate consistency with known-value coverage and tolerant variation. */
export function bitrateConsistency(
    files: readonly AlbumCandidateFile[],
): number {
    const values = files
        .map((file) => file.bitRate)
        .filter((value): value is number =>
            Boolean(value && Number.isFinite(value) && value > 0),
        );
    if (values.length === 0) return 0;
    const knownCoverage = values.length / files.length;
    if (values.length === 1) return knownCoverage;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance =
        values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        values.length;
    const coefficientOfVariation = Math.sqrt(variance) / mean;
    const consistency = Math.max(
        0,
        1 - coefficientOfVariation * BITRATE_VARIATION_PENALTY,
    );
    return knownCoverage * consistency;
}

function tokenSet(value: string): Set<string> {
    // Both sides tokenize punctuation identically, so "AC/DC" yields the
    // same tokens whether it appears in the folder name or the target.
    const tokenizable = value.replace(/[\p{P}\p{S}]+/gu, " ");
    return new Set(
        normalizeForFuzzyMatch(tokenizable).split(/\s+/).filter(Boolean),
    );
}

/** Compare a folder leaf with the normalized "artist album (year)" target. */
export function folderNameSimilarity(
    folderName: string,
    artist: string,
    album: string,
    year?: number,
): number {
    const target = `${artist} ${album}${year ? ` ${year}` : ""}`;
    const folderTokens = tokenSet(folderName);
    const targetTokens = tokenSet(target);
    if (folderTokens.size === 0 || targetTokens.size === 0) return 0;
    let common = 0;
    for (const token of folderTokens) {
        if (targetTokens.has(token)) common += 1;
    }
    return (2 * common) / (folderTokens.size + targetTokens.size);
}

/** Return zero for compilation-looking folders and one otherwise. */
export function compilationPenaltyAvoidance(folderName: string): number {
    const normalized = normalizeForFuzzyMatch(folderName);
    return COMPILATION_FOLDER_PATTERN.test(normalized) ||
        UNKNOWN_FOLDER_PATTERN.test(normalized)
        ? 0
        : 1;
}

function peerSignals(files: readonly AlbumCandidateFile[]): number {
    const hasSlots = files.some((file) => file.slots === true);
    let speed = 0;
    for (const file of files) {
        speed = Math.max(speed, file.speed ?? 0);
    }
    const speedScore = speed > 1_000_000 ? 0.15 : speed > 500_000 ? 0.05 : 0;
    return (hasSlots ? 0.4 : 0) + speedScore;
}

/** Apply the published weights to one folder and add bounded peer signals. */
export function scoreFolderCandidate(
    candidate: AlbumFolderCandidate,
    target: AlbumFolderTarget,
): ScoredAlbumFolder {
    const components = {
        completeness: requestedSearchCompleteness(
            candidate.matchedSearchIndices,
            target.requestedSearchCount,
        ),
        folderName: folderNameSimilarity(
            candidate.folderName,
            target.artist,
            target.album,
            target.year,
        ),
        format: formatConsistency(candidate.files),
        bitrate: bitrateConsistency(candidate.files),
        penaltyAvoidance: compilationPenaltyAvoidance(candidate.folderName),
    };
    const coherenceScore =
        components.completeness * COHERENCE_WEIGHTS.completeness +
        components.folderName * COHERENCE_WEIGHTS.folderName +
        components.format * COHERENCE_WEIGHTS.format +
        components.bitrate * COHERENCE_WEIGHTS.bitrate +
        components.penaltyAvoidance * COHERENCE_WEIGHTS.penaltyAvoidance;
    const peerSignalScore = peerSignals(candidate.files);
    return {
        ...candidate,
        components,
        coherenceScore,
        peerSignalScore,
        compositeScore: coherenceScore + peerSignalScore,
    };
}

function asCandidates(
    values: readonly AlbumCandidateFile[] | readonly AlbumFolderCandidate[],
): AlbumFolderCandidate[] {
    if (values.length === 0) return [];
    return "files" in values[0]
        ? [...(values as readonly AlbumFolderCandidate[])]
        : groupFolderCandidates(values as readonly AlbumCandidateFile[]);
}

function rankByComposite(
    left: ScoredAlbumFolder,
    right: ScoredAlbumFolder,
): number {
    return (
        right.compositeScore - left.compositeScore ||
        right.coherenceScore - left.coherenceScore ||
        left.username.localeCompare(right.username) ||
        left.folderPath.localeCompare(right.folderPath)
    );
}

function rankByCoherence(
    left: ScoredAlbumFolder,
    right: ScoredAlbumFolder,
): number {
    return (
        right.coherenceScore - left.coherenceScore ||
        right.components.completeness - left.components.completeness ||
        left.username.localeCompare(right.username) ||
        left.folderPath.localeCompare(right.folderPath)
    );
}

function isEligible(candidate: ScoredAlbumFolder): boolean {
    return (
        candidate.components.completeness >= ALBUM_FOLDER_COMPLETENESS_FLOOR &&
        candidate.coherenceScore >= ALBUM_FOLDER_COHERENCE_FLOOR
    );
}

/** Gate folders by coverage and coherence, then rank eligible candidates. */
export function selectAlbumFolder(
    values: readonly AlbumCandidateFile[] | readonly AlbumFolderCandidate[],
    target: AlbumFolderTarget,
): {
    candidateCount: number;
    best: ScoredAlbumFolder | null;
    selected: ScoredAlbumFolder | null;
} {
    const candidates = asCandidates(values);
    const scored = candidates.map((candidate) =>
        scoreFolderCandidate(candidate, target),
    );
    const eligible = scored.filter(isEligible).sort(rankByComposite);
    const selected = eligible[0];
    const best = selected ?? scored.sort(rankByCoherence)[0];
    return {
        candidateCount: scored.length,
        best: best ?? null,
        selected: target.requestedSearchCount > 1 && selected ? selected : null,
    };
}

/** Identify a multi-track batch representing one artist and album. */
export function isAlbumShapedBatch(
    tracks: readonly { artist: string; album: string }[],
): boolean {
    if (tracks.length <= 1) return false;
    const artist = normalizeForFuzzyMatch(tracks[0].artist);
    const album = normalizeForFuzzyMatch(tracks[0].album);
    if (!artist || !album) return false;
    return tracks.every(
        (track) =>
            normalizeForFuzzyMatch(track.artist) === artist &&
            normalizeForFuzzyMatch(track.album) === album,
    );
}
