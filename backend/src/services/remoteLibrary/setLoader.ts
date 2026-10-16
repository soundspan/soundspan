import type { Prisma as PrismaTypes } from "@prisma/client";
import { recordRemoteLibraryRowsCapped } from "../../metrics";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import {
    TRACK_VISIBLE_WHERE,
    trackBrowseWhere,
} from "../../utils/librarySorting";
import { rankPlaybackSource } from "../playbackSourcePriority";
import { RemoteLibraryCapWarningLimiter } from "./capWarningLimiter";
import { deriveRemoteLibraryLookups } from "./derivations";
import { collapseProviderDuplicates } from "./providerDuplicateCollapse";
import { loadRemoteLibraryAccess } from "./providers";
import type {
    RemoteLibraryProvider,
    RemoteLibrarySet,
    RemoteLibraryTrack,
} from "./types";

/** Maximum liked rows loaded from each provider for one request. */
export const REMOTE_LIBRARY_ROW_CAP = 5_000;
const remoteLibraryLogger = logger.child("RemoteLibrary");
const capWarningLimiter = new RemoteLibraryCapWarningLimiter();

const albumMembershipSelect = {
    artistId: true,
    location: true,
} satisfies PrismaTypes.AlbumSelect;
const mappingSelect = {
    id: true,
    trackId: true,
} satisfies PrismaTypes.TrackMappingSelect;
const activeMappingSelection = {
    where: { stale: false },
    select: mappingSelect,
} satisfies PrismaTypes.TrackMappingFindManyArgs;
const tidalTrackSelect = {
    id: true,
    title: true,
    artistId: true,
    albumId: true,
    albumEntity: { select: albumMembershipSelect },
    mappings: activeMappingSelection,
} satisfies PrismaTypes.TrackTidalSelect;
const ytTrackSelect = {
    id: true,
    title: true,
    artistId: true,
    albumId: true,
    albumEntity: { select: albumMembershipSelect },
    mappings: activeMappingSelection,
} satisfies PrismaTypes.TrackYtMusicSelect;

type TidalLikedRow = PrismaTypes.LikedRemoteTrackGetPayload<{
    select: { likedAt: true; trackTidal: { select: typeof tidalTrackSelect } };
}>;
type YtLikedRow = PrismaTypes.LikedRemoteTrackGetPayload<{
    select: {
        likedAt: true;
        trackYtMusic: { select: typeof ytTrackSelect };
    };
}>;

function emptyRemoteLibrarySet(): RemoteLibrarySet {
    return {
        tracks: [],
        byArtistId: new Map(),
        byAlbumId: new Map(),
    };
}

function visibleMappingWhere(): PrismaTypes.TrackMappingWhereInput {
    const visibleTrack = {
        AND: [TRACK_VISIBLE_WHERE, trackBrowseWhere("all")],
    } satisfies PrismaTypes.TrackWhereInput;
    return {
        stale: false,
        trackId: { not: null },
        track: {
            is: {
                OR: [visibleTrack, { dedupOfTrack: { is: visibleTrack } }],
            },
        },
    };
}

function reportCap(
    userId: string,
    provider: RemoteLibraryProvider,
    count: number,
): void {
    if (count <= REMOTE_LIBRARY_ROW_CAP) return;
    recordRemoteLibraryRowsCapped(provider);
    if (!capWarningLimiter.shouldWarn(userId, provider)) return;
    remoteLibraryLogger.warn("Remote library provider row cap reached", {
        userId,
        provider,
        cap: REMOTE_LIBRARY_ROW_CAP,
    });
}

function effectiveArtistScopeWhere(artistId: string | undefined) {
    if (!artistId) return {};
    return {
        OR: [
            { artistId },
            {
                albumEntity: { is: { artistId } },
            },
        ],
    };
}

function mapTidalLikedRow(entry: TidalLikedRow): RemoteLibraryTrack[] {
    if (!entry.trackTidal) return [];
    return [
        {
            provider: "tidal",
            providerRowId: entry.trackTidal.id,
            title: entry.trackTidal.title,
            artistId: entry.trackTidal.artistId,
            albumId: entry.trackTidal.albumId,
            albumLocation: entry.trackTidal.albumEntity?.location ?? null,
            albumArtistId: entry.trackTidal.albumEntity?.artistId ?? null,
            likedAt: entry.likedAt,
            mappings: entry.trackTidal.mappings,
        },
    ];
}

