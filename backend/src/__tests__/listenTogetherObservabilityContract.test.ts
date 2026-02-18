import fs from "fs";
import path from "path";

describe("listen together observability contract", () => {
    it("tracks reconnect and conflict counters with explicit logs", () => {
        const socketPath = path.resolve(
            __dirname,
            "../services/listenTogetherSocket.ts"
        );
        const source = fs.readFileSync(socketPath, "utf8");

        expect(source).toContain("listenTogetherObservabilityCounters");
        expect(source).toContain("reconnectSamples");
        expect(source).toContain("conflictErrors");
        expect(source).toContain("[ListenTogether/Observability]");
    });
});
