import type { Prisma } from "@prisma/client";
import {
    normalizeForExactKey,
    VARIOUS_ARTISTS_MBID,
} from "../utils/artistNormalization";
import { prisma } from "../utils/db";
import { logger as rootLogger } from "../utils/logger";
import { isRealArtistMbid, isValidMbid } from "../utils/musicIds";
import type {
    MusicBrainzArtistCredit,
    MusicBrainzReleaseGroupSearchResult,
} from "./musicbrainz";
import { musicBrainzService } from "./musicbrainz";
import {
    pickRemoteAlbumMbidMatch,
    type RemoteAlbumMbidCandidate,
    type RemoteAlbumMbidMatch,
} from "./remoteAlbumMbidMatch";

const logger = rootLogger.child("RemoteAlbumMbidResolution");
const MAX_BATCH_SIZE = 25;
const SEARCH_RESULT_LIMIT = 25;
const UNMATCHED_RECHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;
const MATCHED_RECHECK_INTERVAL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CONSECUTIVE_TRANSIENT_ERRORS = 3;
const RELEASE_GROUP_TYPES = ["album", "ep", "single"];
const VARIOUS_ARTISTS_KEY = normalizeForExactKey("Various Artists");

interface RemoteAlbumCandidate {
    id: string;
    rgMbid: string;
    title: string;
    matchedRgMbid: string | null;
    artist: { name: string; mbid: string | null };
    tracksTidal: Array<{ title: string }>;
    tracksYtMusic: Array<{ title: string }>;
}

interface ValidatedSearchReleaseGroup {
    id: string;
    title: string;
    "primary-type": string;
    "artist-credit": MusicBrainzArtistCredit[];
    score?: unknown;
}

interface ReleaseGroupFields {
    id: string;
    title: string;
    "primary-type"?: string;
    "artist-credit"?: MusicBrainzArtistCredit[];
    score?: unknown;
}

const remoteAlbumCandidateSelect = {
    id: true,
    rgMbid: true,
    title: true,
    matchedRgMbid: true,
    artist: { select: { name: true, mbid: true } },
    tracksTidal: {
        where: { likedBy: { some: {} } },
        take: 50,
        select: { title: true },
    },
    tracksYtMusic: {
        where: { likedBy: { some: {} } },
        take: 50,
        select: { title: true },
    },
} satisfies Prisma.AlbumSelect;

type AlbumOutcome =
    | "matched"
    | "missed"
    | "skipped"
    | "permanentError"
    | "transientError";

/** Counts emitted by one bounded remote-album identity resolution run. */
export interface RemoteAlbumMbidResolutionResult {
    scanned: number;
    matched: number;
    missed: number;
    skipped: number;
    errors: number;
}

function emptyResult(): RemoteAlbumMbidResolutionResult {
    return { scanned: 0, matched: 0, missed: 0, skipped: 0, errors: 0 };
}

function validateBatchSize(batchSize: number): void {
    if (
        !Number.isInteger(batchSize) ||
        batchSize < 1 ||
        batchSize > MAX_BATCH_SIZE
    ) {
        throw new RangeError(
            `batchSize must be between 1 and ${MAX_BATCH_SIZE}`,
        );
    }
}

function dueAlbumWhere(now: Date): Prisma.AlbumWhereInput {
    const unmatchedBefore = new Date(
        now.getTime() - UNMATCHED_RECHECK_INTERVAL_MS,
    );
    const matchedBefore = new Date(now.getTime() - MATCHED_RECHECK_INTERVAL_MS);
    return {
        location: "REMOTE",
        rgMbid: { startsWith: "remote:" },
        OR: [
            {
                matchedRgMbid: null,
                OR: [
                    { rgMbidCheckedAt: null },
                    { rgMbidCheckedAt: { lt: unmatchedBefore } },
                ],
            },
            {
                matchedRgMbid: { not: null },
                rgMbidCheckedAt: { lt: matchedBefore },
            },
        ],
        AND: [
            {
                OR: [
                    { tracksTidal: { some: { likedBy: { some: {} } } } },
                    {
                        tracksYtMusic: {
                            some: { likedBy: { some: {} } },
                        },
                    },
                ],
            },
        ],
    };
}

