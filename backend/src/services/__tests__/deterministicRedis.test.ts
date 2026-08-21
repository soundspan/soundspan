import {
    LISTEN_TOGETHER_ACQUIRE_LEASE_SCRIPT,
    LISTEN_TOGETHER_VALIDATE_PUBLICATION_SCRIPT,
} from "../listenTogetherRedisScripts";
import { DeterministicRedisServer } from "./support/deterministicRedis";

describe("deterministic Redis Lua boundary", () => {
    it("executes only the exact production script constants", async () => {
        const server = new DeterministicRedisServer();
        const client = server.createClient();

        await expect(
            client.eval(
                `${LISTEN_TOGETHER_ACQUIRE_LEASE_SCRIPT}\n-- drift`,
                2,
                "lock",
                "counter",
                "owner",
                "1000",
            ),
        ).rejects.toThrow("Unsupported deterministic Redis Lua script");
    });

    it("models SET-before-INCR ordering when counter allocation errors", async () => {
        const server = new DeterministicRedisServer();
        const client = server.createClient();
        server.write("counter", "not-an-integer");

        await expect(
            client.eval(
                LISTEN_TOGETHER_ACQUIRE_LEASE_SCRIPT,
                2,
                "lock",
                "counter",
                "owner",
                "1000",
            ),
        ).rejects.toThrow("not an integer");
        expect(server.read("lock")).toBe("owner");
        server.advanceBy(1_001);
        expect(server.read("lock")).toBeNull();
    });

    it("rejects token-zero publication validation when Redis keys are absent", async () => {
        const server = new DeterministicRedisServer();
        const client = server.createClient();

        await expect(
            client.eval(
                LISTEN_TOGETHER_VALIDATE_PUBLICATION_SCRIPT,
                3,
                "snapshot",
                "fence",
                "counter",
                "0",
                "group-ended",
                "0",
                "0",
            ),
        ).resolves.toBe(0);
    });
});
