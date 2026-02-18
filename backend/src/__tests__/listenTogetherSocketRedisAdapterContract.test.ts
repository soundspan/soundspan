import fs from "fs";
import path from "path";

describe("listen together socket redis adapter contract", () => {
    const socketServicePath = path.join(
        __dirname,
        "..",
        "services",
        "listenTogetherSocket.ts"
    );
    const frontendSocketPath = path.resolve(
        __dirname,
        "../../../frontend/lib/listen-together-socket.ts"
    );
    const source = fs.readFileSync(socketServicePath, "utf8");
    const frontendSource = fs.readFileSync(frontendSocketPath, "utf8");

    it("supports env flag to disable redis adapter", () => {
        expect(source).toContain("LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED");
        expect(source).toContain(
            "process.env.LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED !== \"false\""
        );
    });

    it("initializes socket.io redis adapter and redis clients", () => {
        expect(source).toContain("@socket.io/redis-adapter");
        expect(source).toContain("createIORedisClient");
        expect(source).toContain("createAdapter(redisAdapterPubClient, redisAdapterSubClient)");
        expect(source).toContain("(io as any).adapter(");
        expect(source).not.toContain("(ns as any).adapter(");
    });

    it("supports websocket-only transport policy by default", () => {
        expect(source).toContain("LISTEN_TOGETHER_ALLOW_POLLING");
        expect(source).toContain("LISTEN_TOGETHER_SOCKET_TRANSPORTS");
        expect(source).toContain("transports: LISTEN_TOGETHER_SOCKET_TRANSPORTS");

        expect(frontendSource).toContain("NEXT_PUBLIC_LISTEN_TOGETHER_ALLOW_POLLING");
        expect(frontendSource).toContain("LISTEN_TOGETHER_SOCKET_TRANSPORTS");
        expect(frontendSource).toContain("[\"websocket\"]");
    });
});
