import type { NextFunction, Request, Response } from "express";
import request from "supertest";

const AUTH_HEADER = "x-test-auth";
const AUTH_VALUE = "ok";
const ADMIN_HEADER = "x-test-admin";
const ADMIN_VALUE = "yes";

const mockRequireAuth = jest.fn(
    (req: Request, res: Response, next: NextFunction) => {
        if (req.header(AUTH_HEADER) !== AUTH_VALUE) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        (req as Request & { user?: unknown }).user = {
            id: "user-1",
            username: "tester",
            role: req.header(ADMIN_HEADER) === ADMIN_VALUE ? "admin" : "user",
        };

        return next();
    }
);

const mockRequireAdmin = jest.fn(
    (req: Request, res: Response, next: NextFunction) => {
        if (req.header(ADMIN_HEADER) !== ADMIN_VALUE) {
            return res.status(403).json({ error: "Forbidden" });
        }
        return next();
    }
);

jest.mock("../../middleware/auth", () => ({
    requireAuth: mockRequireAuth,
    requireAdmin: mockRequireAdmin,
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
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

jest.mock("../../services/staleJobCleanup", () => ({
    staleJobCleanupService: {
        cleanupAll: jest.fn(),
    },
}));

jest.mock("../../services/tidalStreaming", () => ({
    tidalStreamingService: {
        clearUserQualityCache: jest.fn(),
    },
}));

class MockMulterError extends Error {
    code: string;

    constructor(code: string, message?: string) {
        super(message ?? code);
        this.code = code;
        this.name = "MulterError";
    }
}

type RequestWithTestFile = Omit<Request, "file"> & {
    file?: {
        buffer: Buffer;
        mimetype: string;
        originalname: string;
        size: number;
    };
};

const mockMulterMemoryStorage = jest.fn(() => ({ engine: "memory" }));
const mockMulterSingle = jest.fn(
    (_fieldName: string) =>
        (req: Request, _res: Response, cb: (err?: Error | null) => void) => {
            const uploadError = req.header("x-test-upload-error");

            if (uploadError === "LIMIT_FILE_SIZE") {
                return cb(new MockMulterError("LIMIT_FILE_SIZE", "File too large"));
            }

            if (uploadError === "GENERIC") {
                return cb(new Error("upload failed"));
            }

            if (req.header("x-test-no-file") === "1") {
                return cb();
            }

            const mutableReq = req as unknown as RequestWithTestFile;

            const fileBuffer = Buffer.from(
                req.header("x-test-file-body") ?? "source-image"
            );

            mutableReq.file = {
                buffer: fileBuffer,
                mimetype: req.header("x-test-file-type") ?? "image/png",
                originalname: "avatar.png",
                size: fileBuffer.length,
            };

            return cb();
        }
);

const mockMulter = Object.assign(jest.fn(() => ({ single: mockMulterSingle })), {
    memoryStorage: mockMulterMemoryStorage,
    MulterError: MockMulterError,
});

jest.mock("multer", () => ({
    __esModule: true,
    default: mockMulter,
}));

const mockSharpToBuffer = jest.fn();
type TestSharpPipeline = {
    resize: jest.Mock;
    rotate: jest.Mock;
    jpeg: jest.Mock;
    toBuffer: jest.Mock;
};

const mockSharpPipeline: TestSharpPipeline = {
    resize: jest.fn(),
    rotate: jest.fn(),
    jpeg: jest.fn(),
    toBuffer: mockSharpToBuffer,
};
mockSharpPipeline.resize.mockImplementation(() => mockSharpPipeline);
mockSharpPipeline.rotate.mockImplementation(() => mockSharpPipeline);
mockSharpPipeline.jpeg.mockImplementation(() => mockSharpPipeline);
const mockSharp = jest.fn(() => mockSharpPipeline);

jest.mock("sharp", () => ({
    __esModule: true,
    default: mockSharp,
}));

const { prisma } = require("../../utils/db") as typeof import("../../utils/db");
const { staleJobCleanupService } = require("../../services/staleJobCleanup") as typeof import("../../services/staleJobCleanup");
const { tidalStreamingService } = require("../../services/tidalStreaming") as typeof import("../../services/tidalStreaming");
const router = require("../settings").default as typeof import("../settings").default;
const {
    createRouteTestApp,
} = require("./helpers/createRouteTestApp") as typeof import("./helpers/createRouteTestApp");

const app = createRouteTestApp("/api/settings", router);

const mockUserSettingsFindUnique = prisma.userSettings.findUnique as jest.Mock;
const mockUserSettingsCreate = prisma.userSettings.create as jest.Mock;
const mockUserSettingsUpsert = prisma.userSettings.upsert as jest.Mock;
const mockUserFindUnique = prisma.user.findUnique as jest.Mock;
const mockUserUpdate = prisma.user.update as jest.Mock;
const mockPrismaQueryRaw = prisma.$queryRaw as jest.Mock;
const mockCleanupAll = staleJobCleanupService.cleanupAll as jest.Mock;
const mockClearUserQualityCache =
    tidalStreamingService.clearUserQualityCache as jest.Mock;

const existingSettings = {
    userId: "user-1",
    playbackQuality: "high",
    shareOnlinePresence: true,
    shareListeningStatus: false,
    wifiOnly: true,
    offlineEnabled: false,
    maxCacheSizeMb: 2048,
    showYtMusicExplore: true,
    showTidalExplore: false,
    ytMusicQuality: "HIGH",
    tidalStreamingQuality: "LOSSLESS",
};

const processedImageBuffer = Buffer.from("processed-image");

describe("settings routes integration", () => {
    beforeEach(() => {
        jest.clearAllMocks();

        mockUserSettingsFindUnique.mockResolvedValue(existingSettings);
        mockUserSettingsCreate.mockImplementation(async ({ data }) => ({
            id: "settings-created",
            ...data,
        }));
        mockUserSettingsUpsert.mockImplementation(async ({ where, create, update }) => ({
            id: "settings-upserted",
            ...(create ?? {}),
            ...(update ?? {}),
            userId: where.userId,
        }));
        mockUserFindUnique.mockResolvedValue({ displayName: "Jane Doe" });
        mockUserUpdate.mockResolvedValue({ id: "user-1" });
        mockPrismaQueryRaw.mockResolvedValue([{ count: BigInt(0) }]);
        mockCleanupAll.mockResolvedValue({
            discoveryBatches: 2,
            downloadJobs: 4,
            spotifyImportJobs: 1,
            bullQueues: 3,
            totalCleaned: 10,
        });
        mockSharpToBuffer.mockResolvedValue(processedImageBuffer);
    });

    it("returns existing settings with displayName and hasProfilePicture", async () => {
        mockPrismaQueryRaw.mockResolvedValueOnce([{ count: BigInt(1) }]);

        const res = await request(app)
            .get("/api/settings")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            ...existingSettings,
            displayName: "Jane Doe",
            hasProfilePicture: true,
        });
        expect(mockUserSettingsCreate).not.toHaveBeenCalled();
        expect(mockUserFindUnique).toHaveBeenCalledWith({
            where: { id: "user-1" },
            select: { displayName: true, profilePicture: false },
        });
    });

    it("creates default settings when none exist", async () => {
        mockUserSettingsFindUnique.mockResolvedValueOnce(null);
        mockUserFindUnique.mockResolvedValueOnce({ displayName: null });

        const res = await request(app)
            .get("/api/settings")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(200);
        expect(mockUserSettingsCreate).toHaveBeenCalledWith({
            data: {
                userId: "user-1",
                playbackQuality: "medium",
                shareOnlinePresence: false,
                shareListeningStatus: false,
                wifiOnly: false,
                offlineEnabled: false,
                maxCacheSizeMb: 5120,
                showYtMusicExplore: true,
                showTidalExplore: true,
            },
        });
        expect(res.body).toEqual(
            expect.objectContaining({
                userId: "user-1",
                playbackQuality: "medium",
                displayName: null,
                hasProfilePicture: false,
            })
        );
    });

    it("updates settings and normalizes displayName", async () => {
        mockUserFindUnique.mockResolvedValueOnce({ displayName: "Mary Jane" });

        const res = await request(app)
            .post("/api/settings")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({
                playbackQuality: "original",
                wifiOnly: false,
                showTidalExplore: true,
                displayName: "  Mary Jane  ",
            });

        expect(res.status).toBe(200);
        expect(mockUserSettingsUpsert).toHaveBeenCalledWith({
            where: { userId: "user-1" },
            create: {
                userId: "user-1",
                playbackQuality: "original",
                wifiOnly: false,
                showTidalExplore: true,
            },
            update: {
                playbackQuality: "original",
                wifiOnly: false,
                showTidalExplore: true,
            },
        });
        expect(mockUserUpdate).toHaveBeenCalledWith({
            where: { id: "user-1" },
            data: { displayName: "Mary Jane" },
        });
        expect(res.body).toEqual(
            expect.objectContaining({
                userId: "user-1",
                playbackQuality: "original",
                wifiOnly: false,
                showTidalExplore: true,
                displayName: "Mary Jane",
            })
        );
    });

    it("clears the TIDAL quality cache when tidalStreamingQuality is updated", async () => {
        const res = await request(app)
            .post("/api/settings")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ tidalStreamingQuality: "HI_RES_LOSSLESS" });

        expect(res.status).toBe(200);
        expect(mockClearUserQualityCache).toHaveBeenCalledWith("user-1");
    });

    it("requires admin and returns cleanup results for stale-job cleanup", async () => {
        const forbiddenRes = await request(app)
            .post("/api/settings/cleanup-stale-jobs")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(forbiddenRes.status).toBe(403);
        expect(forbiddenRes.body).toEqual({ error: "Forbidden" });
        expect(mockCleanupAll).not.toHaveBeenCalled();

        const successRes = await request(app)
            .post("/api/settings/cleanup-stale-jobs")
            .set(AUTH_HEADER, AUTH_VALUE)
            .set(ADMIN_HEADER, ADMIN_VALUE);

        expect(successRes.status).toBe(200);
        expect(successRes.body).toEqual({
            success: true,
            cleaned: {
                discoveryBatches: 2,
                downloadJobs: 4,
                spotifyImportJobs: 1,
                bullQueues: 3,
            },
            totalCleaned: 10,
        });
        expect(mockCleanupAll).toHaveBeenCalledTimes(1);
    });

    it("rejects invalid profile picture file types", async () => {
        const res = await request(app)
            .post("/api/settings/profile-picture")
            .set(AUTH_HEADER, AUTH_VALUE)
            .set("x-test-file-type", "text/plain");

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: "Invalid file type. Allowed: JPEG, PNG, WebP, GIF",
        });
        expect(mockSharp).not.toHaveBeenCalled();
        expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it("processes and stores an uploaded profile picture", async () => {
        const res = await request(app)
            .post("/api/settings/profile-picture")
            .set(AUTH_HEADER, AUTH_VALUE)
            .set("x-test-file-type", "image/png")
            .set("x-test-file-body", "raw-image-data");

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true });
        expect(mockSharp).toHaveBeenCalledWith(Buffer.from("raw-image-data"));
        expect(mockSharpPipeline.resize).toHaveBeenCalledWith(512, 512, {
            fit: "cover",
        });
        expect(mockSharpPipeline.rotate).toHaveBeenCalled();
        expect(mockSharpPipeline.jpeg).toHaveBeenCalledWith({ quality: 85 });
        expect(mockUserUpdate).toHaveBeenCalledWith({
            where: { id: "user-1" },
            data: { profilePicture: new Uint8Array(processedImageBuffer) },
        });
    });

    it("deletes the current profile picture", async () => {
        const res = await request(app)
            .delete("/api/settings/profile-picture")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true });
        expect(mockUserUpdate).toHaveBeenCalledWith({
            where: { id: "user-1" },
            data: { profilePicture: null },
        });
    });

    it.each([
        { method: "get", path: "/api/settings" },
        {
            method: "post",
            path: "/api/settings",
            body: { playbackQuality: "high" },
        },
        { method: "post", path: "/api/settings/cleanup-stale-jobs" },
        { method: "post", path: "/api/settings/profile-picture" },
        { method: "delete", path: "/api/settings/profile-picture" },
    ])("requires authentication for $method $path", async ({ method, path, body }) => {
        let testRequest = request(app)[method as "get" | "post" | "delete"](path);

        if (body) {
            testRequest = testRequest.send(body);
        }

        const res = await testRequest;

        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: "Not authenticated" });
    });

    it.each([
        {
            name: "invalid displayName characters",
            body: { displayName: "Jane@Doe" },
        },
        {
            name: "negative cache size",
            body: { maxCacheSizeMb: -1 },
        },
    ])("returns 400 for $name", async ({ body }) => {
        const res = await request(app)
            .post("/api/settings")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send(body);

        expect(res.status).toBe(400);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: "Invalid settings",
                details: expect.any(Array),
            })
        );
        expect(mockUserSettingsUpsert).not.toHaveBeenCalled();
    });
});
