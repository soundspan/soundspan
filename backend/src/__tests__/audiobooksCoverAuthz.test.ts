import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";

export {};

const mockTempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "soundspan-audiobook-cover-"),
);
const mockMusicPath = path.join(mockTempRoot, "music");

const mockRequireAuthOrToken = jest.fn(
    async (req: any, res: any, next: any) => {
        if (req.headers["x-test-user"]) {
            req.user = { id: "user-1", username: "tester", role: "user" };
            return next();
        }
        return res.status(401).json({ error: "Not authenticated" });
    },
);

jest.mock("../middleware/auth", () => ({
    requireAuthOrToken: (req: any, res: any, next: any) =>
        mockRequireAuthOrToken(req, res, next),
}));

jest.mock("../middleware/rateLimiter", () => ({
    apiLimiter: (_req: any, _res: any, next: any) => next(),
    imageLimiter: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

const mockAudiobookshelfService = {
    getAllAudiobooks: jest.fn(),
    getAudiobook: jest.fn(),
    searchAudiobooks: jest.fn(),
    streamAudiobook: jest.fn(),
    updateProgress: jest.fn(),
};
jest.mock("../services/audiobookshelf", () => ({
    audiobookshelfService: mockAudiobookshelfService,
}));

const mockAudiobookCacheService = {
    syncAll: jest.fn(),
    getAudiobook: jest.fn(),
};
jest.mock("../services/audiobookCache", () => ({
    audiobookCacheService: mockAudiobookCacheService,
}));

const mockNotificationService = {
    notifySystem: jest.fn(),
};
jest.mock("../services/notificationService", () => ({
    notificationService: mockNotificationService,
}));

const mockGetSystemSettings = jest.fn(async () => ({}));
jest.mock("../utils/systemSettings", () => ({
    getSystemSettings: mockGetSystemSettings,
}));

const mockPrisma = {
    audiobook: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
    },
    audiobookProgress: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
    },
};
jest.mock("../utils/db", () => ({
    prisma: mockPrisma,
}));

jest.mock("../config", () => ({
    config: {
        music: {
            musicPath: mockMusicPath,
        },
    },
}));

import audiobooksRouter from "../routes/audiobooks";

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/audiobooks", audiobooksRouter);
    return app;
}

function writeCover(filePath: string, contents: Buffer): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
}

