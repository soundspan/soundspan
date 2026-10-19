import fs from "fs/promises";
import os from "os";
import path from "path";

const mockValues = new Map<string, string>();
const mockRedis = {
    isReady: true,
    set: jest.fn(
        async (key: string, value: string, options?: { NX?: boolean }) => {
            if (options?.NX && mockValues.has(key)) return null;
            mockValues.set(key, value);
            return "OK";
        },
    ),
    get: jest.fn(async (key: string) => mockValues.get(key) ?? null),
    getDel: jest.fn(async (key: string) => {
        const value = mockValues.get(key) ?? null;
        mockValues.delete(key);
        return value;
    }),
    del: jest.fn(async (key: string) => (mockValues.delete(key) ? 1 : 0)),
    expire: jest.fn(async () => true),
    exists: jest.fn(async (key: string) => (mockValues.has(key) ? 1 : 0)),
    sendCommand: jest.fn(async (args: readonly string[]) => {
        if (args[0] !== "GET") return null;
        return mockValues.get(args[1]!) ?? null;
    }),
};

let mockCachePath = "";
jest.mock("../../../config", () => ({
    config: {
        music: {
            get transcodeCachePath() {
                return mockCachePath;
            },
        },
    },
}));
jest.mock("../../../utils/redis", () => ({ redisClient: mockRedis }));

import {
    beginRestoreCompletion,
    cancelRestoreUpload,
    claimCompletedRestoreUpload,
    completeRestoreUpload,
    createRestoreUpload,
    hasActiveRestoreUpload,
    hasActiveRestoreUploadForRegistration,
    MAX_RESTORE_SIZE_BYTES,
    RESTORE_CHUNK_SIZE_BYTES,
    writeRestoreChunk,
    releaseRestoreCompletion,
} from "../restoreUploads";

