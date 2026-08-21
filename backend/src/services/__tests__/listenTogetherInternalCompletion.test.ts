import { ReadyGateCompletionSupervisor } from "../listenTogetherInternalCompletion";

describe("listen together internal completion", () => {
    const conflict = () =>
        Object.assign(new Error("busy"), {
            code: "CONFLICT",
            retryable: true,
        });

    it("shares a three-attempt budget across timer re-arms with jittered backoff", async () => {
        const supervisor = new ReadyGateCompletionSupervisor(
            () => 1_000,
            () => 0.5,
        );
        const complete = jest.fn(async (_signal: AbortSignal) => {
            throw conflict();
        });
        const rearm = jest.fn();
        const data = { currentIndex: 2, stateVersion: 7 };

        await expect(
            supervisor.run("group-1", data, complete, rearm),
        ).resolves.toBe("rearmed");
        await expect(
            supervisor.run("group-1", data, complete, rearm),
        ).resolves.toBe("rearmed");
        await expect(
            supervisor.run("group-1", data, complete, rearm),
        ).resolves.toBe("exhausted");

        expect(complete).toHaveBeenCalledTimes(3);
        expect(rearm.mock.calls.map(([delayMs]) => delayMs)).toEqual([23, 47]);
    });

    it("refuses to re-arm when shutdown occurs during an active attempt", async () => {
        const supervisor = new ReadyGateCompletionSupervisor(
            () => 1_000,
            () => 0,
        );
        let rejectCompletion: (error: Error) => void = () => undefined;
        const complete = (_signal: AbortSignal) =>
            new Promise<boolean>((_resolve, reject) => {
                rejectCompletion = reject;
            });
        const rearm = jest.fn();
        const pending = supervisor.run(
            "group-1",
            { currentIndex: 2, stateVersion: 7 },
            complete,
            rearm,
        );

        supervisor.shutdown();
        rejectCompletion(conflict());

        await expect(pending).resolves.toBe("exhausted");
        expect(rearm).not.toHaveBeenCalled();
    });

    it("stops when the total deadline expires between arms", async () => {
        let now = 1_000;
        const supervisor = new ReadyGateCompletionSupervisor(
            () => now,
            () => 0,
        );
        const complete = jest.fn(async (_signal: AbortSignal) => {
            throw conflict();
        });
        const rearm = jest.fn();
        const data = { currentIndex: 2, stateVersion: 7 };

        await supervisor.run("group-1", data, complete, rearm);
        now += 5_001;
        await expect(
            supervisor.run("group-1", data, complete, rearm),
        ).resolves.toBe("exhausted");
        expect(complete).toHaveBeenCalledTimes(1);
    });

    it("bounds an active completion attempt by the generation budget", async () => {
        jest.useFakeTimers();
        const supervisor = new ReadyGateCompletionSupervisor(Date.now, () => 0);
        let attemptSignal: AbortSignal | undefined;
        const pending = supervisor.run(
            "group-1",
            { currentIndex: 2, stateVersion: 7 },
            (signal) => {
                attemptSignal = signal;
                return new Promise<boolean>(() => undefined);
            },
            jest.fn(),
        );

        await jest.advanceTimersByTimeAsync(5_001);

        await expect(pending).resolves.toBe("exhausted");
        expect(attemptSignal?.aborted).toBe(true);
    });
});
