const mockPrisma = {
    userSettings: {
        findUnique: jest.fn(),
    },
    systemSettings: {
        findUnique: jest.fn(),
    },
    trackMapping: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
    },
    trackTidal: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
    },
    trackYtMusic: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
    },
};

jest.mock("../../utils/db", () => ({
    prisma: mockPrisma,
}));

import {
    getUserProviderProfile,
    resolveTrackForUser,
} from "../listenTogetherResolution";
import type { SyncQueueItem } from "../listenTogetherManager";

function queueItem(overrides: Partial<SyncQueueItem> = {}): SyncQueueItem {
    return {
        id: "track-1",
        title: "Track 1",
        duration: 180,
        artist: { id: "artist-1", name: "Artist 1" },
        album: { id: "album-1", title: "Album 1", coverArt: null },
        ...overrides,
    };
}

describe("listenTogetherResolution", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
            ytMusicEnabled: true,
        });
    });

    it("returns local when queue item has localTrackId", async () => {
        const profile = {
            userId: "user-1",
            hasLocal: true as const,
            hasTidal: true,
            hasYtMusic: true,
        };

        const resolved = await resolveTrackForUser(
            queueItem({ localTrackId: "local-1" }),
            profile
        );
        expect(resolved).toEqual({
            available: true,
            source: "local",
            trackId: "local-1",
        });
    });

    it("falls back to youtube mapping for users without tidal", async () => {
        const profile = {
            userId: "user-1",
            hasLocal: true as const,
            hasTidal: false,
            hasYtMusic: true,
        };
        const mapping = {
            id: "map-1",
            stale: false,
            confidence: 0.92,
            trackId: null,
            trackTidal: {
                id: "tt-1",
                tidalId: 123,
                duration: 181,
            },
            trackYtMusic: {
                id: "yt-1",
                videoId: "vid-1",
                duration: 182,
            },
        };

        const resolved = await resolveTrackForUser(
            queueItem({ trackMappingId: "map-1" }),
            profile,
            { mappingsById: new Map([["map-1", mapping]]) }
        );
        expect(resolved).toEqual({
            available: true,
            source: "youtube",
            youtubeVideoId: "vid-1",
            trackYtMusicId: "yt-1",
        });
    });

    it("marks low-confidence mappings unavailable", async () => {
        const profile = {
            userId: "user-1",
            hasLocal: true as const,
            hasTidal: true,
            hasYtMusic: true,
        };
        const mapping = {
            id: "map-low",
            stale: false,
            confidence: 0.5,
            trackId: null,
            trackTidal: {
                id: "tt-low",
                tidalId: 555,
                duration: 180,
            },
            trackYtMusic: null,
        };

        const resolved = await resolveTrackForUser(
            queueItem({ trackMappingId: "map-low" }),
            profile,
            { mappingsById: new Map([["map-low", mapping]]) }
        );
        expect(resolved).toEqual({
            available: false,
            reason: "low-confidence",
        });
    });

    it("marks duration mismatches unavailable", async () => {
        const profile = {
            userId: "user-1",
            hasLocal: true as const,
            hasTidal: true,
            hasYtMusic: false,
        };
        const mapping = {
            id: "map-duration",
            stale: false,
            confidence: 0.91,
            trackId: null,
            trackTidal: {
                id: "tt-duration",
                tidalId: 777,
                duration: 240,
            },
            trackYtMusic: null,
        };

        const resolved = await resolveTrackForUser(
            queueItem({ trackMappingId: "map-duration", duration: 180 }),
            profile,
            { mappingsById: new Map([["map-duration", mapping]]) }
        );
        expect(resolved).toEqual({
            available: false,
            reason: "duration-mismatch",
        });
    });

    it("returns no-provider for direct tidal refs when user has no tidal connection", async () => {
        const profile = {
            userId: "user-1",
            hasLocal: true as const,
            hasTidal: false,
            hasYtMusic: false,
        };

        const resolved = await resolveTrackForUser(
            queueItem({ trackTidalId: "tt-direct", tidalTrackId: 444 }),
            profile
        );
        expect(resolved).toEqual({
            available: false,
            reason: "no-provider",
        });
    });

    it("falls back to youtube via cross-provider mapping when tidal unavailable", async () => {
        const profile = {
            userId: "user-1",
            hasLocal: true as const,
            hasTidal: false,
            hasYtMusic: true,
        };

        mockPrisma.trackMapping.findFirst.mockResolvedValueOnce({
            confidence: 0.9,
            trackYtMusic: {
                id: "yt-cross",
                videoId: "cross-vid",
                duration: 182,
            },
        });

        const resolved = await resolveTrackForUser(
            queueItem({ trackTidalId: "tt-direct", tidalTrackId: 444 }),
            profile
        );
        expect(resolved).toEqual({
            available: true,
            source: "youtube",
            youtubeVideoId: "cross-vid",
            trackYtMusicId: "yt-cross",
        });
        expect(mockPrisma.trackMapping.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    stale: false,
                    trackTidalId: "tt-direct",
                    trackYtMusicId: { not: null },
                }),
            })
        );
    });

    it("returns no-provider for direct tidal refs when no cross-provider match exists", async () => {
        const profile = {
            userId: "user-1",
            hasLocal: true as const,
            hasTidal: false,
            hasYtMusic: true,
        };

        mockPrisma.trackMapping.findFirst.mockResolvedValueOnce(null);

        const resolved = await resolveTrackForUser(
            queueItem({ trackTidalId: "tt-orphan", tidalTrackId: 555 }),
            profile
        );
        expect(resolved).toEqual({
            available: false,
            reason: "no-provider",
        });
    });

    it("falls back to tidal via cross-provider mapping when youtube unavailable", async () => {
        const profile = {
            userId: "user-1",
            hasLocal: true as const,
            hasTidal: true,
            hasYtMusic: false,
        };

        mockPrisma.trackMapping.findFirst.mockResolvedValueOnce({
            confidence: 0.88,
            trackTidal: {
                id: "tt-cross",
                tidalId: 999,
                duration: 181,
            },
        });

        const resolved = await resolveTrackForUser(
            queueItem({ trackYtMusicId: "yt-direct", youtubeVideoId: "vid-direct" }),
            profile
        );
        expect(resolved).toEqual({
            available: true,
            source: "tidal",
            tidalTrackId: 999,
            trackTidalId: "tt-cross",
        });
        expect(mockPrisma.trackMapping.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    stale: false,
                    trackYtMusicId: "yt-direct",
                    trackTidalId: { not: null },
                }),
            })
        );
    });

    it("marks youtube as available even when user oauth token is absent", async () => {
        mockPrisma.userSettings.findUnique.mockResolvedValueOnce({
            tidalOAuthJson: "tidal-token",
            ytMusicOAuthJson: null,
        });

        const profile = await getUserProviderProfile("user-abc");
        expect(profile).toEqual({
            userId: "user-abc",
            hasLocal: true,
            hasTidal: true,
            hasYtMusic: true,
        });
    });

    it("marks youtube unavailable when globally disabled", async () => {
        mockPrisma.userSettings.findUnique.mockResolvedValueOnce({
            tidalOAuthJson: "tidal-token",
        });
        mockPrisma.systemSettings.findUnique.mockResolvedValueOnce({
            ytMusicEnabled: false,
        });

        const profile = await getUserProviderProfile("user-disabled");
        expect(profile).toEqual({
            userId: "user-disabled",
            hasLocal: true,
            hasTidal: true,
            hasYtMusic: false,
        });
    });
});
