import { chunkArray, processBatched, yieldToEventLoop } from "../async";

describe("async utils", () => {
    describe("chunkArray", () => {
        it("splits an array into normal chunks", () => {
            expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([
                [1, 2],
                [3, 4],
                [5],
            ]);
        });

        it("returns a single chunk when chunk size is larger than the array", () => {
            expect(chunkArray([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
        });

        it("returns an empty array for empty input", () => {
            expect(chunkArray([], 3)).toEqual([]);
        });

        it("throws when chunk size is not positive", () => {
            expect(() => chunkArray([1, 2, 3], 0)).toThrow(
                "Chunk size must be positive",
            );
            expect(() => chunkArray([1, 2, 3], -1)).toThrow(
                "Chunk size must be positive",
            );
        });
    });

    describe("yieldToEventLoop", () => {
        it("resolves successfully", async () => {
            await expect(yieldToEventLoop()).resolves.toBeUndefined();
        });
    });

    describe("processBatched", () => {
        it("processes multiple chunks in order", async () => {
            const calls: number[][] = [];
            const processor = jest.fn(async (batch: number[]) => {
                calls.push([...batch]);
                return batch.map((item) => item * 10);
            });

            const results = await processBatched([1, 2, 3, 4, 5], 2, processor);

            expect(calls).toEqual([
                [1, 2],
                [3, 4],
                [5],
            ]);
            expect(results).toEqual([10, 20, 30, 40, 50]);
            expect(processor).toHaveBeenCalledTimes(3);
        });

        it("stops early when AbortSignal is already aborted", async () => {
            const controller = new AbortController();
            controller.abort();
            const processor = jest.fn(async (batch: number[]) => batch);

            const results = await processBatched(
                [1, 2, 3, 4],
                2,
                processor,
                controller.signal,
            );

            expect(results).toEqual([]);
            expect(processor).not.toHaveBeenCalled();
        });

        it("stops after first chunk when signal is aborted in processor", async () => {
            const controller = new AbortController();
            const processor = jest.fn(async (batch: number[]) => {
                if (batch[0] === 1) {
                    controller.abort();
                }
                return batch;
            });

            const results = await processBatched(
                [1, 2, 3, 4],
                2,
                processor,
                controller.signal,
            );

            expect(results).toEqual([1, 2]);
            expect(processor).toHaveBeenCalledTimes(1);
        });

        it("propagates processor rejection", async () => {
            const error = new Error("processor failed");
            const processor = jest.fn(async (batch: number[]) => {
                if (batch[0] === 3) {
                    throw error;
                }
                return batch;
            });

            await expect(
                processBatched([1, 2, 3, 4], 2, processor),
            ).rejects.toThrow("processor failed");
            expect(processor).toHaveBeenCalledTimes(2);
        });
    });
});
