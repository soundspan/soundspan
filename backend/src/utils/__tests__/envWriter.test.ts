const mockReadFileSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockChmodSync = jest.fn();
const mockRenameSync = jest.fn();
const mockUnlinkSync = jest.fn();
const mockLoggerDebug = jest.fn();
const mockLogger = {
    debug: (...args: unknown[]) => mockLoggerDebug(...args),
    child: jest.fn(),
};
mockLogger.child.mockReturnValue(mockLogger);

jest.mock("fs", () => ({
    __esModule: true,
    default: {
        readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
        writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
        chmodSync: (...args: unknown[]) => mockChmodSync(...args),
        renameSync: (...args: unknown[]) => mockRenameSync(...args),
        unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
    },
}));

jest.mock("../logger", () => ({
    logger: mockLogger,
}));

import { EnvFileSyncSkippedError, writeEnvFile } from "../envWriter";

describe("envWriter", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...originalEnv };
        delete process.env.ENABLE_ENV_FILE_SYNC;
        delete process.env.KUBERNETES_SERVICE_HOST;
        delete process.env.ENV_FILE_PATH;
        delete process.env.SECRETS_DB_ONLY;
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it("skips writing when ENABLE_ENV_FILE_SYNC is false", async () => {
        process.env.ENABLE_ENV_FILE_SYNC = "false";
        process.env.ENV_FILE_PATH = "/tmp/soundspan.env";

        await expect(writeEnvFile({ PORT: "3006" })).rejects.toEqual(
            expect.objectContaining({
                name: "EnvFileSyncSkippedError",
                message: "disabled by ENABLE_ENV_FILE_SYNC=false",
            }),
        );
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "Skipping .env sync: disabled by ENABLE_ENV_FILE_SYNC=false",
        );
        expect(mockWriteFileSync).not.toHaveBeenCalled();
        expect(mockChmodSync).not.toHaveBeenCalled();
        expect(mockRenameSync).not.toHaveBeenCalled();
    });

    it("skips writing in Kubernetes unless explicitly enabled", async () => {
        process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
        process.env.ENV_FILE_PATH = "/tmp/soundspan.env";

        await expect(writeEnvFile({ PORT: "3006" })).rejects.toEqual(
            expect.objectContaining({
                name: "EnvFileSyncSkippedError",
                message:
                    "running in Kubernetes without explicit ENABLE_ENV_FILE_SYNC=true",
            }),
        );
        expect(mockWriteFileSync).not.toHaveBeenCalled();
        expect(mockChmodSync).not.toHaveBeenCalled();
        expect(mockRenameSync).not.toHaveBeenCalled();
    });

    it("skips implicit writes when resolved path is filesystem root", async () => {
        process.env.ENV_FILE_PATH = "/.env";

        await expect(writeEnvFile({ PORT: "3006" })).rejects.toBeInstanceOf(
            EnvFileSyncSkippedError,
        );
        expect(mockWriteFileSync).not.toHaveBeenCalled();
        expect(mockChmodSync).not.toHaveBeenCalled();
        expect(mockRenameSync).not.toHaveBeenCalled();
    });

    it("uses default path based on cwd when ENV_FILE_PATH is not set", async () => {
        const cwdSpy = jest
            .spyOn(process, "cwd")
            .mockReturnValue("/srv/backend");
        mockReadFileSync.mockImplementation(() => {
            throw new Error("ENOENT");
        });

        await writeEnvFile({ PORT: "3006" });

        expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
        const tempPath = String(mockWriteFileSync.mock.calls[0][0]);
        expect(tempPath).toEqual(expect.stringContaining("/srv/.env.tmp-"));
        expect(mockWriteFileSync).toHaveBeenCalledWith(
            tempPath,
            expect.any(String),
            { encoding: "utf-8", mode: 0o600 },
        );
        expect(mockChmodSync).toHaveBeenCalledWith(tempPath, 0o600);
        expect(mockRenameSync).toHaveBeenCalledWith(tempPath, "/srv/.env");
        cwdSpy.mockRestore();
    });

    it("creates a new env file when one does not exist", async () => {
        process.env.ENV_FILE_PATH = "/tmp/soundspan.env";
        mockReadFileSync.mockImplementation(() => {
            throw new Error("ENOENT");
        });

        await writeEnvFile({
            PORT: "3006",
            EXTERNAL_API_URL: "https://api.example",
        });

        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "No existing .env file, creating new one",
        );
        expect(mockWriteFileSync).toHaveBeenCalledTimes(1);

        const written = String(mockWriteFileSync.mock.calls[0][1]);
        expect(written).toContain("# soundspan Environment Variables");
        expect(written).toContain("# Server");
        expect(written).toContain("PORT=3006");
        expect(written).toContain("# Other Variables");
        expect(written).toContain("EXTERNAL_API_URL=https://api.example");
    });

    it("writes integration secret keys when DB-only mode is off", async () => {
        process.env.ENV_FILE_PATH = "/tmp/soundspan.env";
        mockReadFileSync.mockImplementation(() => {
            throw new Error("ENOENT");
        });

        await writeEnvFile({
            FANART_API_KEY: "env-key-456",
            OPENAI_API_KEY: "env-openai-key-456",
        });

        const written = String(mockWriteFileSync.mock.calls[0][1]);
        expect(written).toContain("FANART_API_KEY=env-key-456");
        expect(written).toContain("OPENAI_API_KEY=env-openai-key-456");
    });

    it("omits incoming integration secret keys in DB-only mode", async () => {
        process.env.ENV_FILE_PATH = "/tmp/soundspan.env";
        process.env.SECRETS_DB_ONLY = "true";
        mockReadFileSync.mockImplementation(() => {
            throw new Error("ENOENT");
        });

        await writeEnvFile({
            FANART_API_KEY: "env-key-456",
            OPENAI_API_KEY: "env-openai-key-456",
            DATABASE_URL: "postgresql://db/soundspan",
        });

        const written = String(mockWriteFileSync.mock.calls[0][1]);
        expect(written).not.toContain("FANART_API_KEY=");
        expect(written).not.toContain("OPENAI_API_KEY=");
        expect(written).toContain("DATABASE_URL=postgresql://db/soundspan");
    });

    it("drops existing integration secrets but preserves URLs and database config in DB-only mode", async () => {
        process.env.ENV_FILE_PATH = "/tmp/soundspan.env";
        process.env.SECRETS_DB_ONLY = "true";
        mockReadFileSync.mockReturnValue(
            [
                "FANART_API_KEY=old-fanart-key-456",
                "AUDIOBOOKSHELF_API_KEY=old-abs-key-456",
                "AUDIOBOOKSHELF_URL=http://audiobookshelf:13378",
                "LIDARR_URL=http://lidarr:8686",
                "DATABASE_URL=postgresql://db/soundspan",
            ].join("\n"),
        );

        await writeEnvFile({});

        const written = String(mockWriteFileSync.mock.calls[0][1]);
        expect(written).not.toContain("FANART_API_KEY=");
        expect(written).not.toContain("AUDIOBOOKSHELF_API_KEY=");
        expect(written).toContain(
            "AUDIOBOOKSHELF_URL=http://audiobookshelf:13378",
        );
        expect(written).toContain("LIDARR_URL=http://lidarr:8686");
        expect(written).toContain("DATABASE_URL=postgresql://db/soundspan");
    });

    it("parses existing values, preserves uncategorized keys, and updates non-null values", async () => {
        process.env.ENV_FILE_PATH = "/tmp/soundspan.env";
        mockReadFileSync.mockReturnValue(
            [
                "# Existing",
                "DATABASE_URL=postgres://user:pass@db/app?sslmode=disable",
                "=missing-key-value-should-be-ignored",
                "CUSTOM_KEY=keep-me",
                "",
            ].join("\n"),
        );

        await writeEnvFile({
            DATABASE_URL: "postgres://new:value@db/newdb",
            REDIS_URL: "redis://cache:6379/0",
            CUSTOM_KEY: null,
            NEW_KEY: "new-value",
            LIDARR_ENABLED: undefined,
        });

        expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
        const written = String(mockWriteFileSync.mock.calls[0][1]);

        expect(written).toContain("# Database & Redis");
        expect(written).toContain("DATABASE_URL=postgres://new:value@db/newdb");
        expect(written).toContain("REDIS_URL=redis://cache:6379/0");
        expect(written).toContain("# Other Variables");
        expect(written).toContain("CUSTOM_KEY=keep-me");
        expect(written).toContain("NEW_KEY=new-value");
        expect(written).not.toContain("LIDARR_ENABLED=");
    });

    it("cleans up the temporary file and preserves the original error when rename fails", async () => {
        process.env.ENV_FILE_PATH = "/tmp/soundspan.env";
        const renameError = new Error("rename failed");
        mockRenameSync.mockImplementation(() => {
            throw renameError;
        });

        await expect(writeEnvFile({ PORT: "3006" })).rejects.toBe(renameError);

        const tempPath = String(mockWriteFileSync.mock.calls[0][0]);
        expect(tempPath).toEqual(
            expect.stringContaining("/tmp/soundspan.env.tmp-"),
        );
        expect(mockWriteFileSync).toHaveBeenCalledWith(
            tempPath,
            expect.any(String),
            { encoding: "utf-8", mode: 0o600 },
        );
        expect(mockChmodSync).toHaveBeenCalledWith(tempPath, 0o600);
        expect(mockRenameSync).toHaveBeenCalledWith(
            tempPath,
            "/tmp/soundspan.env",
        );
        expect(mockUnlinkSync).toHaveBeenCalledWith(tempPath);
        expect(mockWriteFileSync).not.toHaveBeenCalledWith(
            "/tmp/soundspan.env",
            expect.anything(),
            expect.anything(),
        );
    });
});
