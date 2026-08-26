import PQueue from "p-queue";
import type { SearchTrackResult, TrackMatch } from "../soulseek";
import {
    albumFolderKey,
    groupFolderCandidates,
    isAlbumShapedBatch,
    selectAlbumFolder,
} from "./albumCoherence";

/** Track identity accepted by the Soulseek multi-track batch boundary. */
export interface AlbumBatchTrack {
    artist: string;
    title: string;
    album: string;
    year?: number;
}

/** One track and its completed Soulseek search. */
export interface AlbumBatchSearch {
    track: AlbumBatchTrack;
    result: SearchTrackResult;
}

interface TrackDownloadResult {
    success: boolean;
    filePath?: string;
    error?: string;
}

/** Bounded decision fields emitted to logging and metrics. */
export interface AlbumFolderDecision {
    outcome: "folder_selected" | "per_track_fallback";
    username?: string;
    folderName?: string;
    coherenceScore: number;
    compositeScore: number;
    candidateCount: number;
}

/** I/O seams owned by the direct Soulseek service. */
export interface AlbumFolderDownloadDependencies {
    downloadWithRetry: (
        track: AlbumBatchTrack,
        matches: TrackMatch[],
    ) => Promise<TrackDownloadResult>;
    formatError: (
        track: AlbumBatchTrack,
        result: TrackDownloadResult,
    ) => string;
    recordDecision: (decision: AlbumFolderDecision) => void;
}

/** Existing aggregate result returned by Soulseek batch downloads. */
export interface AlbumBatchDownloadResult {
    successful: number;
    failed: number;
    files: string[];
    errors: string[];
}

function matchesInFolderFirst(
    matches: readonly TrackMatch[],
    selectedKey: string,
): TrackMatch[] {
    const selected = matches.find(
        (match) => albumFolderKey(match) === selectedKey,
    );
    if (!selected) return [...matches];
    return [
        selected,
        ...matches.filter(
            (match) =>
                match !== selected && albumFolderKey(match) !== selectedKey,
        ),
    ];
}

function missingTrackError(search: AlbumBatchSearch): string {
    return `${search.track.artist} - ${search.track.title}: No match found on Soulseek`;
}

async function downloadSearch(
    search: AlbumBatchSearch,
    matches: TrackMatch[],
    dependencies: AlbumFolderDownloadDependencies,
): Promise<{ file?: string; error?: string }> {
    if (!search.result.found || matches.length === 0) {
        return { error: missingTrackError(search) };
    }
    const result = await dependencies.downloadWithRetry(search.track, matches);
    if (result.success && result.filePath) return { file: result.filePath };
    return { error: dependencies.formatError(search.track, result) };
}

async function runDownloads(
    searches: readonly AlbumBatchSearch[],
    concurrency: number,
    selectedKey: string | null,
    dependencies: AlbumFolderDownloadDependencies,
): Promise<AlbumBatchDownloadResult> {
    const queue = new PQueue({ concurrency });
    const promises = searches.map((search) => {
        const matches = selectedKey
            ? matchesInFolderFirst(search.result.allMatches, selectedKey)
            : search.result.allMatches;
        return queue.add(() => downloadSearch(search, matches, dependencies));
    });
    const outcomes = await Promise.all(promises);
    const files = outcomes.flatMap((outcome) => outcome?.file ?? []);
    const errors = outcomes.flatMap((outcome) => outcome?.error ?? []);
    return {
        successful: files.length,
        failed: errors.length,
        files,
        errors,
    };
}

function decideFolder(
    searches: readonly AlbumBatchSearch[],
): ReturnType<typeof selectAlbumFolder> {
    const candidates = groupFolderCandidates(
        searches.flatMap((search, searchIndex) =>
            search.result.allMatches.map((match) => ({
                ...match,
                searchIndex,
            })),
        ),
    );
    const first = searches[0].track;
    return selectAlbumFolder(candidates, {
        artist: first.artist,
        album: first.album,
        year: first.year,
        requestedSearchCount: searches.length,
    });
}

/** Select a coherent album folder when possible, then run bounded downloads. */
export async function downloadAlbumBatch(
    searches: readonly AlbumBatchSearch[],
    concurrency: number,
    dependencies: AlbumFolderDownloadDependencies,
): Promise<AlbumBatchDownloadResult> {
    if (!isAlbumShapedBatch(searches.map(({ track }) => track))) {
        return runDownloads(searches, concurrency, null, dependencies);
    }
    const decision = decideFolder(searches);
    const selected = decision.selected;
    const scored = selected ?? decision.best;
    dependencies.recordDecision({
        outcome: selected ? "folder_selected" : "per_track_fallback",
        username: selected?.username,
        folderName: selected?.folderName,
        coherenceScore: scored?.coherenceScore ?? 0,
        compositeScore: scored?.compositeScore ?? 0,
        candidateCount: decision.candidateCount,
    });
    return runDownloads(
        searches,
        concurrency,
        selected?.key ?? null,
        dependencies,
    );
}
