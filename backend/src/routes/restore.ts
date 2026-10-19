import path from "path";
import express, { Router } from "express";
import { z } from "zod";
import { resolveAppVersion } from "../config/appVersion";
import { asyncHandler } from "../middleware/asyncHandler";
import { parseRestoreChunk } from "../middleware/restoreChunkBody";
import {
    requireFreshInstall,
    requireNoRestoreJob,
} from "../middleware/restoreAvailability";
import {
    apiLimiter,
    restoreChunkLimiter,
    restoreMutationLimiter,
} from "../middleware/rateLimiter";
import { prisma } from "../utils/db";
import { sendRouteError } from "../utils/routeErrorResponse";
import { readBackupHeader } from "../services/backup/backupArchiveReader";
import { BackupError, RestoreError } from "../services/backup/backupErrors";
import { unwrapEncryptionKey } from "../services/backup/backupKeyWrap";
import {
    evaluateRestoreCompatibility,
    readImageMigrations,
} from "../services/backup/restoreCompatibility";
import {
    getRestoreStatus,
    setRestoreStatus,
    startRestoreJob,
} from "../services/backup/restoreJob";
import {
    cancelRestoreUpload,
    claimCompletedRestoreUpload,
    completeRestoreUpload,
    createRestoreUpload,
    getActiveRestoreUpload,
    beginRestoreCompletion,
    releaseRestoreCompletion,
    MAX_RESTORE_SIZE_BYTES,
    writeRestoreChunk,
} from "../services/backup/restoreUploads";
import { isRestartRequired } from "../services/backup/restartRequired";
import { isRestoreLockHeld } from "../services/backup/restoreLock";

const router = Router();
const BACKEND_ROOT = path.resolve(__dirname, "../..");
const uploadIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const sizeSchema = z.object({ sizeBytes: z.number().int().safe().min(1) });
const passphraseSchema = z.object({
    passphrase: z.string().min(12).max(1024),
});

async function usersExist(): Promise<boolean> {
    try {
        return (await prisma.user.count()) !== 0;
    } catch (error) {
        if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "P2021"
        ) {
            return false;
        }
        throw error;
    }
}

function isDirtyRestoreFailure(code: string | undefined): boolean {
    return code === "RESTORE_INTERRUPTED" || code === "RESTORE_CLEANUP_FAILED";
}

function statusForError(error: BackupError): number {
    if (error.code === "RESTORE_UPLOAD_NOT_FOUND") return 404;
    if (error.code === "BACKUP_TOO_LARGE") return 413;
    if (error.code === "INSUFFICIENT_STORAGE") return 507;
    if (error.code === "RESTORE_STAGING_UNAVAILABLE") return 507;
    if (error.code === "RESTORE_STATUS_UNAVAILABLE") return 503;
    if (
        error.code === "BACKUP_FORMAT_INVALID" ||
        error.code === "BACKUP_PASSPHRASE_INVALID" ||
        error.code === "RESTORE_CHUNK_SIZE"
    )
        return 400;
    if (error.code === "RESTORE_UNAVAILABLE") return 403;
    return 409;
}

function sendBackupError(res: express.Response, failure: unknown) {
    if (!(failure instanceof BackupError)) throw failure;
    return sendRouteError(res, statusForError(failure), failure.clientMessage, {
        code: failure.code,
    });
}

/**
 * @openapi
 * /api/restore/status:
 *   get:
 *     summary: Read fresh-install restore status
 *     tags: [Restore]
 *     security: []
 *     responses:
 *       200: { description: Restore status }
 */
router.get(
    "/status",
    apiLimiter,
    asyncHandler(async (_req, res) => {
        const jobActive = await isRestoreLockHeld();
        let status;
        try {
            status = await getRestoreStatus(jobActive);
        } catch (error) {
            return sendBackupError(res, error);
        }
        const [upload, restartRequired] = await Promise.all([
            getActiveRestoreUpload(),
            isRestartRequired(),
        ]);
        const userExists = jobActive ? false : await usersExist();
        const { error: jobFailure } = status;
        const state =
            status.state === "uploading" && !upload ? "idle" : status.state;
        if (userExists && !restartRequired) {
            const dirtyFailure = isDirtyRestoreFailure(jobFailure?.code);
            return res.json({
                available: false,
                state: dirtyFailure ? "failed" : state,
                restartRequired: false,
                progress: null,
                error: dirtyFailure ? jobFailure : null,
                summary: null,
                upload: null,
            });
        }
        res.json({
            available: !userExists && !upload && !jobActive,
            state,
            progress: status.progress,
            ["error"]: jobFailure,
            summary: status.summary,
            restartRequired,
            upload,
        });
    }),
);

/**
 * @openapi
 * /api/restore/uploads:
 *   post:
 *     summary: Create a chunked restore upload
 *     tags: [Restore]
 *     security: []
 *     responses:
 *       201: { description: Upload created }
 *       403: { description: Restore unavailable }
 *       409: { description: Restore in progress }
 *       413: { description: Backup too large }
 *       507: { description: Insufficient storage }
 */
