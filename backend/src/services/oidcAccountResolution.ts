import type { InviteCode, Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { acquireRoleGuardLock } from "../utils/advisoryLocks";
import { claimInviteCode, recordInviteCodeUsage } from "./inviteCodes";
import { getOidcProviderId, type OidcClaims } from "./oidcAuth";

const oidcLog = logger.child("OIDCAuth");
const MAX_USERNAME_ATTEMPTS = 50;
const MAX_USERNAME_LENGTH = 32;

/** User fields shared by local and OIDC login success responses. */
export interface LoginUser {
    id: string;
    username: string;
    displayName: string | null;
    role: string;
    tokenVersion: number;
}

/** Single-use state used to confirm an email-based account link. */
export interface OidcLinkEntry {
    provider: string;
    providerSubject: string;
    email: string | null;
    displayName: string | null;
    userId: string;
    groups: string[];
}

/** Single-use state used to gate OIDC provisioning with an invite. */
export interface OidcInviteEntry {
    provider: string;
    providerSubject: string;
    email: string | null;
    displayName: string | null;
    preferredUsername?: string | null;
}

/** Ordered result of resolving validated OIDC claims. */
export type OidcAccountResolution =
    | { kind: "authenticated"; user: LoginUser }
    | { kind: "link"; entry: OidcLinkEntry }
    | { kind: "alreadyLinked" }
    | { kind: "invite"; entry: OidcInviteEntry };

const loginUserSelect = {
    id: true,
    username: true,
    displayName: true,
    role: true,
    tokenVersion: true,
} as const;

function desiredRole(groups: string[]): "admin" | "user" {
    return groups.includes(config.oidc.adminGroup) ? "admin" : "user";
}

async function demoteOidcAdmin(user: LoginUser): Promise<LoginUser> {
    return prisma.$transaction(async (tx) => {
        await acquireRoleGuardLock(tx);
        const otherAdmins = await tx.user.count({
            where: {
                role: "admin",
                id: { not: user.id },
                pendingDeletionAt: null,
            },
        });
        if (otherAdmins === 0) {
            oidcLog.warn("Skipped OIDC role demotion for the last admin", {
                userId: user.id,
            });
            return user;
        }
        return tx.user.update({
            where: { id: user.id },
            data: { role: "user" },
            select: loginUserSelect,
        });
    });
}

/** Applies opt-in OIDC role synchronization with last-admin protection. */
export async function syncOidcRole(
    user: LoginUser,
    groups: string[],
): Promise<LoginUser> {
    if (!config.oidc.manageRoles) return user;
    const desired = desiredRole(groups);
    if (desired === user.role) return user;
    if (user.role === "admin" && desired === "user") {
        return demoteOidcAdmin(user);
    }
    return prisma.user.update({
        where: { id: user.id },
        data: { role: desired },
        select: loginUserSelect,
    });
}

function slugifyUsername(value: string): string {
    const normalized = value
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, MAX_USERNAME_LENGTH);
    return normalized.length >= 3 ? normalized : `oidc_${normalized || "user"}`;
}

function usernameBase(claims: OidcClaims): string {
    const candidate =
        claims.preferredUsername ??
        claims.email?.split("@")[0] ??
        claims.name ??
        claims.sub.slice(0, 16);
    return slugifyUsername(candidate);
}

async function findAvailableUsername(
    tx: Prisma.TransactionClient,
    claims: OidcClaims,
): Promise<string> {
    const base = usernameBase(claims);
    for (let index = 0; index < MAX_USERNAME_ATTEMPTS; index += 1) {
        const suffix = index === 0 ? "" : `_${index}`;
        const candidate = `${base.slice(0, MAX_USERNAME_LENGTH - suffix.length)}${suffix}`;
        const existing = await tx.user.findUnique({
            where: { username: candidate },
            select: { id: true },
        });
        if (!existing) return candidate;
    }
    throw new Error("Unable to allocate an OIDC username");
}

