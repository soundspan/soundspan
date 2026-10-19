import assert from "node:assert/strict";
import { test } from "node:test";
import { uploadBackupFile } from "../../features/backup/restoreUploader";
import type { RestoreUploadSession } from "../../lib/api/backup";

function session(
    chunkSizeBytes: number,
    totalChunks: number,
): RestoreUploadSession {
    return {
        uploadId: "upload-1",
        chunkSizeBytes,
        totalChunks,
        expiresAt: "2030-01-01T00:00:00.000Z",
    };
}

function transient(): Error {
    return Object.assign(new Error("bad gateway"), { status: 502, data: {} });
}

test("uploads every chunk in order with exact byte ranges", async () => {
    const file = new Blob(["abcdefghij"]);
    const sent: Array<{ index: number; text: string }> = [];
    const progress: number[] = [];
    await uploadBackupFile({
        file,
        session: session(4, 3),
        uploadChunk: async (_id, index, chunk) => {
            sent.push({ index, text: await chunk.text() });
        },
        onProgress: (bytes) => progress.push(bytes),
        signal: new AbortController().signal,
    });
    assert.deepEqual(sent, [
        { index: 0, text: "abcd" },
        { index: 1, text: "efgh" },
        { index: 2, text: "ij" },
    ]);
    assert.deepEqual(progress, [4, 8, 10]);
});

test("retries a transient chunk failure, then continues", async () => {
    const attempts: number[] = [];
    const waits: number[] = [];
    await uploadBackupFile({
        file: new Blob(["abcd"]),
        session: session(4, 1),
        uploadChunk: async (_id, index) => {
            attempts.push(index);
            if (attempts.length === 1) throw transient();
        },
        onProgress: () => undefined,
        signal: new AbortController().signal,
        wait: async (ms) => {
            waits.push(ms);
        },
    });
    assert.deepEqual(attempts, [0, 0]);
    assert.deepEqual(waits, [1000]);
});

test("gives up after the bounded number of attempts", async () => {
    let attempts = 0;
    await assert.rejects(
        uploadBackupFile({
            file: new Blob(["abcd"]),
            session: session(4, 1),
            uploadChunk: async () => {
                attempts += 1;
                throw transient();
            },
            onProgress: () => undefined,
            signal: new AbortController().signal,
            wait: async () => undefined,
        }),
        /bad gateway/,
    );
    assert.equal(attempts, 3);
});

test("does not retry contract errors", async () => {
    let attempts = 0;
    const wrongReplica = Object.assign(new Error("wrong replica"), {
        status: 409,
        data: { code: "RESTORE_UPLOAD_WRONG_REPLICA" },
    });
    await assert.rejects(
        uploadBackupFile({
            file: new Blob(["abcd"]),
            session: session(4, 1),
            uploadChunk: async () => {
                attempts += 1;
                throw wrongReplica;
            },
            onProgress: () => undefined,
            signal: new AbortController().signal,
            wait: async () => undefined,
        }),
        /wrong replica/,
    );
    assert.equal(attempts, 1);
});

test("rejects a session that doesn't fit the file", async () => {
    await assert.rejects(
        uploadBackupFile({
            file: new Blob(["abcdefghij"]),
            session: session(4, 2),
            uploadChunk: async () => undefined,
            onProgress: () => undefined,
            signal: new AbortController().signal,
        }),
        /different upload/,
    );
});

test("stops before the next chunk once cancelled", async () => {
    const abort = new AbortController();
    const sent: number[] = [];
    await assert.rejects(
        uploadBackupFile({
            file: new Blob(["abcdefgh"]),
            session: session(4, 2),
            uploadChunk: async (_id, index) => {
                sent.push(index);
                abort.abort();
            },
            onProgress: () => undefined,
            signal: abort.signal,
        }),
        (error: unknown) =>
            error instanceof DOMException && error.name === "AbortError",
    );
    assert.deepEqual(sent, [0]);
});
