const mockConfig = {
    oidc: {
        autoProvision: false,
        manageRoles: false,
        adminGroup: "soundspan-admins",
    },
};

jest.mock("../../config", () => ({ config: mockConfig }));

const oidcLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
oidcLogger.child.mockReturnValue(oidcLogger);
jest.mock("../../utils/logger", () => ({ logger: oidcLogger }));

const prisma = {
    externalIdentity: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
    },
    user: {
        findUnique: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
    },
    $executeRaw: jest.fn(),
    $transaction: jest.fn(),
};
jest.mock("../../utils/db", () => ({ prisma }));

jest.mock("../oidcAuth", () => ({
    getOidcProviderId: () => "oidc:https://idp.example",
}));

import type { OidcClaims } from "../oidcAuth";
import {
    provisionOidcUser,
    resolveOidcAccount,
    syncOidcRole,
} from "../oidcAccountResolution";

const baseClaims: OidcClaims = {
    sub: "subject-1",
    email: "alice@example.com",
    emailVerified: true,
    name: "Alice Example",
    preferredUsername: "alice",
    groups: [],
};

const linkedUser = {
    id: "u1",
    username: "alice",
    displayName: "Alice Example",
    role: "user",
    tokenVersion: 2,
};

describe("oidcAccountResolution", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockConfig.oidc.autoProvision = false;
        mockConfig.oidc.manageRoles = false;
        prisma.externalIdentity.findUnique.mockResolvedValue(null);
        prisma.externalIdentity.findFirst.mockResolvedValue(null);
        prisma.user.findUnique.mockResolvedValue(null);
        prisma.user.count.mockResolvedValue(1);
        prisma.$executeRaw.mockResolvedValue(0);
        prisma.$transaction.mockImplementation(async (run) => run(prisma));
        prisma.user.update.mockImplementation(async ({ data }) => ({
            ...linkedUser,
            role: data.role,
        }));
    });

    it("resolves a linked provider subject before considering email", async () => {
        prisma.externalIdentity.findUnique.mockResolvedValueOnce({
            user: linkedUser,
        });

        await expect(resolveOidcAccount(baseClaims)).resolves.toEqual({
            kind: "authenticated",
            user: linkedUser,
        });
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it("requires confirmation when an OIDC email matches a local user", async () => {
        prisma.user.findUnique.mockResolvedValueOnce(linkedUser);

        await expect(resolveOidcAccount(baseClaims)).resolves.toEqual({
            kind: "link",
            entry: {
                provider: "oidc:https://idp.example",
                providerSubject: "subject-1",
                email: "alice@example.com",
                displayName: "Alice Example",
                userId: "u1",
                groups: [],
            },
        });
    });

    it("rejects an email-matched account already linked to this provider", async () => {
        prisma.user.findUnique.mockResolvedValueOnce(linkedUser);
        prisma.externalIdentity.findFirst.mockResolvedValueOnce({ id: "ei1" });

        await expect(resolveOidcAccount(baseClaims)).resolves.toEqual({
            kind: "alreadyLinked",
        });
    });

    it("returns invite state when direct provisioning is disabled", async () => {
        await expect(resolveOidcAccount(baseClaims)).resolves.toEqual({
            kind: "invite",
            entry: {
                provider: "oidc:https://idp.example",
                providerSubject: "subject-1",
                email: "alice@example.com",
                displayName: "Alice Example",
                preferredUsername: "alice",
            },
        });
    });

    it("does not carry an unverified email into invite provisioning state", async () => {
        await expect(
            resolveOidcAccount({ ...baseClaims, emailVerified: false }),
        ).resolves.toEqual(
            expect.objectContaining({
                kind: "invite",
                entry: expect.objectContaining({ email: null }),
            }),
        );
    });

    it("provisions a regular user with a collision suffix and default settings", async () => {
        const tx = createTransaction();
        tx.user.findUnique.mockImplementation(async ({ where }) => {
            if (where.email) return null;
            return where.username === "alice" ? { id: "taken" } : null;
        });
        prisma.$transaction.mockImplementation(async (run) => run(tx));

        await expect(
            provisionOidcUser(baseClaims, "oidc:https://idp.example"),
        ).resolves.toEqual(tx.createdUser);
        expect(tx.user.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: {
                    username: "alice_1",
                    displayName: "Alice Example",
                    email: "alice@example.com",
                    passwordHash: null,
                    role: "user",
                    onboardingComplete: true,
                },
            }),
        );
        expect(tx.userSettings.create).toHaveBeenCalledWith({
            data: {
                userId: "u-new",
                playbackQuality: "original",
                wifiOnly: false,
                offlineEnabled: false,
                maxCacheSizeMb: 10240,
            },
        });
        expect(tx.externalIdentity.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: "u-new",
                providerSubject: "subject-1",
            }),
        });
    });

    it("uses direct provisioning only when auto-provision is enabled", async () => {
        mockConfig.oidc.autoProvision = true;
        const tx = createTransaction();
        tx.user.findUnique.mockResolvedValue(null);
        prisma.$transaction.mockImplementation(async (run) => run(tx));

        await expect(resolveOidcAccount(baseClaims)).resolves.toEqual({
            kind: "authenticated",
            user: tx.createdUser,
        });
    });

    it("claims an invite and records its usage in the provisioning transaction", async () => {
        const tx = createTransaction();
        tx.user.findUnique.mockResolvedValue(null);
        prisma.$transaction.mockImplementation(async (run) => run(tx));
        const invite = {
            id: "invite-1",
            code: "INVITE",
            createdBy: "admin-1",
            expiresAt: null,
            maxUses: 1,
            useCount: 0,
            revoked: false,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
        };

        await provisionOidcUser(baseClaims, "oidc:https://idp.example", invite);

        expect(tx.inviteCode.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: "invite-1" }),
            }),
        );
        expect(tx.inviteCodeUsage.create).toHaveBeenCalledWith({
            data: { inviteCodeId: "invite-1", usedBy: "u-new" },
        });
    });

    it("never reads groups or changes role when management is disabled", async () => {
        const groups = new Proxy(["soundspan-admins"], {
            get() {
                throw new Error("groups were read");
            },
        });

        await expect(syncOidcRole(linkedUser, groups)).resolves.toEqual(
            linkedUser,
        );
        expect(prisma.user.count).not.toHaveBeenCalled();
        expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("promotes and demotes linked users when role management is enabled", async () => {
        mockConfig.oidc.manageRoles = true;

        await expect(
            syncOidcRole(linkedUser, ["soundspan-admins"]),
        ).resolves.toEqual(expect.objectContaining({ role: "admin" }));
        expect(prisma.user.update).toHaveBeenLastCalledWith(
            expect.objectContaining({ data: { role: "admin" } }),
        );

        const adminUser = { ...linkedUser, role: "admin" };
        const order: string[] = [];
        prisma.$executeRaw.mockImplementationOnce(async () => {
            order.push("lock");
            return 0;
        });
        prisma.user.count.mockImplementationOnce(async () => {
            order.push("count");
            return 1;
        });
        prisma.user.update.mockImplementationOnce(async ({ data }) => {
            order.push("update");
            return { ...linkedUser, role: data.role };
        });
        await expect(syncOidcRole(adminUser, [])).resolves.toEqual(
            expect.objectContaining({ role: "user" }),
        );
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
        expect(order).toEqual(["lock", "count", "update"]);
        expect(prisma.user.update).toHaveBeenLastCalledWith(
            expect.objectContaining({ data: { role: "user" } }),
        );
    });

    it("does not demote the last remaining admin", async () => {
        mockConfig.oidc.manageRoles = true;
        prisma.user.count.mockResolvedValueOnce(0);
        const adminUser = { ...linkedUser, role: "admin" };

        await expect(syncOidcRole(adminUser, [])).resolves.toEqual(adminUser);
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(oidcLogger.warn).toHaveBeenCalledWith(
            "Skipped OIDC role demotion for the last admin",
            { userId: "u1" },
        );
    });
});

function createTransaction() {
    const createdUser = {
        id: "u-new",
        username: "alice_1",
        displayName: "Alice Example",
        role: "user",
        tokenVersion: 0,
    };
    return {
        createdUser,
        user: {
            findUnique: jest.fn(),
            create: jest.fn().mockResolvedValue(createdUser),
        },
        userSettings: { create: jest.fn().mockResolvedValue({}) },
        externalIdentity: { create: jest.fn().mockResolvedValue({}) },
        inviteCode: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        inviteCodeUsage: { create: jest.fn().mockResolvedValue({}) },
    };
}
