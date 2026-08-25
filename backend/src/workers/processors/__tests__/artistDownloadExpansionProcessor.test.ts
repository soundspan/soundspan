const mockDownloadJobFindUnique = jest.fn();
const mockDownloadJobUpdate = jest.fn();
const mockAlbumFindFirst = jest.fn();
const mockTransaction = jest.fn();
const mockGetArtist = jest.fn();
const mockGetReleaseGroups = jest.fn();
const mockGetReleaseGroupsWithCredits = jest.fn();
const mockGetArtistCorrection = jest.fn();
const mockEnqueueAlbumDownloadInBackground = jest.fn();
const mockLogInfo = jest.fn();

jest.mock("../../../utils/db", () => ({
    prisma: {
        downloadJob: {
            findUnique: (...args: unknown[]) =>
                mockDownloadJobFindUnique(...args),
            update: (...args: unknown[]) => mockDownloadJobUpdate(...args),
        },
        album: {
            findFirst: (...args: unknown[]) => mockAlbumFindFirst(...args),
        },
        $transaction: (...args: unknown[]) => mockTransaction(...args),
    },
}));

jest.mock("../../../services/musicbrainz", () => ({
    musicBrainzService: {
        getArtist: (...args: unknown[]) => mockGetArtist(...args),
        getReleaseGroups: (...args: unknown[]) => mockGetReleaseGroups(...args),
        getReleaseGroupsWithCredits: (...args: unknown[]) =>
            mockGetReleaseGroupsWithCredits(...args),
    },
}));

jest.mock("../../../services/lastfm", () => ({
    lastFmService: {
        getArtistCorrection: (...args: unknown[]) =>
            mockGetArtistCorrection(...args),
    },
}));

jest.mock("../../../services/albumDownloadQueueService", () => ({
    enqueueAlbumDownloadInBackground: (...args: unknown[]) =>
        mockEnqueueAlbumDownloadInBackground(...args),
}));

jest.mock("../../../utils/logger", () => ({
    logger: {
        child: () => ({
            debug: jest.fn(),
            info: (...args: unknown[]) => mockLogInfo(...args),
            warn: jest.fn(),
            error: jest.fn(),
        }),
    },
}));

import { processArtistDownloadExpansion } from "../artistDownloadExpansionProcessor";

const payload = {
    jobId: "artist-job-1",
    artistMbid: "artist-mbid-1",
    artistName: "Alias Artist",
    downloadType: "library",
    rootFolderPath: "/music",
    userId: "user-1",
} as const;

function eligibleReleaseGroup(id: string, title: string) {
    return {
        id,
        title,
        "primary-type": "Album",
        "secondary-types": [],
        "artist-credit": [{ artist: { id: payload.artistMbid } }],
    };
}

function createJob() {
    return {
        data: payload,
        progress: jest.fn().mockResolvedValue(undefined),
    } as any;
}

function transactionResult(
    active: unknown[],
    recentFailed: unknown[],
    createdId?: string,
) {
    return async (operation: (transaction: any) => Promise<unknown>) =>
        operation({
            $queryRaw: jest
                .fn()
                .mockResolvedValueOnce(active)
                .mockResolvedValueOnce(recentFailed),
            downloadJob: {
                create: jest.fn(async ({ data }) => ({
                    id: createdId,
                    ...data,
                })),
            },
        });
}

