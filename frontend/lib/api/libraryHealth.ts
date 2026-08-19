import { type ApiClientConstructor } from "./core";

/** Metadata-gap drill-down categories served by the dashboard API. */
export type LibraryHealthGapKind =
    | "missing-art"
    | "missing-mbid"
    | "missing-genres"
    | "missing-lyrics";

export type LibraryHealthDuplicateTier = "audioHash" | "recordingMbid" | "isrc";

export interface LibraryHealthStatusCounts {
    pending: number;
    processing: number;
    failed: number;
    completed: number;
}

export interface LibraryHealthSummary {
    metadataGaps: {
        missingArt: { albums: number; artists: number };
        missingMbid: { albums: number; artists: number };
        missingGenres: number;
        missingLyrics: number;
    };
    analysisCoverage: {
        total: number;
        analysisStatus: LibraryHealthStatusCounts;
        vibeAnalysisStatus: LibraryHealthStatusCounts;
        loudness: { measured: number; missing: number };
    };
    storage: {
        tracks: number;
        totalFileSize: number;
        mimeTypes: number;
        artists: number;
        isTruncated: boolean;
    };
    quality: {
        floorKbps: number;
        albumsBelowFloor: number;
        isTruncated: boolean;
    };
    duplicates: {
        clusters: number;
        byTier: Record<LibraryHealthDuplicateTier, number>;
        isTruncated: boolean;
    };
}

export interface LibraryHealthAlbumGapItem {
    id: string;
    title: string;
    rgMbid: string;
    coverUrl: string | null;
    userCoverUrl: string | null;
    artist: { id: string; name: string };
}

export interface LibraryHealthTrackGapItem {
    id: string;
    title: string;
    filePath: string | null;
    album: { title: string; artist: { name: string } };
}

export interface LibraryHealthGapPage {
    kind: LibraryHealthGapKind;
    counts: Record<string, number>;
    items: Array<LibraryHealthAlbumGapItem | LibraryHealthTrackGapItem>;
    total: number;
    limit: number;
    offset: number;
}

export interface LibraryHealthAnalysisPage {
    total: number;
    analysisStatus: LibraryHealthStatusCounts;
    vibeAnalysisStatus: LibraryHealthStatusCounts;
    loudness: { measured: number; missing: number };
    failed: {
        items: Array<{
            id: string;
            title: string;
            analysisError: string | null;
            album: { title: string; artist: { name: string } };
        }>;
        total: number;
        limit: number;
        offset: number;
    };
}

export interface LibraryHealthStorageReport {
    formats: Array<{
        mime: string | null;
        trackCount: number;
        totalFileSize: number;
        averageBitrateKbps: number | null;
        bitrateSampleSize: number;
    }>;
    topArtists: Array<{
        artistId: string;
        artistName: string;
        trackCount: number;
        totalFileSize: number;
    }>;
    sampledTracks: number;
    sampleLimit: number;
    isTruncated: boolean;
}

export interface LibraryHealthQualityPage {
    floorKbps: number;
    items: Array<{
        albumId: string;
        title: string;
        artist: { id: string; name: string };
        averageBitrateKbps: number;
        trackCount: number;
    }>;
    total: number;
    limit: number;
    offset: number;
    sampledTracks: number;
    sampleLimit: number;
    isTruncated: boolean;
}

export interface LibraryHealthDuplicatesPage {
    clusters: Array<{
        tier: LibraryHealthDuplicateTier;
        identity: string;
        memberCount: number;
        totalFileSize: number;
        members: Array<{
            id: string;
            title: string;
            albumTitle: string;
            artistName: string;
            filePath: string | null;
            fileSize: number;
            mime: string | null;
        }>;
    }>;
    total: number;
    byTier: Record<LibraryHealthDuplicateTier, number>;
    isTruncated: boolean;
    limit: number;
    offset: number;
}

export interface LibraryHealthPageQuery {
    limit?: number;
    offset?: number;
}

function pageParams(query: LibraryHealthPageQuery): string {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.offset !== undefined) params.set("offset", String(query.offset));
    const encoded = params.toString();
    return encoded ? `?${encoded}` : "";
}

/** Add Library Health dashboard operations to an API client base class. */
export function WithLibraryHealthDashboard<TBase extends ApiClientConstructor>(
    Base: TBase,
) {
    abstract class LibraryHealthDashboardApi extends Base {
        async getLibraryHealthSummary() {
            return this.request<LibraryHealthSummary>(
                "/library-health/summary",
            );
        }

        async getLibraryHealthGaps(
            kind: LibraryHealthGapKind,
            query: LibraryHealthPageQuery = {},
        ) {
            return this.request<LibraryHealthGapPage>(
                `/library-health/gaps/${kind}${pageParams(query)}`,
            );
        }

        async getLibraryHealthAnalysis(query: LibraryHealthPageQuery = {}) {
            return this.request<LibraryHealthAnalysisPage>(
                `/library-health/analysis${pageParams(query)}`,
            );
        }

        async getLibraryHealthStorage() {
            return this.request<LibraryHealthStorageReport>(
                "/library-health/storage",
            );
        }

        async getLibraryHealthQuality(
            floor?: number,
            query: LibraryHealthPageQuery = {},
        ) {
            const params = new URLSearchParams();
            if (floor !== undefined) params.set("floor", String(floor));
            if (query.limit !== undefined)
                params.set("limit", String(query.limit));
            if (query.offset !== undefined)
                params.set("offset", String(query.offset));
            const encoded = params.toString();
            return this.request<LibraryHealthQualityPage>(
                `/library-health/quality${encoded ? `?${encoded}` : ""}`,
            );
        }

        async getLibraryHealthDuplicates(query: LibraryHealthPageQuery = {}) {
            return this.request<LibraryHealthDuplicatesPage>(
                `/library-health/duplicates${pageParams(query)}`,
            );
        }

        async refreshLibraryHealthDashboard() {
            return this.request<LibraryHealthSummary>(
                "/library-health/refresh",
                { method: "POST" },
            );
        }
    }
    return LibraryHealthDashboardApi;
}
