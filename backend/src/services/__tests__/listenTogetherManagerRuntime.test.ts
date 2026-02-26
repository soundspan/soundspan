import {
    GroupError,
    groupManager,
    type GroupSnapshot,
    type ManagerCallbacks,
    type SyncQueueItem,
} from "../listenTogetherManager";

describe("listenTogetherManager runtime behavior", () => {
    const track = (id: string, duration: number = 180): SyncQueueItem => ({
        id,
        title: `Track ${id}`,
        duration,
        artist: { id: `artist-${id}`, name: `Artist ${id}` },
        album: { id: `album-${id}`, title: `Album ${id}`, coverArt: null },
        mediaSource: "local",
        provider: { source: "local" },
    });

    const createCallbacks = (): jest.Mocked<ManagerCallbacks> => ({
        onGroupState: jest.fn(),
        onPlaybackDelta: jest.fn(),
        onQueueDelta: jest.fn(),
        onWaiting: jest.fn(),
        onPlayAt: jest.fn(),
        onMemberJoined: jest.fn(),
        onMemberLeft: jest.fn(),
        onGroupEnded: jest.fn(),
    });

    const resetManager = (): void => {
        for (const groupId of groupManager.allGroupIds()) {
            groupManager.remove(groupId);
        }
    };

    beforeEach(() => {
        jest.useRealTimers();
        resetManager();
    });

    afterEach(() => {
        jest.useRealTimers();
        resetManager();
        jest.clearAllMocks();
    });

    it("creates and hydrates groups with expected initial playback state", () => {
        const callbacks = createCallbacks();
        groupManager.setCallbacks(callbacks);

        const created = groupManager.create("g-create", {
            name: "Created",
            joinCode: "ABC123",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host-1",
            hostUsername: "Host 1",
            queue: [track("1"), track("2")],
            currentIndex: 1,
            currentTimeMs: 2500,
            isPlaying: true,
            createdAt: new Date("2026-02-16T00:00:00.000Z"),
        });
        const hydrated = groupManager.hydrate("g-hydrate", {
            name: "Hydrated",
            joinCode: "XYZ987",
            groupType: "collaborative",
            visibility: "public",
            hostUserId: "host-2",
            queue: [track("3")],
            currentIndex: 0,
            isPlaying: true,
            currentTimeMs: 900,
            stateVersion: 7,
            createdAt: new Date("2026-02-15T00:00:00.000Z"),
            members: [
                {
                    userId: "host-2",
                    username: "Hydrated Host",
                    isHost: true,
                    joinedAt: new Date("2026-02-15T00:00:00.000Z"),
                },
            ],
        });

        expect(created.playback.currentIndex).toBe(1);
        expect(created.playback.isPlaying).toBe(true);
        expect(groupManager.has("g-create")).toBe(true);
        expect(groupManager.get("g-create")).toBeDefined();
        expect(hydrated.syncState).toBe("playing");
        expect(hydrated.playback.isPlaying).toBe(false);
        expect(groupManager.allGroupIds().sort()).toEqual([
            "g-create",
            "g-hydrate",
        ]);
    });

    it("tracks dirty groups and supports markClean/remove", () => {
        groupManager.setCallbacks(createCallbacks());
        groupManager.create("g-dirty", {
            name: "Dirty",
            joinCode: "D1",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1")],
            createdAt: new Date(),
        });

        groupManager.addMember("g-dirty", "guest-1", "Guest 1");
        expect(groupManager.dirtyGroups().map((g) => g.id)).toContain("g-dirty");

        groupManager.markClean("g-dirty");
        expect(groupManager.dirtyGroups().map((g) => g.id)).not.toContain("g-dirty");

        groupManager.remove("g-dirty");
        expect(groupManager.has("g-dirty")).toBe(false);
    });

    it("handles member joins/leaves including host transfer and auto-disband", () => {
        const callbacks = createCallbacks();
        groupManager.setCallbacks(callbacks);
        groupManager.create("g-members", {
            name: "Members",
            joinCode: "MEM",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1")],
            createdAt: new Date(),
        });

        // Existing member path updates/broadcasts without a join callback.
        const existingSnapshot = groupManager.addMember("g-members", "host", "Host");
        expect(existingSnapshot.members.length).toBe(1);
        expect(callbacks.onMemberJoined).not.toHaveBeenCalled();

        groupManager.addMember("g-members", "u-b", "Bravo");
        groupManager.addMember("g-members", "u-a", "Alpha");
        const transfer = groupManager.removeMember("g-members", "host");

        expect(transfer).toEqual({
            ended: false,
            newHostUserId: "u-a",
            newHostUsername: "Alpha",
        });
        expect(callbacks.onMemberLeft).toHaveBeenCalledWith(
            "g-members",
            expect.objectContaining({
                userId: "host",
                newHostUserId: "u-a",
            })
        );

        const ended = groupManager.removeMember("g-members", "u-a");
        expect(ended.ended).toBe(false);
        const lastEnded = groupManager.removeMember("g-members", "u-b");
        expect(lastEnded.ended).toBe(true);
        expect(callbacks.onGroupEnded).toHaveBeenCalledWith(
            "g-members",
            "All members left"
        );
    });

    it("tracks sockets, presence transitions, and ready-gate disconnection behavior", () => {
        const callbacks = createCallbacks();
        groupManager.setCallbacks(callbacks);
        groupManager.create("g-socket", {
            name: "Sockets",
            joinCode: "SOC",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1"), track("2")],
            createdAt: new Date(),
        });
        groupManager.addMember("g-socket", "guest", "Guest");
        groupManager.addSocket("g-socket", "host", "host-socket");
        groupManager.addSocket("g-socket", "guest", "guest-socket");

        expect(groupManager.socketCount("g-socket", "guest")).toBe(1);
        expect(groupManager.connectedMemberCount("g-socket")).toBe(2);

        // Enter waiting gate and mark host ready so guest disconnect triggers forcePlay.
        groupManager.setTrack("g-socket", "host", 1, true);
        groupManager.reportReady("g-socket", "host");
        groupManager.removeSocket("g-socket", "guest", "guest-socket");

        expect(groupManager.connectedMemberCount("g-socket")).toBe(1);
        expect(callbacks.onPlayAt).toHaveBeenCalled();
    });

    it("enforces host-only playback control and supports play/pause/seek deltas", () => {
        const callbacks = createCallbacks();
        groupManager.setCallbacks(callbacks);
        groupManager.create("g-playback", {
            name: "Playback",
            joinCode: "PLY",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1", 120)],
            createdAt: new Date(),
        });
        groupManager.addMember("g-playback", "guest", "Guest");

        expect(() => groupManager.play("g-playback", "guest")).toThrow(GroupError);

        const playDelta = groupManager.play("g-playback", "host");
        expect(playDelta.isPlaying).toBe(true);
        const pauseDelta = groupManager.pause("g-playback", "host");
        expect(pauseDelta.isPlaying).toBe(false);

        const seekDelta = groupManager.seek("g-playback", "host", 999_999);
        expect(seekDelta.positionMs).toBe(120_000);
        expect(callbacks.onPlaybackDelta).toHaveBeenCalled();
    });

    it("supports next/previous behavior including restart-current shortcut", () => {
        groupManager.setCallbacks(createCallbacks());
        groupManager.create("g-nav", {
            name: "Nav",
            joinCode: "NAV",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1", 240), track("2", 240)],
            currentIndex: 1,
            createdAt: new Date(),
        });
        groupManager.addSocket("g-nav", "host", "host-socket");

        const nextResult = groupManager.next("g-nav", "host");
        expect(nextResult.snapshot.playback.currentIndex).toBe(0);

        // Set position past 3s so previous restarts current track.
        groupManager.seek("g-nav", "host", 4_000);
        const previousRestart = groupManager.previous("g-nav", "host");
        expect(previousRestart.snapshot.playback.currentIndex).toBe(0);
    });

    it("handles ready-gate track switching, reportReady, and timeout auto-start", async () => {
        jest.useFakeTimers();
        const callbacks = createCallbacks();
        groupManager.setCallbacks(callbacks);
        groupManager.create("g-ready", {
            name: "Ready",
            joinCode: "RDY",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1"), track("2")],
            createdAt: new Date(),
        });
        groupManager.addMember("g-ready", "guest", "Guest");
        groupManager.addSocket("g-ready", "host", "host-socket");
        groupManager.addSocket("g-ready", "guest", "guest-socket");

        const waiting = groupManager.setTrack("g-ready", "host", 1, true);
        expect(waiting.waiting).toBe(true);
        expect(() => groupManager.setTrack("g-ready", "host", 0, true)).toThrow(
            GroupError
        );

        expect(groupManager.reportReady("g-ready", "host")).toBe(false);
        expect(groupManager.reportReady("g-ready", "guest")).toBe(true);
        expect(callbacks.onPlayAt).toHaveBeenCalledTimes(1);

        // Trigger timeout path on a new waiting gate.
        callbacks.onPlayAt.mockClear();
        groupManager.setTrack("g-ready", "host", 0, true);
        await jest.advanceTimersByTimeAsync(8_000);
        expect(callbacks.onPlayAt).toHaveBeenCalledTimes(1);
    });

    it("applies queue actions for add/remove/clear and rejects invalid actions", () => {
        const callbacks = createCallbacks();
        groupManager.setCallbacks(callbacks);
        groupManager.create("g-queue", {
            name: "Queue",
            joinCode: "QUE",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [],
            createdAt: new Date(),
        });

        const addDelta = groupManager.modifyQueue("g-queue", "host", {
            action: "add",
            items: [track("1"), track("2")],
        });
        expect(addDelta.queue.length).toBe(2);
        expect(addDelta.queue[0]?.provider?.source).toBe("local");
        expect(groupManager.get("g-queue")?.syncState).toBe("paused");

        groupManager.modifyQueue("g-queue", "host", { action: "remove", index: 0 });
        expect(() =>
            groupManager.modifyQueue("g-queue", "host", {
                action: "remove",
                index: 99,
            })
        ).toThrow(GroupError);
        expect(() =>
            groupManager.modifyQueue("g-queue", "host", {
                action: "reorder",
                fromIndex: 0,
                toIndex: 1,
            })
        ).toThrow(GroupError);

        const clearDelta = groupManager.modifyQueue("g-queue", "host", {
            action: "clear",
        });
        expect(clearDelta.queue).toEqual([]);
        expect(groupManager.get("g-queue")?.syncState).toBe("idle");
        expect(callbacks.onQueueDelta).toHaveBeenCalled();
    });

    it("supports end-group permissions and force-end behavior", () => {
        const callbacks = createCallbacks();
        groupManager.setCallbacks(callbacks);
        groupManager.create("g-end", {
            name: "End",
            joinCode: "END",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1")],
            createdAt: new Date(),
        });
        groupManager.addMember("g-end", "guest", "Guest");

        expect(() => groupManager.endGroup("g-end", "guest")).toThrow(GroupError);
        groupManager.endGroup("g-end", "host");
        expect(callbacks.onGroupEnded).toHaveBeenCalledWith(
            "g-end",
            "Host ended the group"
        );

        callbacks.onGroupEnded.mockClear();
        groupManager.forceEnd("g-end", "forced cleanup");
        expect(callbacks.onGroupEnded).toHaveBeenCalledWith(
            "g-end",
            "forced cleanup"
        );
    });

    it("generates snapshots and applies external snapshots with version/time guards", () => {
        groupManager.setCallbacks(createCallbacks());
        groupManager.create("g-snap", {
            name: "Snapshot",
            joinCode: "SNP",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1"), track("2")],
            currentIndex: 1,
            createdAt: new Date(),
        });
        groupManager.addMember("g-snap", "guest", "Guest");
        groupManager.addSocket("g-snap", "host", "host-socket");

        const before = groupManager.snapshotById("g-snap");
        expect(before?.members[0]?.isHost).toBe(true);
        expect(before?.members[0]?.userId).toBe("host");

        const staleSnapshot: GroupSnapshot = {
            ...before!,
            playback: {
                ...before!.playback,
                queue: [track("x")],
                currentIndex: 0,
                stateVersion: before!.playback.stateVersion,
                serverTime: before!.playback.serverTime - 1_000,
                positionMs: 1234,
            },
        };
        groupManager.applyExternalSnapshot(staleSnapshot);
        const afterStale = groupManager.snapshotById("g-snap");
        expect(afterStale?.playback.queue.length).toBe(2);

        const freshSnapshot: GroupSnapshot = {
            ...before!,
            playback: {
                ...before!.playback,
                queue: [track("fresh-1")],
                currentIndex: 0,
                stateVersion: before!.playback.stateVersion + 1,
                serverTime: before!.playback.serverTime + 5_000,
                positionMs: 2000,
                isPlaying: true,
                trackId: "fresh-1",
            },
        };
        groupManager.applyExternalSnapshot(freshSnapshot);
        const afterFresh = groupManager.snapshotById("g-snap");
        expect(afterFresh?.playback.queue[0]?.id).toBe("fresh-1");
    });

    it("cleans up stale members and returns removed user IDs", () => {
        groupManager.setCallbacks(createCallbacks());
        const now = Date.now();
        jest.spyOn(Date, "now").mockReturnValue(now);

        groupManager.create("g-stale", {
            name: "Stale",
            joinCode: "STL",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1")],
            createdAt: new Date(now),
        });
        groupManager.addMember("g-stale", "guest", "Guest");
        groupManager.addSocket("g-stale", "host", "host-socket");
        groupManager.removeSocket("g-stale", "guest", "missing-socket");

        // Advance clock past stale threshold so disconnected guest is removed.
        (Date.now as jest.Mock).mockReturnValue(now + 61_000);
        const removed = groupManager.cleanupStaleMembers("g-stale");
        expect(removed).toContain("guest");
        expect(groupManager.cleanupStaleMembers("unknown-group")).toEqual([]);
    });

    it("uses joinedAt tie-break for host transfer and re-checks ready gate after host leaves", () => {
        const callbacks = createCallbacks();
        groupManager.setCallbacks(callbacks);
        groupManager.hydrate("g-host-transfer", {
            name: "Host Transfer",
            joinCode: "HOSTTR",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            queue: [track("1"), track("2")],
            currentIndex: 0,
            isPlaying: false,
            currentTimeMs: 0,
            stateVersion: 1,
            createdAt: new Date("2026-02-16T00:00:00.000Z"),
            members: [
                {
                    userId: "host",
                    username: "Host",
                    isHost: true,
                    joinedAt: new Date("2026-02-16T00:00:00.000Z"),
                },
                {
                    userId: "user-a",
                    username: "Same Name",
                    isHost: false,
                    joinedAt: new Date("2026-02-16T00:00:01.000Z"),
                },
                {
                    userId: "user-b",
                    username: "Same Name",
                    isHost: false,
                    joinedAt: new Date("2026-02-16T00:00:02.000Z"),
                },
            ],
        });
        groupManager.addSocket("g-host-transfer", "host", "sock-host");
        groupManager.addSocket("g-host-transfer", "user-a", "sock-a");
        groupManager.addSocket("g-host-transfer", "user-b", "sock-b");

        const waiting = groupManager.setTrack("g-host-transfer", "host", 1, true);
        expect(waiting.waiting).toBe(true);
        groupManager.reportReady("g-host-transfer", "user-a");
        groupManager.reportReady("g-host-transfer", "user-b");
        callbacks.onPlayAt.mockClear();

        const removed = groupManager.removeMember("g-host-transfer", "host");
        expect(removed.ended).toBe(false);
        expect(removed.newHostUserId).toBe("user-a");
        expect(callbacks.onPlayAt).toHaveBeenCalled();
    });

    it("keeps paused sync state when setTrack is called with autoPlay=false", () => {
        groupManager.setCallbacks(createCallbacks());
        groupManager.create("g-auto-play-off", {
            name: "Auto Play Off",
            joinCode: "APOFF",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1"), track("2")],
            createdAt: new Date(),
        });
        groupManager.addSocket("g-auto-play-off", "host", "sock-host");

        const result = groupManager.setTrack("g-auto-play-off", "host", 1, false);
        expect(result.waiting).toBe(false);
        expect(groupManager.get("g-auto-play-off")?.syncState).toBe("paused");
    });

    it("wraps previous track navigation when near the start of playback", () => {
        groupManager.setCallbacks(createCallbacks());
        groupManager.create("g-prev-wrap", {
            name: "Prev Wrap",
            joinCode: "PWRAP",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1"), track("2"), track("3")],
            currentIndex: 0,
            createdAt: new Date(),
        });
        groupManager.addSocket("g-prev-wrap", "host", "sock-host");

        const result = groupManager.previous("g-prev-wrap", "host");
        expect(result.snapshot.playback.currentIndex).toBe(2);
    });

    it("applies queue remove branches for empty queue and index-shift adjustments", () => {
        groupManager.setCallbacks(createCallbacks());
        groupManager.create("g-remove-empty", {
            name: "Remove Empty",
            joinCode: "REMEM",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1")],
            createdAt: new Date(),
        });

        groupManager.modifyQueue("g-remove-empty", "host", {
            action: "remove",
            index: 0,
        });
        const emptySnapshot = groupManager.snapshotById("g-remove-empty");
        expect(emptySnapshot?.playback.queue).toEqual([]);
        expect(groupManager.get("g-remove-empty")?.syncState).toBe("idle");

        groupManager.create("g-remove-shift", {
            name: "Remove Shift",
            joinCode: "REMSH",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1"), track("2"), track("3")],
            currentIndex: 2,
            createdAt: new Date(),
        });
        groupManager.modifyQueue("g-remove-shift", "host", {
            action: "remove",
            index: 0,
        });
        expect(groupManager.snapshotById("g-remove-shift")?.playback.currentIndex).toBe(1);
    });

    it("clears ready timeout when ending a group from a waiting state", () => {
        groupManager.setCallbacks(createCallbacks());
        groupManager.create("g-end-timeout", {
            name: "End Timeout",
            joinCode: "EDTMO",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1"), track("2")],
            createdAt: new Date(),
        });
        groupManager.addMember("g-end-timeout", "guest", "Guest");
        groupManager.addSocket("g-end-timeout", "host", "sock-host");
        groupManager.addSocket("g-end-timeout", "guest", "sock-guest");

        const waiting = groupManager.setTrack("g-end-timeout", "host", 1, true);
        expect(waiting.waiting).toBe(true);
        expect(groupManager.get("g-end-timeout")?.readyTimeout).toBeTruthy();

        groupManager.endGroup("g-end-timeout", "host");
        expect(groupManager.get("g-end-timeout")?.readyTimeout).toBeNull();
    });

    it("returns safe defaults for missing groups and members", () => {
        groupManager.setCallbacks(createCallbacks());
        expect(groupManager.snapshotById("missing-group")).toBeUndefined();
        expect(() =>
            groupManager.removeMember("missing-group", "missing-user")
        ).toThrow(GroupError);
        expect(() => groupManager.forceEnd("missing-group", "noop")).not.toThrow();
    });

    it("enforces member and control checks for playback and queue edits", () => {
        groupManager.setCallbacks(createCallbacks());
        groupManager.create("g-authz", {
            name: "Authz",
            joinCode: "AUTHZ1",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [],
            createdAt: new Date(),
        });

        expect(() => groupManager.play("g-authz", "guest")).toThrow(GroupError);
        expect(() =>
            groupManager.modifyQueue("g-authz", "guest", {
                action: "clear",
            })
        ).toThrow(GroupError);

        groupManager.addMember("g-authz", "guest", "Guest");
        expect(() => groupManager.play("g-authz", "host")).toThrow(GroupError);
    });

    it("handles reportReady outside waiting state and remove-missing-member branch", () => {
        groupManager.setCallbacks(createCallbacks());
        groupManager.create("g-report-ready", {
            name: "Report Ready",
            joinCode: "RPTRDY",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1")],
            createdAt: new Date(),
        });

        expect(groupManager.reportReady("g-report-ready", "host")).toBe(false);
        expect(groupManager.removeMember("g-report-ready", "unknown-user")).toEqual({
            ended: false,
        });
    });
});
