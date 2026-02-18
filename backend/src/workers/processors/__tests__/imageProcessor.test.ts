const mockLoggerDebug = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("../../../utils/logger", () => ({
    logger: {
        debug: (...args: unknown[]) => mockLoggerDebug(...args),
        error: (...args: unknown[]) => mockLoggerError(...args),
    },
}));

import { processImageOptimization } from "../imageProcessor";

describe("imageProcessor", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("returns success and reports all progress stages", async () => {
        const job = {
            id: "image-1",
            data: {
                imageUrl: "https://img/cover.jpg",
                coverId: "cover-1",
                type: "thumbnail",
            },
            progress: jest.fn().mockResolvedValue(undefined),
        } as any;

        const result = await processImageOptimization(job);

        expect(job.progress).toHaveBeenCalledTimes(3);
        expect(job.progress).toHaveBeenNthCalledWith(1, 0);
        expect(job.progress).toHaveBeenNthCalledWith(2, 50);
        expect(job.progress).toHaveBeenNthCalledWith(3, 100);
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[ImageJob image-1] Processing thumbnail for cover cover-1"
        );
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[ImageJob image-1] Image optimization complete"
        );
        expect(result).toEqual({ success: true, paths: [] });
    });

    it("captures thrown errors and returns normalized failure response", async () => {
        const job = {
            id: "image-2",
            data: {
                imageUrl: "https://img/cover.jpg",
                coverId: "cover-2",
                type: "webp",
            },
            progress: jest
                .fn()
                .mockResolvedValueOnce(undefined)
                .mockRejectedValueOnce(new Error("disk full")),
        } as any;

        const result = await processImageOptimization(job);

        expect(mockLoggerError).toHaveBeenCalledWith(
            "[ImageJob image-2] Optimization failed:",
            expect.any(Error)
        );
        expect(result).toEqual({
            success: false,
            error: "disk full",
        });
    });

    it("falls back to Unknown error when thrown value has no message", async () => {
        const job = {
            id: "image-3",
            data: {
                imageUrl: "https://img/cover.jpg",
                coverId: "cover-3",
                type: "webp",
            },
            progress: jest
                .fn()
                .mockResolvedValueOnce(undefined)
                .mockRejectedValueOnce({ code: "EFAIL" }),
        } as any;

        const result = await processImageOptimization(job);

        expect(result).toEqual({
            success: false,
            error: "Unknown error",
        });
    });
});