describe("audiobook cover authorization and path containment", () => {
    const originalFetch = global.fetch;
    const fetchMock = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        global.fetch = fetchMock;
        fs.rmSync(mockMusicPath, { recursive: true, force: true });
        fs.rmSync(path.join(mockTempRoot, "secrets"), {
            recursive: true,
            force: true,
        });
        fs.mkdirSync(mockMusicPath, { recursive: true });
        mockPrisma.audiobook.findUnique.mockResolvedValue(null);
        mockPrisma.audiobook.update.mockResolvedValue({});
        mockGetSystemSettings.mockResolvedValue({});
    });

    afterAll(() => {
        global.fetch = originalFetch;
        fs.rmSync(mockTempRoot, { recursive: true, force: true });
    });

    it("rejects unauthenticated cover requests", async () => {
        const response = await request(buildApp()).get(
            "/api/audiobooks/book-1/cover",
        );

        expect(response.status).toBe(401);
        expect(response.body).toEqual({ error: "Not authenticated" });
    });

    it("rejects path traversal in the audiobook ID", async () => {
        const secretBytes = Buffer.from("known-secret-image-bytes");
        writeCover(
            path.join(mockTempRoot, "secrets", "secret.jpg"),
            secretBytes,
        );

        const response = await request(buildApp())
            .get("/api/audiobooks/%2e%2e%2f%2e%2e%2fsecrets%2fsecret/cover")
            .set("x-test-user", "yes");

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: "Invalid audiobook ID" });
        expect(
            Buffer.isBuffer(response.body) && response.body.equals(secretBytes),
        ).toBe(false);
    });

    it("serves and back-fills a valid fallback cover", async () => {
        const coverBytes = Buffer.from("fallback-cover-bytes");
        const fallbackPath = path.join(
            mockMusicPath,
            "cover-cache",
            "audiobooks",
            "book-1.jpg",
        );
        writeCover(fallbackPath, coverBytes);

        const response = await request(buildApp())
            .get("/api/audiobooks/book-1/cover")
            .set("x-test-user", "yes");

        expect(response.status).toBe(200);
        expect(response.body).toEqual(coverBytes);
        expect(mockPrisma.audiobook.update).toHaveBeenCalledWith({
            where: { id: "book-1" },
            data: { localCoverPath: fallbackPath },
        });
    });

    it("does not reflect arbitrary request origins on served covers", async () => {
        const coverBytes = Buffer.from("fallback-cover-bytes");
        writeCover(
            path.join(mockMusicPath, "cover-cache", "audiobooks", "book-1.jpg"),
            coverBytes,
        );

        const response = await request(buildApp())
            .get("/api/audiobooks/book-1/cover")
            .set("x-test-user", "yes")
            .set("Origin", "https://evil.example");

        expect(response.status).toBe(200);
        // CORS headers are owned by the app-level cors() allowlist
        // middleware; the route handler must not reflect the origin itself.
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
        expect(
            response.headers["access-control-allow-credentials"],
        ).toBeUndefined();
    });

    it("serves a valid cover from the database path", async () => {
        const coverBytes = Buffer.from("database-cover-bytes");
        const localCoverPath = path.join(mockTempRoot, "db-cover.jpg");
        writeCover(localCoverPath, coverBytes);
        mockPrisma.audiobook.findUnique.mockResolvedValue({
            localCoverPath,
            coverUrl: null,
        });

        const response = await request(buildApp())
            .get("/api/audiobooks/book-1/cover")
            .set("x-test-user", "yes");

        expect(response.status).toBe(200);
        expect(response.body).toEqual(coverBytes);
        expect(mockPrisma.audiobook.update).not.toHaveBeenCalled();
    });

    it("returns 404 when no cover is available", async () => {
        const response = await request(buildApp())
            .get("/api/audiobooks/book-1/cover")
            .set("x-test-user", "yes");

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: "Cover not found" });
    });

    it("proxies a normal small remote cover", async () => {
        const coverBytes = Buffer.from("remote-cover-bytes");
        mockPrisma.audiobook.findUnique.mockResolvedValue({
            localCoverPath: null,
            coverUrl: "items/book-1/cover",
        });
        mockGetSystemSettings.mockResolvedValue({
            audiobookshelfUrl: "https://audiobooks.example",
            audiobookshelfApiKey: "abs-key",
        });
        fetchMock.mockResolvedValue(
            new Response(coverBytes, {
                status: 200,
                headers: { "content-type": "image/jpeg" },
            }),
        );

        const response = await request(buildApp())
            .get("/api/audiobooks/book-1/cover")
            .set("x-test-user", "yes");

        expect(response.status).toBe(200);
        expect(response.body).toEqual(coverBytes);
    });

    it("cancels an oversized streamed remote cover", async () => {
        const cancel = jest.fn();
        const oneMiBChunk = new Uint8Array(1024 * 1024);
        const chunks = Array.from({ length: 64 }, () => oneMiBChunk);
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                const chunk = chunks.shift();
                if (chunk) {
                    controller.enqueue(chunk);
                } else {
                    controller.close();
                }
            },
            cancel,
        });
        mockPrisma.audiobook.findUnique.mockResolvedValue({
            localCoverPath: null,
            coverUrl: "items/book-1/cover",
        });
        mockGetSystemSettings.mockResolvedValue({
            audiobookshelfUrl: "https://audiobooks.example",
            audiobookshelfApiKey: "abs-key",
        });
        fetchMock.mockResolvedValue(new Response(body, { status: 200 }));

        const response = await request(buildApp())
            .get("/api/audiobooks/book-1/cover")
            .set("x-test-user", "yes");

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: "Cover not found" });
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(chunks.length).toBeGreaterThan(0);
    });
});
