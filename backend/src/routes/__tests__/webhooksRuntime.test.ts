const mockScanQueueAdd = jest.fn();
jest.mock("../../workers/queues", () => ({
    scanQueue: {
        add: (...args: unknown[]) => mockScanQueueAdd(...args),
    },
}));

const mockOnDownloadGrabbed = jest.fn();
const mockOnDownloadComplete = jest.fn();
const mockOnImportFailed = jest.fn();
jest.mock("../../services/simpleDownloadManager", () => ({
    simpleDownloadManager: {
        onDownloadGrabbed: (...args: unknown[]) => mockOnDownloadGrabbed(...args),
        onDownloadComplete: (...args: unknown[]) => mockOnDownloadComplete(...args),
        onImportFailed: (...args: unknown[]) => mockOnImportFailed(...args),
    },
}));

const mockQueueCleanerStart = jest.fn();
jest.mock("../../jobs/queueCleaner", () => ({
    queueCleaner: {
        start: (...args: unknown[]) => mockQueueCleanerStart(...args),
    },
}));

const mockGetSystemSettings = jest.fn();
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: (...args: unknown[]) => mockGetSystemSettings(...args),
}));

const prisma = {
    downloadJob: {
        findUnique: jest.fn(),
    },
};
jest.mock("../../utils/db", () => ({
    prisma,
}));

const mockLoggerDebug = jest.fn();
const mockLoggerError = jest.fn();
jest.mock("../../utils/logger", () => ({
    logger: {
        debug: (...args: unknown[]) => mockLoggerDebug(...args),
        info: jest.fn(),
        warn: jest.fn(),
        error: (...args: unknown[]) => mockLoggerError(...args),
    },
}));

import router from "../webhooks";
import { prisma as prismaClient } from "../../utils/db";

const mockDownloadJobFindUnique = prismaClient.downloadJob.findUnique as jest.Mock;

function getHandler(method: "get" | "post", path: string) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );

    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }

    return layer.route.stack[layer.route.stack.length - 1].handle;
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

