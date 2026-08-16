import type { InviteCode, Prisma } from "@prisma/client";
import { prisma } from "../utils/db";

/** A stable client-facing invite validation failure. */
export class InviteCodeValidationError extends Error {}

/** A race-safe failure raised when an invite is exhausted during consumption. */
export class InviteCodeExhaustedError extends Error {
    constructor() {
        super("This invite code has been fully used");
    }
}

function validateInvite(invite: InviteCode | null, now: Date): InviteCode {
    if (!invite) throw new InviteCodeValidationError("Invalid invite code");
    if (invite.revoked) {
        throw new InviteCodeValidationError(
            "This invite code has been revoked",
        );
    }
    if (invite.useCount >= invite.maxUses) {
        throw new InviteCodeValidationError(
            "This invite code has been fully used",
        );
    }
    if (invite.expiresAt && invite.expiresAt < now) {
        throw new InviteCodeValidationError("This invite code has expired");
    }
    return invite;
}

/** Loads an invite and applies the public registration validity rules. */
export async function loadUsableInviteCode(code: string): Promise<InviteCode> {
    const invite = await prisma.inviteCode.findUnique({
        where: { code: code.toUpperCase() },
    });
    return validateInvite(invite, new Date());
}

/** Atomically claims one remaining use of an invite inside a transaction. */
export async function claimInviteCode(
    tx: Prisma.TransactionClient,
    invite: InviteCode,
): Promise<void> {
    const consumed = await tx.inviteCode.updateMany({
        where: {
            id: invite.id,
            revoked: false,
            useCount: { lt: invite.maxUses },
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        data: { useCount: { increment: 1 } },
    });
    if (consumed.count !== 1) throw new InviteCodeExhaustedError();
}

/** Records which user redeemed a previously claimed invite use. */
export async function recordInviteCodeUsage(
    tx: Prisma.TransactionClient,
    invite: InviteCode,
    userId: string,
): Promise<void> {
    await tx.inviteCodeUsage.create({
        data: { inviteCodeId: invite.id, usedBy: userId },
    });
}

/** Claims an invite use and records the user in the current transaction. */
export async function consumeInviteCode(
    tx: Prisma.TransactionClient,
    invite: InviteCode,
    userId: string,
): Promise<void> {
    await claimInviteCode(tx, invite);
    await recordInviteCodeUsage(tx, invite, userId);
}
