import type {
    ResolvedSource,
    TrackResolutionInput,
    UserProviderProfile,
} from "../listenTogetherResolution";
import {
    playlistTrackResolutionTestables,
    resolvePlaylistItemsForUser,
} from "../playlistTrackResolution";
import type {
    UnifiedLocalTrackRecord,
    UnifiedPlaylistItemRecord,
    UnifiedTrackTidalRecord,
    UnifiedTrackYtMusicRecord,
} from "../unifiedTrackResponse";

jest.mock("../../utils/db", () => ({
    prisma: {
        trackMapping: {
            findMany: jest.fn(),
        },
        track: {
            findMany: jest.fn(),
        },
        trackTidal: {
            findMany: jest.fn(),
        },
        trackYtMusic: {
            findMany: jest.fn(),
        },
    },
}));

jest.mock("../listenTogetherResolution", () => ({
    getUserProviderProfile: jest.fn(),
    resolveQueueForUser: jest.fn(),
}));

const { prisma: mockPrisma } = jest.requireMock("../../utils/db") as {
    prisma: {
        trackMapping: { findMany: jest.Mock };
        track: { findMany: jest.Mock };
        trackTidal: { findMany: jest.Mock };
        trackYtMusic: { findMany: jest.Mock };
    };
};

const {
    getUserProviderProfile: mockGetUserProviderProfile,
    resolveQueueForUser: mockResolveQueueForUser,
} = jest.requireMock("../listenTogetherResolution") as {
    getUserProviderProfile: jest.Mock;
    resolveQueueForUser: jest.Mock;
};

type MappingRow = Parameters<
    typeof playlistTrackResolutionTestables.compareMappings
>[0];

function providerProfile(
    overrides: Partial<UserProviderProfile> = {}
): UserProviderProfile {
    return {
        userId: "user-1",
        hasLocal: true,
        hasTidal: false,
        hasYtMusic: false,
        ...overrides,
    };
}

function localTrack(
    overrides: Partial<UnifiedLocalTrackRecord> = {}
): UnifiedLocalTrackRecord {
    return {
        id: "local-1",
        title: "Local Track",
        duration: 180,
        album: {
            id: "album-1",
            title: "Album 1",
            coverArt: null,
            artist: {
                id: "artist-1",
                name: "Artist 1",
            },
        },
        ...overrides,
    };
}

function tidalTrack(
    overrides: Partial<UnifiedTrackTidalRecord> = {}
): UnifiedTrackTidalRecord {
    return {
        id: "tidal-1",
        tidalId: 101,
        title: "Tidal Track",
        artist: "Tidal Artist",
        album: "Tidal Album",
        duration: 200,
        ...overrides,
    };
}

function ytTrack(
    overrides: Partial<UnifiedTrackYtMusicRecord> = {}
): UnifiedTrackYtMusicRecord {
    return {
        id: "yt-1",
        videoId: "video-1",
        title: "YT Track",
        artist: "YT Artist",
        album: "YT Album",
        duration: 210,
        ...overrides,
    };
}

function playlistItem(
    overrides: Partial<UnifiedPlaylistItemRecord> = {}
): UnifiedPlaylistItemRecord {
    return {
        id: "item-1",
        playlistId: "playlist-1",
        trackId: null,
        trackTidalId: null,
        trackYtMusicId: null,
        sort: 0,
        track: null,
        trackTidal: null,
        trackYtMusic: null,
        ...overrides,
    };
}

function mapping(overrides: Partial<MappingRow> = {}): MappingRow {
    return {
        id: "map-1",
        source: "gap-fill",
        confidence: 0.8,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        trackId: null,
        trackTidalId: null,
        trackYtMusicId: null,
        ...overrides,
    };
}

