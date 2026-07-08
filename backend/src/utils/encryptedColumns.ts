/**
 * Single source of truth for which database columns store values encrypted by
 * `utils/encryption` (the settings cipher). Both the secrets-status check
 * (`GET /api/admin/secrets-status`) and the v1→v2 re-encryption backfill
 * (`scripts/migrate-settings-to-gcm.ts`) read this list, so they can never
 * drift out of sync.
 *
 * When a new `encrypt()` / `encryptField()` write site is added in the app, add
 * its column here so the migration tooling keeps covering every encrypted value.
 * Keys are Prisma model delegate names; values are the encrypted column names on
 * that model.
 */
export const ENCRYPTED_SETTINGS_COLUMNS = {
    // twoFactorSecret / twoFactorRecoveryCodes use the same settings cipher via
    // the `encrypt2FASecret = encrypt` alias in routes/auth.ts — they must be
    // migrated and counted too, or `migrationComplete` would falsely report done
    // while legacy 2FA ciphertext lingers.
    user: ["subsonicPassword", "twoFactorSecret", "twoFactorRecoveryCodes"],
    userSettings: ["ytMusicOAuthJson", "tidalOAuthJson"],
    systemSettings: [
        "lidarrApiKey",
        "lidarrWebhookSecret",
        "openaiApiKey",
        "fanartApiKey",
        "lastfmApiKey",
        "audiobookshelfApiKey",
        "soulseekPassword",
        "spotifyClientSecret",
        "tidalAccessToken",
        "tidalRefreshToken",
        "ytMusicClientSecret",
    ],
} as const;

export type EncryptedModelName = keyof typeof ENCRYPTED_SETTINGS_COLUMNS;

/**
 * Primary-key column per tracked model. The v1→v2 backfill selects and updates
 * rows by this key — it is NOT `id` everywhere (`UserSettings` is keyed by
 * `userId`), so a hardcoded `id` would make Prisma reject the query and abort
 * the migration partway through the model list.
 */
export const ENCRYPTED_MODEL_PRIMARY_KEYS: Record<EncryptedModelName, string> =
    {
        user: "id",
        userSettings: "userId",
        systemSettings: "id",
    };

/**
 * Prefix of the current authenticated v2 envelope written by `utils/encryption`
 * (`v2:<saltHex>:<ivHex>:<tagHex>:<ctHex>`). Defined here, in a key-free module,
 * so the secrets-status check and the v1→v2 backfill can classify stored values
 * as migrated-or-not without importing the key-loading encryption module. Keep
 * in sync with `ENVELOPE_V2` in `utils/encryption.ts`.
 */
export const ENVELOPE_V2_PREFIX = "v2:";

/**
 * Whether a stored value is already in the authenticated v2 envelope (vs a
 * legacy v1/plaintext value still pending migration). Pure string check — no
 * decryption, no key required.
 */
export function isV2Envelope(value: string | null | undefined): boolean {
    return typeof value === "string" && value.startsWith(ENVELOPE_V2_PREFIX);
}
