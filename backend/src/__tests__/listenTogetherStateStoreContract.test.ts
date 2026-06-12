import fs from "fs";
import path from "path";

describe("listen together state store contract", () => {
    const socketServicePath = path.join(
        __dirname,
        "..",
        "services",
        "listenTogetherSocket.ts"
    );
    const listenTogetherServicePath = path.join(
        __dirname,
        "..",
        "services",
        "listenTogether.ts"
    );
    const stateStorePath = path.join(
        __dirname,
        "..",
        "services",
        "listenTogetherStateStore.ts"
    );

    const socketSource = fs.readFileSync(socketServicePath, "utf8");
    const serviceSource = fs.readFileSync(listenTogetherServicePath, "utf8");
    const stateStoreSource = fs.readFileSync(stateStorePath, "utf8");

    it("loads authoritative snapshot from redis store before locked mutations", () => {
        expect(socketSource).toContain(
            "await listenTogetherStateStore.getSnapshot(groupId)"
        );
        expect(socketSource).toContain(
            "groupManager.applyExternalSnapshot(authoritativeSnapshot)"
        );
    });

    it("persists and deletes snapshots through callbacks and shutdown", () => {
        expect(socketSource).toContain(
            "await listenTogetherStateStore.setSnapshot(groupId, resolvedSnapshot)"
        );
        expect(socketSource).toContain(
            "await listenTogetherStateStore.deleteSnapshot(groupId)"
        );
        expect(socketSource).toContain("listenTogetherStateStore.stop();");
    });

    it("hydrates cold-path memory from state store before database fallback", () => {
        expect(serviceSource).toContain(
            "const storedSnapshot = await listenTogetherStateStore.getSnapshot(groupId);"
        );
        expect(serviceSource).toContain(
            "groupManager.applyExternalSnapshot(storedSnapshot);"
        );
    });

    it("defines env-driven controls for authoritative store", () => {
        expect(stateStoreSource).toContain(
            "LISTEN_TOGETHER_STATE_STORE_ENABLED"
        );
        expect(stateStoreSource).toContain(
            "LISTEN_TOGETHER_STATE_STORE_TTL_SECONDS"
        );
        expect(stateStoreSource).toContain(
            "LISTEN_TOGETHER_STATE_STORE_KEY_PREFIX"
        );
    });
});
