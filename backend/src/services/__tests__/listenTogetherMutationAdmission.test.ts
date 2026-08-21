describe("listen together mutation admission", () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.resetModules();
        jest.restoreAllMocks();
    });

    function loadAdmission(drainDeadlineMs = 10_000) {
        jest.resetModules();
        const log = {
            warn: jest.fn(),
            child: jest.fn(),
        };
        log.child.mockReturnValue(log);
        jest.doMock("../../utils/logger", () => ({ logger: log }));
        jest.doMock("../../config", () => ({
            config: {
                listenTogether: { mutationDrainDeadlineMs: drainDeadlineMs },
            },
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const admission =
            require("../listenTogetherMutationAdmission") as typeof import("../listenTogetherMutationAdmission");
        return { admission, log };
    }

    it("rejects new work after shutdown while draining every admitted mutation", async () => {
        const { admission } = loadAdmission();
        let releaseFirst: () => void = () => undefined;
        let markStarted: () => void = () => undefined;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        const first = admission.withListenTogetherMutationAdmission(
            "first",
            async () => {
                markStarted();
                await new Promise<void>((resolve) => {
                    releaseFirst = resolve;
                });
            },
        );
        await started;

        const drain = admission.stopListenTogetherMutationAdmission();
        await expect(
            admission.withListenTogetherMutationAdmission(
                "late",
                async () => undefined,
            ),
        ).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });

        let drained = false;
        void drain.then(() => {
            drained = true;
        });
        await Promise.resolve();
        expect(drained).toBe(false);

        releaseFirst();
        const [, result] = await Promise.all([first, drain]);
        expect(result).toEqual(
            expect.objectContaining({
                drained: true,
                remainingMs: expect.any(Number),
            }),
        );
    });

    it("bounds shutdown drain and warns when accepted work never settles", async () => {
        jest.useFakeTimers();
        const { admission, log } = loadAdmission(50);
        void admission.withListenTogetherMutationAdmission(
            "blackhole",
            () => new Promise<void>(() => undefined),
        );
        await Promise.resolve();

        const drain = admission.stopListenTogetherMutationAdmission();
        await jest.advanceTimersByTimeAsync(51);

        await expect(drain).resolves.toEqual(
            expect.objectContaining({ drained: false, remainingMs: 0 }),
        );
        expect(log.warn).toHaveBeenCalledWith(
            "Mutation drain deadline expired",
            expect.objectContaining({ admittedMutations: 1 }),
        );
    });

    it("does not renew an already-expired total drain deadline after progress", async () => {
        jest.useFakeTimers().setSystemTime(0);
        const { admission } = loadAdmission(50);
        let releaseProgress: () => void = () => undefined;
        void admission.withListenTogetherMutationAdmission(
            "progress",
            () =>
                new Promise<void>((resolve) => {
                    releaseProgress = resolve;
                }),
        );
        void admission.withListenTogetherMutationAdmission(
            "still-running",
            () => new Promise<void>(() => undefined),
        );
        await Promise.resolve();

        let result: { drained: boolean } | undefined;
        const drain = admission
            .stopListenTogetherMutationAdmission()
            .then((value: { drained: boolean }) => {
                result = value;
            });
        jest.setSystemTime(51);
        releaseProgress();
        await jest.advanceTimersByTimeAsync(0);

        expect(result?.drained).toBe(false);
        await drain;
    });
});