async function loadAlbums(
    batchSize: number,
    now: Date,
): Promise<RemoteAlbumCandidate[]> {
    return prisma.album.findMany({
        where: dueAlbumWhere(now),
        orderBy: [
            { rgMbidCheckedAt: { sort: "asc", nulls: "first" } },
            { id: "asc" },
        ],
        take: batchSize,
        select: remoteAlbumCandidateSelect,
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isValidArtistCredit(value: unknown): value is MusicBrainzArtistCredit {
    if (!isRecord(value)) return false;
    const artist = value.artist;
    const hasCreditName = typeof value.name === "string";
    const hasArtistField =
        isRecord(artist) &&
        (typeof artist.id === "string" || typeof artist.name === "string");
    return hasCreditName || hasArtistField;
}

function parseSearchReleaseGroups(
    value: unknown,
): ValidatedSearchReleaseGroup[] {
    if (!Array.isArray(value)) {
        throw new TypeError(
            "Invalid MusicBrainz release-group search response",
        );
    }
    return value
        .slice(0, SEARCH_RESULT_LIMIT)
        .filter((entry): entry is ValidatedSearchReleaseGroup => {
            if (!isRecord(entry) || !isValidMbid(entry.id)) return false;
            if (
                typeof entry.title !== "string" ||
                typeof entry["primary-type"] !== "string" ||
                !Array.isArray(entry["artist-credit"])
            ) {
                return false;
            }
            return entry["artist-credit"].every(isValidArtistCredit);
        });
}

function creditArtistIdMatches(
    credits: readonly MusicBrainzArtistCredit[] | undefined,
    artistMbid: string,
): boolean {
    return (
        credits?.some(
            (credit) =>
                isValidArtistCredit(credit) && credit.artist?.id === artistMbid,
        ) ?? false
    );
}

function creditArtistNameMatches(
    credits: readonly MusicBrainzArtistCredit[],
    artistName: string,
): boolean {
    const expected = normalizeForExactKey(artistName);
    return credits.some((credit) => {
        const creditedName = credit.artist?.name ?? credit.name;
        return (
            typeof creditedName === "string" &&
            normalizeForExactKey(creditedName) === expected
        );
    });
}

function numericScore(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "number" || typeof value === "string") {
        return Number(value);
    }
    return Number.NaN;
}

function mapReleaseGroup(
    group: ReleaseGroupFields,
    artistMatches: boolean,
    includeScore: boolean,
): RemoteAlbumMbidCandidate {
    return {
        rgMbid: group.id,
        title: group.title,
        primaryType:
            typeof group["primary-type"] === "string"
                ? group["primary-type"]
                : "",
        artistMatches,
        ...(includeScore ? { score: numericScore(group.score) } : {}),
    };
}

async function searchMusicBrainzMatch(
    album: RemoteAlbumCandidate,
    artistMbid: string | null,
    allowSingle: boolean,
): Promise<RemoteAlbumMbidMatch | null> {
    const rawGroups: unknown = await musicBrainzService.searchReleaseGroups(
        album.title,
        album.artist.name,
        SEARCH_RESULT_LIMIT,
        { strict: true },
    );
    const groups = parseSearchReleaseGroups(rawGroups);
    const candidates = groups.map((group) => {
        const artistMatches = artistMbid
            ? creditArtistIdMatches(group["artist-credit"], artistMbid)
            : creditArtistNameMatches(
                  group["artist-credit"],
                  album.artist.name,
              );
        return mapReleaseGroup(group, artistMatches, true);
    });
    return pickRemoteAlbumMbidMatch(album.title, candidates, { allowSingle });
}

function browseCandidates(
    groups: readonly MusicBrainzReleaseGroupSearchResult[],
    artistMbid: string,
): RemoteAlbumMbidCandidate[] {
    const hasAnyCredits = groups.some(
        (group) => (group["artist-credit"]?.length ?? 0) > 0,
    );
    return groups.map((group) =>
        mapReleaseGroup(
            group,
            !hasAnyCredits ||
                creditArtistIdMatches(group["artist-credit"], artistMbid),
            false,
        ),
    );
}

async function browseMusicBrainzMatch(
    album: RemoteAlbumCandidate,
    artistMbid: string,
    allowSingle: boolean,
): Promise<RemoteAlbumMbidMatch | null> {
    const groups = await musicBrainzService.getReleaseGroupsWithCredits(
        artistMbid,
        RELEASE_GROUP_TYPES,
        100,
    );
    if (groups.length >= 100) {
        return searchMusicBrainzMatch(album, artistMbid, allowSingle);
    }
    return pickRemoteAlbumMbidMatch(
        album.title,
        browseCandidates(groups, artistMbid),
        { allowSingle },
    );
}

function allowsSingleMatch(album: RemoteAlbumCandidate): boolean {
    const albumKey = normalizeForExactKey(album.title);
    if (!albumKey) return false;
    const titleMatches = (track: { title: string }) =>
        normalizeForExactKey(track.title) === albumKey;
    return (
        album.tracksTidal.some(titleMatches) ||
        album.tracksYtMusic.some(titleMatches)
    );
}

function findMusicBrainzMatch(
    album: RemoteAlbumCandidate,
): Promise<RemoteAlbumMbidMatch | null> {
    const artistMbid = album.artist.mbid;
    const allowSingle = allowsSingleMatch(album);
    return artistMbid !== null && isRealArtistMbid(artistMbid)
        ? browseMusicBrainzMatch(album, artistMbid, allowSingle)
        : searchMusicBrainzMatch(album, null, allowSingle);
}

function isVariousArtists(album: RemoteAlbumCandidate): boolean {
    return (
        album.artist.mbid === VARIOUS_ARTISTS_MBID ||
        normalizeForExactKey(album.artist.name) === VARIOUS_ARTISTS_KEY
    );
}

function markChecked(album: RemoteAlbumCandidate, now: Date) {
    return prisma.album.updateMany({
        where: { id: album.id, rgMbid: album.rgMbid },
        data: { rgMbidCheckedAt: now },
    });
}

function storeMatch(
    album: RemoteAlbumCandidate,
    match: RemoteAlbumMbidMatch,
    now: Date,
) {
    return prisma.album.updateMany({
        where: { id: album.id, rgMbid: album.rgMbid },
        data: { matchedRgMbid: match.rgMbid, rgMbidCheckedAt: now },
    });
}

function storeMiss(album: RemoteAlbumCandidate, now: Date) {
    if (album.matchedRgMbid === null) return markChecked(album, now);
    return prisma.album.updateMany({
        where: { id: album.id, rgMbid: album.rgMbid },
        data: { matchedRgMbid: null, rgMbidCheckedAt: now },
    });
}

function httpStatus(error: unknown): number | undefined {
    if (!isRecord(error) || !isRecord(error.response)) return undefined;
    return typeof error.response.status === "number"
        ? error.response.status
        : undefined;
}

// Authentication blocks, request timeouts, and rate limits can clear by the next run.
const RETRYABLE_CLIENT_STATUSES = new Set([401, 403, 408, 429]);

function isPermanentLookupError(error: unknown): boolean {
    const status = httpStatus(error);
    if (status !== undefined && RETRYABLE_CLIENT_STATUSES.has(status)) {
        return false;
    }
    return (
        error instanceof TypeError ||
        (status !== undefined && status >= 400 && status <= 499)
    );
}

async function resolveAlbum(
    album: RemoteAlbumCandidate,
    now: Date,
): Promise<AlbumOutcome> {
    if (isVariousArtists(album)) {
        await markChecked(album, now);
        return "skipped";
    }
    let match: RemoteAlbumMbidMatch | null;
    try {
        match = await findMusicBrainzMatch(album);
    } catch (error) {
        logger.debug("Remote album MusicBrainz lookup failed", {
            albumId: album.id,
            status: httpStatus(error),
            message: String(error),
        });
        if (!isPermanentLookupError(error)) return "transientError";
        await markChecked(album, now);
        return "permanentError";
    }
    if (!match) {
        await storeMiss(album, now);
        return "missed";
    }
    await storeMatch(album, match, now);
    return "matched";
}

function recordOutcome(
    result: RemoteAlbumMbidResolutionResult,
    outcome: AlbumOutcome,
): void {
    if (outcome === "permanentError" || outcome === "transientError") {
        result.errors += 1;
        return;
    }
    result[outcome] += 1;
}

function logSummary(result: RemoteAlbumMbidResolutionResult): void {
    const message = "Remote album MusicBrainz resolution completed";
    if (result.errors > 0) {
        logger.warn(message, result);
    } else if (result.matched > 0) {
        logger.info(message, result);
    } else {
        logger.debug(message, result);
    }
}

/** Resolve a bounded batch of liked REMOTE album placeholder identities. */
export async function resolveRemoteAlbumMbids({
    batchSize = 25,
    now = new Date(),
}: {
    batchSize?: number;
    now?: Date;
} = {}): Promise<RemoteAlbumMbidResolutionResult> {
    validateBatchSize(batchSize);
    const albums = await loadAlbums(batchSize, now);
    const result = emptyResult();
    let consecutiveTransientErrors = 0;
    for (let index = 0; index < MAX_BATCH_SIZE; index += 1) {
        const album = albums[index];
        if (!album) break;
        result.scanned += 1;
        const outcome = await resolveAlbum(album, now);
        recordOutcome(result, outcome);
        consecutiveTransientErrors =
            outcome === "transientError" ? consecutiveTransientErrors + 1 : 0;
        if (consecutiveTransientErrors >= MAX_CONSECUTIVE_TRANSIENT_ERRORS) {
            break;
        }
    }
    logSummary(result);
    return result;
}
