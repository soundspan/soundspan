const prisma = {
    syncGroup: { findMany: jest.fn() },
};

jest.mock("../../utils/db", () => ({ prisma }));

const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
logger.child.mockReturnValue(logger);
jest.mock("../../utils/logger", () => ({ logger }));

jest.mock("../../config", () => ({
    config: {
        listenTogether: {
            mutationLockEnabled: false,
            stateStoreEnabled: false,
            stateSyncEnabled: false,
            mutationLockPrefix: "listen-together:mutation-lock",
            publicationDeadlineMs: 750,
        },
    },
}));

import {
    shutdownGroupMutationLock,
    withGroupMutationLock,
} from "../listenTogetherMutationLock";
import { quiesceListenTogetherUserGroups } from "../listenTogetherUserQuiescence";

describe("Listen Together user cleanup quiescence", () => {
    afterEach(() => {
        shutdownGroupMutationLock();
        jest.clearAllMocks();
    });

    it("waits for an already-admitted leave boundary captured after reservation", async () => {
        prisma.syncGroup.findMany.mockResolvedValueOnce([{ id: "group-1" }]);
        let releaseLeave: () => void = () => undefined;
        let markLeaveStarted: () => void = () => undefined;
        const leaveStarted = new Promise<void>((resolve) => {
            markLeaveStarted = resolve;
        });
        const leaveReleased = new Promise<void>((resolve) => {
            releaseLeave = resolve;
        });
        const leave = withGroupMutationLock(
            "group-1",
            "leave-group",
            async () => {
                markLeaveStarted();
                await leaveReleased;
            },
        );
        await leaveStarted;

        let quiesced = false;
        const quiescence = quiesceListenTogetherUserGroups(
            "deleting-user",
            Date.now() + 1_000,
            new AbortController().signal,
        ).then(() => {
            quiesced = true;
        });
        await Promise.resolve();

        expect(quiesced).toBe(false);
        expect(prisma.syncGroup.findMany).toHaveBeenCalledWith({
            where: {
                OR: [
                    { hostUserId: "deleting-user" },
                    { members: { some: { userId: "deleting-user" } } },
                ],
            },
            select: { id: true },
            orderBy: { id: "asc" },
            take: 250,
        });

        releaseLeave();
        await leave;
        await expect(quiescence).resolves.toBeUndefined();
        expect(quiesced).toBe(true);
    });

    it("stops paging promptly when aborted during collection", async () => {
        const controller = new AbortController();
        const firstPage = Array.from({ length: 250 }, (_value, index) => ({
            id: `group-${index.toString().padStart(3, "0")}`,
        }));
        let resolveSecondPage: (rows: typeof firstPage) => void = () =>
            undefined;
        let markSecondPageStarted: () => void = () => undefined;
        const secondPageStarted = new Promise<void>((resolve) => {
            markSecondPageStarted = resolve;
        });
        const secondPage = new Promise<typeof firstPage>((resolve) => {
            resolveSecondPage = resolve;
        });
        prisma.syncGroup.findMany
            .mockResolvedValueOnce(firstPage)
            .mockImplementationOnce(() => {
                markSecondPageStarted();
                return secondPage;
            });

        const quiescence = quiesceListenTogetherUserGroups(
            "deleting-user",
            Date.now() + 10_000,
            controller.signal,
        );
        await secondPageStarted;
        controller.abort(new Error("test abort"));

        await expect(quiescence).rejects.toThrow("test abort");
        resolveSecondPage(firstPage);
        await new Promise((resolve) => setImmediate(resolve));
        expect(prisma.syncGroup.findMany).toHaveBeenCalledTimes(2);
    });
});
