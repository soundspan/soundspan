import crypto from "crypto";
import { z } from "zod";

export const RESTORE_CHUNK_SIZE_BYTES = 4 * 1024 * 1024;
export const MAX_RESTORE_SIZE_BYTES = 256 * 1024 * 1024 * 1024;
export const RESTORE_UPLOAD_ACTIVE_KEY = "restore:upload:active";
export const RESTORE_REPLICA_ID = crypto.randomBytes(32).toString("base64url");
const SESSION_PREFIX = "restore:upload:";

const uploadSessionSchema = z
    .object({
        uploadId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        replicaId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        sizeBytes: z.number().int().safe().min(1).max(MAX_RESTORE_SIZE_BYTES),
        totalChunks: z.number().int().safe().min(1),
        nextIndex: z.number().int().safe().nonnegative(),
        createdAt: z.number().int().safe().nonnegative(),
        expiresAt: z.number().int().safe().nonnegative(),
    })
    .strict()
    .refine(
        (session) =>
            session.totalChunks ===
                Math.ceil(session.sizeBytes / RESTORE_CHUNK_SIZE_BYTES) &&
            session.nextIndex <= session.totalChunks,
    );

export interface RestoreUploadSession {
    uploadId: string;
    replicaId: string;
    sizeBytes: number;
    totalChunks: number;
    nextIndex: number;
    createdAt: number;
    expiresAt: number;
}

export function restoreUploadSessionKey(uploadId: string): string {
    return `${SESSION_PREFIX}${uploadId}`;
}

export function safeCapabilityEqual(left: string, right: string): boolean {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return (
        leftBytes.length === rightBytes.length &&
        crypto.timingSafeEqual(leftBytes, rightBytes)
    );
}

export function parseRestoreUploadSession(
    raw: string,
): RestoreUploadSession | null {
    try {
        const parsed = uploadSessionSchema.safeParse(
            JSON.parse(raw) as unknown,
        );
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}
