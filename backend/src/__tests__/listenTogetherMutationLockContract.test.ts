import { DeterministicRedisServer } from "../services/__tests__/support/deterministicRedis";
import { withSyncGroupMembershipFence } from "../services/listenTogetherMembershipFence";
import type { Prisma } from "@prisma/client";

type LockModule = typeof import("../services/listenTogetherMutationLock");

describe("listen together mutation lock", () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.resetModules();
        jest.restoreAllMocks();
    });

    function loadLock(
        server: DeterministicRedisServer,
        options: {
            lockEnabled: boolean;
            stateStoreEnabled: boolean;
            stateSyncEnabled?: boolean;
        },
    ): LockModule {
        jest.resetModules();
        const logger: any = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            child: jest.fn(),
        };
        logger.child.mockReturnValue(logger);
        jest.doMock("../config", () => ({
            config: {
                listenTogether: {
                    mutationLockEnabled: options.lockEnabled,
                    stateStoreEnabled: options.stateStoreEnabled,
                    stateSyncEnabled: options.stateSyncEnabled ?? false,
                    mutationLockTtlMs: 90,
                    mutationLockRenewIntervalMs: 30,
                    publicationDeadlineMs: 1_000,
                    mutationLockPrefix: "listen-together:mutation-lock",
                },
            },
        }));
        jest.doMock("../utils/logger", () => ({ logger }));
        jest.doMock("../utils/ioredis", () => ({
            createIORedisClient: jest.fn(() => server.createClient()),
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require("../services/listenTogetherMutationLock");
    }

    it("serializes overlapping process-local mutations for one group", async () => {
        const server = new DeterministicRedisServer();
        const lock = loadLock(server, {
            lockEnabled: false,
            stateStoreEnabled: false,
        });
        const events: string[] = [];
        let releaseFirst: () => void = () => undefined;
        let markFirstStarted: () => void = () => undefined;
        const firstStarted = new Promise<void>((resolve) => {
            markFirstStarted = resolve;
        });
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        const first = lock.withGroupMutationLock(
            "group-1",
            "first",
            async () => {
                events.push("first:start");
                markFirstStarted();
                await firstGate;
                events.push("first:end");
            },
        );
        await firstStarted;
        const second = lock.withGroupMutationLock(
            "group-1",
            "second",
            async () => {
                events.push("second:start", "second:end");
            },
        );
        await new Promise((resolve) => setImmediate(resolve));

        expect(events).toEqual(["first:start"]);
        releaseFirst();
        await Promise.all([first, second]);
        expect(events).toEqual([
            "first:start",
            "first:end",
            "second:start",
            "second:end",
        ]);
        lock.shutdownGroupMutationLock();
    });

    it("retains an aborted queued tail until the prior operation settles", async () => {
        const server = new DeterministicRedisServer();
        const lock = loadLock(server, {
            lockEnabled: false,
            stateStoreEnabled: false,
        });
        let releaseFirst: () => void = () => undefined;
        let markFirstStarted: () => void = () => undefined;
        const firstStarted = new Promise<void>((resolve) => {
            markFirstStarted = resolve;
        });
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const first = lock.withGroupMutationLock(
            "group-1",
            "first",
            async () => {
                markFirstStarted();
                await firstGate;
            },
        );
        await firstStarted;

        const controller = new AbortController();
        const abortedMutation = jest.fn(async () => undefined);
        const aborted = lock.withGroupMutationLock(
            "group-1",
            "aborted",
            abortedMutation,
            {
                signal: controller.signal,
                abandonOperationOnAbort: true,
            },
        );
        controller.abort(new Error("queued operation aborted"));
        await expect(aborted).rejects.toThrow("queued operation aborted");

        const finalMutation = jest.fn(async () => undefined);
        const final = lock.withGroupMutationLock(
            "group-1",
            "final",
            finalMutation,
        );
        let drainSettled = false;
        const drain = lock
            .drainListenTogetherMutationLocks(Date.now() + 1_000)
            .then((result) => {
                drainSettled = true;
                return result;
            });
        await new Promise((resolve) => setImmediate(resolve));

        expect(abortedMutation).not.toHaveBeenCalled();
        expect(finalMutation).not.toHaveBeenCalled();
        expect(drainSettled).toBe(false);

        releaseFirst();
        await expect(Promise.all([first, final, drain])).resolves.toEqual([
            undefined,
            undefined,
            expect.objectContaining({ drained: true }),
        ]);
        expect(finalMutation).toHaveBeenCalledTimes(1);
        lock.shutdownGroupMutationLock();
    });

    it("drains active local mutation tails before shutdown persistence", async () => {
        const server = new DeterministicRedisServer();
        const lock = loadLock(server, {
            lockEnabled: false,
            stateStoreEnabled: false,
        });
        let releaseOperation: () => void = () => undefined;
        let markStarted: () => void = () => undefined;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        const operation = lock.withGroupMutationLock(
            "group-1",
            "shutdown-drain",
            async () => {
                markStarted();
                await new Promise<void>((resolve) => {
                    releaseOperation = resolve;
                });
            },
        );
        await started;
        let drained = false;
        const drain = lock
            .drainListenTogetherMutationLocks(Date.now() + 1_000)
            .then((result) => {
                expect(result.drained).toBe(true);
                drained = true;
            });
        await Promise.resolve();
        expect(drained).toBe(false);

        releaseOperation();
        await Promise.all([operation, drain]);
        expect(drained).toBe(true);
        lock.shutdownGroupMutationLock();
    });

    it("returns the exhausted budget when a local mutation tail never settles", async () => {
        jest.useFakeTimers().setSystemTime(0);
        const server = new DeterministicRedisServer();
        const lock = loadLock(server, {
            lockEnabled: false,
            stateStoreEnabled: false,
        });
        const operation = lock.withGroupMutationLock(
            "group-1",
            "never-settles",
            async () => new Promise<void>(() => undefined),
        );
        void operation.catch(() => undefined);
        await Promise.resolve();

        const drain = lock.drainListenTogetherMutationLocks(50);
        await jest.advanceTimersByTimeAsync(51);

        await expect(drain).resolves.toEqual({
            drained: false,
            deadlineAtMs: 50,
            remainingMs: 0,
        });
        lock.shutdownGroupMutationLock();
    });

    it("releases fully local fencing counters after definitive group end", async () => {
        const server = new DeterministicRedisServer();
        const lock = loadLock(server, {
            lockEnabled: false,
            stateStoreEnabled: false,
        });
        const tokens: number[] = [];
        await lock.withGroupMutationLock(
            "group-1",
            "before-end",
            async (fence) => {
                tokens.push(fence.fencingToken);
            },
        );
        lock.releaseLocalGroupMutationState("group-1");
        await lock.withGroupMutationLock(
            "group-1",
            "after-end",
            async (fence) => {
                tokens.push(fence.fencingToken);
            },
        );

        expect(tokens).toEqual([1, 1]);
        lock.shutdownGroupMutationLock();
    });

    it.each([
        {
            lockEnabled: false,
            stateStoreEnabled: false,
            stateSyncEnabled: false,
            allocationCommand: null,
            restartTokens: [1, 1],
            requiresMembershipFence: false,
        },
        {
            lockEnabled: false,
            stateStoreEnabled: false,
            stateSyncEnabled: true,
            allocationCommand: "INCR",
            restartTokens: [1, 2],
            requiresMembershipFence: true,
        },
        {
            lockEnabled: false,
            stateStoreEnabled: true,
            stateSyncEnabled: false,
            allocationCommand: "INCR",
            restartTokens: [1, 2],
            requiresMembershipFence: true,
        },
        {
            lockEnabled: true,
            stateStoreEnabled: false,
            stateSyncEnabled: false,
            allocationCommand: "EVAL",
            restartTokens: [1, 2],
            requiresMembershipFence: true,
        },
        {
            lockEnabled: true,
            stateStoreEnabled: true,
            stateSyncEnabled: true,
            allocationCommand: "EVAL",
            restartTokens: [1, 2],
            requiresMembershipFence: true,
        },
    ])(
        "uses the explicit lock=$lockEnabled/stateStore=$stateStoreEnabled/stateSync=$stateSyncEnabled fencing mode",
        async ({
            lockEnabled,
            stateStoreEnabled,
            stateSyncEnabled,
            allocationCommand,
            restartTokens,
            requiresMembershipFence,
        }) => {
            const server = new DeterministicRedisServer();
            const firstModule = loadLock(server, {
                lockEnabled,
                stateStoreEnabled,
                stateSyncEnabled,
            });
            const tokens: number[] = [];
            const durableFenceModes: boolean[] = [];
            await firstModule.withGroupMutationLock(
                "group-1",
                "before-restart",
                async (fence) => {
                    tokens.push(fence.fencingToken);
                    durableFenceModes.push(
                        fence.requiresMembershipFence === true,
                    );
                },
            );
            firstModule.shutdownGroupMutationLock();

            const secondModule = loadLock(server, {
                lockEnabled,
                stateStoreEnabled,
                stateSyncEnabled,
            });
            await secondModule.withGroupMutationLock(
                "group-1",
                "after-restart",
                async (fence) => {
                    tokens.push(fence.fencingToken);
                    durableFenceModes.push(
                        fence.requiresMembershipFence === true,
                    );
                },
            );

            expect(tokens).toEqual(restartTokens);
            expect(durableFenceModes).toEqual([
                requiresMembershipFence,
                requiresMembershipFence,
            ]);
            if (allocationCommand) {
                expect(
                    server.commandLog.filter(
                        (command) => command.name === allocationCommand,
                    ),
                ).not.toHaveLength(0);
            } else {
                expect(server.commandLog).toHaveLength(0);
            }
            secondModule.shutdownGroupMutationLock();
        },
    );

    it("allocates the lease and fencing token atomically across two clients", async () => {
        const server = new DeterministicRedisServer();
        const podA = loadLock(server, {
            lockEnabled: true,
            stateStoreEnabled: true,
        });
        let releaseA: () => void = () => undefined;
        let startedA: () => void = () => undefined;
        let tokenA = 0;
        const aStarted = new Promise<void>((resolve) => {
            startedA = resolve;
        });
        const aGate = new Promise<void>((resolve) => {
            releaseA = resolve;
        });
        const operationA = podA.withGroupMutationLock(
            "group-1",
            "pod-a",
            async (fence) => {
                tokenA = fence.fencingToken;
                startedA();
                await aGate;
            },
        );
        await aStarted;

        server.advanceBy(91);
        const podB = loadLock(server, {
            lockEnabled: true,
            stateStoreEnabled: true,
        });
        let tokenB = 0;
        await podB.withGroupMutationLock("group-1", "pod-b", async (fence) => {
            tokenB = fence.fencingToken;
        });
        releaseA();
        await expect(operationA).rejects.toMatchObject({ code: "CONFLICT" });

        expect([tokenA, tokenB]).toEqual([1, 2]);
        expect(
            server.commandLog.filter((command) => command.name === "SET"),
        ).toHaveLength(0);
        expect(
            server.commandLog.filter((command) => command.name === "INCR"),
        ).toHaveLength(0);
        const acquisitions = server.commandLog.filter(
            (command) =>
                command.name === "EVAL" &&
                String(command.args[0]).includes(
                    "listen-together:acquire-lease-and-fence",
                ),
        );
        expect(acquisitions).toHaveLength(2);
        podA.shutdownGroupMutationLock();
        podB.shutdownGroupMutationLock();
    });

    it("rejects a timed-out acquisition and advances the local tail before late cleanup", async () => {
        jest.useFakeTimers().setSystemTime(0);
        const server = new DeterministicRedisServer();
        let releaseAcquire: () => void = () => undefined;
        let acquisitionCount = 0;
        server.beforeCommand = (command) => {
            if (
                command.name === "EVAL" &&
                String(command.args[0]).includes("acquire-lease-and-fence")
            ) {
                acquisitionCount += 1;
                if (acquisitionCount > 1) return;
                return new Promise<void>((resolve) => {
                    releaseAcquire = resolve;
                });
            }
        };
        const lock = loadLock(server, {
            lockEnabled: true,
            stateStoreEnabled: true,
        });
        const operation = lock.withGroupMutationLock(
            "group-1",
            "delayed-acquire",
            async () => undefined,
        );
        const secondMutation = jest.fn(async () => undefined);
        const second = lock.withGroupMutationLock(
            "group-1",
            "after-delayed-acquire",
            secondMutation,
        );
        let firstSettled = false;
        void operation.then(
            () => {
                firstSettled = true;
            },
            () => {
                firstSettled = true;
            },
        );

        await jest.advanceTimersByTimeAsync(1_001);
        expect(firstSettled).toBe(true);
        await expect(operation).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(second).resolves.toBeUndefined();
        expect(secondMutation).toHaveBeenCalledTimes(1);

        releaseAcquire();
        await jest.runAllTimersAsync();

        const acquisitions = server.commandLog.filter(
            (command) =>
                command.name === "EVAL" &&
                String(command.args[0]).includes("acquire-lease-and-fence"),
        );
        const releases = server.commandLog.filter(
            (command) =>
                command.name === "EVAL" &&
                String(command.args[0]).includes("release-owned-lease"),
        );
        expect(acquisitions).toHaveLength(2);
        expect(releases).toHaveLength(2);
        expect(releases[1]?.args[3]).toBe(acquisitions[0]?.args[4]);
        expect(server.peek("listen-together:mutation-lock:group-1")).toBeNull();
        lock.shutdownGroupMutationLock();
    });

    it("releases a lease acquired after its caller abandons without running the mutation", async () => {
        jest.useFakeTimers();
        const server = new DeterministicRedisServer();
        let releaseAcquire: () => void = () => undefined;
        server.beforeCommand = (command) => {
            if (
                command.name === "EVAL" &&
                String(command.args[0]).includes("acquire-lease-and-fence")
            ) {
                return new Promise<void>((resolve) => {
                    releaseAcquire = resolve;
                });
            }
        };
        const lock = loadLock(server, {
            lockEnabled: true,
            stateStoreEnabled: true,
        });
        const controller = new AbortController();
        const mutation = jest.fn(async () => undefined);
        const operation = lock.withGroupMutationLock(
            "group-1",
            "abandoned-acquire",
            mutation,
            {
                signal: controller.signal,
                abandonOperationOnAbort: true,
            },
        );
        void operation.catch(() => undefined);

        controller.abort(new Error("attempt deadline expired"));
        releaseAcquire();
        await jest.runAllTimersAsync();

        await expect(operation).rejects.toThrow("attempt deadline expired");
        expect(mutation).not.toHaveBeenCalled();
        expect(server.peek("listen-together:mutation-lock:group-1")).toBeNull();
        lock.shutdownGroupMutationLock();
    });

    it("checks fencing after an in-flight renewal has drained", async () => {
        jest.useFakeTimers();
        const server = new DeterministicRedisServer();
        let releaseRenewal: () => void = () => undefined;
        server.beforeCommand = (command) => {
            if (
                command.name === "EVAL" &&
                String(command.args[0]).includes("renew-owned-lease")
            ) {
                return new Promise<void>((resolve) => {
                    releaseRenewal = resolve;
                });
            }
        };
        const lock = loadLock(server, {
            lockEnabled: true,
            stateStoreEnabled: true,
        });
        let finishOperation: () => void = () => undefined;
        const operation = lock.withGroupMutationLock(
            "group-1",
            "renewal-race",
            async () =>
                new Promise<void>((resolve) => {
                    finishOperation = resolve;
                }),
        );
        await jest.advanceTimersByTimeAsync(31);
        server.advanceBy(91);
        finishOperation();
        await Promise.resolve();
        releaseRenewal();

        await expect(operation).rejects.toMatchObject({ code: "CONFLICT" });
        lock.shutdownGroupMutationLock();
    });

    it("fences a never-settling renewal without blocking completion or drain", async () => {
        jest.useFakeTimers().setSystemTime(0);
        const server = new DeterministicRedisServer();
        server.beforeCommand = (command) => {
            if (
                command.name === "EVAL" &&
                String(command.args[0]).includes("renew-owned-lease")
            ) {
                return new Promise<void>(() => undefined);
            }
        };
        const lock = loadLock(server, {
            lockEnabled: true,
            stateStoreEnabled: true,
        });
        let observedFence:
            | { fencingToken: number; isFenced(): boolean }
            | undefined;
        let finishOperation: () => void = () => undefined;
        const operation = lock.withGroupMutationLock(
            "group-1",
            "never-settling-renewal",
            async (fence) => {
                observedFence = fence;
                await new Promise<void>((resolve) => {
                    finishOperation = resolve;
                });
            },
        );
        await jest.advanceTimersByTimeAsync(31);
        finishOperation();
        const secondMutation = jest.fn(async () => undefined);
        const second = lock.withGroupMutationLock(
            "group-1",
            "after-never-settling-renewal",
            secondMutation,
        );
        const drain = lock.drainListenTogetherMutationLocks(2_000);
        let operationSettled = false;
        void operation.then(
            () => {
                operationSettled = true;
            },
            () => {
                operationSettled = true;
            },
        );

        await jest.advanceTimersByTimeAsync(1_001);

        expect(observedFence?.fencingToken).toBe(1);
        expect(observedFence?.isFenced()).toBe(true);
        expect(operationSettled).toBe(true);
        await expect(operation).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(second).resolves.toBeUndefined();
        expect(secondMutation).toHaveBeenCalledTimes(1);
        await expect(drain).resolves.toMatchObject({ drained: true });
        lock.shutdownGroupMutationLock();
    });

    it("marks the holder fenced when token-guarded renewal loses ownership", async () => {
        jest.useFakeTimers();
        const server = new DeterministicRedisServer();
        const lock = loadLock(server, {
            lockEnabled: true,
            stateStoreEnabled: true,
        });
        let observedFence:
            | { fencingToken: number; isFenced(): boolean }
            | undefined;
        let releaseOperation: () => void = () => undefined;
        const operationGate = new Promise<void>((resolve) => {
            releaseOperation = resolve;
        });
        const operation = lock.withGroupMutationLock(
            "group-1",
            "fenced",
            async (fence) => {
                observedFence = fence;
                await operationGate;
            },
        );
        await jest.advanceTimersByTimeAsync(1);
        server.advanceBy(91);
        await jest.advanceTimersByTimeAsync(30);

        expect(observedFence?.fencingToken).toBe(1);
        expect(observedFence?.isFenced()).toBe(true);

        releaseOperation();
        await expect(operation).rejects.toMatchObject({ code: "CONFLICT" });
        lock.shutdownGroupMutationLock();
    });

    it("rolls back staged membership when renewal fences the lease during the transaction", async () => {
        jest.useFakeTimers();
        const server = new DeterministicRedisServer();
        const lock = loadLock(server, {
            lockEnabled: true,
            stateStoreEnabled: true,
        });
        let durableMemberPresent = false;

        const operation = lock.withGroupMutationLock(
            "group-transaction",
            "membership-transaction",
            async (fence) => {
                let stagedMemberPresent = durableMemberPresent;
                const tx = {
                    syncGroup: {
                        updateMany: jest.fn(async () => ({ count: 1 })),
                    },
                } as unknown as Prisma.TransactionClient;
                await withSyncGroupMembershipFence(
                    tx,
                    "group-transaction",
                    fence,
                    async () => {
                        stagedMemberPresent = true;
                        server.advanceBy(91);
                        await jest.advanceTimersByTimeAsync(30);
                    },
                );
                durableMemberPresent = stagedMemberPresent;
            },
        );

        await expect(operation).rejects.toMatchObject({ code: "CONFLICT" });
        expect(durableMemberPresent).toBe(false);
        lock.shutdownGroupMutationLock();
    });

    it("does not begin membership writes after renewal has already fenced the lease", async () => {
        jest.useFakeTimers();
        const server = new DeterministicRedisServer();
        const lock = loadLock(server, {
            lockEnabled: true,
            stateStoreEnabled: true,
        });
        const updateMany = jest.fn(async () => ({ count: 1 }));
        const write = jest.fn(async () => undefined);

        const operation = lock.withGroupMutationLock(
            "group-before-transaction",
            "membership-transaction",
            async (fence) => {
                server.advanceBy(91);
                await jest.advanceTimersByTimeAsync(30);
                const tx = {
                    syncGroup: { updateMany },
                } as unknown as Prisma.TransactionClient;
                await withSyncGroupMembershipFence(
                    tx,
                    "group-before-transaction",
                    fence,
                    write,
                );
            },
        );

        await expect(operation).rejects.toMatchObject({ code: "CONFLICT" });
        expect(updateMany).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        lock.shutdownGroupMutationLock();
    });
});
