const mockCreateAlbumDownloadJob = jest.fn();
const mockResolveAlbumDownloadArtistName = jest.fn();
const mockGetSystemSettings = jest.fn();
const mockRecordMusicRequestAction = jest.fn();
const mockNotifyRequestSubmitted = jest.fn();
const mockNotifyRequestApproved = jest.fn();
const mockNotifyRequestDenied = jest.fn();
const mockNotifyRequestFulfilled = jest.fn();
const mockListAdminRecipientIds = jest.fn();
const mockConfig = {
    music: { musicPath: "/music" },
    requests: { dailyCapPerUser: 10, deniedCooldownDays: 30 },
};

const prisma = {
    album: { findFirst: jest.fn(), findMany: jest.fn() },
    artist: { findMany: jest.fn() },
    downloadJob: { findFirst: jest.fn(), findMany: jest.fn() },
    musicRequest: {
        count: jest.fn(),
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        groupBy: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
    },
    user: { findMany: jest.fn(), findUnique: jest.fn() },
    $transaction: jest.fn(),
};

jest.mock("../../utils/db", () => ({ prisma }));
jest.mock("../../config", () => ({ config: mockConfig }));
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
    buildRequestNotificationMetadata: (
        request: {
            id: string;
            rgMbid: string;
            artistName: string;
            albumTitle: string;
        },
        albumId?: string,
    ) => ({
        requestId: request.id,
        rgMbid: request.rgMbid,
        artistName: request.artistName,
        albumTitle: request.albumTitle,
        ...(albumId ? { albumId } : {}),
    }),
    listAdminRecipientIds: (...args: unknown[]) =>
        mockListAdminRecipientIds(...args),
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
    getRequestAvailability,
    getRequestCounts,
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
        mockCreateAlbumDownloadJob.mockReset();
        prisma.downloadJob.findFirst.mockReset();
        prisma.musicRequest.updateMany.mockReset();
        prisma.album.findFirst.mockResolvedValue(null);
        prisma.album.findMany.mockResolvedValue([]);
        prisma.artist.findMany.mockResolvedValue([]);
        prisma.musicRequest.findFirst.mockResolvedValue(null);
        prisma.downloadJob.findFirst.mockResolvedValue(null);
        prisma.downloadJob.findMany.mockResolvedValue([]);
        prisma.musicRequest.count.mockResolvedValue(0);
        prisma.musicRequest.groupBy.mockResolvedValue([]);
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
        mockListAdminRecipientIds.mockImplementation(async () => {
            const admins = await prisma.user.findMany({
                where: { role: "admin" },
                select: { id: true },
                take: 200,
            });
            return admins.map(({ id }: { id: string }) => id);
        });
        mockConfig.requests.deniedCooldownDays = 30;
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

    it("rejects an album during a global denial cooldown", async () => {
        const cooldownUntil = new Date("2026-11-01T00:00:00.000Z");
        prisma.musicRequest.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ cooldownUntil });

        await expect(createRequest("user-1", input)).rejects.toMatchObject({
            code: "recently_denied",
            retryAfter: cooldownUntil,
        });

        expect(prisma.musicRequest.findFirst).toHaveBeenNthCalledWith(2, {
            where: {
                rgMbid: input.rgMbid,
                status: "denied",
                cooldownUntil: { gt: expect.any(Date) },
            },
            select: { cooldownUntil: true },
            orderBy: { cooldownUntil: "desc" },
        });
        expect(mockRecordMusicRequestAction).toHaveBeenCalledWith(
            "rejected_cooldown",
        );
        expect(prisma.musicRequest.count).not.toHaveBeenCalled();
    });

    it("allows an expired denial cooldown", async () => {
        prisma.musicRequest.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        await expect(createRequest("user-1", input)).resolves.toEqual(
            pendingRequest,
        );
    });

    it("skips all denial cooldown rows when cooldowns are disabled", async () => {
        mockConfig.requests.deniedCooldownDays = 0;

        await createRequest("user-1", input);

        expect(prisma.musicRequest.findFirst).toHaveBeenCalledTimes(1);
        expect(prisma.musicRequest.findFirst).toHaveBeenCalledWith({
            where: {
                rgMbid: input.rgMbid,
                status: { in: ["pending", "approved"] },
            },
            select: { id: true },
        });
    });

    it("checks cooldowns only for the requested album", async () => {
        await createRequest("user-1", {
            ...input,
            rgMbid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        });

        expect(prisma.musicRequest.findFirst).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                where: expect.objectContaining({
                    rgMbid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                }),
            }),
        );
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

        prisma.musicRequest.count.mockResolvedValueOnce(2);
        prisma.downloadJob.findMany.mockResolvedValueOnce([
            { id: "job-1", status: "processing" },
        ]);
        const rows = [
            { ...pendingRequest, downloadJobId: "job-1" },
            { ...secondRequest, downloadJobId: "deleted-job" },
        ];
        prisma.musicRequest.findMany.mockReset();
        prisma.musicRequest.findMany.mockResolvedValueOnce(rows);

        const result = await listRequestsForUser("user-1", {
            status: "pending",
            limit: 20,
            offset: 10,
        });

        expect(result).toEqual({
            requests: [
                {
                    ...rows[0],
                    albumId: "album-library",
                    artistId: "artist-library",
                    downloadStatus: "processing",
                },
                {
                    ...rows[1],
                    albumId: "album-library",
                    artistId: "artist-library",
                    downloadStatus: null,
                },
            ],
            total: 2,
            offset: 10,
            limit: 20,
        });
        expect(prisma.musicRequest.findMany).toHaveBeenCalledWith({
            where: { userId: "user-1", status: "pending" },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: 10,
            take: 20,
        });
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
        expect(prisma.downloadJob.findMany).toHaveBeenCalledTimes(1);
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

        prisma.musicRequest.count.mockResolvedValueOnce(1);
        const result = await listAllRequests({
            status: "pending",
            limit: 50,
            offset: 0,
        });

        expect(result.requests).toEqual([
            {
                ...adminRequest,
                albumId: null,
                artistId: "artist-local",
                downloadStatus: null,
            },
        ]);
        expect(prisma.artist.findMany).toHaveBeenCalledWith({
            where: { mbid: { in: [input.artistMbid] } },
            select: { id: true, mbid: true },
        });
        expect(prisma.musicRequest.findMany).toHaveBeenCalledWith({
            where: { status: "pending" },
            include: { user: { select: { id: true, username: true } } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: 0,
            take: 50,
        });
    });

    it("returns null links when neither album nor artist resolves", async () => {
        prisma.musicRequest.findMany.mockResolvedValueOnce([pendingRequest]);

        prisma.musicRequest.count.mockResolvedValueOnce(1);
        await expect(listRequestsForUser("user-1")).resolves.toEqual({
            requests: [
                {
                    ...pendingRequest,
                    albumId: null,
                    artistId: null,
                    downloadStatus: null,
                },
            ],
            total: 1,
            offset: 0,
            limit: 50,
        });
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
            reason: "not_reviewable",
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
            reason: "not_reviewable",
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
                artistMbid: input.artistMbid,
                albumTitle: input.albumTitle,
                downloadType: "library",
                rootFolderPath: "/library",
                metadata: {
                    queuedVia: "album-download-queue",
                    noFallback: true,
                },
            },
            prisma,
            input.artistName,
        );
        expect(mockNotifyRequestApproved).toHaveBeenCalledWith(
            "user-1",
            expect.objectContaining({ requestId: "request-1" }),
        );
    });

    it("uses a supplied artist name without resolving it again", async () => {
        await approveRequest("admin-1", "request-1", {
            verifiedArtistName: "Canonical Artist",
        });

        expect(mockResolveAlbumDownloadArtistName).not.toHaveBeenCalled();
        expect(mockCreateAlbumDownloadJob).toHaveBeenCalledWith(
            expect.any(Object),
            prisma,
            "Canonical Artist",
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

    it("reuses an active job after a download-job P2002 race", async () => {
        mockCreateAlbumDownloadJob.mockRejectedValueOnce({ code: "P2002" });
        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-existing",
            targetMbid: input.rgMbid,
            status: "processing",
        });
        prisma.musicRequest.update.mockResolvedValueOnce({
            ...pendingRequest,
            status: "approved",
            downloadJobId: "job-existing",
        });

        await expect(
            approveRequest("admin-1", "request-1"),
        ).resolves.toMatchObject({
            kind: "updated",
            duplicate: true,
            dispatch: null,
            request: { downloadJobId: "job-existing" },
        });

        expect(prisma.downloadJob.findFirst).toHaveBeenCalledWith({
            where: {
                targetMbid: input.rgMbid,
                status: { in: ["pending", "processing"] },
            },
            orderBy: { createdAt: "asc" },
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
            expect.objectContaining({
                requestId: "request-1",
                albumId: "album-1",
            }),
        );
        expect(mockGetSystemSettings).not.toHaveBeenCalled();
        expect(mockCreateAlbumDownloadJob).not.toHaveBeenCalled();
    });

    it("re-approves a failed request with a new linked job", async () => {
        const failedRequest = { ...pendingRequest, status: "failed" };
        prisma.musicRequest.findUnique.mockResolvedValueOnce(failedRequest);

        await expect(
            approveRequest("admin-1", "request-1"),
        ).resolves.toMatchObject({ kind: "updated" });

        expect(prisma.musicRequest.findFirst).toHaveBeenCalledWith({
            where: {
                id: { not: "request-1" },
                userId: "user-1",
                rgMbid: input.rgMbid,
                status: { in: ["pending", "approved"] },
            },
            select: { id: true },
        });
        expect(prisma.musicRequest.updateMany).toHaveBeenCalledWith({
            where: { id: "request-1", status: "failed" },
            data: expect.objectContaining({ status: "approved" }),
        });
        expect(prisma.musicRequest.update).toHaveBeenCalledWith({
            where: { id: "request-1" },
            data: { downloadJobId: "job-1" },
        });
        expect(mockNotifyRequestApproved).toHaveBeenCalled();
    });

    it("fulfills a failed request during re-approval when already owned", async () => {
        const failedRequest = { ...pendingRequest, status: "failed" };
        const fulfilledRequest = { ...failedRequest, status: "fulfilled" };
        prisma.musicRequest.findUnique
            .mockResolvedValueOnce(failedRequest)
            .mockResolvedValueOnce(fulfilledRequest);
        prisma.album.findFirst.mockResolvedValueOnce({ id: "album-1" });

        await approveRequest("admin-1", "request-1");

        expect(prisma.musicRequest.updateMany).toHaveBeenCalledWith({
            where: { id: "request-1", status: "failed" },
            data: expect.objectContaining({ status: "fulfilled" }),
        });
        expect(mockNotifyRequestFulfilled).toHaveBeenCalledWith(
            "user-1",
            expect.objectContaining({ albumId: "album-1" }),
        );
    });

    it("fulfills an owned failed request despite another open request", async () => {
        const failedRequest = { ...pendingRequest, status: "failed" };
        const fulfilledRequest = { ...failedRequest, status: "fulfilled" };
        prisma.musicRequest.findUnique
            .mockResolvedValueOnce(failedRequest)
            .mockResolvedValueOnce(fulfilledRequest);
        prisma.album.findFirst.mockResolvedValueOnce({ id: "album-1" });
        prisma.musicRequest.findFirst.mockResolvedValueOnce({
            id: "request-2",
        });

        await expect(
            approveRequest("admin-1", "request-1"),
        ).resolves.toMatchObject({
            kind: "updated",
            request: { status: "fulfilled" },
        });

        expect(prisma.musicRequest.findFirst).not.toHaveBeenCalled();
        expect(prisma.musicRequest.updateMany).toHaveBeenCalledWith({
            where: { id: "request-1", status: "failed" },
            data: expect.objectContaining({ status: "fulfilled" }),
        });
    });

    it("rejects failed re-approval when the user has another open request", async () => {
        prisma.musicRequest.findUnique.mockResolvedValueOnce({
            ...pendingRequest,
            status: "failed",
        });
        prisma.musicRequest.findFirst.mockResolvedValueOnce({
            id: "request-2",
        });

        await expect(approveRequest("admin-1", "request-1")).resolves.toEqual({
            kind: "conflict",
            reason: "open_request_exists",
        });

        expect(prisma.album.findFirst).toHaveBeenCalledWith({
            where: { rgMbid: input.rgMbid, location: "LIBRARY" },
            select: { id: true },
        });
        expect(mockCreateAlbumDownloadJob).not.toHaveBeenCalled();
    });

    it("maps a failed re-approval status-index P2002 race to conflict", async () => {
        prisma.musicRequest.findUnique.mockResolvedValueOnce({
            ...pendingRequest,
            status: "failed",
        });
        prisma.musicRequest.updateMany.mockRejectedValueOnce({ code: "P2002" });

        await expect(approveRequest("admin-1", "request-1")).resolves.toEqual({
            kind: "conflict",
            reason: "open_request_exists",
        });

        expect(prisma.downloadJob.findFirst).not.toHaveBeenCalled();
        expect(mockCreateAlbumDownloadJob).not.toHaveBeenCalled();
    });

    it("maps a second-transaction status-index P2002 race to an open-request conflict", async () => {
        prisma.musicRequest.findUnique.mockResolvedValueOnce({
            ...pendingRequest,
            status: "failed",
        });
        prisma.musicRequest.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockRejectedValueOnce({ code: "P2002" });
        mockCreateAlbumDownloadJob.mockRejectedValueOnce({ code: "P2002" });
        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-existing",
            targetMbid: input.rgMbid,
            status: "processing",
        });

        await expect(approveRequest("admin-1", "request-1")).resolves.toEqual({
            kind: "conflict",
            reason: "open_request_exists",
        });

        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(prisma.musicRequest.updateMany).toHaveBeenCalledTimes(2);
    });

    it.each(["pending", "failed"])(
        "denies a %s request and applies the configured cooldown",
        async (status) => {
            jest.useFakeTimers({
                now: new Date("2026-10-19T12:00:00.000Z"),
            });
            const existing = { ...pendingRequest, status };
            const denied = { ...existing, status: "denied" };
            prisma.musicRequest.findUnique
                .mockResolvedValueOnce(existing)
                .mockResolvedValueOnce(denied);

            try {
                await denyRequest("admin-1", "request-1", " No space ");

                expect(prisma.musicRequest.updateMany).toHaveBeenCalledWith({
                    where: { id: "request-1", status },
                    data: {
                        status: "denied",
                        deniedReason: "No space",
                        reviewedById: "admin-1",
                        reviewedAt: new Date("2026-10-19T12:00:00.000Z"),
                        cooldownUntil: new Date("2026-11-18T12:00:00.000Z"),
                    },
                });
                expect(mockNotifyRequestDenied).toHaveBeenCalledWith(
                    "user-1",
                    expect.objectContaining({ requestId: "request-1" }),
                    "No space",
                );
            } finally {
                jest.useRealTimers();
            }
        },
    );

    it("stores no denial cooldown when cooldowns are disabled", async () => {
        mockConfig.requests.deniedCooldownDays = 0;
        prisma.musicRequest.findUnique
            .mockResolvedValueOnce(pendingRequest)
            .mockResolvedValueOnce({ ...pendingRequest, status: "denied" });

        await denyRequest("admin-1", "request-1");

        expect(prisma.musicRequest.updateMany).toHaveBeenCalledWith({
            where: { id: "request-1", status: "pending" },
            data: expect.objectContaining({ cooldownUntil: null }),
        });
    });

    it("zero-fills request counts from one grouped query", async () => {
        prisma.musicRequest.groupBy.mockResolvedValueOnce([
            { status: "pending", _count: { _all: 2 } },
            { status: "failed", _count: { _all: 1 } },
        ]);

        await expect(getRequestCounts()).resolves.toEqual({
            pending: 2,
            approved: 0,
            denied: 0,
            fulfilled: 0,
            failed: 1,
            cancelled: 0,
        });
        expect(prisma.musicRequest.groupBy).toHaveBeenCalledTimes(1);
        expect(prisma.musicRequest.groupBy).toHaveBeenCalledWith({
            by: ["status"],
            where: {
                status: {
                    in: [
                        "pending",
                        "approved",
                        "denied",
                        "fulfilled",
                        "failed",
                        "cancelled",
                    ],
                },
            },
            _count: { _all: true },
        });
    });

    it("rejects denial after the pending state", async () => {
        prisma.musicRequest.findUnique.mockResolvedValueOnce({
            ...pendingRequest,
            status: "approved",
        });

        await expect(
            denyRequest("admin-1", "request-1", "No space"),
        ).resolves.toEqual({
            kind: "conflict",
            reason: "not_reviewable",
        });
        expect(prisma.musicRequest.updateMany).not.toHaveBeenCalled();
    });

    it("includes the configured denial cooldown in availability", async () => {
        prisma.musicRequest.count.mockResolvedValueOnce(3);

        await expect(getRequestAvailability("user-1")).resolves.toEqual({
            enabled: true,
            remainingToday: 7,
            dailyCap: 10,
            deniedCooldownDays: 30,
        });
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
