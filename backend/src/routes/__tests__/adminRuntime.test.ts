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

jest.mock("../../utils/db", () => ({
    prisma: {
        libraryHealthRecord: {
            findMany: jest.fn(),
            count: jest.fn(),
            delete: jest.fn(),
        },
    },
}));

import router from "../admin";
import { prisma } from "../../utils/db";

const mockFindMany = prisma.libraryHealthRecord.findMany as jest.Mock;
const mockCount = prisma.libraryHealthRecord.count as jest.Mock;
const mockDelete = prisma.libraryHealthRecord.delete as jest.Mock;

function getHandler(path: string, method: "get" | "delete") {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
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

describe("admin library health routes", () => {
    const getLibraryHealthHandler = getHandler("/library-health", "get");
    const dismissLibraryHealthHandler = getHandler("/library-health/:recordId", "delete");

    beforeEach(() => {
        jest.clearAllMocks();
        mockCount.mockResolvedValue(1);
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
                        artist: { name: "Example Artist" },
                    },
                },
            },
        ]);
        mockDelete.mockResolvedValue({ id: "record-1" });
    });

    it("returns library health records for admins", async () => {
        const req = { user: { id: "admin-1" } } as any;
        const res = createRes();

        await getLibraryHealthHandler(req, res);

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
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            records: [
                expect.objectContaining({
                    id: "record-1",
                    trackId: "track-1",
                    track: expect.objectContaining({
                        title: "Example Track",
                    }),
                }),
            ],
            total: 1,
        });
    });

    it("dismisses a library health record", async () => {
        const req = { params: { recordId: "record-1" } } as any;
        const res = createRes();

        await dismissLibraryHealthHandler(req, res);

        expect(mockDelete).toHaveBeenCalledWith({
            where: { id: "record-1" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true });
    });
});
