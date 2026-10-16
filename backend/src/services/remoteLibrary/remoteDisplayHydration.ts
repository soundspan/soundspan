import type { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import type {
    HydratedRemoteLibraryTrack,
    RemoteLibraryProvider,
    RemoteLibraryTrack,
} from "./types";

const remoteArtistSelect = {
    id: true,
    name: true,
} satisfies Prisma.ArtistSelect;
const remoteAlbumSelect = {
    id: true,
    title: true,
    rgMbid: true,
    coverUrl: true,
    artistId: true,
    location: true,
    artist: { select: remoteArtistSelect },
} satisfies Prisma.AlbumSelect;
const tidalDisplaySelect = {
    id: true,
    tidalId: true,
    title: true,
    artist: true,
    album: true,
    duration: true,
    artistId: true,
    albumId: true,
    artistEntity: { select: remoteArtistSelect },
    albumEntity: { select: remoteAlbumSelect },
} satisfies Prisma.TrackTidalSelect;
const youtubeDisplaySelect = {
    id: true,
    videoId: true,
    title: true,
    artist: true,
    album: true,
    duration: true,
    thumbnailUrl: true,
    artistId: true,
    albumId: true,
    artistEntity: { select: remoteArtistSelect },
    albumEntity: { select: remoteAlbumSelect },
} satisfies Prisma.TrackYtMusicSelect;
type TidalDisplayRow = Prisma.TrackTidalGetPayload<{
    select: typeof tidalDisplaySelect;
}>;
type YoutubeDisplayRow = Prisma.TrackYtMusicGetPayload<{
    select: typeof youtubeDisplaySelect;
}>;

function providerIds(
    rows: ReadonlyArray<RemoteLibraryTrack>,
    provider: RemoteLibraryProvider,
): string[] {
    return rows
        .filter((row) => row.provider === provider)
        .map((row) => row.providerRowId);
}

async function loadTidalDisplayRows(ids: string[]) {
    if (ids.length === 0) return [];
    return prisma.trackTidal.findMany({
        where: { id: { in: ids } },
        select: tidalDisplaySelect,
    });
}

async function loadYoutubeDisplayRows(ids: string[]) {
    if (ids.length === 0) return [];
    return prisma.trackYtMusic.findMany({
        where: { id: { in: ids } },
        select: youtubeDisplaySelect,
    });
}

function hydrateRemoteRow(
    row: RemoteLibraryTrack,
    tidalById: ReadonlyMap<string, TidalDisplayRow>,
    youtubeById: ReadonlyMap<string, YoutubeDisplayRow>,
): HydratedRemoteLibraryTrack | null {
    if (row.provider === "tidal") {
        const track = tidalById.get(row.providerRowId);
        return track ? { ...row, track } : null;
    }
    const track = youtubeById.get(row.providerRowId);
    return track ? { ...row, track } : null;
}

/** Hydrates display fields for only the provided remote-library rows. */
export async function hydrateRemoteLibraryTracks(
    rows: ReadonlyArray<RemoteLibraryTrack>,
): Promise<HydratedRemoteLibraryTrack[]> {
    const [tidalRows, youtubeRows] = await Promise.all([
        loadTidalDisplayRows(providerIds(rows, "tidal")),
        loadYoutubeDisplayRows(providerIds(rows, "youtube")),
    ]);
    const tidalById = new Map(tidalRows.map((row) => [row.id, row]));
    const youtubeById = new Map(youtubeRows.map((row) => [row.id, row]));
    return rows.flatMap((row) => {
        const hydrated = hydrateRemoteRow(row, tidalById, youtubeById);
        return hydrated ? [hydrated] : [];
    });
}
