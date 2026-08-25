import { scanRedisKeys } from "../enrichmentMixCache";

describe("enrichment mix-cache scanning", () => {
    it("returns the same matching key set across bounded SCAN pages", async () => {
        const scan = jest
            .fn()
            .mockResolvedValueOnce(["7", ["mixes:first", "mixes:second"]])
            .mockResolvedValueOnce(["0", ["mixes:second", "mixes:third"]]);

        const keys = await scanRedisKeys({ scan }, "mixes:*", 250, 10);

        expect(new Set(keys)).toEqual(
            new Set(["mixes:first", "mixes:second", "mixes:third"]),
        );
        expect(scan).toHaveBeenNthCalledWith(
            1,
            "0",
            "MATCH",
            "mixes:*",
            "COUNT",
            250,
        );
        expect(scan).toHaveBeenNthCalledWith(
            2,
            "7",
            "MATCH",
            "mixes:*",
            "COUNT",
            250,
        );
    });

    it("fails closed when the scan iteration bound is exhausted", async () => {
        const scan = jest.fn<
            Promise<[string, string[]]>,
            [string, "MATCH", string, "COUNT", number]
        >(async () => ["1", ["mixes:first"]]);

        await expect(
            scanRedisKeys({ scan }, "mixes:*", 250, 2),
        ).rejects.toThrow("iteration limit");
        expect(scan).toHaveBeenCalledTimes(2);
    });
});
