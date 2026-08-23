const mockCreateAlbumDownloadJob = jest.fn();
const mockResolveAlbumDownloadArtistName = jest.fn();
const mockGetSystemSettings = jest.fn();
const mockRecordMusicRequestAction = jest.fn();
const mockNotifyRequestSubmitted = jest.fn();
const mockNotifyRequestApproved = jest.fn();
const mockNotifyRequestDenied = jest.fn();
const mockNotifyRequestFulfilled = jest.fn();

const prisma = {
    album: { findFirst: jest.fn(), findMany: jest.fn() },
    artist: { findMany: jest.fn() },
    downloadJob: { findFirst: jest.fn() },
    musicRequest: {
        count: jest.fn(),
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
    },
    user: { findMany: jest.fn(), findUnique: jest.fn() },
    $transaction: jest.fn(),
};

jest.mock("../../utils/db", () => ({ prisma }));
jest.mock("../../config", () => ({
    config: {
        music: { musicPath: "/music" },
        requests: { dailyCapPerUser: 10 },
    },
}));
jest.mock("../albumDownloadJobs", () => ({
    createAlbumDownloadJob: (...args: unknown[]) =>
        mockCreateAlbumDownloadJob(...args),
    resolveAlbumDownloadArtistName: (...args: unknown[]) =>
        mockResolveAlbumDownloadArtistName(...args),
}));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: (...args: unknown[]) => mockGetSystemSettings(...args),
}));
jest.mock("../../metrics", () => ({
    recordMusicRequestAction: (...args: unknown[]) =>
        mockRecordMusicRequestAction(...args),
}));
jest.mock("../notificationService", () => ({
    notificationService: {
        notifyRequestSubmitted: (...args: unknown[]) =>
            mockNotifyRequestSubmitted(...args),
        notifyRequestApproved: (...args: unknown[]) =>
            mockNotifyRequestApproved(...args),
        notifyRequestDenied: (...args: unknown[]) =>
            mockNotifyRequestDenied(...args),
        notifyRequestFulfilled: (...args: unknown[]) =>
            mockNotifyRequestFulfilled(...args),
    },
}));
jest.mock("../../utils/logger", () => ({
    logger: {
        child: () => ({
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        }),
    },
}));

import {
    approveRequest,
    cancelOwnRequest,
    createRequest,
    denyRequest,
    listAllRequests,
    listRequestsForUser,
    MusicRequestServiceError,
} from "../musicRequestService";

const input = {
    artistName: "Massive Attack",
    albumTitle: "Mezzanine",
    artistMbid: "10adbeaa-cdf8-4435-b6f1-14b76af17c34",
    rgMbid: "4f9d25d1-32c2-4093-83a5-34fcbaaf6f25",
    note: "  Please add this  ",
};

const pendingRequest = {
    id: "request-1",
    userId: "user-1",
    type: "album",
    status: "pending",
    artistName: input.artistName,
    albumTitle: input.albumTitle,
    artistMbid: input.artistMbid,
    rgMbid: input.rgMbid,
    note: "Please add this",
};

async function expectCreateError(code: string): Promise<void> {
    await expect(createRequest("user-1", input)).rejects.toMatchObject({
        code,
    });
}

