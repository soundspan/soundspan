const redisClient = {
    set: jest.fn(),
    getDel: jest.fn(),
};

jest.mock("../redis", () => ({ redisClient }));

import { putOnce, takeOnce } from "../redisKv";

describe("redisKv", () => {
    beforeEach(() => jest.clearAllMocks());

    it("stores JSON with NX and a bounded TTL", async () => {
        redisClient.set.mockResolvedValue("OK");

        await expect(
            putOnce("oidc:pending:state", { nonce: "n" }, 600),
        ).resolves.toBe(true);
        expect(redisClient.set).toHaveBeenCalledWith(
            "oidc:pending:state",
            JSON.stringify({ nonce: "n" }),
            { EX: 600, NX: true },
        );
    });

    it("reports an existing key without overwriting it", async () => {
        redisClient.set.mockResolvedValue(null);

        await expect(
            putOnce("oidc:exchange:code", { userId: "u1" }, 60),
        ).resolves.toBe(false);
    });

    it("atomically gets and deletes a single-use value", async () => {
        redisClient.getDel.mockResolvedValue('{"userId":"u1"}');

        await expect(takeOnce("oidc:exchange:code")).resolves.toEqual({
            userId: "u1",
        });
        expect(redisClient.getDel).toHaveBeenCalledWith("oidc:exchange:code");
    });

    it("returns null for a missing value", async () => {
        redisClient.getDel.mockResolvedValue(null);

        await expect(takeOnce("oidc:exchange:missing")).resolves.toBeNull();
    });
});
