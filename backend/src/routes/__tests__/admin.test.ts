import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

type AuthFailureMode = "ok" | "unauthorized" | "forbidden";

const mockAuthFailureState = { mode: "ok" as AuthFailureMode };

const mockRequireAuth = jest.fn(
    (_req: Request, res: Response, next: NextFunction) => {
        if (mockAuthFailureState.mode === "unauthorized") {
            return res.status(401).json({ error: "Unauthorized" });
        }

        return next();
    }
);

const mockRequireAdmin = jest.fn(
    (_req: Request, res: Response, next: NextFunction) => {
        if (mockAuthFailureState.mode === "forbidden") {
            return res.status(403).json({ error: "Forbidden" });
        }

        return next();
    }
);

const mockPrisma = {
    libraryHealthRecord: {
        findMany: jest.fn(),
        count: jest.fn(),
        delete: jest.fn(),
    },
};

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

jest.mock("../../middleware/auth", () => ({
    requireAuth: mockRequireAuth,
    requireAdmin: mockRequireAdmin,
}));

jest.mock("../../utils/db", () => ({
    prisma: mockPrisma,
}));

jest.mock("../../utils/logger", () => ({
    logger: mockLogger,
}));

import router from "../admin";

const mockFindMany = mockPrisma.libraryHealthRecord.findMany as jest.Mock;
const mockCount = mockPrisma.libraryHealthRecord.count as jest.Mock;
const mockDelete = mockPrisma.libraryHealthRecord.delete as jest.Mock;
const mockLoggerError = mockLogger.error as jest.Mock;

function createApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/admin", router);
    return app;
}

describe("admin routes", () => {
    const app = createApp();

    beforeEach(() => {
        jest.clearAllMocks();
        mockAuthFailureState.mode = "ok";

        mockFindMany.mockResolvedValue([
            {
                id: "record-1",
                trackId: "track-1",
                status: "MISSING_FROM_DISK",
                filePath: "/music/example.mp3",
                detail: null,
                detectedAt: new Date("2026-03-10T00:00:00.000Z"),
                updatedAt: new Date("2026-03-10T01:00:00.000Z"),
                track: {
                    id: "track-1",
                    title: "Example Track",
                    album: {
                        title: "Example Album",
                        artist: {
                            name: "Example Artist",
                        },
                    },
                },
            },
        ]);
        mockCount.mockResolvedValue(1);
        mockDelete.mockResolvedValue({ id: "record-1" });
    });

    it("GET /api/admin/library-health returns records with track details and total count", async () => {
        const response = await request(app).get("/api/admin/library-health");

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            records: [
                expect.objectContaining({
                    id: "record-1",
                    trackId: "track-1",
                    status: "MISSING_FROM_DISK",
                    track: {
                        id: "track-1",
                        title: "Example Track",
                        album: {
                            title: "Example Album",
                            artist: {
                                name: "Example Artist",
                            },
                        },
                    },
                }),
            ],
            total: 1,
        });
        expect(mockFindMany).toHaveBeenCalledWith({
            include: {
                track: {
                    select: {
                        id: true,
                        title: true,
                        album: {
                            select: {
                                title: true,
                                artist: {
                                    select: {
                                        name: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
            orderBy: {
                updatedAt: "desc",
            },
        });
        expect(mockCount).toHaveBeenCalledWith();
        expect(mockRequireAuth).toHaveBeenCalled();
        expect(mockRequireAdmin).toHaveBeenCalled();
    });

    it("GET /api/admin/library-health handles database errors gracefully", async () => {
        const error = new Error("database unavailable");
        mockFindMany.mockRejectedValueOnce(error);

        const response = await request(app).get("/api/admin/library-health");

        expect(response.status).toBe(500);
        expect(response.body).toEqual({
            error: "Failed to load library health records",
        });
        expect(mockLoggerError).toHaveBeenCalledWith("Get library health error:", error);
    });

    it("DELETE /api/admin/library-health/:recordId deletes the specified record", async () => {
        const response = await request(app).delete(
            "/api/admin/library-health/record-1"
        );

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true });
        expect(mockDelete).toHaveBeenCalledWith({
            where: {
                id: "record-1",
            },
        });
    });

    it("DELETE /api/admin/library-health/:recordId returns 404 if the record does not exist", async () => {
        mockDelete.mockRejectedValueOnce({ code: "P2025" });

        const response = await request(app).delete(
            "/api/admin/library-health/missing-record"
        );

        expect(response.status).toBe(404);
        expect(response.body).toEqual({
            error: "Library health record not found",
        });
        expect(mockLoggerError).not.toHaveBeenCalled();
    });

    it.each([
        ["GET /api/admin/library-health", "get", "/api/admin/library-health"],
        [
            "DELETE /api/admin/library-health/:recordId",
            "delete",
            "/api/admin/library-health/record-1",
        ],
    ] as const)(
        "%s requires admin middleware",
        async (_label, method, path) => {
            mockAuthFailureState.mode = "unauthorized";

            const unauthorizedResponse = await request(app)[method](path);

            expect(unauthorizedResponse.status).toBe(401);
            expect(unauthorizedResponse.body).toEqual({ error: "Unauthorized" });
            expect(mockRequireAuth).toHaveBeenCalled();
            expect(mockRequireAdmin).not.toHaveBeenCalled();
            expect(mockFindMany).not.toHaveBeenCalled();
            expect(mockCount).not.toHaveBeenCalled();
            expect(mockDelete).not.toHaveBeenCalled();

            jest.clearAllMocks();
            mockAuthFailureState.mode = "forbidden";

            const forbiddenResponse = await request(app)[method](path);

            expect(forbiddenResponse.status).toBe(403);
            expect(forbiddenResponse.body).toEqual({ error: "Forbidden" });
            expect(mockRequireAuth).toHaveBeenCalled();
            expect(mockRequireAdmin).toHaveBeenCalled();
            expect(mockFindMany).not.toHaveBeenCalled();
            expect(mockCount).not.toHaveBeenCalled();
            expect(mockDelete).not.toHaveBeenCalled();
        }
    );
});