describe("webhooks routes runtime", () => {
    const getVerify = getHandler("get", "/lidarr/verify");
    const postLidarr = getHandler("post", "/lidarr");
    const originalPackageVersion = process.env.npm_package_version;
    const originalDebugWebhooks = process.env.DEBUG_WEBHOOKS;

    beforeEach(() => {
        jest.clearAllMocks();

        process.env.npm_package_version = "9.9.9";
        process.env.DEBUG_WEBHOOKS = "false";

        mockGetSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr.local",
            lidarrApiKey: "api-key",
            lidarrWebhookSecret: null,
        });
        mockOnDownloadGrabbed.mockResolvedValue({ matched: false });
        mockOnDownloadComplete.mockResolvedValue({ jobId: null });
        mockOnImportFailed.mockResolvedValue(undefined);
        mockDownloadJobFindUnique.mockResolvedValue({ id: "job-1", userId: "u1" });
    });

    afterAll(() => {
        process.env.npm_package_version = originalPackageVersion;
        process.env.DEBUG_WEBHOOKS = originalDebugWebhooks;
    });

    it("returns verification metadata", async () => {
        const req = {} as any;
        const res = createRes();

        await getVerify(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                status: "ok",
                service: "soundspan",
                legacyServiceAliases: expect.arrayContaining(["soundspan"]),
                version: "9.9.9",
                timestamp: expect.any(String),
            })
        );
    });

    it("ignores webhook when lidarr integration is disabled", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            lidarrEnabled: false,
            lidarrUrl: "",
            lidarrApiKey: "",
            lidarrWebhookSecret: null,
        });

        const req = {
            body: { eventType: "Grab" },
            headers: {},
        } as any;
        const res = createRes();

        await postLidarr(req, res);

        expect(res.statusCode).toBe(202);
        expect(res.body).toEqual({
            success: true,
            ignored: true,
            reason: "lidarr-disabled",
        });
        expect(mockOnDownloadGrabbed).not.toHaveBeenCalled();
    });

    it("rejects lidarr webhook when secret is missing or invalid", async () => {
        mockGetSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr.local",
            lidarrApiKey: "api-key",
            lidarrWebhookSecret: "shhh",
        });

        const missingReq = {
            body: { eventType: "Grab" },
            headers: {},
        } as any;
        const missingRes = createRes();
        await postLidarr(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(401);
        expect(missingRes.body).toEqual({
            error: "Unauthorized - Invalid webhook secret",
        });

        const invalidReq = {
            body: { eventType: "Grab" },
            headers: { "x-webhook-secret": "wrong" },
        } as any;
        const invalidRes = createRes();
        await postLidarr(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(401);
    });

    it("handles Grab events, starts cleaner when matched, and ignores missing ids", async () => {
        mockOnDownloadGrabbed.mockResolvedValueOnce({ matched: true });

        const req = {
            body: {
                eventType: "Grab",
                downloadId: "dl-1",
                albums: [
                    {
                        foreignAlbumId: "mbid-1",
                        title: "Album One",
                        id: 42,
                    },
                ],
                artist: { name: "Artist One" },
            },
            headers: {},
        } as any;
        const res = createRes();

        await postLidarr(req, res);

        expect(mockOnDownloadGrabbed).toHaveBeenCalledWith(
            "dl-1",
            "mbid-1",
            "Album One",
            "Artist One",
            42
        );
        expect(mockQueueCleanerStart).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true });

        const missingReq = {
            body: { eventType: "Grab" },
            headers: {},
        } as any;
        const missingRes = createRes();
        await postLidarr(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(200);
        expect(mockOnDownloadGrabbed).toHaveBeenCalledTimes(1);
    });

    it("handles download-family events with and without matching jobs", async () => {
        mockOnDownloadComplete.mockResolvedValueOnce({ jobId: "job-1" });
        mockDownloadJobFindUnique.mockResolvedValueOnce({ id: "job-1", userId: "u9" });

        process.env.DEBUG_WEBHOOKS = "true";

        const matchedReq = {
            body: {
                eventType: "Download",
                downloadId: "dl-2",
                album: { title: "Album Two", foreignAlbumId: "mbid-2", id: 77 },
                artist: { name: "Artist Two" },
            },
            headers: {},
        } as any;
        const matchedRes = createRes();

        await postLidarr(matchedReq, matchedRes);

        expect(mockOnDownloadComplete).toHaveBeenCalledWith(
            "dl-2",
            "mbid-2",
            "Artist Two",
            "Album Two",
            77
        );
        expect(mockDownloadJobFindUnique).toHaveBeenCalledWith({
            where: { id: "job-1" },
            select: { userId: true, id: true },
        });
        expect(mockScanQueueAdd).toHaveBeenCalledWith("scan", {
            userId: "u9",
            source: "lidarr-webhook",
            artistName: "Artist Two",
            albumMbid: "mbid-2",
            downloadId: "job-1",
        });
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "   Payload:",
            expect.any(String)
        );

        mockOnDownloadComplete.mockResolvedValueOnce({ jobId: null });
        const externalReq = {
            body: {
                eventType: "TrackRetag",
                downloadId: "dl-3",
                albums: [{ title: "Album Three", foreignAlbumId: "mbid-3", id: 12 }],
                artist: { name: "Artist Three" },
            },
            headers: {},
        } as any;
        const externalRes = createRes();
        await postLidarr(externalReq, externalRes);

        expect(mockScanQueueAdd).toHaveBeenLastCalledWith("scan", {
            type: "full",
            source: "lidarr-import-external",
        });

        const noIdReq = {
            body: { eventType: "Rename" },
            headers: {},
        } as any;
        const noIdRes = createRes();
        await postLidarr(noIdReq, noIdRes);
        expect(noIdRes.statusCode).toBe(200);
    });

    it("handles import-failure events and ignores health/test/unknown events", async () => {
        const failedReq = {
            body: {
                eventType: "DownloadFailed",
                downloadId: "dl-4",
                album: { foreignAlbumId: "mbid-4", title: "Album Four" },
                message: "Import failed",
            },
            headers: {},
        } as any;
        const failedRes = createRes();

        await postLidarr(failedReq, failedRes);

        expect(mockOnImportFailed).toHaveBeenCalledWith(
            "dl-4",
            "Import failed",
            "mbid-4"
        );
        expect(failedRes.statusCode).toBe(200);

        const healthReq = { body: { eventType: "HealthIssue" }, headers: {} } as any;
        const healthRes = createRes();
        await postLidarr(healthReq, healthRes);
        expect(healthRes.statusCode).toBe(200);

        const testReq = { body: { eventType: "Test" }, headers: {} } as any;
        const testRes = createRes();
        await postLidarr(testReq, testRes);
        expect(testRes.statusCode).toBe(200);

        const unknownReq = { body: { eventType: "AlienEvent" }, headers: {} } as any;
        const unknownRes = createRes();
        await postLidarr(unknownReq, unknownRes);
        expect(unknownRes.statusCode).toBe(200);
    });

    it("returns 500 on webhook processing errors", async () => {
        mockGetSystemSettings.mockRejectedValueOnce(new Error("settings unavailable"));

        const req = {
            body: { eventType: "Grab", downloadId: "dl-9" },
            headers: {},
        } as any;
        const res = createRes();

        await postLidarr(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Webhook processing failed" });
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Webhook error:",
            "settings unavailable"
        );
    });
});
