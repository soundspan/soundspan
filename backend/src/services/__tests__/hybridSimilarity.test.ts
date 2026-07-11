const mockQueryRaw = jest.fn();
const mockRunAnnQuery = jest.fn();
const mockGetFeatures = jest.fn();
const mockLoggerDebug = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: {
        $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    },
}));

// The ANN sites (hybrid + CLAP-only modes) route through the F14 helper, which
// owns the transaction-scoped ivfflat.probes. We mock it at that boundary and
// feed canned candidate rows, so these tests assert findSimilarTracks BEHAVIOUR
// (mode chosen, rows returned/ranked, artist-diversity cap) rather than SQL or
// call shapes. The helper's own transaction/set_config contract is covered by
// src/utils/__tests__/annQuery.test.ts. features-only mode is non-ANN and still
// goes straight through prisma.$queryRaw.
jest.mock("../../utils/annQuery", () => ({
    runAnnQuery: (...args: unknown[]) => mockRunAnnQuery(...args),
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
        duration: 240,
        distance: 0.12,
        similarity: 0.88,
        albumId: "album-1",
        albumTitle: "Album One",
        albumCoverUrl: "https://covers/album-1.jpg",
        artistId: "artist-1",
        artistName: "Artist One",
        energy: null,
        valence: null,
        danceability: null,
        arousal: null,
        ...overrides,
    };
}

describe("hybridSimilarity service", () => {
    beforeEach(() => {
        mockQueryRaw.mockReset();
        mockRunAnnQuery.mockReset();
        mockGetFeatures.mockReset();
        mockLoggerDebug.mockReset();
        mockLoggerWarn.mockReset();
    });

    it("uses hybrid mode (via the ANN helper) when both feature systems are available", async () => {
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
        mockRunAnnQuery.mockResolvedValueOnce(expected);

        await expect(findSimilarTracks(sourceTrackId, limit)).resolves.toEqual(expected);

        expect(mockLoggerDebug).toHaveBeenCalledWith(
            `[HYBRID-SIMILARITY] Using hybrid mode for track ${sourceTrackId}`
        );
        // Hybrid mode is ANN: it goes through the probes-applying helper, once,
        // and never through the bare prisma.$queryRaw path.
        expect(mockRunAnnQuery).toHaveBeenCalledTimes(1);
        expect(mockQueryRaw).not.toHaveBeenCalled();

        // The right values reached the query: the Prisma.Sql passed to the
        // helper binds the source trackId and the 5x candidate limit (which
        // appears twice — the candidate CTE's LIMIT and the outer LIMIT).
        const sqlArg = mockRunAnnQuery.mock.calls[0]?.[0] as { values: unknown[] };
        expect(sqlArg.values).toContain(sourceTrackId);
        expect(
            sqlArg.values.filter((value: unknown) => value === limit * 5).length
        ).toBeGreaterThanOrEqual(2);
        expect(mockLoggerWarn).not.toHaveBeenCalled();
    });

    it("uses CLAP-only mode (via the ANN helper) when only vibe embeddings are available", async () => {
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
        mockRunAnnQuery.mockResolvedValueOnce(expected);

        // No explicit limit -> default of 20 flows through to a returned result.
        await expect(findSimilarTracks(sourceTrackId)).resolves.toEqual(expected);

        expect(mockLoggerDebug).toHaveBeenCalledWith(
            `[HYBRID-SIMILARITY] Using CLAP-only mode for track ${sourceTrackId}`
        );
        expect(mockRunAnnQuery).toHaveBeenCalledTimes(1);
        expect(mockQueryRaw).not.toHaveBeenCalled();

        // Default limit 20 -> candidate limit 100, bound exactly once (the
        // LIMIT), alongside the source trackId.
        const sqlArg = mockRunAnnQuery.mock.calls[0]?.[0] as { values: unknown[] };
        expect(sqlArg.values).toContain(sourceTrackId);
        expect(sqlArg.values.filter((value: unknown) => value === 100)).toHaveLength(1);
    });

    it("uses features-only mode (non-ANN, direct query) when CLAP embeddings are unavailable", async () => {
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
        // features-only has no ANN, so it must NOT go through the probes helper.
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
        expect(mockRunAnnQuery).not.toHaveBeenCalled();

        // The right values reached the tagged-template query: its bound args
        // carry the source trackId and the 5x candidate limit.
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

        expect(mockRunAnnQuery).not.toHaveBeenCalled();
        expect(mockQueryRaw).not.toHaveBeenCalled();
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "[HYBRID-SIMILARITY] No similarity features available"
        );
        expect(mockLoggerDebug).not.toHaveBeenCalled();
    });

    it("propagates feature-detection failures without querying", async () => {
        const failure = new Error("feature detection unavailable");
        mockGetFeatures.mockRejectedValueOnce(failure);

        await expect(findSimilarTracks("source-track-5", 6)).rejects.toThrow(
            "feature detection unavailable"
        );

        expect(mockRunAnnQuery).not.toHaveBeenCalled();
        expect(mockQueryRaw).not.toHaveBeenCalled();
        expect(mockLoggerDebug).not.toHaveBeenCalled();
        expect(mockLoggerWarn).not.toHaveBeenCalled();
    });

    it("propagates ANN query failures in hybrid mode", async () => {
        const sourceTrackId = "source-track-6";
        mockGetFeatures.mockResolvedValueOnce({
            vibeEmbeddings: true,
            musicCNN: true,
        });
        mockRunAnnQuery.mockRejectedValueOnce(new Error("hybrid query failed"));

        await expect(findSimilarTracks(sourceTrackId, 4)).rejects.toThrow(
            "hybrid query failed"
        );

        expect(mockLoggerDebug).toHaveBeenCalledWith(
            `[HYBRID-SIMILARITY] Using hybrid mode for track ${sourceTrackId}`
        );
        expect(mockRunAnnQuery).toHaveBeenCalledTimes(1);
    });

    it("propagates ANN query failures in CLAP-only mode", async () => {
        const sourceTrackId = "source-track-7";
        mockGetFeatures.mockResolvedValueOnce({
            vibeEmbeddings: true,
            musicCNN: false,
        });
        mockRunAnnQuery.mockRejectedValueOnce(new Error("clap query failed"));

        await expect(findSimilarTracks(sourceTrackId, 10)).rejects.toThrow(
            "clap query failed"
        );

        expect(mockLoggerDebug).toHaveBeenCalledWith(
            `[HYBRID-SIMILARITY] Using CLAP-only mode for track ${sourceTrackId}`
        );
        expect(mockRunAnnQuery).toHaveBeenCalledTimes(1);
    });

    it("propagates query failures in features-only mode", async () => {
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
        mockRunAnnQuery.mockResolvedValueOnce([
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

    it("handles candidates with missing artistId using unknown track fallback keys", async () => {
        const sourceTrackId = "source-track-missing-artist";
        mockGetFeatures.mockResolvedValueOnce({
            vibeEmbeddings: true,
            musicCNN: true,
        });
        mockRunAnnQuery.mockResolvedValueOnce([
            buildSimilarTrack({
                id: "missing-artist-1",
                artistId: "" as unknown as string,
                artistName: "Unknown Artist 1",
            }),
            buildSimilarTrack({
                id: "missing-artist-2",
                artistId: "" as unknown as string,
                artistName: "Unknown Artist 2",
            }),
            buildSimilarTrack({
                id: "artist-b-1",
                artistId: "artist-b",
                artistName: "Artist B",
            }),
        ]);

        const result = await findSimilarTracks(sourceTrackId, 3);

        expect(result).toHaveLength(3);
        expect(result.map((track) => track.id)).toEqual([
            "missing-artist-1",
            "missing-artist-2",
            "artist-b-1",
        ]);
    });

    it("uses unknown artist fallback keys during overflow rebalancing", async () => {
        const sourceTrackId = "source-track-missing-artist-overflow";
        const limit = 6;
        mockGetFeatures.mockResolvedValueOnce({
            vibeEmbeddings: true,
            musicCNN: true,
        });
        mockRunAnnQuery.mockResolvedValueOnce([
            buildSimilarTrack({ id: "artist-a-1", artistId: "artist-a", artistName: "Artist A" }),
            buildSimilarTrack({ id: "artist-a-2", artistId: "artist-a", artistName: "Artist A" }),
            buildSimilarTrack({ id: "artist-a-3", artistId: "artist-a", artistName: "Artist A" }),
            buildSimilarTrack({ id: "artist-a-4", artistId: "artist-a", artistName: "Artist A" }),
            buildSimilarTrack({
                id: "missing-artist-overflow",
                artistId: "" as unknown as string,
                artistName: "Unknown Artist",
            }),
            buildSimilarTrack({ id: "artist-b-1", artistId: "artist-b", artistName: "Artist B" }),
        ]);

        const result = await findSimilarTracks(sourceTrackId, limit);

        expect(result).toHaveLength(limit);
        expect(result.map((track) => track.id)).toContain("missing-artist-overflow");
    });
});