function mapYoutubeLikedRow(entry: YtLikedRow): RemoteLibraryTrack[] {
    if (!entry.trackYtMusic) return [];
    return [
        {
            provider: "youtube",
            providerRowId: entry.trackYtMusic.id,
            title: entry.trackYtMusic.title,
            artistId: entry.trackYtMusic.artistId,
            albumId: entry.trackYtMusic.albumId,
            albumLocation: entry.trackYtMusic.albumEntity?.location ?? null,
            albumArtistId: entry.trackYtMusic.albumEntity?.artistId ?? null,
            likedAt: entry.likedAt,
            mappings: entry.trackYtMusic.mappings,
        },
    ];
}

function matchesArtistScope(
    row: RemoteLibraryTrack,
    artistId: string | undefined,
): boolean {
    return (
        !artistId || row.artistId === artistId || row.albumArtistId === artistId
    );
}

async function loadTidalRows(
    userId: string,
    artistId: string | undefined,
    shouldReportCap: boolean,
): Promise<RemoteLibraryTrack[]> {
    const rows: TidalLikedRow[] = await prisma.likedRemoteTrack.findMany({
        where: {
            userId,
            trackTidalId: { not: null },
            trackTidal: {
                is: {
                    ...effectiveArtistScopeWhere(artistId),
                    mappings: { none: visibleMappingWhere() },
                },
            },
        },
        select: { likedAt: true, trackTidal: { select: tidalTrackSelect } },
        orderBy: [{ likedAt: "desc" }, { id: "asc" }],
        take: REMOTE_LIBRARY_ROW_CAP + 1,
    });
    if (shouldReportCap) reportCap(userId, "tidal", rows.length);
    const tracks = rows
        .slice(0, REMOTE_LIBRARY_ROW_CAP)
        .flatMap(mapTidalLikedRow);
    return tracks.filter((row) => matchesArtistScope(row, artistId));
}

async function loadYoutubeRows(
    userId: string,
    artistId: string | undefined,
    shouldReportCap: boolean,
): Promise<RemoteLibraryTrack[]> {
    const rows: YtLikedRow[] = await prisma.likedRemoteTrack.findMany({
        where: {
            userId,
            trackYtMusicId: { not: null },
            trackYtMusic: {
                is: {
                    ...effectiveArtistScopeWhere(artistId),
                    mappings: { none: visibleMappingWhere() },
                },
            },
        },
        select: {
            likedAt: true,
            trackYtMusic: { select: ytTrackSelect },
        },
        orderBy: [{ likedAt: "desc" }, { id: "asc" }],
        take: REMOTE_LIBRARY_ROW_CAP + 1,
    });
    if (shouldReportCap) reportCap(userId, "youtube", rows.length);
    const tracks = rows
        .slice(0, REMOTE_LIBRARY_ROW_CAP)
        .flatMap(mapYoutubeLikedRow);
    return tracks.filter((row) => matchesArtistScope(row, artistId));
}

function preferredProvider(
    order: Awaited<
        ReturnType<typeof loadRemoteLibraryAccess>
    >["playbackSourceOrder"],
): RemoteLibraryProvider {
    const tidal = rankPlaybackSource(
        { source: "tidal", available: true },
        order,
    );
    const youtube = rankPlaybackSource(
        { source: "ytmusic", available: true },
        order,
    );
    return tidal >= youtube ? "tidal" : "youtube";
}

/** Loads and derives the bounded per-user remote library set. */
export async function loadRemoteLibrarySet(
    userId: string | undefined,
    options?: { artistId?: string; reportCap?: boolean },
): Promise<RemoteLibrarySet> {
    if (!userId) return emptyRemoteLibrarySet();
    const access = await loadRemoteLibraryAccess(userId);
    if (!access.providers.tidal && !access.providers.youtube) {
        return emptyRemoteLibrarySet();
    }
    const shouldReportCap = options?.reportCap ?? true;
    const [tidalRows, youtubeRows] = await Promise.all([
        access.providers.tidal
            ? loadTidalRows(userId, options?.artistId, shouldReportCap)
            : Promise.resolve([]),
        access.providers.youtube
            ? loadYoutubeRows(userId, options?.artistId, shouldReportCap)
            : Promise.resolve([]),
    ]);
    const tracks = collapseProviderDuplicates(
        tidalRows,
        youtubeRows,
        preferredProvider(access.playbackSourceOrder),
    );
    return { tracks, ...deriveRemoteLibraryLookups(tracks) };
}
