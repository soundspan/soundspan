const mockReadFileSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockLoggerDebug = jest.fn();

jest.mock("fs", () => ({
    __esModule: true,
    default: {
        readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
        writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    },
}));

jest.mock("../logger", () => ({
    logger: {
        debug: (...args: unknown[]) => mockLoggerDebug(...args),
    },
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
            })
        );
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[ENV] Skipping .env sync: disabled by ENABLE_ENV_FILE_SYNC=false"
        );
        expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("skips writing in Kubernetes unless explicitly enabled", async () => {
        process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
        process.env.ENV_FILE_PATH = "/tmp/soundspan.env";

        await expect(writeEnvFile({ PORT: "3006" })).rejects.toEqual(
            expect.objectContaining({
                name: "EnvFileSyncSkippedError",
                message:
                    "running in Kubernetes without explicit ENABLE_ENV_FILE_SYNC=true",
            })
        );
        expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("skips implicit writes when resolved path is filesystem root", async () => {
        process.env.ENV_FILE_PATH = "/.env";

        await expect(writeEnvFile({ PORT: "3006" })).rejects.toBeInstanceOf(
            EnvFileSyncSkippedError
        );
        expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("uses default path based on cwd when ENV_FILE_PATH is not set", async () => {
        const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue("/srv/backend");
        mockReadFileSync.mockImplementation(() => {
            throw new Error("ENOENT");
        });

        await writeEnvFile({ PORT: "3006" });

        expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
        expect(mockWriteFileSync).toHaveBeenCalledWith(
            "/srv/.env",
            expect.any(String),
            "utf-8"
        );
        cwdSpy.mockRestore();
    });

    it("creates a new env file when one does not exist", async () => {
        process.env.ENV_FILE_PATH = "/tmp/soundspan.env";
        mockReadFileSync.mockImplementation(() => {
            throw new Error("ENOENT");
        });

        await writeEnvFile({ PORT: "3006", EXTERNAL_API_URL: "https://api.example" });

        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "No existing .env file, creating new one"
        );
        expect(mockWriteFileSync).toHaveBeenCalledTimes(1);

        const written = String(mockWriteFileSync.mock.calls[0][1]);
        expect(written).toContain("# soundspan Environment Variables");
        expect(written).toContain("# Server");
        expect(written).toContain("PORT=3006");
        expect(written).toContain("# Other Variables");
        expect(written).toContain("EXTERNAL_API_URL=https://api.example");
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
            ].join("\n")
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
});
