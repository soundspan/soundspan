import { Router } from "express";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import {
    ENCRYPTED_SETTINGS_COLUMNS,
    isV2Envelope,
    type EncryptedModelName,
} from "../utils/encryptedColumns";
import { getPepperFingerprint, isHashedApiKey } from "../utils/apiKeyHash";

const router = Router();

router.use(requireAuth, requireAdmin);

// Per-model row fetchers for the secrets-status check. Keyed by the same model
// names as ENCRYPTED_SETTINGS_COLUMNS so the column inventory stays the single
// source of truth; the `select` is driven by that inventory at call time.
const ENCRYPTED_MODEL_QUERIERS: Record<
    EncryptedModelName,
    (select: Record<string, boolean>) => Promise<Array<Record<string, unknown>>>
> = {
    user: (select) => prisma.user.findMany({ select }),
    userSettings: (select) => prisma.userSettings.findMany({ select }),
    systemSettings: (select) => prisma.systemSettings.findMany({ select }),
};

function isPrismaRecordNotFound(error: unknown): error is { code: string } {
    return Boolean(
        error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "P2025"
    );
}

/**
 * @openapi
 * /api/admin/library-health:
 *   get:
 *     summary: List library health records
 *     tags: [Admin]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Library health records returned successfully
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
router.get("/library-health", async (_req, res) => {
    try {
        const [records, total] = await Promise.all([
            prisma.libraryHealthRecord.findMany({
                include: {
                    track: {
                        select: {
                            id: true,
                            title: true,
                            album: {
                                select: {
                                    title: true,
                                    artist: {
                                        select: {
                                            name: true,
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                orderBy: {
                    updatedAt: "desc",
                },
            }),
            prisma.libraryHealthRecord.count(),
        ]);

        res.json({ records, total });
    } catch (error) {
        logger.error("Get library health error:", error);
        res.status(500).json({ error: "Failed to load library health records" });
    }
});

/**
 * @openapi
 * /api/admin/library-health/{recordId}:
 *   delete:
 *     summary: Dismiss a library health record
 *     tags: [Admin]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: recordId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Record dismissed successfully
 *       404:
 *         description: Library health record not found
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
router.delete("/library-health/:recordId", async (req, res) => {
    try {
        await prisma.libraryHealthRecord.delete({
            where: {
                id: req.params.recordId,
            },
        });

        res.json({ success: true });
    } catch (error) {
        if (isPrismaRecordNotFound(error)) {
            return res.status(404).json({ error: "Library health record not found" });
        }

        logger.error("Dismiss library health record error:", error);
        res.status(500).json({ error: "Failed to dismiss library health record" });
    }
});

/**
 * @openapi
 * /api/admin/secrets-status:
 *   get:
 *     summary: Report settings-cipher migration progress (legacy v1 vs authenticated v2)
 *     tags: [Admin]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Counts of encrypted settings values still on the legacy cipher vs migrated to v2
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Not an admin
 */
// GET /admin/secrets-status - how many encrypted settings columns are still on
// the legacy v1 (AES-256-CBC) cipher vs migrated to authenticated v2 GCM. Lets
// an operator know when the v1→v2 backfill is complete (legacy === 0) and it's
// safe to drop the legacy read path. Returns only counts — never secret values.
router.get("/secrets-status", async (_req, res) => {
    try {
        const byModel: Record<
            string,
            { total: number; v2: number; legacy: number }
        > = {};
        let total = 0;
        let v2 = 0;
        let legacy = 0;

        for (const [modelName, columns] of Object.entries(
            ENCRYPTED_SETTINGS_COLUMNS
        )) {
            const select: Record<string, boolean> = {};
            for (const column of columns) select[column] = true;

            const rows = await ENCRYPTED_MODEL_QUERIERS[
                modelName as EncryptedModelName
            ](select);

            let modelV2 = 0;
            let modelLegacy = 0;
            for (const row of rows) {
                for (const column of columns) {
                    const value = row[column];
                    if (typeof value !== "string" || value.length === 0) {
                        continue;
                    }
                    if (isV2Envelope(value)) modelV2 += 1;
                    else modelLegacy += 1;
                }
            }

            byModel[modelName] = {
                total: modelV2 + modelLegacy,
                v2: modelV2,
                legacy: modelLegacy,
            };
            total += modelV2 + modelLegacy;
            v2 += modelV2;
            legacy += modelLegacy;
        }

        // API keys at rest: hashed (hmac:<hex>) vs legacy plaintext rows.
        const apiKeyRows = await prisma.apiKey.findMany({
            select: { key: true },
        });
        let apiKeysHashed = 0;
        let apiKeysPlaintext = 0;
        for (const row of apiKeyRows) {
            if (isHashedApiKey(row.key)) apiKeysHashed += 1;
            else apiKeysPlaintext += 1;
        }

        res.json({
            settingsCipher: {
                total,
                v2,
                legacy,
                migrationComplete: legacy === 0,
                byModel,
            },
            apiKeys: {
                total: apiKeysHashed + apiKeysPlaintext,
                hashed: apiKeysHashed,
                plaintext: apiKeysPlaintext,
                migrationComplete: apiKeysPlaintext === 0,
                // Fingerprint of the pepper VALUE (not the value itself) —
                // compare with the hash-existing-api-keys backfill log to
                // catch a script-env vs app-env mismatch before --apply.
                pepperFingerprint: getPepperFingerprint(),
            },
        });
    } catch (error) {
        logger.error("Secrets status error:", error);
        res.status(500).json({ error: "Failed to compute secrets status" });
    }
});

export default router;
