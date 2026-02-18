describe("dataIntegrity CLI entrypoint", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    async function importCliEntrypoint() {
        jest.isolateModules(() => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require("../dataIntegrityCli");
        });
        await new Promise((resolve) => setImmediate(resolve));
    }

    it("runs data integrity check and exits with success code", async () => {
        const runDataIntegrityCheck = jest.fn().mockResolvedValue(undefined);
        const logger = {
            debug: jest.fn(),
            error: jest.fn(),
        };
        const exitSpy = jest
            .spyOn(process, "exit")
            .mockImplementation((() => undefined) as never);

        jest.doMock("../dataIntegrity", () => ({
            runDataIntegrityCheck,
        }));
        jest.doMock("../../utils/logger", () => ({ logger }));

        await importCliEntrypoint();

        expect(runDataIntegrityCheck).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledWith(
            "\nData integrity check completed successfully"
        );
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("logs failure and exits with non-zero code when integrity check rejects", async () => {
        const failure = new Error("check failed");
        const runDataIntegrityCheck = jest.fn().mockRejectedValue(failure);
        const logger = {
            debug: jest.fn(),
            error: jest.fn(),
        };
        const exitSpy = jest
            .spyOn(process, "exit")
            .mockImplementation((() => undefined) as never);

        jest.doMock("../dataIntegrity", () => ({
            runDataIntegrityCheck,
        }));
        jest.doMock("../../utils/logger", () => ({ logger }));

        await importCliEntrypoint();

        expect(runDataIntegrityCheck).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(
            "\n Data integrity check failed:",
            failure
        );
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
});
