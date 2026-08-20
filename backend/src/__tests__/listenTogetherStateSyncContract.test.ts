import fs from "fs";
import path from "path";

describe("listen together state sync contract", () => {
    const socketServicePath = path.join(
        __dirname,
        "..",
        "services",
        "listenTogetherSocket.ts",
    );
    const managerPath = path.join(
        __dirname,
        "..",
        "services",
        "listenTogetherManager.ts",
    );

    const socketSource = fs.readFileSync(socketServicePath, "utf8");
    const managerSource = fs.readFileSync(managerPath, "utf8");
    const snapshotPath = path.join(
        __dirname,
        "..",
        "services",
        "listenTogetherSnapshot.ts",
    );
    const snapshotSource = fs.readFileSync(snapshotPath, "utf8");

    it("starts cluster sync and applies external snapshots", () => {
        expect(socketSource).toContain("listenTogetherClusterSync");
        expect(socketSource).toContain(".start((snapshot)");
        expect(socketSource).toContain(
            "groupManager.applyExternalSnapshot(snapshot)",
        );
    });

    it("publishes snapshots on group mutation callbacks", () => {
        expect(socketSource).toContain("publishSnapshot(groupId, snapshot)");
        expect(socketSource).toContain("snapshotById(groupId)");
    });

    it("group manager can apply externally synced snapshots", () => {
        expect(managerSource).toContain(
            "applyExternalSnapshot(snapshot: GroupSnapshot)",
        );
        expect(managerSource).toContain("mergeSnapshotMembers(");
        expect(managerSource).toContain("shouldApplyIncomingPlayback(");
        expect(snapshotSource).toContain(
            "Merge snapshot membership while retaining members connected to this pod.",
        );
        expect(snapshotSource).toContain(
            "existingMember?.socketIds ?? new Set<string>()",
        );
        // Equal-version ordering stays in the producer clock domain.
        expect(snapshotSource).toContain(
            "existing.playback.lastAppliedSnapshotServerTime",
        );
    });
});
