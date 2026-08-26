/** Artist shape used by Lidarr service orchestration. */
export interface LidarrArtist {
    id: number;
    artistName: string;
    foreignArtistId: string;
    monitored: boolean;
    tags?: number[];
    artistType?: string;
    qualityProfileId?: number;
    metadataProfileId?: number;
    rootFolderPath?: string;
    statistics?: {
        albumCount?: number;
        trackFileCount?: number;
        trackCount?: number;
        totalTrackCount?: number;
        sizeOnDisk?: number;
        percentOfTracks?: number;
    };
    ratings?: { votes?: number; value?: number };
}

/** Album shape used by Lidarr service orchestration. */
export interface LidarrAlbum {
    id: number;
    title: string;
    foreignAlbumId: string;
    artistId: number;
    monitored: boolean;
    anyReleaseOk?: boolean;
    releases?: unknown[];
    artist?: { foreignArtistId: string; artistName: string };
    [key: string]: unknown;
}

/** Lidarr tag returned by the tag API. */
export interface LidarrTag {
    id: number;
    label: string;
}
