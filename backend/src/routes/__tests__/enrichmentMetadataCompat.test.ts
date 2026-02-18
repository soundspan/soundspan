import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
    requireAdmin: (_req: Request, _res: Response, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../services/enrichment", () => ({
    enrichmentService: {
        getSettings: jest.fn(),
        updateSettings: jest.fn(),
        enrichArtist: jest.fn(),
        applyArtistEnrichment: jest.fn(),
        enrichAlbum: jest.fn(),
        applyAlbumEnrichment: jest.fn(),
    },
}));

jest.mock("../../workers/unifiedEnrichment", () => ({
    getEnrichmentProgress: jest.fn(),
    runFullEnrichment: jest.fn(),
    reRunArtistsOnly: jest.fn(),
    reRunMoodTagsOnly: jest.fn(),
    reRunAudioAnalysisOnly: jest.fn(),
    reRunVibeEmbeddingsOnly: jest.fn(),
    triggerEnrichmentNow: jest.fn(),
}));

jest.mock("../../services/enrichmentState", () => ({
    enrichmentStateService: {
        getState: jest.fn(),
        pause: jest.fn(),
        resume: jest.fn(),
        stop: jest.fn(),
    },
}));

jest.mock("../../services/enrichmentFailureService", () => ({
    enrichmentFailureService: {
        getFailures: jest.fn(),
        getFailureCounts: jest.fn(),
        resetRetryCount: jest.fn(),
        getFailure: jest.fn(),
        resolveFailures: jest.fn(),
        skipFailures: jest.fn(),
        clearAllFailures: jest.fn(),
        deleteFailures: jest.fn(),
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
    invalidateSystemSettingsCache: jest.fn(),
}));

jest.mock("../../services/rateLimiter", () => ({
    rateLimiter: {
        updateConcurrencyMultiplier: jest.fn(),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        artist: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            update: jest.fn(),
        },
        album: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            update: jest.fn(),
        },
        track: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        systemSettings: {
            upsert: jest.fn(),
            findUnique: jest.fn(),
        },
        ownedAlbum: {
            deleteMany: jest.fn(),
            upsert: jest.fn(),
        },
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        del: jest.fn(),
    },
}));

import router from "../enrichment";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";

const mockArtistFindUnique = prisma.artist.findUnique as jest.Mock;
const mockArtistFindFirst = prisma.artist.findFirst as jest.Mock;
const mockArtistUpdate = prisma.artist.update as jest.Mock;
const mockAlbumFindUnique = prisma.album.findUnique as jest.Mock;
const mockAlbumFindFirst = prisma.album.findFirst as jest.Mock;
const mockAlbumUpdate = prisma.album.update as jest.Mock;
const mockTrackFindUnique = prisma.track.findUnique as jest.Mock;
const mockTrackUpdate = prisma.track.update as jest.Mock;
const mockOwnedAlbumDeleteMany = prisma.ownedAlbum.deleteMany as jest.Mock;
const mockOwnedAlbumUpsert = prisma.ownedAlbum.upsert as jest.Mock;
const mockRedisDel = redisClient.del as jest.Mock;

function getHandler(path: string, method: "get" | "put" | "post", stackIndex = 0) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path &&
            entry.route?.methods?.[method],
    );

    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }

    return layer.route.stack[stackIndex].handle;
}

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
    };

    return res;
}

