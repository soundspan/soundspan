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

jest.mock("../../services/staleJobCleanup", () => ({
    staleJobCleanupService: {
        cleanupAll: jest.fn(),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        userSettings: {
            findUnique: jest.fn(),
            create: jest.fn(),
            upsert: jest.fn(),
        },
        user: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        $queryRaw: jest.fn(),
    },
}));

import router from "../settings";
import { prisma } from "../../utils/db";
import { staleJobCleanupService } from "../../services/staleJobCleanup";

const mockUserSettingsFindUnique = prisma.userSettings.findUnique as jest.Mock;
const mockUserSettingsCreate = prisma.userSettings.create as jest.Mock;
const mockUserSettingsUpsert = prisma.userSettings.upsert as jest.Mock;
const mockUserFindUnique = prisma.user.findUnique as jest.Mock;
const mockUserUpdate = prisma.user.update as jest.Mock;
const mockPrismaQueryRaw = prisma.$queryRaw as jest.Mock;
const mockStaleJobCleanup = staleJobCleanupService.cleanupAll as jest.Mock;

function getGetHandler(path: string) {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.get
    );
    if (!layer) throw new Error(`GET route not found: ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function getPostHandler(path: string) {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.post
    );
    if (!layer) throw new Error(`POST route not found: ${path}`);
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

describe("settings displayName compatibility", () => {
    const getSettingsHandler = getGetHandler("/");
    const updateSettingsHandler = getPostHandler("/");
    const cleanupStaleJobsHandler = getPostHandler("/cleanup-stale-jobs");

    beforeEach(() => {
        jest.clearAllMocks();
        mockPrismaQueryRaw.mockResolvedValue([{ count: BigInt(0) }]);
    });

    it("returns displayName alongside user settings", async () => {
        mockUserSettingsFindUnique.mockResolvedValue({
            userId: "user-1",
            playbackQuality: "high",
            shareOnlinePresence: false,
            shareListeningStatus: false,
            wifiOnly: false,
            offlineEnabled: false,
            maxCacheSizeMb: 1024,
            ytMusicQuality: "HIGH",
            tidalStreamingQuality: "HIGH",
        });
        mockUserFindUnique.mockResolvedValue({ displayName: "Jane Doe" });

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();

        await getSettingsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                userId: "user-1",
                displayName: "Jane Doe",
            })
        );
        expect(mockUserSettingsCreate).not.toHaveBeenCalled();
    });

    it("creates default settings when settings are missing", async () => {
        mockUserSettingsFindUnique.mockResolvedValue(null);
        mockUserSettingsCreate.mockResolvedValue({
            userId: "user-1",
            playbackQuality: "medium",
            shareOnlinePresence: false,
            shareListeningStatus: false,
            wifiOnly: false,
            offlineEnabled: false,
            maxCacheSizeMb: 5120,
        });
        mockUserFindUnique.mockResolvedValue({ displayName: "Jane Doe" });

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();

        await getSettingsHandler(req, res);

        expect(mockUserSettingsCreate).toHaveBeenCalledWith({
            data: {
                userId: "user-1",
                playbackQuality: "medium",
                shareOnlinePresence: false,
                shareListeningStatus: false,
                wifiOnly: false,
                offlineEnabled: false,
                maxCacheSizeMb: 5120,
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                userId: "user-1",
                playbackQuality: "medium",
                shareOnlinePresence: false,
                shareListeningStatus: false,
                wifiOnly: false,
                offlineEnabled: false,
                maxCacheSizeMb: 5120,
                displayName: "Jane Doe",
            })
        );
    });

    it("returns 500 when GET settings fails", async () => {
        mockUserSettingsFindUnique.mockRejectedValue(new Error("db down"));
        mockUserFindUnique.mockResolvedValue({ displayName: "Jane Doe" });

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();

        await getSettingsHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get settings" });
    });

    it("updates user displayName when valid", async () => {
        mockUserSettingsUpsert.mockResolvedValue({
            userId: "user-1",
            playbackQuality: "original",
            shareOnlinePresence: false,
            shareListeningStatus: false,
            wifiOnly: false,
            offlineEnabled: false,
            maxCacheSizeMb: 5120,
            ytMusicQuality: "HIGH",
            tidalStreamingQuality: "HIGH",
        });
        mockUserUpdate.mockResolvedValue({ displayName: "Mary-Jane Doe" });
        mockUserFindUnique.mockResolvedValue({ displayName: "Mary-Jane Doe" });

        const req = {
            user: { id: "user-1" },
            body: { displayName: "Mary-Jane Doe", playbackQuality: "original" },
        } as any;
        const res = createRes();

        await updateSettingsHandler(req, res);

        expect(mockUserUpdate).toHaveBeenCalledWith({
            where: { id: "user-1" },
            data: { displayName: "Mary-Jane Doe" },
        });
        expect(mockUserSettingsUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                update: expect.objectContaining({ playbackQuality: "original" }),
            })
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                displayName: "Mary-Jane Doe",
            })
        );
    });

    it("rejects invalid displayName values", async () => {
        const req = {
            user: { id: "user-1" },
            body: { displayName: "Jane@Doe" },
        } as any;
        const res = createRes();

        await updateSettingsHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: "Invalid settings",
            })
        );
        expect(mockUserUpdate).not.toHaveBeenCalled();
        expect(mockUserSettingsUpsert).not.toHaveBeenCalled();
    });

    it("allows clearing displayName", async () => {
        mockUserSettingsUpsert.mockResolvedValue({
            userId: "user-1",
            playbackQuality: "original",
            shareOnlinePresence: false,
            shareListeningStatus: false,
            wifiOnly: false,
            offlineEnabled: false,
            maxCacheSizeMb: 5120,
            ytMusicQuality: "HIGH",
            tidalStreamingQuality: "HIGH",
        });
        mockUserUpdate.mockResolvedValue({ displayName: null });
        mockUserFindUnique.mockResolvedValue({ displayName: null });

        const req = {
            user: { id: "user-1" },
            body: { displayName: "" },
        } as any;
        const res = createRes();

        await updateSettingsHandler(req, res);

        expect(mockUserUpdate).toHaveBeenCalledWith({
            where: { id: "user-1" },
            data: { displayName: null },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                displayName: null,
            })
        );
    });

    it("updates social sharing flags", async () => {
        mockUserSettingsUpsert.mockResolvedValue({
            userId: "user-1",
            playbackQuality: "original",
            shareOnlinePresence: true,
            shareListeningStatus: true,
            wifiOnly: false,
            offlineEnabled: false,
            maxCacheSizeMb: 5120,
            ytMusicQuality: "HIGH",
            tidalStreamingQuality: "HIGH",
        });
        mockUserFindUnique.mockResolvedValue({ displayName: "Jane Doe" });

        const req = {
            user: { id: "user-1" },
            body: {
                shareOnlinePresence: true,
                shareListeningStatus: true,
            },
        } as any;
        const res = createRes();

        await updateSettingsHandler(req, res);

        expect(mockUserSettingsUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                update: expect.objectContaining({
                    shareOnlinePresence: true,
                    shareListeningStatus: true,
                }),
            })
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                shareOnlinePresence: true,
                shareListeningStatus: true,
            })
        );
    });

    it("does not update displayName when request displayName is undefined", async () => {
        mockUserSettingsUpsert.mockResolvedValue({
            userId: "user-1",
            playbackQuality: "original",
            shareOnlinePresence: false,
            shareListeningStatus: false,
            wifiOnly: false,
            offlineEnabled: false,
            maxCacheSizeMb: 5120,
            ytMusicQuality: "HIGH",
            tidalStreamingQuality: "HIGH",
        });
        mockUserFindUnique.mockResolvedValue({ displayName: "Jane Doe" });

        const req = {
            user: { id: "user-1" },
            body: { playbackQuality: "original" },
        } as any;
        const res = createRes();

        await updateSettingsHandler(req, res);

        expect(mockUserUpdate).not.toHaveBeenCalled();
        expect(mockUserSettingsUpsert).toHaveBeenCalled();
        expect(mockUserFindUnique).toHaveBeenCalledWith({
            where: { id: "user-1" },
            select: { displayName: true },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                userId: "user-1",
                playbackQuality: "original",
            })
        );
    });

    it("returns 500 when updating settings fails", async () => {
        mockUserSettingsUpsert.mockRejectedValue(new Error("db down"));

        const req = {
            user: { id: "user-1" },
            body: { playbackQuality: "original" },
        } as any;
        const res = createRes();

        await updateSettingsHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to update settings" });
        expect(mockUserUpdate).not.toHaveBeenCalled();
        expect(mockUserFindUnique).not.toHaveBeenCalled();
    });

    it("successfully cleans up stale jobs", async () => {
        mockStaleJobCleanup.mockResolvedValue({
            discoveryBatches: 2,
            downloadJobs: 4,
            spotifyImportJobs: 1,
            bullQueues: 3,
            totalCleaned: 10,
        });

        const req = { user: { id: "admin-1" } } as any;
        const res = createRes();

        await cleanupStaleJobsHandler(req, res);

        expect(mockStaleJobCleanup).toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            cleaned: {
                discoveryBatches: 2,
                downloadJobs: 4,
                spotifyImportJobs: 1,
                bullQueues: 3,
            },
            totalCleaned: 10,
        });
    });

    it("returns 500 when cleanup-stale-jobs fails", async () => {
        mockStaleJobCleanup.mockRejectedValue(new Error("cleanup service unavailable"));

        const req = { user: { id: "admin-1" } } as any;
        const res = createRes();

        await cleanupStaleJobsHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to cleanup stale jobs" });
    });
});
