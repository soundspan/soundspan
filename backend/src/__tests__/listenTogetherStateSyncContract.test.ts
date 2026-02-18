import fs from "fs";
import path from "path";

describe("listen together state sync contract", () => {
    const socketServicePath = path.join(
        __dirname,
        "..",
        "services",
        "listenTogetherSocket.ts"
    );
    const clusterSyncPath = path.join(
        __dirname,
        "..",
        "services",
        "listenTogetherClusterSync.ts"
    );
    const managerPath = path.join(
        __dirname,
        "..",
        "services",
        "listenTogetherManager.ts"
    );

    const socketSource = fs.readFileSync(socketServicePath, "utf8");
    const clusterSyncSource = fs.readFileSync(clusterSyncPath, "utf8");
    const managerSource = fs.readFileSync(managerPath, "utf8");

    it("starts cluster sync and applies external snapshots", () => {
        expect(socketSource).toContain("listenTogetherClusterSync");
        expect(socketSource).toContain(".start((snapshot)");
        expect(socketSource).toContain("groupManager.applyExternalSnapshot(snapshot)");
    });

    it("publishes snapshots on group mutation callbacks", () => {
        expect(socketSource).toContain("publishSnapshot(groupId, snapshot)");
        expect(socketSource).toContain("snapshotById(groupId)");
    });

    it("supports disabling state sync by env flag", () => {
        expect(clusterSyncSource).toContain("LISTEN_TOGETHER_STATE_SYNC_ENABLED");
        expect(clusterSyncSource).toContain(
            "process.env.LISTEN_TOGETHER_STATE_SYNC_ENABLED !== \"false\""
        );
    });

    it("group manager can apply externally synced snapshots", () => {
        expect(managerSource).toContain("applyExternalSnapshot(snapshot: GroupSnapshot)");
        expect(managerSource).toContain("Preserve local socket presence for users connected to this pod.");
        expect(managerSource).toContain("shouldApplyIncomingPlayback(");
        expect(managerSource).toContain("incomingServerTime >= existing.playback.lastPositionUpdate");
    });
});
