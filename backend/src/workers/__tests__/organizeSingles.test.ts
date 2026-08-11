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
            warn: jest.fn(),
            child: jest.fn(),
        };
        logger.child.mockReturnValue(logger);
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
        const tmpRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), "soundspan-org-"),
        );
        process.env = { ...originalEnv, MUSIC_PATH: tmpRoot };

        const soulseekAlbum = path.join(
            tmpRoot,
            "Soulseek",
            "Artist A - Album A (2020)",
        );
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
            "Track 1.mp3",
        );
        const marker = path.join(tmpRoot, ".soulseek-migrated");

        expect(fs.existsSync(migratedTrack)).toBe(true);
        expect(fs.existsSync(sourceTrack)).toBe(false);
        expect(fs.existsSync(marker)).toBe(true);
        expect(prisma.downloadJob.findMany).toHaveBeenCalled();
    });

    it("marks legacy slskd jobs failed and queue wrapper swallows errors", async () => {
        const tmpRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), "soundspan-org-"),
        );
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
            await expect(
                module.queueOrganizeSingles(),
            ).resolves.toBeUndefined();
            expect(logger.error).toHaveBeenCalledWith(
                "Organization failed",
                expect.any(Error),
            );
        } finally {
            process.chdir(previousCwd);
        }
    });

    it("skips migration work when marker already exists", async () => {
        const tmpRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), "soundspan-org-"),
        );
        process.env = { ...originalEnv, MUSIC_PATH: tmpRoot };
        fs.writeFileSync(path.join(tmpRoot, ".soulseek-migrated"), "done");

        const soulseekAlbum = path.join(
            tmpRoot,
            "Soulseek",
            "Artist A - Album A",
        );
        fs.mkdirSync(soulseekAlbum, { recursive: true });
        const sourceTrack = path.join(soulseekAlbum, "Track 1.mp3");
        fs.writeFileSync(sourceTrack, "audio");

        const { module } = loadOrganizeSingles();
        await module.organizeSingles();

        expect(fs.existsSync(sourceTrack)).toBe(true);
    });

    it("marks migration complete when Soulseek folder is absent", async () => {
        const tmpRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), "soundspan-org-"),
        );
        process.env = { ...originalEnv, MUSIC_PATH: tmpRoot };

        const { module } = loadOrganizeSingles();
        await module.organizeSingles();

        expect(fs.existsSync(path.join(tmpRoot, ".soulseek-migrated"))).toBe(
            true,
        );
    });

    it("falls back to MUSIC_PATH from ../.env when env var is unset", async () => {
        const root = fs.mkdtempSync(
            path.join(os.tmpdir(), "soundspan-org-root-"),
        );
        const cwdDir = path.join(root, "repo", "backend");
        const musicDir = path.join(root, "music");
        fs.mkdirSync(cwdDir, { recursive: true });
        fs.mkdirSync(musicDir, { recursive: true });
        fs.writeFileSync(
            path.join(root, "repo", ".env"),
            `MUSIC_PATH="${musicDir}"\n`,
        );

        const previousCwd = process.cwd();
        process.chdir(cwdDir);
        process.env = { ...originalEnv };
        delete process.env.MUSIC_PATH;

        try {
            const { module, sessionLog } = loadOrganizeSingles();
            await module.organizeSingles();
            expect(
                fs.existsSync(path.join(musicDir, ".soulseek-migrated")),
            ).toBe(true);
            expect(JSON.stringify(sessionLog.mock.calls)).not.toContain(
                musicDir,
            );
            expect(sessionLog).toHaveBeenCalledWith(
                "ORGANIZE",
                "Music path configured",
            );
        } finally {
            process.chdir(previousCwd);
        }
    });

    it("logs successful queue wrapper completion", async () => {
        const tmpRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), "soundspan-org-"),
        );
        process.env = { ...originalEnv, MUSIC_PATH: tmpRoot };

        const { module, logger } = loadOrganizeSingles();
        await module.queueOrganizeSingles();

        expect(logger.debug).toHaveBeenCalledWith("Organization complete");
    });

    it("swallows legacy cleanup lookup failures and logs warning", async () => {
        const tmpRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), "soundspan-org-"),
        );
        process.env = { ...originalEnv, MUSIC_PATH: tmpRoot };

        const { module, logger, sessionLog } = loadOrganizeSingles({
            legacyJobsError: new Error(
                "legacy lookup failed at /srv/music/private",
            ),
        });
        await module.organizeSingles();

        expect(sessionLog).toHaveBeenCalledWith(
            "ORGANIZE",
            "Failed to clean up legacy jobs (detail in server log)",
            "WARN",
        );
        expect(JSON.stringify(sessionLog.mock.calls)).not.toContain(
            "/srv/music/private",
        );
        expect(logger.warn).toHaveBeenCalledWith(
            "Failed to clean up legacy jobs",
            expect.any(Error),
        );
    });

    it("keeps migration directory failures and absolute paths out of the session log", async () => {
        const tmpRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), "soundspan-org-"),
        );
        process.env = { ...originalEnv, MUSIC_PATH: tmpRoot };
        const soulseekAlbum = path.join(
            tmpRoot,
            "Soulseek",
            "Artist A - Album A",
        );
        fs.mkdirSync(soulseekAlbum, { recursive: true });
        fs.writeFileSync(path.join(soulseekAlbum, "Track 1.mp3"), "audio");

        const { module, logger, sessionLog } = loadOrganizeSingles();
        const mkdirSpy = jest.spyOn(fs, "mkdirSync").mockImplementation(() => {
            throw new Error(`EACCES: denied ${tmpRoot}`);
        });

        try {
            await module.organizeSingles();
        } finally {
            mkdirSpy.mockRestore();
        }

        expect(JSON.stringify(sessionLog.mock.calls)).not.toContain(tmpRoot);
        expect(sessionLog).toHaveBeenCalledWith(
            "ORGANIZE",
            "Failed to create directory (detail in server log)",
            "WARN",
        );
        expect(logger.warn).toHaveBeenCalledWith(
            "Failed to create migration destination directory",
            expect.objectContaining({
                destDir: expect.stringContaining("Singles"),
                error: expect.any(Error),
            }),
        );
    });

    it("keeps file migration failures and source paths out of the session log", async () => {
        const tmpRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), "soundspan-org-"),
        );
        process.env = { ...originalEnv, MUSIC_PATH: tmpRoot };
        const soulseekAlbum = path.join(
            tmpRoot,
            "Soulseek",
            "Artist A - Album A",
        );
        fs.mkdirSync(soulseekAlbum, { recursive: true });
        fs.writeFileSync(path.join(soulseekAlbum, "Track 1.mp3"), "audio");

        const { module, logger, sessionLog } = loadOrganizeSingles();
        const copySpy = jest
            .spyOn(fs, "copyFileSync")
            .mockImplementation(() => {
                throw new Error(`EIO: failed ${tmpRoot}`);
            });

        try {
            await module.organizeSingles();
        } finally {
            copySpy.mockRestore();
        }

        expect(JSON.stringify(sessionLog.mock.calls)).not.toContain(tmpRoot);
        expect(sessionLog).toHaveBeenCalledWith(
            "ORGANIZE",
            "Failed to migrate file (detail in server log)",
            "WARN",
        );
        expect(logger.warn).toHaveBeenCalledWith(
            "Failed to migrate Soulseek file",
            expect.objectContaining({
                filePath: expect.stringContaining("Track 1.mp3"),
                error: expect.any(Error),
            }),
        );
    });
});
