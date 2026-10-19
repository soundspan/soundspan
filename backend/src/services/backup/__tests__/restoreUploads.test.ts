import fs from "fs/promises";
import os from "os";
import path from "path";

const mockValues = new Map<string, string>();
const mockRedis = {
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
    cancelRestoreUpload,
    claimCompletedRestoreUpload,
    completeRestoreUpload,
    createRestoreUpload,
    hasActiveRestoreUpload,
    MAX_RESTORE_SIZE_BYTES,
    RESTORE_CHUNK_SIZE_BYTES,
    writeRestoreChunk,
} from "../restoreUploads";

describe("restore uploads", () => {
    let directory: string;

    beforeEach(async () => {
        mockValues.clear();
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
});
