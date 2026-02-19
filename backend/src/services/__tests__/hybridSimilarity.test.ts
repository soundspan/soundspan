const mockQueryRaw = jest.fn();
const mockGetFeatures = jest.fn();
const mockLoggerDebug = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: {
        $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    },
}));

jest.mock("../featureDetection", () => ({
    featureDetection: {
        getFeatures: (...args: unknown[]) => mockGetFeatures(...args),
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: (...args: unknown[]) => mockLoggerDebug(...args),
        warn: (...args: unknown[]) => mockLoggerWarn(...args),
    },
}));

import { findSimilarTracks, type SimilarTrack } from "../hybridSimilarity";

function buildSimilarTrack(overrides: Partial<SimilarTrack> = {}): SimilarTrack {
    return {
        id: "track-2",
        title: "Candidate Track",
        distance: 0.12,
        similarity: 0.88,
        albumId: "album-1",
        albumTitle: "Album One",
        albumCoverUrl: "https://covers/album-1.jpg",
        artistId: "artist-1",
        artistName: "Artist One",
        ...overrides,
    };
}

describe("hybridSimilarity service", () => {
    beforeEach(() => {
        mockQueryRaw.mockReset();
        mockGetFeatures.mockReset();
        mockLoggerDebug.mockReset();
        mockLoggerWarn.mockReset();
    });

    it("uses hybrid mode when both feature systems are available", async () => {
        const sourceTrackId = "source-track-1";
        const limit = 7;
        const expected = [
            buildSimilarTrack({ id: "hybrid-track-1", similarity: 0.92 }),
            buildSimilarTrack({ id: "hybrid-track-2", similarity: 0.89 }),
        ];

        mockGetFeatures.mockResolvedValueOnce({
            vibeEmbeddings: true,
            musicCNN: true,
        });
        mockQueryRaw.mockResolvedValueOnce(expected);

        await expect(findSimilarTracks(sourceTrackId, limit)).resolves.toEqual(expected);

        expect(mockLoggerDebug).toHaveBeenCalledWith(
            `[HYBRID-SIMILARITY] Using hybrid mode for track ${sourceTrackId}`
        );
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);

        const queryArgs = mockQueryRaw.mock.calls[0] ?? [];
        expect(queryArgs).toContain(sourceTrackId);
        expect(queryArgs.filter((value: unknown) => value === limit * 5).length).toBeGreaterThanOrEqual(2);
        expect(mockLoggerWarn).not.toHaveBeenCalled();
    });

    it("uses CLAP-only mode and default limit when only vibe embeddings are available", async () => {
        const sourceTrackId = "source-track-2";
        const expected = [
            buildSimilarTrack({
                id: "clap-track-1",
                distance: 0.05,
                similarity: 0.95,
            }),
        ];

        mockGetFeatures.mockResolvedValueOnce({
            vibeEmbeddings: true,
            musicCNN: false,
        });
        mockQueryRaw.mockResolvedValueOnce(expected);

        await expect(findSimilarTracks(sourceTrackId)).resolves.toEqual(expected);

        expect(mockLoggerDebug).toHaveBeenCalledWith(
            `[HYBRID-SIMILARITY] Using CLAP-only mode for track ${sourceTrackId}`
        );
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);

        const queryArgs = mockQueryRaw.mock.calls[0] ?? [];
        expect(queryArgs).toContain(sourceTrackId);
        expect(queryArgs.filter((value: unknown) => value === 100)).toHaveLength(1);
    });

    it("uses features-only mode when CLAP embeddings are unavailable", async () => {
        const sourceTrackId = "source-track-3";
        const limit = 12;
        const expected = [
            buildSimilarTrack({
                id: "features-track-1",
                distance: 0,
                similarity: 0.82,
            }),
        ];

        mockGetFeatures.mockResolvedValueOnce({
            vibeEmbeddings: false,
            musicCNN: true,
        });
        mockQueryRaw.mockResolvedValueOnce(expected);

        await expect(findSimilarTracks(sourceTrackId, limit)).resolves.toEqual(expected);

        expect(mockLoggerDebug).toHaveBeenCalledWith(
            `[HYBRID-SIMILARITY] Using features-only mode for track ${sourceTrackId}`
        );
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);

        const queryArgs = mockQueryRaw.mock.calls[0] ?? [];
        expect(queryArgs).toContain(sourceTrackId);
        expect(queryArgs).toContain(limit * 5);
    });

    it("returns an empty list and warns when no feature systems are available", async () => {
        mockGetFeatures.mockResolvedValueOnce({
            vibeEmbeddings: false,
            musicCNN: false,
        });

        await expect(findSimilarTracks("source-track-4", 9)).resolves.toEqual([]);

        expect(mockQueryRaw).not.toHaveBeenCalled();
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "[HYBRID-SIMILARITY] No similarity features available"
        );
        expect(mockLoggerDebug).not.toHaveBeenCalled();
    });

    it("propagates feature-detection failures without querying prisma", async () => {
        const failure = new Error("feature detection unavailable");
        mockGetFeatures.mockRejectedValueOnce(failure);

        await expect(findSimilarTracks("source-track-5", 6)).rejects.toThrow(
            "feature detection unavailable"
        );

        expect(mockQueryRaw).not.toHaveBeenCalled();
        expect(mockLoggerDebug).not.toHaveBeenCalled();
        expect(mockLoggerWarn).not.toHaveBeenCalled();
    });

    it("propagates prisma query failures in hybrid mode", async () => {
        const sourceTrackId = "source-track-6";
        mockGetFeatures.mockResolvedValueOnce({
            vibeEmbeddings: true,
            musicCNN: true,
        });
        mockQueryRaw.mockRejectedValueOnce(new Error("hybrid query failed"));

        await expect(findSimilarTracks(sourceTrackId, 4)).rejects.toThrow(
            "hybrid query failed"
        );

        expect(mockLoggerDebug).toHaveBeenCalledWith(
            `[HYBRID-SIMILARITY] Using hybrid mode for track ${sourceTrackId}`
        );
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    });

    it("propagates prisma query failures in CLAP-only mode", async () => {
        const sourceTrackId = "source-track-7";
        mockGetFeatures.mockResolvedValueOnce({
            vibeEmbeddings: true,
            musicCNN: false,
        });
        mockQueryRaw.mockRejectedValueOnce(new Error("clap query failed"));

        await expect(findSimilarTracks(sourceTrackId, 10)).rejects.toThrow(
            "clap query failed"
        );

        expect(mockLoggerDebug).toHaveBeenCalledWith(
            `[HYBRID-SIMILARITY] Using CLAP-only mode for track ${sourceTrackId}`
        );
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    });

    it("propagates prisma query failures in features-only mode", async () => {
        const sourceTrackId = "source-track-8";
        mockGetFeatures.mockResolvedValueOnce({
            vibeEmbeddings: false,
            musicCNN: true,
        });
        mockQueryRaw.mockRejectedValueOnce(new Error("features query failed"));

        await expect(findSimilarTracks(sourceTrackId, 11)).rejects.toThrow(
            "features query failed"
        );

        expect(mockLoggerDebug).toHaveBeenCalledWith(
            `[HYBRID-SIMILARITY] Using features-only mode for track ${sourceTrackId}`
        );
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    });

    it("caps over-represented artists while still filling the requested limit", async () => {
        const sourceTrackId = "source-track-diversity";
        const limit = 6;
        mockGetFeatures.mockResolvedValueOnce({
            vibeEmbeddings: true,
            musicCNN: true,
        });
        mockQueryRaw.mockResolvedValueOnce([
            buildSimilarTrack({ id: "a-1", artistId: "artist-a", artistName: "Artist A" }),
            buildSimilarTrack({ id: "a-2", artistId: "artist-a", artistName: "Artist A" }),
            buildSimilarTrack({ id: "a-3", artistId: "artist-a", artistName: "Artist A" }),
            buildSimilarTrack({ id: "a-4", artistId: "artist-a", artistName: "Artist A" }),
            buildSimilarTrack({ id: "a-5", artistId: "artist-a", artistName: "Artist A" }),
            buildSimilarTrack({ id: "b-1", artistId: "artist-b", artistName: "Artist B" }),
            buildSimilarTrack({ id: "b-2", artistId: "artist-b", artistName: "Artist B" }),
            buildSimilarTrack({ id: "c-1", artistId: "artist-c", artistName: "Artist C" }),
            buildSimilarTrack({ id: "d-1", artistId: "artist-d", artistName: "Artist D" }),
        ]);

        const result = await findSimilarTracks(sourceTrackId, limit);
        const artistCounts = result.reduce<Record<string, number>>((acc, track) => {
            acc[track.artistId] = (acc[track.artistId] || 0) + 1;
            return acc;
        }, {});

        expect(result).toHaveLength(limit);
        expect(Math.max(...Object.values(artistCounts))).toBeLessThanOrEqual(2);
        expect(artistCounts["artist-a"]).toBe(2);
    });
});
