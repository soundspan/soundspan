import crypto from "crypto";

/** Prefix identifying app-password credentials at the Subsonic password boundary. */
export const APP_PASSWORD_SECRET_PREFIX = "ssap_";

/** Maximum number of active app passwords accepted for one user. */
export const MAX_ACTIVE_APP_PASSWORDS = 20;

const APP_PASSWORD_RANDOM_BYTES = 24;

/** Generates a cryptographically random app-password secret for one-time display. */
export function generateAppPasswordSecret(): string {
    const random = crypto
        .randomBytes(APP_PASSWORD_RANDOM_BYTES)
        .toString("base64url");
    return `${APP_PASSWORD_SECRET_PREFIX}${random}`;
}
