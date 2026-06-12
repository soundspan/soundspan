import bcrypt from "bcrypt";

/**
 * Pre-hashed bcrypt constant for dummy comparisons.
 *
 * When a login attempt references a non-existent user, we still run
 * bcrypt.compare() against this hash so the response time is consistent
 * with the valid-user path. This prevents username enumeration via timing.
 *
 * The actual plaintext is irrelevant — it will never match any real input.
 */
export const DUMMY_PASSWORD_HASH =
    "$2b$10$x2/fHhMDUxrUBAYTZdgv.uk3ajC8D.c1G3SE1E1TqJsDcDyC0Eyxa";

/**
 * Run a dummy bcrypt comparison to equalize response timing.
 * The result is intentionally discarded.
 */
export async function runDummyBcrypt(): Promise<void> {
    await bcrypt.compare("dummy-password-never-matches", DUMMY_PASSWORD_HASH);
}
