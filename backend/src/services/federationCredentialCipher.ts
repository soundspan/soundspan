import { decrypt, encrypt } from "../utils/encryption";
import { isV2Envelope } from "../utils/encryptedColumns";

/** Encrypts an outbound peer token for persistence as a v2 AES-GCM envelope. */
export function encryptFederationOutboundToken(token: string): string {
    return encrypt(token);
}

/**
 * Decrypts a persisted outbound token. Non-v2 values pass through only so
 * rolling processes can read legacy plaintext while startup backfill runs.
 * A process that reaches readiness has already removed this compatibility case.
 */
export function decryptFederationOutboundToken(storedToken: string): string {
    return isV2Envelope(storedToken) ? decrypt(storedToken) : storedToken;
}
