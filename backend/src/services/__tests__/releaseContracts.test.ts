import type { CalendarRelease, LidarrRelease } from "../lidarr";
import {
    formatBytes,
    mapCalendarReleaseToRadarItem,
    mapInteractiveRelease,
    sortByReleaseDateAsc,
    sortByReleaseDateDesc,
} from "../releaseContracts";

function makeLidarrRelease(
    overrides: Partial<LidarrRelease & { infoUrl?: string | null }> = {}
): LidarrRelease & { infoUrl?: string | null } {
    return {
        guid: overrides.guid ?? "guid-1",
        title: overrides.title ?? "Release",
        indexerId: overrides.indexerId ?? 100,
        indexer: overrides.indexer,
        size: overrides.size,
        seeders: overrides.seeders,
        leechers: overrides.leechers,
        protocol: overrides.protocol ?? "torrent",
        approved: overrides.approved ?? true,
        rejected: overrides.rejected ?? false,
        rejections: overrides.rejections,
        quality: overrides.quality,
        infoUrl: overrides.infoUrl,
    };
}

function makeCalendarRelease(
    overrides: Partial<CalendarRelease> = {}
): CalendarRelease {
    return {
        id: overrides.id ?? 1,
        title: overrides.title ?? "Album",
        artistName: overrides.artistName ?? "Artist",
        artistId: overrides.artistId,
        artistMbid: overrides.artistMbid,
        albumMbid: overrides.albumMbid ?? "album-mbid-1",
        releaseDate: overrides.releaseDate ?? "2026-03-01T00:00:00.000Z",
        monitored: overrides.monitored ?? true,
        grabbed: overrides.grabbed ?? false,
        hasFile: overrides.hasFile ?? false,
        coverUrl: overrides.coverUrl ?? null,
    };
}

describe("releaseContracts", () => {
    describe("formatBytes", () => {
        it("returns zero for non-positive and non-finite values", () => {
            expect(formatBytes(0)).toBe("0 B");
            expect(formatBytes(-1)).toBe("0 B");
            expect(formatBytes(Number.NaN)).toBe("0 B");
            expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
        });

        it("formats with two decimals under 10 units and one decimal from 10+", () => {
            expect(formatBytes(1536)).toBe("1.50 KB");
            expect(formatBytes(10 * 1024)).toBe("10.0 KB");
        });

        it("caps at TB when the input is larger than supported units", () => {
            expect(formatBytes(1024 ** 5)).toBe("1024.0 TB");
        });
    });

    describe("mapInteractiveRelease", () => {
        it("maps release fields and applies defaults for missing optional data", () => {
            const mapped = mapInteractiveRelease(
                makeLidarrRelease({
                    guid: "g1",
                    title: "My Release",
                    indexerId: 7,
                    indexer: "",
                    infoUrl: undefined,
                    size: undefined,
                    quality: undefined,
                    rejections: undefined,
                    approved: false,
                    rejected: true,
                })
            );

            expect(mapped).toEqual({
                guid: "g1",
                title: "My Release",
                indexer: "Unknown",
                indexerId: 7,
                infoUrl: null,
                size: 0,
                sizeFormatted: "0 B",
                seeders: undefined,
                leechers: undefined,
                protocol: "torrent",
                quality: "Unknown",
                approved: false,
                rejected: true,
                rejections: [],
            });
        });

        it("preserves optional values when present", () => {
            const mapped = mapInteractiveRelease(
                makeLidarrRelease({
                    guid: "g2",
                    title: "Hi-Res Release",
                    indexer: "My Indexer",
                    seeders: 42,
                    leechers: 5,
                    size: 2 * 1024 ** 3,
                    infoUrl: "https://example.com/release",
                    quality: { quality: { name: "FLAC" } },
                    rejections: ["seeders-too-low"],
                })
            );

            expect(mapped.seeders).toBe(42);
            expect(mapped.leechers).toBe(5);
            expect(mapped.quality).toBe("FLAC");
            expect(mapped.infoUrl).toBe("https://example.com/release");
            expect(mapped.rejections).toEqual(["seeders-too-low"]);
            expect(mapped.sizeFormatted).toBe("2.00 GB");
        });
    });

    describe("mapCalendarReleaseToRadarItem", () => {
        const now = new Date("2026-03-04T12:00:00.000Z");

        it("marks future releases as upcoming and non-downloadable", () => {
            const mapped = mapCalendarReleaseToRadarItem(
                makeCalendarRelease({
                    id: 10,
                    releaseDate: "2026-03-10T00:00:00.000Z",
                    hasFile: false,
                }),
                now,
                new Set()
            );

            expect(mapped.status).toBe("upcoming");
            expect(mapped.inLibrary).toBe(false);
            expect(mapped.canDownload).toBe(false);
            expect(mapped.source).toBe("lidarr");
        });

        it("marks already-owned releases as available via hasFile or library mbid", () => {
            const viaHasFile = mapCalendarReleaseToRadarItem(
                makeCalendarRelease({
                    id: 11,
                    albumMbid: "album-a",
                    releaseDate: "2026-03-01T00:00:00.000Z",
                    hasFile: true,
                }),
                now,
                new Set()
            );
            const viaLibrarySet = mapCalendarReleaseToRadarItem(
                makeCalendarRelease({
                    id: 12,
                    albumMbid: "album-b",
                    releaseDate: "2026-03-01T00:00:00.000Z",
                    hasFile: false,
                }),
                now,
                new Set(["album-b"])
            );

            expect(viaHasFile.status).toBe("available");
            expect(viaHasFile.inLibrary).toBe(true);
            expect(viaHasFile.canDownload).toBe(false);

            expect(viaLibrarySet.status).toBe("available");
            expect(viaLibrarySet.inLibrary).toBe(true);
            expect(viaLibrarySet.canDownload).toBe(false);
        });

        it("marks past not-owned releases as released and downloadable", () => {
            const mapped = mapCalendarReleaseToRadarItem(
                makeCalendarRelease({
                    id: 13,
                    albumMbid: "album-c",
                    releaseDate: "2026-02-15T00:00:00.000Z",
                    hasFile: false,
                }),
                now,
                new Set()
            );

            expect(mapped.status).toBe("released");
            expect(mapped.inLibrary).toBe(false);
            expect(mapped.canDownload).toBe(true);
        });
    });

    describe("release-date sort helpers", () => {
        const input = [
            { id: "middle", releaseDate: "2026-03-02T00:00:00.000Z" },
            { id: "early", releaseDate: "2026-02-01T00:00:00.000Z" },
            { id: "late", releaseDate: "2026-04-01T00:00:00.000Z" },
        ];

        it("sorts ascending without mutating the source array", () => {
            const sorted = sortByReleaseDateAsc(input);

            expect(sorted.map((item) => item.id)).toEqual(["early", "middle", "late"]);
            expect(input.map((item) => item.id)).toEqual(["middle", "early", "late"]);
        });

        it("sorts descending without mutating the source array", () => {
            const sorted = sortByReleaseDateDesc(input);

            expect(sorted.map((item) => item.id)).toEqual(["late", "middle", "early"]);
            expect(input.map((item) => item.id)).toEqual(["middle", "early", "late"]);
        });
    });
});
