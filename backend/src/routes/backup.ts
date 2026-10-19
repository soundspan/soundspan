import crypto from "crypto";
import { Router } from "express";
import { z } from "zod";
import { resolveAppVersion } from "../config/appVersion";
import {
    BACKUP_DOWNLOAD_TOKEN_PURPOSE,
    BACKUP_DOWNLOAD_TTL_SECONDS,
    generateBackupDownloadToken,
    requireAdmin,
    requireAuth,
    requireInteractiveSession,
    verifyAuthToken,
} from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { backupLimiter } from "../middleware/rateLimiter";
import { prisma } from "../utils/db";
import { readCookie } from "../utils/cookies";
import { logger as rootLogger } from "../utils/logger";
import { getSettingsEncryptionKey } from "../utils/encryption";
import { getPepperFingerprint } from "../utils/apiKeyHash";
import { putOnce, takeOnce } from "../utils/redisKv";
import { sendRouteError } from "../utils/routeErrorResponse";
import { wrapEncryptionKey } from "../services/backup/backupKeyWrap";
import type { WrappedEncryptionKey } from "../services/backup/backupFormat";
import { wrappedEncryptionKeySchema } from "../services/backup/backupFormat";
import {
    isBackupExportBusy,
    openBackupExport,
} from "../services/backup/backupExport";
import { BackupBusyError } from "../services/backup/backupErrors";
import { config } from "../config";
import { BRAND_SLUG } from "../config/brand";

const logger = rootLogger.child("BackupRestore");
const router = Router();
const COOKIE_BASE_NAME = "soundspan-backup";
const passphraseSchema = z.object({
    passphrase: z.string().min(12).max(1024),
});

interface DownloadSession {
    wrapped: WrappedEncryptionKey;
    macKey: string;
    userId: string;
}
const downloadSessionSchema = z
    .object({
        wrapped: wrappedEncryptionKeySchema,
        macKey: z.string().min(1).max(100_000),
        userId: z.string().min(1).max(1_000),
    })
    .strict();

function cookieName(): string {
    return config.secureCookies
        ? `__Secure-${COOKIE_BASE_NAME}`
        : COOKIE_BASE_NAME;
}

function cookieOptions() {
    return {
        httpOnly: true,
        sameSite: "strict" as const,
        secure: config.secureCookies,
        path: "/api/backup/download",
        maxAge: BACKUP_DOWNLOAD_TTL_SECONDS * 1000,
    };
}

function downloadKey(downloadId: string): string {
    return `backup:download:${downloadId}`;
}

/**
 * @openapi
 * /api/backup/session:
 *   post:
 *     summary: Create a one-use full database backup download session
 *     tags: [Backup]
 *     responses:
 *       204: { description: Backup session created }
 *       400: { description: Invalid passphrase }
 *       409: { description: Backup already in progress }
 */
router.post(
    "/session",
    backupLimiter,
    requireAuth,
    requireAdmin,
    requireInteractiveSession,
    asyncHandler(async (req, res) => {
        const parsed = passphraseSchema.safeParse(req.body);
        if (!parsed.success)
            return sendRouteError(res, 400, "Invalid passphrase");
        if (await isBackupExportBusy()) {
            return sendRouteError(res, 409, "A backup is already in progress", {
                code: "BACKUP_IN_PROGRESS",
            });
        }
        const key = getSettingsEncryptionKey();
        if (!req.user) throw new Error("Backup encryption key unavailable");
        const wrapped = await wrapEncryptionKey(
            key,
            parsed.data.passphrase,
            getPepperFingerprint(),
        );
        const downloadId = crypto.randomBytes(32).toString("base64url");
        const stored = await putOnce(
            downloadKey(downloadId),
            {
                wrapped: wrapped.wrappedKey,
                macKey: wrapped.macKey.toString("base64"),
                userId: req.user.id,
            } satisfies DownloadSession,
            BACKUP_DOWNLOAD_TTL_SECONDS,
        );
        if (!stored)
            throw new Error("Could not reserve backup download session");
        const user = await prisma.user.findUniqueOrThrow({
            where: { id: req.user.id },
            select: { id: true, tokenVersion: true },
        });
        res.cookie(
            cookieName(),
            generateBackupDownloadToken(user, downloadId),
            cookieOptions(),
        );
        res.sendStatus(204);
    }),
);

/**
 * @openapi
 * /api/backup/download:
 *   get:
 *     summary: Download a full data-only database backup
 *     tags: [Backup]
 *     responses:
 *       200: { description: Gzip-compressed backup stream }
 *       401: { description: Invalid or used download session }
 *       409: { description: Backup already in progress }
 */
router.get(
    "/download",
    backupLimiter,
    asyncHandler(async (req, res) => {
        const token = readCookie(req, cookieName());
        if (!token)
            return sendRouteError(res, 401, "Backup session is invalid");
        let payload;
        try {
            payload = verifyAuthToken(token);
        } catch {
            return sendRouteError(res, 401, "Backup session is invalid");
        }
        if (
            payload.purpose !== BACKUP_DOWNLOAD_TOKEN_PURPOSE ||
            !payload.downloadId ||
            payload.tokenVersion === undefined
        ) {
            return sendRouteError(res, 401, "Backup session is invalid");
        }
        const user = await prisma.user.findUnique({
            where: { id: payload.userId },
        });
        if (
            !user ||
            user.role !== "admin" ||
            user.tokenVersion !== payload.tokenVersion
        ) {
            return sendRouteError(res, 401, "Backup session is invalid");
        }
        const stored = downloadSessionSchema.safeParse(
            await takeOnce(downloadKey(payload.downloadId)),
        );
        res.clearCookie(cookieName(), cookieOptions());
        if (!stored.success || stored.data.userId !== user.id) {
            return sendRouteError(res, 401, "Backup session is invalid");
        }
        let exporter;
        try {
            exporter = await openBackupExport({
                wrappedKey: stored.data.wrapped,
                macKey: Buffer.from(stored.data.macKey, "base64"),
                appVersion: resolveAppVersion(),
            });
        } catch (error) {
            if (error instanceof BackupBusyError) {
                return sendRouteError(res, 409, error.clientMessage, {
                    code: error.code,
                });
            }
            throw error;
        }
        const stamp = new Date()
            .toISOString()
            .replace(
                /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/,
                "$1$2$3-$4$5$6Z",
            );
        res.status(200);
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${BRAND_SLUG}-backup-${stamp}.soundspan-backup"`,
        );
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.flushHeaders();
        try {
            await exporter.streamTo(res);
        } catch (error) {
            logger.error("Backup streaming failed", error);
            res.destroy();
        } finally {
            await exporter.close();
        }
    }),
);

export default router;
