import fs from "fs";
import path from "path";

describe("listen together reconnect SLO contract", () => {
    const socketServicePath = path.join(
        __dirname,
        "..",
        "services",
        "listenTogetherSocket.ts",
    );
    const source = fs.readFileSync(socketServicePath, "utf8");

    it("records reconnect latency and warns on SLO breach", () => {
        expect(source).toContain("[ListenTogether/SLO] Reconnect latency");
        expect(source).toContain("exceeded target");
    });
});
