import { DownloadJobEvents } from "../downloadJobEvents";
import { logger } from "../../../utils/logger";

jest.mock("../../../utils/logger", () => ({
    logger: {
        child: jest.fn(() => ({ error: jest.fn() })),
    },
}));

const eventLogger = (logger.child as jest.Mock).mock.results[0].value;

describe("DownloadJobEvents", () => {
    it("publishes only the closed, typed download-job vocabulary", async () => {
        const events = new DownloadJobEvents();
        const completed = jest.fn(async () => undefined);
        const exhausted = jest.fn(async () => undefined);
        const timedOut = jest.fn(async () => ({ timeoutExtended: true }));

        events.on("download.completed", completed);
        events.on("download.exhausted", exhausted);
        events.on("download.timedOut", timedOut);

        await expect(
            events.emit("download.completed", {
                jobId: "job-1",
                userId: "user-1",
                subject: "Artist - Album",
                artistId: "artist-1",
            }),
        ).resolves.toEqual([undefined]);
        await expect(
            events.emit("download.exhausted", {
                jobId: "job-2",
                userId: "user-1",
                subject: "Artist - Missing",
                reason: "no releases",
            }),
        ).resolves.toEqual([undefined]);
        await expect(
            events.emit("download.timedOut", {
                jobId: "job-3",
                subject: "Artist - Slow Album",
            }),
        ).resolves.toEqual([{ timeoutExtended: true }]);

        expect(completed).toHaveBeenCalledTimes(1);
        expect(exhausted).toHaveBeenCalledTimes(1);
        expect(timedOut).toHaveBeenCalledTimes(1);
    });

    it("stops publishing after a listener unsubscribes", async () => {
        const events = new DownloadJobEvents();
        const listener = jest.fn(async () => undefined);
        const unsubscribe = events.on("download.completed", listener);

        unsubscribe();
        await expect(
            events.emit("download.completed", {
                jobId: "job-1",
                userId: "user-1",
                subject: "Artist - Album",
            }),
        ).resolves.toEqual([]);
        expect(listener).not.toHaveBeenCalled();
    });

    it("isolates a throwing subscriber and settles the remaining subscribers", async () => {
        const events = new DownloadJobEvents();
        const throwing = jest.fn(async () => {
            throw new Error("subscriber failed");
        });
        const succeeding = jest.fn(async () => ({ timeoutExtended: true }));
        events.on("download.timedOut", throwing);
        events.on("download.timedOut", succeeding);

        await expect(
            events.emit("download.timedOut", {
                jobId: "job-1",
                subject: "Artist - Album",
            }),
        ).resolves.toEqual([{ timeoutExtended: true }]);
        expect(throwing).toHaveBeenCalledTimes(1);
        expect(succeeding).toHaveBeenCalledTimes(1);
        expect(eventLogger.error).toHaveBeenCalledWith(
            "Download job event subscriber failed",
            expect.objectContaining({
                eventName: "download.timedOut",
                error: expect.any(Error),
            }),
        );
    });
});
