import type { Prisma } from "@prisma/client";
import { createPrismaClient } from "../prismaClientFactory";
import {
    acquireRoleGuardLock,
    acquireUserScopedLock,
    USER_LOCK_NAMESPACES,
} from "../advisoryLocks";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

type TestClient = ReturnType<typeof createPrismaClient>;
type LockAction = (tx: Prisma.TransactionClient) => Promise<void>;

describeWithDatabase("PostgreSQL advisory locks", () => {
    let firstClient: TestClient;
    let secondClient: TestClient;

    beforeAll(() => {
        if (!databaseUrl) return;
        firstClient = createPrismaClient({
            databaseUrl,
            connectionLimit: 1,
            poolTimeoutSeconds: 2,
        });
        secondClient = createPrismaClient({
            databaseUrl,
            connectionLimit: 1,
            poolTimeoutSeconds: 2,
        });
    });

    afterAll(async () => {
        await firstClient?.$disconnect();
        await secondClient?.$disconnect();
    });

    async function expectTransactionSerialization(
        acquireLock: LockAction,
    ): Promise<void> {
        await firstClient.$transaction(async (firstTx) => {
            await acquireLock(firstTx);
            await expect(
                secondClient.$transaction(async (secondTx) => {
                    await secondTx.$executeRaw`SET LOCAL lock_timeout = '100ms'`;
                    await acquireLock(secondTx);
                }),
            ).rejects.toThrow();
        });
        await expect(
            secondClient.$transaction(acquireLock),
        ).resolves.toBeUndefined();
    }

    it("serializes role-demotion guards", async () => {
        await expectTransactionSerialization(acquireRoleGuardLock);
    });

    it("serializes identity unlink guards per user", async () => {
        await expectTransactionSerialization((tx) =>
            acquireUserScopedLock(
                tx,
                USER_LOCK_NAMESPACES.identityUnlink,
                "integration-user",
            ),
        );
    });

    it("serializes app-password creation guards per user", async () => {
        await expectTransactionSerialization((tx) =>
            acquireUserScopedLock(
                tx,
                USER_LOCK_NAMESPACES.appPasswordCreate,
                "integration-user",
            ),
        );
    });

    it("serializes federation pairing-code creation per administrator", async () => {
        await expectTransactionSerialization((tx) =>
            acquireUserScopedLock(
                tx,
                USER_LOCK_NAMESPACES.federationPairingCodeCreate,
                "integration-admin",
            ),
        );
    });
});
