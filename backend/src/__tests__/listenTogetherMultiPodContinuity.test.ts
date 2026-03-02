import {
    groupManager,
    type GroupSnapshot,
    type SyncQueueItem,
} from "../services/listenTogetherManager";

function buildTrack(id: string, title: string): SyncQueueItem {
    return {
        id,
        title,
        duration: 240,
        artist: { id: "artist-1", name: "Artist" },
        album: { id: "album-1", title: "Album", coverArt: null },
    };
}

describe("listen together multi-pod continuity", () => {
    const createdGroupIds: string[] = [];

    afterEach(() => {
        for (const groupId of createdGroupIds.splice(0, createdGroupIds.length)) {
            groupManager.remove(groupId);
        }
    });

    it("preserves local socket presence when external snapshots mark members disconnected", () => {
        const groupId = `lt-multipod-${Date.now()}-presence`;
        createdGroupIds.push(groupId);

        const hostUserId = "host-user";
        groupManager.create(groupId, {
            name: "Group",
            joinCode: "ABC123",
            groupType: "host-follower",
            visibility: "public",
            hostUserId,
            hostUsername: "Host",
            queue: [buildTrack("track-1", "Track 1")],
            createdAt: new Date(),
        });

        groupManager.addMember(groupId, "member-2", "Member 2");
        groupManager.addSocket(groupId, "member-2", "pod-a-socket");

        const snapshot = groupManager.snapshotById(groupId);
        expect(snapshot).toBeDefined();

        const remoteSnapshot = JSON.parse(
            JSON.stringify(snapshot)
        ) as GroupSnapshot;
        remoteSnapshot.members = remoteSnapshot.members.map((member) =>
            member.userId === "member-2"
                ? { ...member, isConnected: false }
                : member
        );

        groupManager.applyExternalSnapshot(remoteSnapshot);

        expect(groupManager.socketCount(groupId, "member-2")).toBe(1);
        const after = groupManager.snapshotById(groupId);
        expect(after).toBeDefined();
        const member = after!.members.find((m) => m.userId === "member-2");
        expect(member?.isConnected).toBe(true);
    });

    it("restores active playback state from snapshot after simulated pod restart", () => {
        const groupId = `lt-multipod-${Date.now()}-rolling`;
        createdGroupIds.push(groupId);

        const hostUserId = "host-user";
        groupManager.create(groupId, {
            name: "Group",
            joinCode: "XYZ789",
            groupType: "host-follower",
            visibility: "public",
            hostUserId,
            hostUsername: "Host",
            queue: [
                buildTrack("track-1", "Track 1"),
                buildTrack("track-2", "Track 2"),
            ],
            createdAt: new Date(),
        });

        groupManager.addMember(groupId, "member-2", "Member 2");
        groupManager.play(groupId, hostUserId);
        groupManager.seek(groupId, hostUserId, 42_000);

        const beforeRestart = groupManager.snapshotById(groupId);
        expect(beforeRestart).toBeDefined();
        expect(beforeRestart!.playback.isPlaying).toBe(true);
        expect(beforeRestart!.playback.positionMs).toBeGreaterThanOrEqual(42_000);

        // Simulate pod replacement: in-memory state is lost on old pod.
        groupManager.remove(groupId);
        expect(groupManager.get(groupId)).toBeUndefined();

        // Simulate warm restore from authoritative shared state store snapshot.
        groupManager.applyExternalSnapshot(beforeRestart!);

        const restored = groupManager.snapshotById(groupId);
        expect(restored).toBeDefined();
        expect(restored!.playback.trackId).toBe(beforeRestart!.playback.trackId);
        expect(restored!.playback.currentIndex).toBe(
            beforeRestart!.playback.currentIndex
        );
        expect(restored!.playback.isPlaying).toBe(beforeRestart!.playback.isPlaying);
        expect(restored!.playback.stateVersion).toBe(
            beforeRestart!.playback.stateVersion
        );
        expect(restored!.members.length).toBe(beforeRestart!.members.length);

        // Ensure host can continue controlling playback after restore.
        groupManager.pause(groupId, hostUserId);
        const afterPause = groupManager.snapshotById(groupId);
        expect(afterPause?.playback.isPlaying).toBe(false);
        expect(afterPause?.playback.stateVersion).toBeGreaterThan(
            beforeRestart!.playback.stateVersion
        );
    });

    it("keeps state monotonic across repeated pod handoffs", () => {
        const groupId = `lt-multipod-${Date.now()}-handoff`;
        createdGroupIds.push(groupId);

        const hostUserId = "host-user";
        const memberUserId = "member-2";
        groupManager.create(groupId, {
            name: "Group",
            joinCode: "LMN456",
            groupType: "host-follower",
            visibility: "public",
            hostUserId,
            hostUsername: "Host",
            queue: [
                buildTrack("track-1", "Track 1"),
                buildTrack("track-2", "Track 2"),
                buildTrack("track-3", "Track 3"),
            ],
            createdAt: new Date(),
        });

        groupManager.addMember(groupId, memberUserId, "Member 2");
        groupManager.addSocket(groupId, hostUserId, "pod-a-host");
        groupManager.addSocket(groupId, memberUserId, "pod-a-member");
        groupManager.play(groupId, hostUserId);
        groupManager.seek(groupId, hostUserId, 12_000);

        const podASnapshot = groupManager.snapshotById(groupId);
        expect(podASnapshot).toBeDefined();

        // Pod A is replaced; Pod B restores from authoritative snapshot.
        groupManager.remove(groupId);
        groupManager.applyExternalSnapshot(podASnapshot!);
        groupManager.addSocket(groupId, hostUserId, "pod-b-host");
        groupManager.addSocket(groupId, memberUserId, "pod-b-member");

        groupManager.next(groupId, hostUserId);
        groupManager.pause(groupId, hostUserId);
        const podBSnapshot = groupManager.snapshotById(groupId);
        expect(podBSnapshot).toBeDefined();
        expect(podBSnapshot!.playback.currentIndex).toBe(1);
        expect(podBSnapshot!.playback.isPlaying).toBe(false);
        expect(podBSnapshot!.playback.stateVersion).toBeGreaterThan(
            podASnapshot!.playback.stateVersion
        );

        // Pod B is replaced; Pod C restores and must continue from latest state.
        groupManager.remove(groupId);
        groupManager.applyExternalSnapshot(podBSnapshot!);
        groupManager.addSocket(groupId, hostUserId, "pod-c-host");

        const restored = groupManager.snapshotById(groupId);
        expect(restored).toBeDefined();
        expect(restored!.playback.currentIndex).toBe(1);
        expect(restored!.playback.isPlaying).toBe(false);
        expect(restored!.playback.stateVersion).toBe(
            podBSnapshot!.playback.stateVersion
        );

        groupManager.play(groupId, hostUserId);
        const afterResume = groupManager.snapshotById(groupId);
        expect(afterResume?.playback.isPlaying).toBe(false);
        groupManager.reportReady(groupId, hostUserId);
        const afterReady = groupManager.snapshotById(groupId);
        expect(afterReady?.playback.isPlaying).toBe(true);
        expect(afterReady?.playback.stateVersion).toBeGreaterThan(
            podBSnapshot!.playback.stateVersion
        );
    });
});