describe("restore uploads", () => {
    let directory: string;

    beforeEach(async () => {
        mockValues.clear();
        mockRedis.isReady = true;
        jest.clearAllMocks();
        directory = await fs.mkdtemp(path.join(os.tmpdir(), "restore-upload-"));
        mockCachePath = path.join(directory, "transcodes");
    });

    afterEach(async () => {
        await fs.rm(directory, { recursive: true, force: true });
        jest.restoreAllMocks();
    });

    it("writes ordered chunks, permits re-send, and completes", async () => {
        const created = await createRestoreUpload(RESTORE_CHUNK_SIZE_BYTES + 3);
        const first = Buffer.alloc(RESTORE_CHUNK_SIZE_BYTES, 1);
        await writeRestoreChunk(created.uploadId, 0, first);
        await writeRestoreChunk(created.uploadId, 0, first);
        await writeRestoreChunk(created.uploadId, 1, Buffer.from([2, 3, 4]));
        await expect(
            completeRestoreUpload(created.uploadId),
        ).resolves.toContain(created.uploadId);
        await expect(
            claimCompletedRestoreUpload(created.uploadId),
        ).resolves.toContain(created.uploadId);
        await expect(hasActiveRestoreUpload()).resolves.toBe(false);
        await expect(
            claimCompletedRestoreUpload(created.uploadId),
        ).rejects.toMatchObject({ code: "RESTORE_UPLOAD_NOT_FOUND" });
    });

    it("rejects out-of-order and wrong-sized chunks", async () => {
        const created = await createRestoreUpload(RESTORE_CHUNK_SIZE_BYTES + 3);
        await expect(
            writeRestoreChunk(created.uploadId, 1, Buffer.from([1, 2, 3])),
        ).rejects.toMatchObject({ code: "RESTORE_CHUNK_OUT_OF_ORDER" });
        await expect(
            writeRestoreChunk(created.uploadId, 0, Buffer.alloc(2)),
        ).rejects.toMatchObject({ code: "RESTORE_CHUNK_SIZE" });
    });

    it("rejects a session owned by another replica", async () => {
        const created = await createRestoreUpload(1);
        const key = `restore:upload:${created.uploadId}`;
        const session = JSON.parse(mockValues.get(key)!) as Record<
            string,
            unknown
        >;
        mockValues.set(
            key,
            JSON.stringify({ ...session, replicaId: "x".repeat(43) }),
        );
        await expect(
            writeRestoreChunk(created.uploadId, 0, Buffer.from([1])),
        ).rejects.toMatchObject({ code: "RESTORE_UPLOAD_WRONG_REPLICA" });
    });

    it("treats a missing or expired session as not found", async () => {
        const created = await createRestoreUpload(1);
        mockValues.delete(`restore:upload:${created.uploadId}`);
        await expect(
            writeRestoreChunk(created.uploadId, 0, Buffer.from([1])),
        ).rejects.toMatchObject({ code: "RESTORE_UPLOAD_NOT_FOUND" });
    });

    it("allows only one active session", async () => {
        const created = await createRestoreUpload(1);
        await expect(createRestoreUpload(1)).rejects.toMatchObject({
            code: "RESTORE_IN_PROGRESS",
        });
        await expect(cancelRestoreUpload(created.uploadId)).resolves.toBe(true);
        await expect(createRestoreUpload(1)).resolves.toBeDefined();
    });

    it("allows only one completion attempt per upload", async () => {
        const created = await createRestoreUpload(1);
        await beginRestoreCompletion(created.uploadId);
        await expect(
            beginRestoreCompletion(created.uploadId),
        ).rejects.toMatchObject({
            code: "RESTORE_IN_PROGRESS",
        });
        await releaseRestoreCompletion(created.uploadId);
        await expect(
            beginRestoreCompletion(created.uploadId),
        ).resolves.toBeUndefined();
    });

    it("reports whether cancellation matched an existing session", async () => {
        const created = await createRestoreUpload(1);
        await expect(cancelRestoreUpload("x".repeat(43))).resolves.toBe(false);
        await expect(cancelRestoreUpload(created.uploadId)).resolves.toBe(true);
        await expect(cancelRestoreUpload(created.uploadId)).resolves.toBe(
            false,
        );
    });

    it("rejects the hard size bound before allocating", async () => {
        await expect(
            createRestoreUpload(MAX_RESTORE_SIZE_BYTES + 1),
        ).rejects.toMatchObject({ code: "BACKUP_TOO_LARGE" });
    });

    it("maps statfs failure to insufficient storage", async () => {
        jest.spyOn(fs, "statfs").mockRejectedValueOnce(
            new Error("statfs failed"),
        );
        await expect(createRestoreUpload(1)).rejects.toMatchObject({
            code: "INSUFFICIENT_STORAGE",
        });
    });

    it("uses a fifteen-minute idle expiry", async () => {
        jest.spyOn(Date, "now").mockReturnValue(1_000_000);
        const created = await createRestoreUpload(1);
        expect(created.expiresAt).toBe(
            new Date(1_000_000 + 15 * 60 * 1000).toISOString(),
        );
    });

    it("requires one GiB of free space after a small staged upload", async () => {
        jest.spyOn(fs, "statfs").mockResolvedValueOnce({
            bavail: 1024 * 1024,
            bsize: 1024,
        } as Awaited<ReturnType<typeof fs.statfs>>);
        await expect(createRestoreUpload(1)).rejects.toMatchObject({
            code: "INSUFFICIENT_STORAGE",
        });
    });

    it("maps an unwritable staging directory to a stable error", async () => {
        jest.spyOn(fs, "mkdir").mockRejectedValueOnce(
            Object.assign(new Error("read only"), { code: "EROFS" }),
        );
        await expect(createRestoreUpload(1)).rejects.toMatchObject({
            code: "RESTORE_STAGING_UNAVAILABLE",
        });
    });

    it("does not relabel Redis session failures as staging failures", async () => {
        mockRedis.set.mockResolvedValueOnce("OK").mockRejectedValueOnce(
            Object.assign(new Error("redis unavailable"), {
                code: "ECONNRESET",
            }),
        );

        await expect(createRestoreUpload(1)).rejects.toMatchObject({
            message: "redis unavailable",
            code: "ECONNRESET",
        });
    });

    it("fails open when the registration upload check stalls", async () => {
        jest.useFakeTimers();
        mockRedis.sendCommand.mockReturnValueOnce(new Promise(() => undefined));
        const pending = hasActiveRestoreUploadForRegistration();
        await jest.advanceTimersByTimeAsync(251);
        await expect(pending).resolves.toBe(false);
        jest.useRealTimers();
    });
});
