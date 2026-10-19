import crypto from "crypto";
import fs from "fs/promises";
import { redisClient } from "../../utils/redis";
import { RestoreError } from "./backupErrors";
import { logger as rootLogger } from "../../utils/logger";
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

const SESSION_TTL_SECONDS = 15 * 60;
const REGISTRATION_REDIS_TIMEOUT_MS = 250;
const ADVANCE_SESSION_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return -1 end
local session = cjson.decode(raw)
local completed = tonumber(ARGV[1]) + 1
session.nextIndex = math.max(tonumber(session.nextIndex), completed)
session.expiresAt = tonumber(ARGV[2])
redis.call("SET", KEYS[1], cjson.encode(session), "EX", ARGV[3])
return session.nextIndex
`;
const logger = rootLogger.child("BackupRestore");

export interface RestoreUploadCreated {
    uploadId: string;
    chunkSizeBytes: number;
    totalChunks: number;
    expiresAt: string;
}

function uploadPath(uploadId: string): string {
    return restoreUploadPath(uploadId);
}

function completionKey(uploadId: string): string {
    return `restore:complete:${uploadId}`;
}

/** Reserve expensive completion validation for one caller per upload. */
export async function beginRestoreCompletion(uploadId: string): Promise<void> {
    const reserved = await redisClient.set(completionKey(uploadId), "1", {
        EX: SESSION_TTL_SECONDS,
        NX: true,
    });
    if (reserved !== "OK") {
        throw new RestoreError(
            "RESTORE_IN_PROGRESS",
            "A restore is already in progress",
        );
    }
}

/** Release completion validation after a non-destructive failure. */
export async function releaseRestoreCompletion(
    uploadId: string,
): Promise<void> {
    await redisClient.del(completionKey(uploadId));
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
    session.expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
    await redisClient.set(
        restoreUploadSessionKey(session.uploadId),
        JSON.stringify(session),
        {
            EX: SESSION_TTL_SECONDS,
        },
    );
    await redisClient.expire(RESTORE_UPLOAD_ACTIVE_KEY, SESSION_TTL_SECONDS);
}

async function advanceSession(uploadId: string, index: number): Promise<void> {
    const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
    const nextIndex = await redisClient.eval(ADVANCE_SESSION_SCRIPT, {
        keys: [restoreUploadSessionKey(uploadId)],
        arguments: [
            String(index),
            String(expiresAt),
            String(SESSION_TTL_SECONDS),
        ],
    });
    if (Number(nextIndex) < 0) {
        throw new RestoreError(
            "RESTORE_UPLOAD_NOT_FOUND",
            "Restore upload was not found",
        );
    }
    await redisClient.expire(RESTORE_UPLOAD_ACTIVE_KEY, SESSION_TTL_SECONDS);
}

function validateRestoreSize(sizeBytes: number): void {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
        throw new RestoreError("BACKUP_FORMAT_INVALID", "Invalid backup size");
    }
    if (sizeBytes > MAX_RESTORE_SIZE_BYTES) {
        throw new RestoreError(
            "BACKUP_TOO_LARGE",
            "Backup exceeds the size limit",
        );
    }
}

function newUploadSession(
    uploadId: string,
    sizeBytes: number,
): RestoreUploadSession {
    const createdAt = Date.now();
    return {
        uploadId,
        replicaId: RESTORE_REPLICA_ID,
        sizeBytes,
        totalChunks: Math.ceil(sizeBytes / RESTORE_CHUNK_SIZE_BYTES),
        nextIndex: 0,
        createdAt,
        expiresAt: createdAt + SESSION_TTL_SECONDS * 1000,
    };
}

async function reserveUpload(uploadId: string): Promise<void> {
    const locked = await redisClient.set(RESTORE_UPLOAD_ACTIVE_KEY, uploadId, {
        EX: SESSION_TTL_SECONDS,
        NX: true,
    });
    if (locked === "OK") return;
    throw new RestoreError(
        "RESTORE_IN_PROGRESS",
        "A restore is already in progress",
    );
}

async function createUploadFile(uploadId: string): Promise<void> {
    try {
        const handle = await fs.open(uploadPath(uploadId), "wx", 0o600);
        await handle.close();
    } catch (error) {
        await redisClient.del(RESTORE_UPLOAD_ACTIVE_KEY);
        await fs.unlink(uploadPath(uploadId)).catch(() => undefined);
        throw new RestoreError(
            "RESTORE_STAGING_UNAVAILABLE",
            "Restore staging storage is unavailable",
            { cause: error },
        );
    }
}

async function saveNewUpload(session: RestoreUploadSession): Promise<void> {
    try {
        await saveSession(session);
    } catch (error) {
        await redisClient.del(RESTORE_UPLOAD_ACTIVE_KEY);
        await fs.unlink(uploadPath(session.uploadId)).catch(() => undefined);
        throw error;
    }
}

/** Reserve the only active upload and create its sparse staging file. */
export async function createRestoreUpload(
    sizeBytes: number,
): Promise<RestoreUploadCreated> {
    validateRestoreSize(sizeBytes);
    await sweepRestoreStaging();
    await ensureRestoreStorage(sizeBytes);
    const uploadId = crypto.randomBytes(32).toString("base64url");
    const session = newUploadSession(uploadId, sizeBytes);
    await reserveUpload(uploadId);
    await createUploadFile(uploadId);
    await saveNewUpload(session);
    return {
        uploadId,
        chunkSizeBytes: RESTORE_CHUNK_SIZE_BYTES,
        totalChunks: session.totalChunks,
        expiresAt: new Date(session.expiresAt).toISOString(),
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
    bytes: unknown,
): Promise<void> {
    if (!(bytes instanceof Buffer)) {
        throw new RestoreError(
            "RESTORE_CHUNK_SIZE",
            "Restore chunk size is invalid",
        );
    }
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
        bytes.byteLength !== expectedChunkSize(session, index)
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
            bytes.byteLength,
            index * RESTORE_CHUNK_SIZE_BYTES,
        );
        if (result.bytesWritten !== bytes.byteLength) {
            throw new Error("Restore chunk write was incomplete");
        }
    } finally {
        await handle.close();
    }
    await advanceSession(uploadId, index);
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

export async function getActiveRestoreUpload(): Promise<{
    expiresAt: string;
} | null> {
    const uploadId = await redisClient.get(RESTORE_UPLOAD_ACTIVE_KEY);
    if (!uploadId) return null;
    const raw = await redisClient.get(restoreUploadSessionKey(uploadId));
    if (!raw) return null;
    const session = parseRestoreUploadSession(raw);
    if (!session || session.expiresAt <= Date.now()) return null;
    return { expiresAt: new Date(session.expiresAt).toISOString() };
}

export async function hasActiveRestoreUpload(): Promise<boolean> {
    return (await getActiveRestoreUpload()) !== null;
}

/** Check upload liveness without allowing Redis to block first registration. */
export async function hasActiveRestoreUploadForRegistration(): Promise<boolean> {
    if (!redisClient.isReady) return false;
    let timeoutId: NodeJS.Timeout | undefined;
    try {
        const read = async (): Promise<boolean> => {
            const uploadId = await redisClient.sendCommand(
                ["GET", RESTORE_UPLOAD_ACTIVE_KEY],
                { timeout: REGISTRATION_REDIS_TIMEOUT_MS },
            );
            if (typeof uploadId !== "string") return false;
            const raw = await redisClient.sendCommand(
                ["GET", restoreUploadSessionKey(uploadId)],
                { timeout: REGISTRATION_REDIS_TIMEOUT_MS },
            );
            if (typeof raw !== "string") return false;
            const session = parseRestoreUploadSession(raw);
            return session !== null && session.expiresAt > Date.now();
        };
        const timeout = new Promise<never>((_resolve, reject) => {
            timeoutId = setTimeout(
                () => reject(new Error("Restore upload check timed out")),
                REGISTRATION_REDIS_TIMEOUT_MS,
            );
            timeoutId.unref();
        });
        return await Promise.race([read(), timeout]);
    } catch (error) {
        logger.warn(
            "Could not check active restore upload during registration",
            error,
        );
        return false;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

export async function releaseRestoreUpload(uploadId: string): Promise<void> {
    await releaseRestoreCompletion(uploadId);
    await redisClient.del(restoreUploadSessionKey(uploadId));
    const active = await redisClient.get(RESTORE_UPLOAD_ACTIVE_KEY);
    if (active && safeCapabilityEqual(active, uploadId))
        await redisClient.del(RESTORE_UPLOAD_ACTIVE_KEY);
}