describe("musicRequestService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.album.findFirst.mockResolvedValue(null);
        prisma.album.findMany.mockResolvedValue([]);
        prisma.artist.findMany.mockResolvedValue([]);
        prisma.musicRequest.findFirst.mockResolvedValue(null);
        prisma.downloadJob.findFirst.mockResolvedValue(null);
        prisma.musicRequest.count.mockResolvedValue(0);
        prisma.musicRequest.create.mockResolvedValue(pendingRequest);
        prisma.musicRequest.findMany.mockResolvedValue([]);
        prisma.musicRequest.findUnique.mockResolvedValue(pendingRequest);
        prisma.musicRequest.updateMany.mockResolvedValue({ count: 1 });
        prisma.musicRequest.update.mockResolvedValue({
            ...pendingRequest,
            status: "approved",
            downloadJobId: "job-1",
        });
        prisma.user.findUnique.mockResolvedValue({ username: "listener" });
        prisma.user.findMany.mockResolvedValue([{ id: "admin-1" }]);
        mockGetSystemSettings.mockResolvedValue({ musicPath: "/library" });
        mockCreateAlbumDownloadJob.mockResolvedValue({
            duplicate: false,
            job: { id: "job-1", status: "pending" },
        });
        mockResolveAlbumDownloadArtistName.mockResolvedValue(input.artistName);
        mockNotifyRequestSubmitted.mockResolvedValue(undefined);
        mockNotifyRequestApproved.mockResolvedValue(undefined);
        mockNotifyRequestDenied.mockResolvedValue(undefined);
        mockNotifyRequestFulfilled.mockResolvedValue(undefined);
        prisma.$transaction.mockImplementation(async (callback: any) =>
            callback(prisma),
        );
    });

    it("rejects an album already owned in the local library", async () => {
        prisma.album.findFirst.mockResolvedValueOnce({ id: "album-1" });

        await expectCreateError("already_in_library");

        expect(prisma.album.findFirst).toHaveBeenCalledWith({
            where: { rgMbid: input.rgMbid, location: "LIBRARY" },
            select: { id: true },
        });
        expect(mockRecordMusicRequestAction).toHaveBeenCalledWith(
            "rejected_duplicate",
        );
    });

    it("rejects an open request globally", async () => {
        prisma.musicRequest.findFirst.mockResolvedValueOnce({ id: "other" });

        await expectCreateError("already_requested");

        expect(prisma.musicRequest.findFirst).toHaveBeenCalledWith({
            where: {
                rgMbid: input.rgMbid,
                status: { in: ["pending", "approved"] },
            },
            select: { id: true },
        });
    });

    it("rejects an album with an active download job", async () => {
        prisma.downloadJob.findFirst.mockResolvedValueOnce({ id: "job-open" });

        await expectCreateError("already_downloading");

        expect(prisma.downloadJob.findFirst).toHaveBeenCalledWith({
            where: {
                targetMbid: input.rgMbid,
                status: { in: ["pending", "processing"] },
            },
            select: { id: true },
        });
    });

    it("creates at cap minus one and trims the note", async () => {
        prisma.musicRequest.count.mockResolvedValueOnce(9);

        const result = await createRequest("user-1", input);

        expect(result).toEqual(pendingRequest);
        expect(prisma.musicRequest.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ note: "Please add this" }),
        });
        expect(mockRecordMusicRequestAction).toHaveBeenCalledWith("created");
        expect(mockNotifyRequestSubmitted).toHaveBeenCalledWith(
            "admin-1",
            "listener",
            expect.objectContaining({ requestId: "request-1" }),
        );
    });

    it("rejects exactly at the daily cap", async () => {
        prisma.musicRequest.count.mockResolvedValueOnce(10);

        await expectCreateError("daily_cap");

        expect(mockRecordMusicRequestAction).toHaveBeenCalledWith(
            "rejected_cap",
        );
        expect(prisma.musicRequest.create).not.toHaveBeenCalled();
    });

    it("maps a P2002 create race to the open-request conflict", async () => {
        prisma.musicRequest.create.mockRejectedValueOnce({ code: "P2002" });

        await expectCreateError("already_requested");

        expect(mockRecordMusicRequestAction).toHaveBeenCalledWith(
            "rejected_duplicate",
        );
    });

    it("batches album links and prefers the library row", async () => {
        const secondRequest = { ...pendingRequest, id: "request-2" };
        prisma.musicRequest.findMany.mockResolvedValueOnce([
            pendingRequest,
            secondRequest,
        ]);
        prisma.album.findMany.mockResolvedValueOnce([
            {
                id: "album-discovery",
                rgMbid: input.rgMbid,
                location: "DISCOVER",
                artistId: "artist-discovery",
            },
            {
                id: "album-library",
                rgMbid: input.rgMbid,
                location: "LIBRARY",
                artistId: "artist-library",
            },
        ]);

        const result = await listRequestsForUser("user-1");

        expect(result).toEqual([
            {
                ...pendingRequest,
                albumId: "album-library",
                artistId: "artist-library",
            },
            {
                ...secondRequest,
                albumId: "album-library",
                artistId: "artist-library",
            },
        ]);
        expect(prisma.album.findMany).toHaveBeenCalledTimes(1);
        expect(prisma.album.findMany).toHaveBeenCalledWith({
            where: { rgMbid: { in: [input.rgMbid] } },
            select: {
                id: true,
                rgMbid: true,
                location: true,
                artistId: true,
            },
        });
        expect(prisma.artist.findMany).not.toHaveBeenCalled();
    });

    it("falls back to the artist MBID for administrator request rows", async () => {
        const adminRequest = {
            ...pendingRequest,
            user: { id: "user-1", username: "listener" },
        };
        prisma.musicRequest.findMany.mockResolvedValueOnce([adminRequest]);
        prisma.artist.findMany.mockResolvedValueOnce([
            { id: "artist-local", mbid: input.artistMbid },
        ]);

        const result = await listAllRequests("pending");

        expect(result).toEqual([
            {
                ...adminRequest,
                albumId: null,
                artistId: "artist-local",
            },
        ]);
        expect(prisma.artist.findMany).toHaveBeenCalledWith({
            where: { mbid: { in: [input.artistMbid] } },
            select: { id: true, mbid: true },
        });
    });

    it("returns null links when neither album nor artist resolves", async () => {
        prisma.musicRequest.findMany.mockResolvedValueOnce([pendingRequest]);

        await expect(listRequestsForUser("user-1")).resolves.toEqual([
            { ...pendingRequest, albumId: null, artistId: null },
        ]);
    });

    it("does not reveal another user's request during cancellation", async () => {
        prisma.musicRequest.updateMany.mockResolvedValueOnce({ count: 0 });
        prisma.musicRequest.findFirst.mockResolvedValueOnce(null);

        await expect(
            cancelOwnRequest("other-user", "request-1"),
        ).resolves.toEqual({ kind: "not_found" });
    });

    it("rejects cancellation after the pending state", async () => {
        prisma.musicRequest.updateMany.mockResolvedValueOnce({ count: 0 });
        prisma.musicRequest.findFirst.mockResolvedValueOnce({
            id: "request-1",
            status: "approved",
        });

        await expect(cancelOwnRequest("user-1", "request-1")).resolves.toEqual({
            kind: "conflict",
        });
    });

    it("cancels with an atomic pending-state guard", async () => {
        prisma.musicRequest.findUnique.mockResolvedValueOnce({
            ...pendingRequest,
            status: "cancelled",
        });

        await expect(
            cancelOwnRequest("user-1", "request-1"),
        ).resolves.toMatchObject({ kind: "updated" });
        expect(prisma.musicRequest.updateMany).toHaveBeenCalledWith({
            where: { id: "request-1", userId: "user-1", status: "pending" },
            data: { status: "cancelled" },
        });
    });

    it("returns conflict when approval no longer targets pending", async () => {
        prisma.musicRequest.findUnique.mockResolvedValueOnce({
            ...pendingRequest,
            status: "denied",
        });

        await expect(approveRequest("admin-1", "request-1")).resolves.toEqual({
            kind: "conflict",
        });
        expect(mockCreateAlbumDownloadJob).not.toHaveBeenCalled();
    });

    it("creates the approval job for the admin and notifies the requester", async () => {
        await approveRequest("admin-1", "request-1");

        expect(mockCreateAlbumDownloadJob).toHaveBeenCalledWith(
            {
                userId: "admin-1",
                mbid: input.rgMbid,
                subject: `${input.artistName} - ${input.albumTitle}`,
                artistName: input.artistName,
                albumTitle: input.albumTitle,
                downloadType: "library",
                rootFolderPath: "/library",
            },
            prisma,
            input.artistName,
        );
        expect(mockNotifyRequestApproved).toHaveBeenCalledWith(
            "user-1",
            expect.objectContaining({ requestId: "request-1" }),
        );
    });

    it("links an existing active job without producing dispatch work", async () => {
        mockCreateAlbumDownloadJob.mockResolvedValueOnce({
            duplicate: true,
            job: { id: "job-existing", status: "processing" },
        });
        prisma.musicRequest.update.mockResolvedValueOnce({
            ...pendingRequest,
            status: "approved",
            downloadJobId: "job-existing",
        });

        const result = await approveRequest("admin-1", "request-1");

        expect(result).toMatchObject({
            kind: "updated",
            duplicate: true,
            dispatch: null,
            request: { downloadJobId: "job-existing" },
        });
        expect(prisma.musicRequest.updateMany).toHaveBeenCalledWith({
            where: { id: "request-1", status: "pending" },
            data: expect.objectContaining({
                status: "approved",
                reviewedById: "admin-1",
            }),
        });
    });

    it("approves two pending requests by sharing one active download job", async () => {
        const secondRequest = {
            ...pendingRequest,
            id: "request-2",
            userId: "user-2",
        };
        prisma.musicRequest.findUnique
            .mockResolvedValueOnce(pendingRequest)
            .mockResolvedValueOnce(secondRequest);
        prisma.musicRequest.update
            .mockResolvedValueOnce({
                ...pendingRequest,
                status: "approved",
                downloadJobId: "job-shared",
            })
            .mockResolvedValueOnce({
                ...secondRequest,
                status: "approved",
                downloadJobId: "job-shared",
            });
        mockCreateAlbumDownloadJob
            .mockResolvedValueOnce({
                duplicate: false,
                job: { id: "job-shared", status: "pending" },
                verifiedArtistName: input.artistName,
            })
            .mockResolvedValueOnce({
                duplicate: true,
                job: { id: "job-shared", status: "processing" },
                verifiedArtistName: input.artistName,
            });

        const first = await approveRequest("admin-1", "request-1");
        const second = await approveRequest("admin-1", "request-2");

        expect(first).toMatchObject({
            kind: "updated",
            duplicate: false,
            dispatch: { jobId: "job-shared" },
            request: { status: "approved", downloadJobId: "job-shared" },
        });
        expect(second).toMatchObject({
            kind: "updated",
            duplicate: true,
            dispatch: null,
            request: { status: "approved", downloadJobId: "job-shared" },
        });
        expect(mockCreateAlbumDownloadJob).toHaveBeenCalledTimes(2);
    });

    it("fulfills a stale pending request when its album is now owned", async () => {
        const fulfilledRequest = {
            ...pendingRequest,
            status: "fulfilled",
            reviewedById: "admin-1",
        };
        prisma.album.findFirst.mockResolvedValueOnce({ id: "album-1" });
        prisma.musicRequest.findUnique
            .mockResolvedValueOnce(pendingRequest)
            .mockResolvedValueOnce(fulfilledRequest);

        await expect(
            approveRequest("admin-1", "request-1"),
        ).resolves.toMatchObject({
            kind: "updated",
            request: fulfilledRequest,
            dispatch: null,
        });

        expect(prisma.musicRequest.updateMany).toHaveBeenCalledWith({
            where: { id: "request-1", status: "pending" },
            data: {
                status: "fulfilled",
                reviewedById: "admin-1",
                reviewedAt: expect.any(Date),
            },
        });
        expect(mockRecordMusicRequestAction).toHaveBeenCalledWith("fulfilled");
        expect(mockNotifyRequestFulfilled).toHaveBeenCalledWith(
            "user-1",
            expect.objectContaining({ requestId: "request-1" }),
        );
        expect(mockGetSystemSettings).not.toHaveBeenCalled();
        expect(mockCreateAlbumDownloadJob).not.toHaveBeenCalled();
    });

    it("rejects denial after the pending state", async () => {
        prisma.musicRequest.findUnique.mockResolvedValueOnce({
            ...pendingRequest,
            status: "approved",
        });

        await expect(
            denyRequest("admin-1", "request-1", "No space"),
        ).resolves.toEqual({ kind: "conflict" });
        expect(prisma.musicRequest.updateMany).not.toHaveBeenCalled();
    });

    it("exposes stable typed create errors", () => {
        const error = new MusicRequestServiceError(
            "already_requested",
            "Already requested",
        );
        expect(error).toMatchObject({
            name: "MusicRequestServiceError",
            code: "already_requested",
        });
    });
});