describe("enrichment metadata compatibility", () => {
    const updateArtistHandler = getHandler("/artists/:id/metadata", "put");
    const updateTrackHandler = getHandler("/tracks/:id/metadata", "put");
    const updateAlbumHandler = getHandler("/albums/:id/metadata", "put");
    const resetTrackHandler = getHandler("/tracks/:id/reset", "post");
    const resetArtistHandler = getHandler("/artists/:id/reset", "post");
    const resetAlbumHandler = getHandler("/albums/:id/reset", "post");

    beforeEach(() => {
        jest.clearAllMocks();
        mockArtistFindFirst.mockResolvedValue(null);
        mockAlbumFindFirst.mockResolvedValue(null);
    });

    it("stores track metadata as non-destructive user overrides", async () => {
        mockTrackUpdate.mockResolvedValue({
            id: "track-1",
            displayTitle: "Renamed Track",
            displayTrackNo: 7,
        });

        const req = {
            params: { id: "track-1" },
            body: { title: "Renamed Track", trackNo: "7" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await updateTrackHandler(req, res);

        expect(mockTrackUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "track-1" },
                data: {
                    displayTitle: "Renamed Track",
                    displayTrackNo: 7,
                    hasUserOverrides: true,
                },
            }),
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({ id: "track-1", displayTrackNo: 7 }),
        );
    });

    it("persists artist MBID corrections alongside override fields", async () => {
        mockArtistFindUnique.mockResolvedValue({
            mbid: "old-artist-mbid",
        });
        mockArtistUpdate.mockResolvedValue({
            id: "artist-1",
            mbid: "550e8400-e29b-41d4-a716-446655440000",
            displayName: "Corrected Name",
            hasUserOverrides: true,
        });

        const req = {
            params: { id: "artist-1" },
            body: {
                name: "Corrected Name",
                mbid: "550e8400-e29b-41d4-a716-446655440000",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await updateArtistHandler(req, res);

        expect(mockArtistUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "artist-1" },
                data: expect.objectContaining({
                    displayName: "Corrected Name",
                    mbid: "550e8400-e29b-41d4-a716-446655440000",
                    hasUserOverrides: true,
                }),
            }),
        );
        expect(res.statusCode).toBe(200);
    });

    it("returns 409 when artist MBID conflicts with an existing artist", async () => {
        mockArtistFindUnique.mockResolvedValue({
            mbid: "old-artist-mbid",
        });
        mockArtistFindFirst.mockResolvedValue({ id: "artist-2" });

        const req = {
            params: { id: "artist-1" },
            body: {
                mbid: "550e8400-e29b-41d4-a716-446655440000",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await updateArtistHandler(req, res);

        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: "MusicBrainz ID is already used by another artist",
                code: "MBID_CONFLICT",
                field: "mbid",
            }),
        );
        expect(mockArtistUpdate).not.toHaveBeenCalled();
    });

    it("returns 400 when artist MBID format is invalid and value changed", async () => {
        mockArtistFindUnique.mockResolvedValue({
            mbid: "old-artist-mbid",
        });

        const req = {
            params: { id: "artist-1" },
            body: {
                mbid: "not-a-valid-mbid",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await updateArtistHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: "Invalid MusicBrainz ID format",
                code: "INVALID_MBID_FORMAT",
                field: "mbid",
            }),
        );
        expect(mockArtistUpdate).not.toHaveBeenCalled();
    });

    it("allows artist override edits when unchanged temporary MBID is present", async () => {
        mockArtistFindUnique.mockResolvedValue({
            mbid: "temp-artist-1",
        });
        mockArtistUpdate.mockResolvedValue({
            id: "artist-1",
            mbid: "temp-artist-1",
            displayName: "Edited Name",
            hasUserOverrides: true,
        });

        const req = {
            params: { id: "artist-1" },
            body: {
                name: "Edited Name",
                mbid: "temp-artist-1",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await updateArtistHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockArtistUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.not.objectContaining({
                    mbid: "temp-artist-1",
                }),
            }),
        );
    });

    it("converts album year input into numeric override value", async () => {
        mockAlbumUpdate.mockResolvedValue({
            id: "album-1",
            displayTitle: "Display Album",
            displayYear: 1999,
            userCoverUrl: "https://example.com/cover.jpg",
        });

        const req = {
            params: { id: "album-1" },
            body: {
                title: "Display Album",
                year: "1999",
                coverUrl: "https://example.com/cover.jpg",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await updateAlbumHandler(req, res);

        expect(mockAlbumUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "album-1" },
                data: {
                    displayTitle: "Display Album",
                    displayYear: 1999,
                    userCoverUrl: "https://example.com/cover.jpg",
                    hasUserOverrides: true,
                },
            }),
        );
        expect(res.statusCode).toBe(200);
    });

    it("updates OwnedAlbum mapping when album release-group MBID is corrected", async () => {
        const originalRgMbid = "11111111-1111-4111-8111-111111111111";
        const updatedRgMbid = "22222222-2222-4222-8222-222222222222";
        mockAlbumFindUnique.mockResolvedValue({
            artistId: "artist-1",
            rgMbid: originalRgMbid,
            location: "LIBRARY",
        });
        mockOwnedAlbumDeleteMany.mockResolvedValue({ count: 1 });
        mockOwnedAlbumUpsert.mockResolvedValue({});
        mockAlbumUpdate.mockResolvedValue({
            id: "album-1",
            rgMbid: updatedRgMbid,
            displayTitle: "Album",
        });

        const req = {
            params: { id: "album-1" },
            body: {
                rgMbid: updatedRgMbid,
                title: "Album",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await updateAlbumHandler(req, res);

        expect(mockAlbumFindUnique).toHaveBeenCalledWith({
            where: { id: "album-1" },
            select: { artistId: true, rgMbid: true, location: true },
        });
        expect(mockOwnedAlbumDeleteMany).toHaveBeenCalledWith({
            where: { artistId: "artist-1", rgMbid: originalRgMbid },
        });
        expect(mockOwnedAlbumUpsert).toHaveBeenCalledWith({
            where: {
                artistId_rgMbid: {
                    artistId: "artist-1",
                    rgMbid: updatedRgMbid,
                },
            },
            create: {
                artistId: "artist-1",
                rgMbid: updatedRgMbid,
                source: "metadata_edit",
            },
            update: {},
        });
        expect(mockAlbumUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ rgMbid: updatedRgMbid }),
            }),
        );
        expect(res.statusCode).toBe(200);
    });

    it("returns 409 when album release-group MBID conflicts with another album", async () => {
        const originalRgMbid = "11111111-1111-4111-8111-111111111111";
        const conflictingRgMbid = "33333333-3333-4333-8333-333333333333";
        mockAlbumFindUnique.mockResolvedValue({
            artistId: "artist-1",
            rgMbid: originalRgMbid,
            location: "LIBRARY",
        });
        mockAlbumFindFirst.mockResolvedValue({ id: "album-2" });

        const req = {
            params: { id: "album-1" },
            body: {
                rgMbid: conflictingRgMbid,
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await updateAlbumHandler(req, res);

        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: "Release-group MBID is already used by another album",
                code: "RG_MBID_CONFLICT",
                field: "rgMbid",
            }),
        );
        expect(mockOwnedAlbumDeleteMany).not.toHaveBeenCalled();
        expect(mockOwnedAlbumUpsert).not.toHaveBeenCalled();
        expect(mockAlbumUpdate).not.toHaveBeenCalled();
    });

    it("returns 400 when album release-group MBID format is invalid and value changed", async () => {
        mockAlbumFindUnique.mockResolvedValue({
            artistId: "artist-1",
            rgMbid: "old-rg",
            location: "LIBRARY",
        });

        const req = {
            params: { id: "album-1" },
            body: {
                rgMbid: "not-a-valid-rg-mbid",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await updateAlbumHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: "Invalid release-group MBID format",
                code: "INVALID_RG_MBID_FORMAT",
                field: "rgMbid",
            }),
        );
        expect(mockAlbumUpdate).not.toHaveBeenCalled();
    });

    it("does not remap owned-album relationships when release-group MBID is unchanged", async () => {
        const existing = {
            artistId: "artist-1",
            rgMbid: "11111111-1111-4111-8111-111111111111",
            location: "LIBRARY",
        };
        mockAlbumFindUnique.mockResolvedValueOnce(existing);
        mockAlbumUpdate.mockResolvedValueOnce({
            id: "album-1",
            displayTitle: "Album Name",
            rgMbid: existing.rgMbid,
            hasUserOverrides: true,
        });

        const req = {
            params: { id: "album-1" },
            body: {
                title: "Album Name",
                rgMbid: existing.rgMbid,
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await updateAlbumHandler(req, res);

        expect(mockAlbumFindUnique).toHaveBeenCalledWith({
            where: { id: "album-1" },
            select: { artistId: true, rgMbid: true, location: true },
        });
        expect(mockAlbumFindFirst).not.toHaveBeenCalled();
        expect(mockOwnedAlbumDeleteMany).not.toHaveBeenCalled();
        expect(mockOwnedAlbumUpsert).not.toHaveBeenCalled();
        expect(mockAlbumUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "album-1" },
                data: expect.objectContaining({
                    displayTitle: "Album Name",
                    hasUserOverrides: true,
                }),
            })
        );
        expect(res.statusCode).toBe(200);
    });

    it("treats non-string release-group MBID as no canonical MBID change", async () => {
        mockAlbumUpdate.mockResolvedValueOnce({
            id: "album-2",
            displayTitle: "Non-String MBID",
            hasUserOverrides: true,
        });

        const req = {
            params: { id: "album-2" },
            body: {
                title: "Non-String MBID",
                rgMbid: 123,
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await updateAlbumHandler(req, res);

        expect(mockAlbumFindUnique).not.toHaveBeenCalled();
        expect(mockAlbumFindFirst).not.toHaveBeenCalled();
        expect(mockAlbumUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "album-2" },
                data: {
                    displayTitle: "Non-String MBID",
                    hasUserOverrides: true,
                },
            })
        );
        expect(res.statusCode).toBe(200);
    });

    it("treats whitespace-only release-group MBID as no canonical MBID change", async () => {
        mockAlbumUpdate.mockResolvedValue({
            id: "album-1",
            displayTitle: "Space Album",
            hasUserOverrides: true,
        });

        const req = {
            params: { id: "album-1" },
            body: {
                title: "Space Album",
                rgMbid: "   ",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await updateAlbumHandler(req, res);

        expect(mockAlbumFindUnique).not.toHaveBeenCalled();
        expect(mockOwnedAlbumDeleteMany).not.toHaveBeenCalled();
        expect(mockOwnedAlbumUpsert).not.toHaveBeenCalled();
        expect(mockAlbumUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "album-1" },
                data: expect.objectContaining({
                    displayTitle: "Space Album",
                    hasUserOverrides: true,
                }),
            })
        );
        expect(res.statusCode).toBe(200);
    });

    it("returns 404 when resetting metadata for a missing track", async () => {
        mockTrackFindUnique.mockResolvedValue(null);

        const req = {
            params: { id: "missing-track" },
            body: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await resetTrackHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({
            error: "Track not found",
            message: "The track may have been deleted",
        });
        expect(mockTrackUpdate).not.toHaveBeenCalled();
    });

    it("clears artist overrides and invalidates hero cache on reset", async () => {
        mockArtistFindUnique.mockResolvedValue({ id: "artist-1" });
        mockArtistUpdate.mockResolvedValue({
            id: "artist-1",
            displayName: null,
            hasUserOverrides: false,
        });

        const req = {
            params: { id: "artist-1" },
            body: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await resetArtistHandler(req, res);

        expect(mockArtistUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "artist-1" },
                data: expect.objectContaining({
                    displayName: null,
                    userSummary: null,
                    userHeroUrl: null,
                    userGenres: [],
                    hasUserOverrides: false,
                }),
            }),
        );
        expect(mockRedisDel).toHaveBeenCalledWith("hero:artist-1");
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                message: "Artist metadata reset to original values",
            }),
        );
    });

    it("resets album override fields without touching canonical rgMbid", async () => {
        mockAlbumFindUnique.mockResolvedValue({ id: "album-1" });
        mockAlbumUpdate.mockResolvedValue({
            id: "album-1",
            displayTitle: null,
            displayYear: null,
            userCoverUrl: null,
            userGenres: [],
            hasUserOverrides: false,
        });

        const req = {
            params: { id: "album-1" },
            body: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await resetAlbumHandler(req, res);

        expect(mockAlbumUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "album-1" },
                data: {
                    displayTitle: null,
                    displayYear: null,
                    userCoverUrl: null,
                    userGenres: [],
                    hasUserOverrides: false,
                },
            }),
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                message: "Album metadata reset to original values",
            }),
        );
    });
});
