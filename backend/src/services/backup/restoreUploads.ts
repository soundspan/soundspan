import crypto from "crypto";
import fs from "fs/promises";
import { redisClient } from "../../utils/redis";
import { RestoreError } from "./backupErrors";
import {
    ensureRestoreStorage,
    restoreUploadPath,
    sweepRestoreStaging,
} from "./restoreStaging";
export { restoreStagingDirectory, sweepRestoreStaging } from "./restoreStaging";
import {
    MAX_RESTORE_SIZE_BYTES,
    parseRestoreUploadSession,
    RESTORE_CHUNK_SIZE_BYTES,
    RESTORE_REPLICA_ID,
    RESTORE_UPLOAD_ACTIVE_KEY,
    restoreUploadSessionKey,
    safeCapabilityEqual,
    type RestoreUploadSession,
} from "./restoreUploadMetadata";
export {
    MAX_RESTORE_SIZE_BYTES,
    RESTORE_CHUNK_SIZE_BYTES,
    type RestoreUploadSession,
} from "./restoreUploadMetadata";

const SESSION_TTL_SECONDS = 60 * 60;

export interface RestoreUploadCreated {
    uploadId: string;
    chunkSizeBytes: number;
    totalChunks: number;
    expiresAt: string;
}

function uploadPath(uploadId: string): string {
    return restoreUploadPath(uploadId);
}

async function readSession(uploadId: string): Promise<RestoreUploadSession> {
    const raw = await redisClient.get(restoreUploadSessionKey(uploadId));
    if (!raw) {
        throw new RestoreError(
            "RESTORE_UPLOAD_NOT_FOUND",
            "Restore upload was not found",
        );
    }
    const session = parseRestoreUploadSession(raw);
    if (!session) {
        throw new RestoreError(
            "RESTORE_UPLOAD_NOT_FOUND",
            "Restore upload was not found",
        );
    }
    if (!safeCapabilityEqual(session.uploadId, uploadId)) {
        throw new RestoreError(
            "RESTORE_UPLOAD_NOT_FOUND",
            "Restore upload was not found",
        );
    }
    const activeUploadId = await redisClient.get(RESTORE_UPLOAD_ACTIVE_KEY);
    if (!activeUploadId || !safeCapabilityEqual(activeUploadId, uploadId)) {
        throw new RestoreError(
            "RESTORE_UPLOAD_NOT_FOUND",
            "Restore upload was not found",
        );
    }
    if (!safeCapabilityEqual(session.replicaId, RESTORE_REPLICA_ID)) {
        throw new RestoreError(
            "RESTORE_UPLOAD_WRONG_REPLICA",
            "Restore upload is assigned to another replica",
        );
    }
    return session;
}

async function saveSession(session: RestoreUploadSession): Promise<void> {
    await redisClient.set(
        restoreUploadSessionKey(session.uploadId),
        JSON.stringify(session),
        {
            EX: SESSION_TTL_SECONDS,
        },
    );
    await redisClient.expire(RESTORE_UPLOAD_ACTIVE_KEY, SESSION_TTL_SECONDS);
}

/** Reserve the only active upload and create its sparse staging file. */
export async function createRestoreUpload(
    sizeBytes: number,
): Promise<RestoreUploadCreated> {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
        throw new RestoreError("BACKUP_FORMAT_INVALID", "Invalid backup size");
    }
    if (sizeBytes > MAX_RESTORE_SIZE_BYTES) {
        throw new RestoreError(
            "BACKUP_TOO_LARGE",
            "Backup exceeds the size limit",
        );
    }
    await sweepRestoreStaging();
    await ensureRestoreStorage(sizeBytes);
    const uploadId = crypto.randomBytes(32).toString("base64url");
    const locked = await redisClient.set(RESTORE_UPLOAD_ACTIVE_KEY, uploadId, {
        EX: SESSION_TTL_SECONDS,
        NX: true,
    });
    if (locked !== "OK") {
        throw new RestoreError(
            "RESTORE_IN_PROGRESS",
            "A restore is already in progress",
        );
    }
    const createdAt = Date.now();
    const session: RestoreUploadSession = {
        uploadId,
        replicaId: RESTORE_REPLICA_ID,
        sizeBytes,
        totalChunks: Math.ceil(sizeBytes / RESTORE_CHUNK_SIZE_BYTES),
        nextIndex: 0,
        createdAt,
    };
    try {
        const handle = await fs.open(uploadPath(uploadId), "wx", 0o600);
        await handle.close();
        await saveSession(session);
    } catch (error) {
        await redisClient.del(RESTORE_UPLOAD_ACTIVE_KEY);
        await fs.unlink(uploadPath(uploadId)).catch(() => undefined);
        throw error;
    }
    return {
        uploadId,
        chunkSizeBytes: RESTORE_CHUNK_SIZE_BYTES,
        totalChunks: session.totalChunks,
        expiresAt: new Date(
            createdAt + SESSION_TTL_SECONDS * 1000,
        ).toISOString(),
    };
}

