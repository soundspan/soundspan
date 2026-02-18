import { CalendarRelease, LidarrRelease } from "./lidarr";

export interface InteractiveReleaseResponseItem {
    guid: string;
    title: string;
    indexer: string;
    indexerId: number;
    infoUrl: string | null;
    size: number;
    sizeFormatted: string;
    seeders?: number;
    leechers?: number;
    protocol: string;
    quality: string;
    approved: boolean;
    rejected: boolean;
    rejections: string[];
}

export interface ReleaseRadarItem {
    id: number | string;
    title: string;
    artistName: string;
    artistMbid?: string;
    albumMbid: string;
    releaseDate: string;
    coverUrl: string | null;
    source: "lidarr" | "similar";
    status: "upcoming" | "released" | "available";
    inLibrary: boolean;
    canDownload: boolean;
}

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return "0 B";
    }

    const units = ["B", "KB", "MB", "GB", "TB"];
    const power = Math.min(
        Math.floor(Math.log(bytes) / Math.log(1024)),
        units.length - 1
    );
    const value = bytes / 1024 ** power;
    const rounded = value >= 10 ? value.toFixed(1) : value.toFixed(2);

    return `${rounded} ${units[power]}`;
}

export function mapInteractiveRelease(
    release: LidarrRelease & { infoUrl?: string | null }
): InteractiveReleaseResponseItem {
    return {
        guid: release.guid,
        title: release.title,
        indexer: release.indexer || "Unknown",
        indexerId: release.indexerId,
        infoUrl: release.infoUrl || null,
        size: release.size || 0,
        sizeFormatted: formatBytes(release.size || 0),
        seeders: release.seeders,
        leechers: release.leechers,
        protocol: release.protocol,
        quality: release.quality?.quality?.name || "Unknown",
        approved: release.approved,
        rejected: release.rejected,
        rejections: release.rejections || [],
    };
}

export function mapCalendarReleaseToRadarItem(
    release: CalendarRelease,
    now: Date,
    libraryAlbumMbids: Set<string>
): ReleaseRadarItem {
    const releaseTime = new Date(release.releaseDate).getTime();
    const isUpcoming = releaseTime > now.getTime();
    const inLibrary = release.hasFile || libraryAlbumMbids.has(release.albumMbid);

    return {
        id: release.id,
        title: release.title,
        artistName: release.artistName,
        artistMbid: release.artistMbid,
        albumMbid: release.albumMbid,
        releaseDate: release.releaseDate,
        coverUrl: release.coverUrl,
        source: "lidarr",
        status: isUpcoming ? "upcoming" : inLibrary ? "available" : "released",
        inLibrary,
        canDownload: !inLibrary && !isUpcoming,
    };
}

export function sortByReleaseDateAsc<T extends { releaseDate: string }>(
    releases: T[]
): T[] {
    return [...releases].sort(
        (a, b) =>
            new Date(a.releaseDate).getTime() -
            new Date(b.releaseDate).getTime()
    );
}

export function sortByReleaseDateDesc<T extends { releaseDate: string }>(
    releases: T[]
): T[] {
    return [...releases].sort(
        (a, b) =>
            new Date(b.releaseDate).getTime() -
            new Date(a.releaseDate).getTime()
    );
}