describe("playlistTrackResolution", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockPrisma.trackMapping.findMany.mockResolvedValue([]);
        mockPrisma.track.findMany.mockResolvedValue([]);
        mockPrisma.trackTidal.findMany.mockResolvedValue([]);
        mockPrisma.trackYtMusic.findMany.mockResolvedValue([]);
        mockGetUserProviderProfile.mockResolvedValue(providerProfile());
        mockResolveQueueForUser.mockResolvedValue(new Map<number, ResolvedSource>());
    });

    it("returns an empty array for empty input", async () => {
        await expect(resolvePlaylistItemsForUser([], "user-1")).resolves.toEqual([]);

        expect(mockPrisma.trackMapping.findMany).not.toHaveBeenCalled();
        expect(mockGetUserProviderProfile).not.toHaveBeenCalled();
        expect(mockResolveQueueForUser).not.toHaveBeenCalled();
    });

    it("returns source priority for each mapping source", () => {
        expect(playlistTrackResolutionTestables.sourcePriority("manual")).toBe(4);
        expect(playlistTrackResolutionTestables.sourcePriority("isrc")).toBe(3);
        expect(playlistTrackResolutionTestables.sourcePriority("import-match")).toBe(2);
        expect(playlistTrackResolutionTestables.sourcePriority("gap-fill")).toBe(1);
        expect(playlistTrackResolutionTestables.sourcePriority("unknown")).toBe(0);
    });

    it("sorts mappings by source priority, confidence, date, and id", () => {
        const manual = mapping({ id: "map-manual", source: "manual", confidence: 0.2 });
        const isrcHighConfidence = mapping({
            id: "map-isrc-high",
            source: "isrc",
            confidence: 0.9,
        });
        const isrcNewer = mapping({
            id: "map-isrc-newer",
            source: "isrc",
            confidence: 0.7,
            createdAt: new Date("2024-02-01T00:00:00.000Z"),
        });
        const isrcSameDateLowId = mapping({
            id: "a-map",
            source: "isrc",
            confidence: 0.7,
            createdAt: new Date("2024-01-01T00:00:00.000Z"),
        });
        const isrcSameDateHighId = mapping({
            id: "z-map",
            source: "isrc",
            confidence: 0.7,
            createdAt: new Date("2024-01-01T00:00:00.000Z"),
        });

        expect([isrcHighConfidence, manual].sort(playlistTrackResolutionTestables.compareMappings)).toEqual([
            manual,
            isrcHighConfidence,
        ]);
        expect([isrcNewer, isrcHighConfidence].sort(playlistTrackResolutionTestables.compareMappings)).toEqual([
            isrcHighConfidence,
            isrcNewer,
        ]);
        expect([isrcSameDateLowId, isrcNewer].sort(playlistTrackResolutionTestables.compareMappings)).toEqual([
            isrcNewer,
            isrcSameDateLowId,
        ]);
        expect([isrcSameDateLowId, isrcSameDateHighId].sort(playlistTrackResolutionTestables.compareMappings)).toEqual([
            isrcSameDateHighId,
            isrcSameDateLowId,
        ]);
    });

    it("extracts all mapping tokens and item tokens", () => {
        expect(
            playlistTrackResolutionTestables.getMappingTokens(
                mapping({
                    trackId: "local-9",
                    trackTidalId: "tidal-9",
                    trackYtMusicId: "yt-9",
                })
            )
        ).toEqual(["l:local-9", "t:tidal-9", "y:yt-9"]);

        expect(
            playlistTrackResolutionTestables.getItemToken(
                playlistItem({ trackId: "local-item" })
            )
        ).toBe("l:local-item");
        expect(
            playlistTrackResolutionTestables.getItemToken(
                playlistItem({ trackId: null, trackTidalId: "tidal-item" })
            )
        ).toBe("t:tidal-item");
        expect(
            playlistTrackResolutionTestables.getItemToken(
                playlistItem({
                    trackId: null,
                    trackTidalId: null,
                    trackYtMusicId: "yt-item",
                })
            )
        ).toBe("y:yt-item");
        expect(playlistTrackResolutionTestables.getItemToken(playlistItem())).toBeNull();
    });

    it("prefers local mappings over remote mappings", () => {
        const preferred = playlistTrackResolutionTestables.selectPreferredMappingForItem(
            [
                mapping({
                    id: "map-remote",
                    source: "manual",
                    trackTidalId: "tidal-preferred-by-rank",
                }),
                mapping({
                    id: "map-local",
                    source: "gap-fill",
                    trackId: "local-preferred",
                }),
            ],
            providerProfile({ hasTidal: true, hasYtMusic: true })
        );

        expect(preferred?.id).toBe("map-local");
    });

    it("respects user provider profile when choosing tidal or youtube mappings", () => {
        const candidates = [
            mapping({
                id: "map-tidal",
                source: "manual",
                trackTidalId: "tidal-available",
            }),
            mapping({
                id: "map-yt",
                source: "isrc",
                trackYtMusicId: "yt-available",
            }),
        ];

        expect(
            playlistTrackResolutionTestables.selectPreferredMappingForItem(
                candidates,
                providerProfile({ hasTidal: true, hasYtMusic: false })
            )?.id
        ).toBe("map-tidal");
        expect(
            playlistTrackResolutionTestables.selectPreferredMappingForItem(
                candidates,
                providerProfile({ hasTidal: false, hasYtMusic: true })
            )?.id
        ).toBe("map-yt");
        expect(
            playlistTrackResolutionTestables.selectPreferredMappingForItem(
                candidates,
                providerProfile({ hasTidal: false, hasYtMusic: false })
            )
        ).toBeUndefined();
    });

    it("converts playlist items into resolution input with normalized duration", () => {
        const input = playlistTrackResolutionTestables.toResolutionInput(
            playlistItem({
                id: "item-duration",
                trackId: null,
                trackTidalId: "tidal-duration",
                trackYtMusicId: "yt-duration",
                track: null,
                trackTidal: tidalTrack({
                    id: "tidal-duration",
                    tidalId: 404,
                    duration: 199.8,
                }),
                trackYtMusic: ytTrack({
                    id: "yt-duration",
                    videoId: "  video-duration  ",
                    duration: 150,
                }),
            }),
            "map-duration"
        );

        expect(input).toEqual({
            id: "item-duration",
            duration: 199,
            localTrackId: undefined,
            trackMappingId: "map-duration",
            trackTidalId: "tidal-duration",
            trackYtMusicId: "yt-duration",
            tidalTrackId: 404,
            youtubeVideoId: "video-duration",
            originSource: "tidal",
        });
    });

    it("queries mappings using deduplicated source ids", async () => {
        const items = [
            playlistItem({ id: "item-local-1", trackId: "local-1" }),
            playlistItem({ id: "item-local-2", trackId: "local-1" }),
            playlistItem({ id: "item-tidal", trackTidalId: "tidal-1" }),
            playlistItem({ id: "item-yt", trackYtMusicId: "yt-1" }),
        ];

        await resolvePlaylistItemsForUser(items, "user-1");

        expect(mockPrisma.trackMapping.findMany).toHaveBeenCalledWith({
            where: {
                stale: false,
                OR: [
                    { trackId: { in: ["local-1"] } },
                    { trackTidalId: { in: ["tidal-1"] } },
                    { trackYtMusicId: { in: ["yt-1"] } },
                ],
            },
            select: {
                id: true,
                source: true,
                confidence: true,
                createdAt: true,
                trackId: true,
                trackTidalId: true,
                trackYtMusicId: true,
            },
        });
    });

    it("builds resolved items with effective track records", async () => {
        mockPrisma.trackMapping.findMany.mockResolvedValueOnce([
            mapping({
                id: "map-local",
                trackTidalId: "tidal-origin",
                trackId: "local-effective",
            }),
            mapping({
                id: "map-tidal",
                trackYtMusicId: "yt-origin",
                trackTidalId: "tidal-effective",
            }),
            mapping({
                id: "map-yt",
                trackId: "local-origin",
                trackYtMusicId: "yt-effective",
            }),
        ]);
        mockGetUserProviderProfile.mockResolvedValueOnce(
            providerProfile({ hasTidal: true, hasYtMusic: true })
        );
        mockResolveQueueForUser.mockResolvedValueOnce(
            new Map<number, ResolvedSource>([
                [0, { available: true, source: "local", trackId: "local-effective" }],
                [
                    1,
                    {
                        available: true,
                        source: "tidal",
                        tidalTrackId: 707,
                        trackTidalId: "tidal-effective",
                    },
                ],
                [
                    2,
                    {
                        available: true,
                        source: "youtube",
                        youtubeVideoId: "video-effective",
                        trackYtMusicId: "yt-effective",
                    },
                ],
            ])
        );
        mockPrisma.track.findMany.mockResolvedValueOnce([
            localTrack({ id: "local-effective", title: "Fetched Local" }),
        ]);
        mockPrisma.trackTidal.findMany.mockResolvedValueOnce([
            tidalTrack({
                id: "tidal-effective",
                tidalId: 707,
                title: "Fetched Tidal",
            }),
        ]);
        mockPrisma.trackYtMusic.findMany.mockResolvedValueOnce([
            ytTrack({
                id: "yt-effective",
                videoId: "video-effective",
                title: "Fetched YT",
            }),
        ]);

        const items = [
            playlistItem({
                id: "item-local",
                trackTidalId: "tidal-origin",
                trackTidal: tidalTrack({ id: "tidal-origin", tidalId: 111 }),
            }),
            playlistItem({
                id: "item-tidal",
                trackYtMusicId: "yt-origin",
                trackYtMusic: ytTrack({ id: "yt-origin", videoId: "video-origin" }),
            }),
            playlistItem({
                id: "item-yt",
                trackId: "local-origin",
                track: localTrack({ id: "local-origin", title: "Original Local" }),
            }),
        ];

        const resolved = await resolvePlaylistItemsForUser(items, "user-1");

        expect(mockResolveQueueForUser).toHaveBeenCalledWith(
            [
                expect.objectContaining<Partial<TrackResolutionInput>>({
                    id: "item-local",
                    trackMappingId: "map-local",
                }),
                expect.objectContaining<Partial<TrackResolutionInput>>({
                    id: "item-tidal",
                    trackMappingId: "map-tidal",
                }),
                expect.objectContaining<Partial<TrackResolutionInput>>({
                    id: "item-yt",
                    trackMappingId: "map-yt",
                }),
            ],
            "user-1"
        );

        expect(resolved).toEqual([
            {
                original: items[0],
                effective: expect.objectContaining({
                    trackId: "local-effective",
                    trackTidalId: null,
                    trackYtMusicId: null,
                    track: expect.objectContaining({ id: "local-effective" }),
                    trackTidal: null,
                    trackYtMusic: null,
                }),
                resolution: {
                    available: true,
                    source: "local",
                    trackId: "local-effective",
                },
            },
            {
                original: items[1],
                effective: expect.objectContaining({
                    trackId: null,
                    trackTidalId: "tidal-effective",
                    trackYtMusicId: null,
                    track: null,
                    trackTidal: expect.objectContaining({ id: "tidal-effective" }),
                    trackYtMusic: null,
                }),
                resolution: {
                    available: true,
                    source: "tidal",
                    tidalTrackId: 707,
                    trackTidalId: "tidal-effective",
                },
            },
            {
                original: items[2],
                effective: expect.objectContaining({
                    trackId: null,
                    trackTidalId: null,
                    trackYtMusicId: "yt-effective",
                    track: null,
                    trackTidal: null,
                    trackYtMusic: expect.objectContaining({ id: "yt-effective" }),
                }),
                resolution: {
                    available: true,
                    source: "youtube",
                    youtubeVideoId: "video-effective",
                    trackYtMusicId: "yt-effective",
                },
            },
        ]);
    });

    it("falls back to unavailable when resolved track records cannot be loaded", async () => {
        mockResolveQueueForUser.mockResolvedValueOnce(
            new Map<number, ResolvedSource>([
                [0, { available: true, source: "local", trackId: "missing-local" }],
                [
                    1,
                    {
                        available: true,
                        source: "tidal",
                        tidalTrackId: 909,
                        trackTidalId: "missing-tidal",
                    },
                ],
                [
                    2,
                    {
                        available: true,
                        source: "youtube",
                        youtubeVideoId: "missing-video",
                        trackYtMusicId: "missing-yt",
                    },
                ],
            ])
        );

        const items = [
            playlistItem({ id: "missing-local-item", trackId: "local-origin" }),
            playlistItem({ id: "missing-tidal-item", trackTidalId: "tidal-origin" }),
            playlistItem({ id: "missing-yt-item", trackYtMusicId: "yt-origin" }),
        ];

        const resolved = await resolvePlaylistItemsForUser(items, "user-1");

        expect(resolved).toEqual([
            {
                original: items[0],
                effective: items[0],
                resolution: { available: false, reason: "no-mapping" },
            },
            {
                original: items[1],
                effective: items[1],
                resolution: { available: false, reason: "no-mapping" },
            },
            {
                original: items[2],
                effective: items[2],
                resolution: { available: false, reason: "no-mapping" },
            },
        ]);
        expect(mockPrisma.track.findMany).toHaveBeenCalledWith({
            where: { id: { in: ["missing-local"] } },
            include: {
                album: {
                    include: {
                        artist: {
                            select: {
                                id: true,
                                name: true,
                                mbid: true,
                            },
                        },
                    },
                },
            },
        });
        expect(mockPrisma.trackTidal.findMany).toHaveBeenCalledWith({
            where: { id: { in: ["missing-tidal"] } },
        });
        expect(mockPrisma.trackYtMusic.findMany).toHaveBeenCalledWith({
            where: { id: { in: ["missing-yt"] } },
        });
    });
});