router.post(
    "/uploads",
    restoreMutationLimiter,
    asyncHandler(async (req, res) => {
        if (!(await requireNoRestoreJob(res))) return;
        if (!(await requireFreshInstall(res))) return;
        const parsed = sizeSchema.safeParse(req.body);
        if (!parsed.success)
            return sendRouteError(res, 400, "Invalid backup size");
        if (parsed.data.sizeBytes > MAX_RESTORE_SIZE_BYTES) {
            return sendRouteError(res, 413, "Backup exceeds the size limit", {
                code: "BACKUP_TOO_LARGE",
            });
        }
        try {
            const created = await createRestoreUpload(parsed.data.sizeBytes);
            await setRestoreStatus({
                state: "uploading",
                progress: null,
                error: null,
                summary: null,
            });
            res.status(201).json(created);
        } catch (error) {
            sendBackupError(res, error);
        }
    }),
);

/**
 * @openapi
 * /api/restore/uploads/{uploadId}/chunks/{index}:
 *   put:
 *     summary: Upload one restore archive chunk
 *     tags: [Restore]
 *     security: []
 *     parameters:
 *       - { in: path, name: uploadId, required: true, schema: { type: string } }
 *       - { in: path, name: index, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Chunk stored }
 *       400: { description: Invalid chunk }
 *       403: { description: Restore unavailable }
 *       404: { description: Upload not found }
 *       409: { description: Chunk conflict }
 */
router.put(
    "/uploads/:uploadId/chunks/:index",
    restoreChunkLimiter,
    asyncHandler(async (_req, res, next) => {
        if (!(await requireNoRestoreJob(res))) return;
        if (!(await requireFreshInstall(res))) return;
        next();
    }),
    parseRestoreChunk,
    asyncHandler(async (req, res) => {
        const uploadId = uploadIdSchema.safeParse(req.params.uploadId);
        const index = z.coerce
            .number()
            .int()
            .safe()
            .nonnegative()
            .safeParse(req.params.index);
        if (!uploadId.success || !index.success || !Buffer.isBuffer(req.body)) {
            return sendRouteError(res, 400, "Restore chunk is invalid", {
                code: "RESTORE_CHUNK_SIZE",
            });
        }
        try {
            await writeRestoreChunk(uploadId.data, index.data, req.body);
            res.sendStatus(204);
        } catch (error) {
            sendBackupError(res, error);
        }
    }),
);

/**
 * @openapi
 * /api/restore/uploads/{uploadId}/complete:
 *   post:
 *     summary: Validate an uploaded backup and start restore
 *     tags: [Restore]
 *     security: []
 *     parameters:
 *       - { in: path, name: uploadId, required: true, schema: { type: string } }
 *     responses:
 *       202: { description: Restore started }
 *       400: { description: Invalid backup or passphrase }
 *       403: { description: Restore unavailable }
 *       409: { description: Incomplete or incompatible backup }
 */
router.post(
    "/uploads/:uploadId/complete",
    restoreMutationLimiter,
    asyncHandler(async (req, res) => {
        if (!(await requireNoRestoreJob(res))) return;
        if (!(await requireFreshInstall(res))) return;
        const uploadId = uploadIdSchema.safeParse(req.params.uploadId);
        const body = passphraseSchema.safeParse(req.body);
        if (!uploadId.success || !body.success) {
            return sendRouteError(res, 400, "Invalid restore request");
        }
        let completionReserved = false;
        try {
            await beginRestoreCompletion(uploadId.data);
            completionReserved = true;
            const filePath = await completeRestoreUpload(uploadId.data);
            const header = await readBackupHeader(filePath);
            const secrets = await unwrapEncryptionKey(
                header.wrappedKey,
                body.data.passphrase,
            );
            const image = await readImageMigrations(
                path.join(BACKEND_ROOT, "prisma", "migrations"),
            );
            const compatibility = evaluateRestoreCompatibility(
                header.migrations,
                image,
            );
            if (compatibility.outcome !== "ok") {
                throw new RestoreError(
                    compatibility.outcome,
                    "Backup migrations are incompatible with this image",
                );
            }
            await claimCompletedRestoreUpload(uploadId.data);
            const restoreId = await startRestoreJob({
                uploadId: uploadId.data,
                filePath,
                backupKey: secrets.key,
                backupPepperFingerprint: secrets.pepperFingerprint,
                macKey: secrets.macKey,
            });
            res.status(202).json({
                restoreId,
                backupCreatedAt: header.createdAt,
                backupAppVersion: header.appVersion,
                appVersion: resolveAppVersion(),
            });
        } catch (error) {
            if (completionReserved) {
                await releaseRestoreCompletion(uploadId.data).catch(
                    () => undefined,
                );
            }
            sendBackupError(res, error);
        }
    }),
);

/**
 * @openapi
 * /api/restore/uploads/{uploadId}:
 *   delete:
 *     summary: Cancel a restore upload
 *     tags: [Restore]
 *     security: []
 *     parameters:
 *       - { in: path, name: uploadId, required: true, schema: { type: string } }
 *     responses:
 *       204: { description: Upload cancelled }
 */
router.delete(
    "/uploads/:uploadId",
    restoreMutationLimiter,
    asyncHandler(async (req, res) => {
        const uploadId = uploadIdSchema.safeParse(req.params.uploadId);
        const cancelled = uploadId.success
            ? await cancelRestoreUpload(uploadId.data)
            : false;
        const status = await getRestoreStatus();
        if (cancelled && status.state === "uploading") {
            await setRestoreStatus({
                state: "idle",
                progress: null,
                error: null,
                summary: null,
            });
        }
        res.sendStatus(204);
    }),
);

export default router;