describe("artist download expansion processor", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDownloadJobFindUnique.mockResolvedValue({
            metadata: { batchId: "batch-1", preserved: true },
        });
        mockDownloadJobUpdate.mockResolvedValue({});
        mockGetArtist.mockResolvedValue({ name: "Canonical Artist" });
        mockGetReleaseGroups.mockResolvedValue([]);
        mockGetReleaseGroupsWithCredits.mockResolvedValue([]);
        mockGetArtistCorrection.mockResolvedValue(null);
        mockAlbumFindFirst.mockResolvedValue(null);
        mockEnqueueAlbumDownloadInBackground.mockReturnValue(undefined);
    });

    it("skips local albums, keeps remote catalog albums, and records expansion counts", async () => {
        mockGetReleaseGroupsWithCredits.mockResolvedValue([
            eligibleReleaseGroup("rg-local", "Local Album"),
            eligibleReleaseGroup("rg-remote", "Remote Album"),
            eligibleReleaseGroup("rg-queued", "Queued Album"),
            eligibleReleaseGroup("rg-recent", "Recent Failure"),
            eligibleReleaseGroup("rg-new", "New Album"),
            {
                ...eligibleReleaseGroup("rg-single", "Featured Single"),
                "primary-type": "Single",
            },
            {
                ...eligibleReleaseGroup("rg-live", "Live Album"),
                "secondary-types": ["Live"],
            },
            {
                ...eligibleReleaseGroup("rg-featured", "I'm on One"),
                "artist-credit": [
                    { artist: { id: "artist-dj-khaled" } },
                    { artist: { id: payload.artistMbid } },
                ],
            },
            {
                ...eligibleReleaseGroup("rg-no-credits", "Unknown Credits"),
                "artist-credit": undefined,
            },
        ]);
        mockAlbumFindFirst.mockImplementation(({ where }) => {
            expect(where.location).toBe("LIBRARY");
            return Promise.resolve(
                where.rgMbid === "rg-local" ? { id: "local-album" } : null,
            );
        });
        mockTransaction
            .mockImplementationOnce(transactionResult([], [], "job-remote"))
            .mockImplementationOnce(
                transactionResult([{ id: "queued-job" }], []),
            )
            .mockImplementationOnce(
                transactionResult([], [{ id: "failed-job" }]),
            )
            .mockImplementationOnce(transactionResult([], [], "job-new"));

        const job = createJob();
        await processArtistDownloadExpansion(job);

        expect(mockGetReleaseGroupsWithCredits).toHaveBeenCalledWith(
            "artist-mbid-1",
            ["album", "ep"],
            100,
        );
        expect(mockGetReleaseGroups).not.toHaveBeenCalled();
        expect(mockEnqueueAlbumDownloadInBackground).toHaveBeenCalledTimes(2);
        expect(mockEnqueueAlbumDownloadInBackground).toHaveBeenCalledWith({
            jobId: "job-remote",
            type: "album",
            mbid: "rg-remote",
            subject: "Canonical Artist - Remote Album",
            artistName: "Canonical Artist",
            artistMbid: "artist-mbid-1",
            albumTitle: "Remote Album",
        });
        expect(mockEnqueueAlbumDownloadInBackground).toHaveBeenCalledWith({
            jobId: "job-new",
            type: "album",
            mbid: "rg-new",
            subject: "Canonical Artist - New Album",
            artistName: "Canonical Artist",
            artistMbid: "artist-mbid-1",
            albumTitle: "New Album",
        });
        expect(mockDownloadJobUpdate).toHaveBeenLastCalledWith({
            where: { id: "artist-job-1" },
            data: {
                status: "completed",
                completedAt: expect.any(Date),
                metadata: {
                    batchId: "batch-1",
                    preserved: true,
                    albumCount: 2,
                    skippedInLibrary: 1,
                    skippedQueued: 1,
                    skippedRecentlyFailed: 1,
                    skippedIneligible: 4,
                    filteredReasons: {
                        wrong_primary_type: 1,
                        secondary_type: 1,
                        not_primary_credit: 1,
                        missing_credits: 1,
                    },
                    statusText: "Queued 2 albums",
                },
            },
        });
        expect(job.progress).toHaveBeenNthCalledWith(1, 0);
        expect(job.progress).toHaveBeenNthCalledWith(2, 100);
        expect(mockLogInfo).toHaveBeenCalledTimes(1);
        expect(mockLogInfo).toHaveBeenCalledWith(
            "Artist expansion eligibility summarized",
            {
                artistMbid: "artist-mbid-1",
                total: 9,
                albumCount: 2,
                skippedInLibrary: 1,
                skippedQueued: 1,
                skippedRecentlyFailed: 1,
                skippedIneligible: 4,
                filteredReasons: {
                    wrong_primary_type: 1,
                    secondary_type: 1,
                    not_primary_credit: 1,
                    missing_credits: 1,
                },
            },
        );
    });

    it("persists batch metadata on each created album job", async () => {
        mockGetReleaseGroupsWithCredits.mockResolvedValue([
            eligibleReleaseGroup("rg-new", "New Album"),
        ]);
        const create = jest.fn().mockResolvedValue({ id: "job-new" });
        mockTransaction.mockImplementationOnce(async (operation: any) =>
            operation({
                $queryRaw: jest
                    .fn()
                    .mockResolvedValueOnce([])
                    .mockResolvedValueOnce([]),
                downloadJob: { create },
            }),
        );

        await processArtistDownloadExpansion(createJob());

        expect(create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                type: "album",
                targetMbid: "rg-new",
                metadata: expect.objectContaining({
                    queuedVia: "album-download-queue",
                    artistMbid: "artist-mbid-1",
                    batchId: "batch-1",
                    batchArtist: "Canonical Artist",
                }),
            }),
        });
    });

    it("marks the artist row failed when discography enumeration fails", async () => {
        const error = new Error("MusicBrainz unavailable");
        mockGetReleaseGroupsWithCredits.mockRejectedValueOnce(error);

        await expect(processArtistDownloadExpansion(createJob())).rejects.toBe(
            error,
        );

        expect(mockDownloadJobUpdate).toHaveBeenLastCalledWith({
            where: { id: "artist-job-1" },
            data: {
                status: "failed",
                error: "Artist expansion failed — see server logs",
                completedAt: expect.any(Date),
                metadata: {
                    batchId: "batch-1",
                    preserved: true,
                    statusText: "Artist expansion failed — see server logs",
                },
            },
        });
    });

    it("completes with zero albums when no release groups are missing", async () => {
        await processArtistDownloadExpansion(createJob());

        expect(mockEnqueueAlbumDownloadInBackground).not.toHaveBeenCalled();
        expect(mockDownloadJobUpdate).toHaveBeenLastCalledWith({
            where: { id: "artist-job-1" },
            data: {
                status: "completed",
                completedAt: expect.any(Date),
                metadata: {
                    batchId: "batch-1",
                    preserved: true,
                    albumCount: 0,
                    skippedInLibrary: 0,
                    skippedQueued: 0,
                    skippedRecentlyFailed: 0,
                    skippedIneligible: 0,
                    filteredReasons: {},
                    statusText: "No missing albums to download",
                },
            },
        });
    });

    it("uses Last.fm correction when canonical MusicBrainz lookup fails", async () => {
        mockGetArtist.mockRejectedValueOnce(new Error("lookup failed"));
        mockGetArtistCorrection.mockResolvedValueOnce({
            canonicalName: "Corrected Artist",
        });
        mockGetReleaseGroupsWithCredits.mockResolvedValue([
            eligibleReleaseGroup("rg-new", "Album"),
        ]);
        mockTransaction.mockImplementationOnce(
            transactionResult([], [], "job-new"),
        );

        await processArtistDownloadExpansion(createJob());

        expect(mockEnqueueAlbumDownloadInBackground).toHaveBeenCalledWith(
            expect.objectContaining({ artistName: "Corrected Artist" }),
        );
    });
});
