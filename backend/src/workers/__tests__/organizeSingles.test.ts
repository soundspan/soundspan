import fs from "fs";
import os from "os";
import path from "path";

describe("organizeSingles worker", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadOrganizeSingles(overrides?: {
        legacyJobs?: Array<{ id: string; subject: string }>;
        legacyJobsError?: Error;
    }) {
        const logger = {
            debug: jest.fn(),
            error: jest.fn(),
        };
        const sessionLog = jest.fn();
        const prisma = {
            downloadJob: {
                findMany: jest.fn(async () => {
                    if (overrides?.legacyJobsError) {
                        throw overrides.legacyJobsError;
                    }
                    return overrides?.legacyJobs ?? [];
                }),
                update: jest.fn(async () => undefined),
            },
        };

        jest.doMock("../../utils/logger", () => ({ logger }));
        jest.doMock("../../utils/playlistLogger", () => ({ sessionLog }));
        jest.doMock("../../utils/db", () => ({ prisma }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require("../organizeSingles");
        return { module, logger, prisma, sessionLog };
    }

    it("migrates soulseek files into Singles and marks migration complete", async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "soundspan-org-"));
        process.env = { ...originalEnv, MUSIC_PATH: tmpRoot };

        const soulseekAlbum = path.join(tmpRoot, "Soulseek", "Artist A - Album A (2020)");
        fs.mkdirSync(soulseekAlbum, { recursive: true });
        const sourceTrack = path.join(soulseekAlbum, "Track 1.mp3");
        fs.writeFileSync(sourceTrack, "audio");

        const { module, prisma } = loadOrganizeSingles();

        await module.organizeSingles();

        const migratedTrack = path.join(
            tmpRoot,
            "Singles",
            "Artist A",
            "Album A",
            "Track 1.mp3"
        );
        const marker = path.join(tmpRoot, ".soulseek-migrated");

        expect(fs.existsSync(migratedTrack)).toBe(true);
        expect(fs.existsSync(sourceTrack)).toBe(false);
        expect(fs.existsSync(marker)).toBe(true);
        expect(prisma.downloadJob.findMany).toHaveBeenCalled();
    });

    it("marks legacy slskd jobs failed and queue wrapper swallows errors", async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "soundspan-org-"));
        process.env = { ...originalEnv, MUSIC_PATH: tmpRoot };

        const { module, logger, prisma } = loadOrganizeSingles({
            legacyJobs: [{ id: "job-1", subject: "Legacy Album" }],
        });

        await module.organizeSingles();
        expect(prisma.downloadJob.update).toHaveBeenCalledWith({
            where: { id: "job-1" },
            data: {
                status: "failed",
                error: "SLSKD integration replaced with direct Soulseek connection",
                completedAt: expect.any(Date),
            },
        });

        delete process.env.MUSIC_PATH;
        const previousCwd = process.cwd();
        process.chdir(tmpRoot);
        try {
            await expect(module.queueOrganizeSingles()).resolves.toBeUndefined();
            expect(logger.error).toHaveBeenCalledWith(
                "[ORGANIZE] Organization failed:",
                "MUSIC_PATH is not set. Cannot organize downloads."
            );
        } finally {
            process.chdir(previousCwd);
        }
    });

    it("skips migration work when marker already exists", async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "soundspan-org-"));
        process.env = { ...originalEnv, MUSIC_PATH: tmpRoot };
        fs.writeFileSync(path.join(tmpRoot, ".soulseek-migrated"), "done");

        const soulseekAlbum = path.join(tmpRoot, "Soulseek", "Artist A - Album A");
        fs.mkdirSync(soulseekAlbum, { recursive: true });
        const sourceTrack = path.join(soulseekAlbum, "Track 1.mp3");
        fs.writeFileSync(sourceTrack, "audio");

        const { module } = loadOrganizeSingles();
        await module.organizeSingles();

        expect(fs.existsSync(sourceTrack)).toBe(true);
    });

    it("marks migration complete when Soulseek folder is absent", async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "soundspan-org-"));
        process.env = { ...originalEnv, MUSIC_PATH: tmpRoot };

        const { module } = loadOrganizeSingles();
        await module.organizeSingles();

        expect(fs.existsSync(path.join(tmpRoot, ".soulseek-migrated"))).toBe(true);
    });

    it("falls back to MUSIC_PATH from ../.env when env var is unset", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "soundspan-org-root-"));
        const cwdDir = path.join(root, "repo", "backend");
        const musicDir = path.join(root, "music");
        fs.mkdirSync(cwdDir, { recursive: true });
        fs.mkdirSync(musicDir, { recursive: true });
        fs.writeFileSync(path.join(root, "repo", ".env"), `MUSIC_PATH="${musicDir}"\n`);

        const previousCwd = process.cwd();
        process.chdir(cwdDir);
        process.env = { ...originalEnv };
        delete process.env.MUSIC_PATH;

        try {
            const { module } = loadOrganizeSingles();
            await module.organizeSingles();
            expect(fs.existsSync(path.join(musicDir, ".soulseek-migrated"))).toBe(true);
        } finally {
            process.chdir(previousCwd);
        }
    });

    it("logs successful queue wrapper completion", async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "soundspan-org-"));
        process.env = { ...originalEnv, MUSIC_PATH: tmpRoot };

        const { module, logger } = loadOrganizeSingles();
        await module.queueOrganizeSingles();

        expect(logger.debug).toHaveBeenCalledWith(
            "[ORGANIZE] Organization complete"
        );
    });

    it("swallows legacy cleanup lookup failures and logs warning", async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "soundspan-org-"));
        process.env = { ...originalEnv, MUSIC_PATH: tmpRoot };

        const { module, sessionLog } = loadOrganizeSingles({
            legacyJobsError: new Error("legacy lookup failed"),
        });
        await module.organizeSingles();

        expect(sessionLog).toHaveBeenCalledWith(
            "ORGANIZE",
            expect.stringContaining("Failed to clean up legacy jobs"),
            "WARN"
        );
    });
});
