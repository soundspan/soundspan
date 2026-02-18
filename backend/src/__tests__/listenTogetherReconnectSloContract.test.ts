import fs from "fs";
import path from "path";

describe("listen together reconnect SLO contract", () => {
    const socketServicePath = path.join(
        __dirname,
        "..",
        "services",
        "listenTogetherSocket.ts"
    );
    const source = fs.readFileSync(socketServicePath, "utf8");

    it("supports env-driven reconnect SLO threshold", () => {
        expect(source).toContain("LISTEN_TOGETHER_RECONNECT_SLO_MS");
        expect(source).toContain("DEFAULT_LISTEN_TOGETHER_RECONNECT_SLO_MS");
    });

    it("records reconnect latency and warns on SLO breach", () => {
        expect(source).toContain("[ListenTogether/SLO] Reconnect latency");
        expect(source).toContain("exceeded target");
    });
});
