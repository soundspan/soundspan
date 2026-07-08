#!/usr/bin/env ts-node
/**
 * F28 backfill: hash existing plaintext API keys at rest.
 *
 * After the dual-validate code ships, new keys are stored hashed (`hmac:<hex>`)
 * and legacy plaintext keys keep working via the raw-key lookup fallback. This
 * script migrates the legacy rows so nothing readable remains, after which the
 * plaintext fallback can be removed. For each row it computes
 * `hashApiKey(plaintextKey)` and writes it back — existing device keys keep
 * working (no re-pairing), because the value is the hash of the same raw key.
 *
 * Idempotent: already-hashed rows (planApiKeyHashing → skip-hashed) are skipped.
 * DEFAULTS TO DRY-RUN — pass `--apply` to write. Requires the SAME pepper the app
 * runs with (API_KEY_PEPPER, or SETTINGS_ENCRYPTION_KEY / ENCRYPTION_KEY /
 * SESSION_SECRET). Compare the logged pepper fingerprint with the
 * `apiKeys.pepperFingerprint` field of GET /api/admin/secrets-status — they
 * MUST match, or the app cannot validate the hashes this script writes.
 *
 *   npx tsx scripts/hash-existing-api-keys.ts            # dry run (no writes)
 *   npx tsx scripts/hash-existing-api-keys.ts --apply    # hash plaintext keys
 *
 * ⚠️  Irreversible (can't un-hash). Take a database backup first. If you ever
 *     change the pepper after running this, all hashed keys stop validating.
 */
import { PrismaClient } from "@prisma/client";
import {
    getPepperFingerprint,
    getPepperSource,
    planApiKeyHashing,
} from "../src/utils/apiKeyHash";

const prisma = new PrismaClient();

async function run(apply: boolean): Promise<void> {
    console.log(
        `[hash-api-keys] starting (${apply ? "APPLY — writing" : "DRY RUN — no writes"})`
    );
    // Surface the pepper source AND a value fingerprint so a mismatch with the
    // running app (which would make every migrated key fail to validate) is
    // caught before --apply: the same source name with a different value in
    // the app env still shows up as a fingerprint difference vs the
    // apiKeys.pepperFingerprint field of GET /api/admin/secrets-status.
    const source = getPepperSource();
    console.log(
        `[hash-api-keys] pepper source: ${source ?? "(none — will fail)"}` +
            (source ? ` (fingerprint ${getPepperFingerprint()})` : "")
    );

    let rows = 0;
    let hashed = 0;
    let alreadyHashed = 0;

    const keys = await prisma.apiKey.findMany({ select: { id: true, key: true } });
    for (const row of keys) {
        rows += 1;
        const outcome = planApiKeyHashing(row.key);
        if (outcome.action === "skip-hashed") {
            alreadyHashed += 1;
            continue;
        }
        hashed += 1;
        if (apply) {
            await prisma.apiKey.update({
                where: { id: row.id },
                data: { key: outcome.value },
            });
        }
    }

    console.log(
        `[hash-api-keys] ${apply ? "complete" : "dry run complete"}: rows=${rows} hashed=${hashed} alreadyHashed=${alreadyHashed}`
    );
    if (!apply && hashed > 0) {
        console.log(
            "[hash-api-keys] re-run with --apply to write these changes (back up the database first)."
        );
    }
}

if (require.main === module) {
    const apply = process.argv.slice(2).includes("--apply");

    run(apply)
        .catch((error) => {
            console.error("[hash-api-keys] failed", error);
            process.exitCode = 1;
        })
        .finally(async () => {
            await prisma.$disconnect();
        });
}