async function availableVerifiedEmail(
    tx: Prisma.TransactionClient,
    claims: OidcClaims,
): Promise<string | null> {
    if (!claims.emailVerified || !claims.email) return null;
    const existing = await tx.user.findUnique({
        where: { email: claims.email },
        select: { id: true },
    });
    return existing ? null : claims.email;
}

async function createProvisionedUser(
    tx: Prisma.TransactionClient,
    claims: OidcClaims,
): Promise<LoginUser> {
    const username = await findAvailableUsername(tx, claims);
    const email = await availableVerifiedEmail(tx, claims);
    return tx.user.create({
        data: {
            username,
            displayName: claims.name,
            email,
            passwordHash: null,
            role: "user",
            onboardingComplete: true,
        },
        select: loginUserSelect,
    });
}

async function createProvisionedRelations(
    tx: Prisma.TransactionClient,
    user: LoginUser,
    claims: OidcClaims,
    provider: string,
): Promise<void> {
    await tx.userSettings.create({
        data: {
            userId: user.id,
            playbackQuality: "original",
            wifiOnly: false,
            offlineEnabled: false,
            maxCacheSizeMb: 10240,
        },
    });
    await tx.externalIdentity.create({
        data: {
            userId: user.id,
            provider,
            providerSubject: claims.sub,
            email: claims.email,
            displayName: claims.name,
        },
    });
}

/** Provisions and links an OIDC user in one transaction. */
export async function provisionOidcUser(
    claims: OidcClaims,
    provider: string,
    invite?: InviteCode,
): Promise<LoginUser> {
    return prisma.$transaction(async (tx) => {
        if (invite) await claimInviteCode(tx, invite);
        const user = await createProvisionedUser(tx, claims);
        await createProvisionedRelations(tx, user, claims, provider);
        if (invite) await recordInviteCodeUsage(tx, invite, user.id);
        return user;
    });
}

async function findLinkedUser(
    provider: string,
    claims: OidcClaims,
): Promise<LoginUser | null> {
    const identity = await prisma.externalIdentity.findUnique({
        where: {
            provider_providerSubject: {
                provider,
                providerSubject: claims.sub,
            },
        },
        include: { user: { select: loginUserSelect } },
    });
    return identity?.user ?? null;
}

async function resolveEmailMatch(
    provider: string,
    claims: OidcClaims,
): Promise<OidcAccountResolution | null> {
    if (!claims.email) return null;
    const user = await prisma.user.findUnique({
        where: { email: claims.email },
        select: loginUserSelect,
    });
    if (!user) return null;
    const existingProviderLink = await prisma.externalIdentity.findFirst({
        where: { userId: user.id, provider },
        select: { id: true },
    });
    if (existingProviderLink) return { kind: "alreadyLinked" };
    return {
        kind: "link",
        entry: {
            provider,
            providerSubject: claims.sub,
            email: claims.email,
            displayName: claims.name,
            userId: user.id,
            groups: config.oidc.manageRoles ? claims.groups : [],
        },
    };
}

/** Resolves OIDC claims in linked, email-match, provision, then invite order. */
export async function resolveOidcAccount(
    claims: OidcClaims,
): Promise<OidcAccountResolution> {
    const provider = getOidcProviderId();
    const linkedUser = await findLinkedUser(provider, claims);
    if (linkedUser) {
        return {
            kind: "authenticated",
            user: await syncOidcRole(linkedUser, claims.groups),
        };
    }
    const emailMatch = await resolveEmailMatch(provider, claims);
    if (emailMatch) return emailMatch;
    if (config.oidc.autoProvision) {
        const user = await provisionOidcUser(claims, provider);
        return { kind: "authenticated", user };
    }
    return {
        kind: "invite",
        entry: {
            provider,
            providerSubject: claims.sub,
            email: claims.emailVerified ? claims.email : null,
            displayName: claims.name,
            preferredUsername: claims.preferredUsername,
        },
    };
}
