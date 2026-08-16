import type { Response } from "express";
import { z } from "zod";
import { verify } from "otplib";
import crypto from "crypto";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { generateToken, generateRefreshToken } from "../../middleware/auth";
import { encrypt, decrypt } from "../../utils/encryption";
import { timingSafeCompare } from "../../utils/timingSafe";
import type { LoginUser } from "../../services/oidcAccountResolution";

async function verifyTotpToken(
    secret: string,
    token: string,
): Promise<boolean> {
    if (
        typeof secret !== "string" ||
        typeof token !== "string" ||
        !/^\d{6}$/.test(token)
    ) {
        return false;
    }

    try {
        // 60 seconds of epoch tolerance matches the former speakeasy window of 2.
        const result = await verify({ secret, token, epochTolerance: 60 });
        return result.valid;
    } catch {
        // Deliberately fail closed when otplib rejects a malformed secret.
        return false;
    }
}

// Use shared encryption module for 2FA secrets
const encrypt2FASecret = encrypt;
const decrypt2FASecret = decrypt;

interface SecondFactorUser {
    id: string;
    twoFactorEnabled: boolean;
    twoFactorSecret: string | null;
    twoFactorRecoveryCodes: string | null;
}

type SecondFactorResult =
    | { kind: "ok" }
    | { kind: "required" }
    | { kind: "invalid"; message: string };

async function verifyRecoveryCode(
    user: SecondFactorUser,
    token: string,
): Promise<boolean> {
    if (!user.twoFactorRecoveryCodes) return false;
    const hashes = decrypt2FASecret(user.twoFactorRecoveryCodes).split(",");
    const providedHash = crypto
        .createHash("sha256")
        .update(token.toUpperCase())
        .digest("hex");
    let matchIndex = -1;
    for (let index = 0; index < hashes.length; index += 1) {
        if (timingSafeCompare(hashes[index], providedHash)) matchIndex = index;
    }
    if (matchIndex === -1) return false;
    hashes.splice(matchIndex, 1);
    await prisma.user.update({
        where: { id: user.id },
        data: {
            twoFactorRecoveryCodes: encrypt2FASecret(hashes.join(",")),
        },
    });
    return true;
}

async function verifyLoginSecondFactor(
    user: SecondFactorUser,
    token?: string,
): Promise<SecondFactorResult> {
    if (!user.twoFactorEnabled || !user.twoFactorSecret) return { kind: "ok" };
    if (!token) return { kind: "required" };
    if (/^[A-F0-9]{8}$/i.test(token)) {
        const valid = await verifyRecoveryCode(user, token);
        return valid
            ? { kind: "ok" }
            : { kind: "invalid", message: "Invalid recovery code" };
    }
    const secret = decrypt2FASecret(user.twoFactorSecret);
    const valid = await verifyTotpToken(secret, token);
    return valid
        ? { kind: "ok" }
        : { kind: "invalid", message: "Invalid 2FA token" };
}

function sendLoginSuccess(res: Response, user: LoginUser): Response {
    return res.json({
        token: generateToken(user),
        refreshToken: generateRefreshToken(user),
        user: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            role: user.role,
        },
    });
}

const oidcLog = logger.child("OIDCAuth");
const credentialLog = logger.child("AuthCredentials");

const resourceIdParamsSchema = z
    .object({
        id: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[a-z0-9]+$/),
    })
    .strict();

function hasErrorCode(error: unknown, code: string): boolean {
    if (typeof error !== "object" || error === null) return false;
    return "code" in error && error.code === code;
}

/** Shared primitives used across auth concern modules. */
export {
    credentialLog,
    decrypt2FASecret,
    encrypt2FASecret,
    hasErrorCode,
    oidcLog,
    resourceIdParamsSchema,
    sendLoginSuccess,
    verifyLoginSecondFactor,
    verifyTotpToken,
};