function expectedChunkSize(
    session: RestoreUploadSession,
    index: number,
): number {
    if (index < session.totalChunks - 1) return RESTORE_CHUNK_SIZE_BYTES;
    return session.sizeBytes - index * RESTORE_CHUNK_SIZE_BYTES;
}

/** Write or idempotently replace one bounded chunk at its deterministic offset. */
export async function writeRestoreChunk(
    uploadId: string,
    index: number,
    bytes: Buffer,
): Promise<void> {
    const session = await readSession(uploadId);
    if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index > session.nextIndex
    ) {
        throw new RestoreError(
            "RESTORE_CHUNK_OUT_OF_ORDER",
            "Restore chunk is out of order",
        );
    }
    if (
        index >= session.totalChunks ||
        bytes.length !== expectedChunkSize(session, index)
    ) {
        throw new RestoreError(
            "RESTORE_CHUNK_SIZE",
            "Restore chunk size is invalid",
        );
    }
    const handle = await fs.open(uploadPath(uploadId), "r+");
    try {
        const result = await handle.write(
            bytes,
            0,
            bytes.length,
            index * RESTORE_CHUNK_SIZE_BYTES,
        );
        if (result.bytesWritten !== bytes.length) {
            throw new Error("Restore chunk write was incomplete");
        }
    } finally {
        await handle.close();
    }
    if (index === session.nextIndex) session.nextIndex += 1;
    await saveSession(session);
}

/** Resolve a complete upload to its local staged path. */
export async function completeRestoreUpload(uploadId: string): Promise<string> {
    const session = await readSession(uploadId);
    if (session.nextIndex !== session.totalChunks) {
        throw new RestoreError(
            "RESTORE_INCOMPLETE_UPLOAD",
            "Restore upload is incomplete",
        );
    }
    return uploadPath(uploadId);
}

/** Atomically consume a validated complete upload before starting its job. */
export async function claimCompletedRestoreUpload(
    uploadId: string,
): Promise<string> {
    const raw = await redisClient.getDel(restoreUploadSessionKey(uploadId));
    if (!raw) {
        const active = await redisClient.get(RESTORE_UPLOAD_ACTIVE_KEY);
        if (active && safeCapabilityEqual(active, uploadId)) {
            throw new RestoreError(
                "RESTORE_IN_PROGRESS",
                "A restore is already in progress",
            );
        }
        throw new RestoreError(
            "RESTORE_UPLOAD_NOT_FOUND",
            "Restore upload was not found",
        );
    }
    const session = parseRestoreUploadSession(raw);
    if (!session || !safeCapabilityEqual(session.uploadId, uploadId)) {
        throw new RestoreError(
            "RESTORE_UPLOAD_NOT_FOUND",
            "Restore upload was not found",
        );
    }
    const active = await redisClient.get(RESTORE_UPLOAD_ACTIVE_KEY);
    if (!active || !safeCapabilityEqual(active, uploadId)) {
        throw new RestoreError(
            "RESTORE_UPLOAD_NOT_FOUND",
            "Restore upload was not found",
        );
    }
    if (!safeCapabilityEqual(session.replicaId, RESTORE_REPLICA_ID)) {
        throw new RestoreError(
            "RESTORE_UPLOAD_WRONG_REPLICA",
            "Restore upload is assigned to another replica",
        );
    }
    if (session.nextIndex !== session.totalChunks) {
        throw new RestoreError(
            "RESTORE_INCOMPLETE_UPLOAD",
            "Restore upload is incomplete",
        );
    }
    await redisClient.del(RESTORE_UPLOAD_ACTIVE_KEY);
    return uploadPath(uploadId);
}

/** Cancel an upload and report whether a matching session existed. */
export async function cancelRestoreUpload(uploadId: string): Promise<boolean> {
    const raw = await redisClient.get(restoreUploadSessionKey(uploadId));
    let cancelled = false;
    if (raw) {
        const session = parseRestoreUploadSession(raw);
        if (session && safeCapabilityEqual(session.uploadId, uploadId)) {
            cancelled = true;
            await fs.unlink(uploadPath(uploadId)).catch(() => undefined);
        }
    }
    await redisClient.del(restoreUploadSessionKey(uploadId));
    const active = await redisClient.get(RESTORE_UPLOAD_ACTIVE_KEY);
    if (active && safeCapabilityEqual(active, uploadId))
        await redisClient.del(RESTORE_UPLOAD_ACTIVE_KEY);
    return cancelled;
}

export async function hasActiveRestoreUpload(): Promise<boolean> {
    return (await redisClient.exists(RESTORE_UPLOAD_ACTIVE_KEY)) === 1;
}

export async function releaseRestoreUpload(uploadId: string): Promise<void> {
    await redisClient.del(restoreUploadSessionKey(uploadId));
    const active = await redisClient.get(RESTORE_UPLOAD_ACTIVE_KEY);
    if (active && safeCapabilityEqual(active, uploadId))
        await redisClient.del(RESTORE_UPLOAD_ACTIVE_KEY);
}
