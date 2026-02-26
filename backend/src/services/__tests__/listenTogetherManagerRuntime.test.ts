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

    it("treats removing unknown groups as a no-op", () => {
        groupManager.setCallbacks(createCallbacks());
        expect(() => groupManager.remove("g-missing")).not.toThrow();
        expect(groupManager.has("g-missing")).toBe(false);
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
        expect(waiting.snapshot.readyDeadlineMs).toEqual(expect.any(Number));
        expect(groupManager.get("g-ready")?.readyDeadlineMs).toEqual(
            expect.any(Number)
        );
        expect(() => groupManager.setTrack("g-ready", "host", 0, true)).toThrow(
            GroupError
        );

        expect(groupManager.reportReady("g-ready", "host")).toBe(false);
        expect(groupManager.reportReady("g-ready", "guest")).toBe(true);
        expect(callbacks.onPlayAt).toHaveBeenCalledTimes(1);
        expect(groupManager.snapshotById("g-ready")?.readyDeadlineMs).toBeNull();

        // Trigger timeout path on a new waiting gate.
        callbacks.onPlayAt.mockClear();
        groupManager.setTrack("g-ready", "host", 0, true);
        await jest.advanceTimersByTimeAsync(8_000);
        expect(callbacks.onPlayAt).toHaveBeenCalledTimes(1);
    });

    it("treats play/pause/seek as no-ops while waiting and keeps track-change conflicts", () => {
        const callbacks = createCallbacks();
        groupManager.setCallbacks(callbacks);
        groupManager.create("g-ready-block", {
            name: "Ready Block",
            joinCode: "RDBK",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1"), track("2")],
            createdAt: new Date(),
        });
        groupManager.addMember("g-ready-block", "guest", "Guest");
        groupManager.addSocket("g-ready-block", "host", "host-socket");
        groupManager.addSocket("g-ready-block", "guest", "guest-socket");

        const waiting = groupManager.setTrack("g-ready-block", "host", 1, true);
        expect(waiting.waiting).toBe(true);
        expect(waiting.snapshot.syncState).toBe("waiting");

        const stateVersionBefore = waiting.snapshot.playback.stateVersion;
        const playDelta = groupManager.play("g-ready-block", "host");
        const pauseDelta = groupManager.pause("g-ready-block", "host");
        const seekDelta = groupManager.seek("g-ready-block", "host", 2_000);

        expect(playDelta.stateVersion).toBe(stateVersionBefore);
        expect(pauseDelta.stateVersion).toBe(stateVersionBefore);
        expect(seekDelta.stateVersion).toBe(stateVersionBefore);
        expect(callbacks.onPlaybackDelta).not.toHaveBeenCalled();

        expect(() => groupManager.next("g-ready-block", "host")).toThrow(
            "Track change already in progress"
        );
        expect(() =>
            groupManager.setTrack("g-ready-block", "host", 0, true)
        ).toThrow("Track change already in progress");

        expect(groupManager.snapshotById("g-ready-block")?.syncState).toBe(
            "waiting"
        );
        expect(groupManager.snapshotById("g-ready-block")?.playback.positionMs).toBe(
            0
        );
    });

    it("re-arms ready-gate timeout when applying an external waiting snapshot", async () => {
        jest.useFakeTimers();
        const callbacks = createCallbacks();
        groupManager.setCallbacks(callbacks);
        groupManager.create("g-ready-rearm", {
            name: "Ready Rearm",
            joinCode: "RDRM",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1"), track("2")],
            createdAt: new Date(),
        });
        groupManager.addMember("g-ready-rearm", "guest", "Guest");
        groupManager.addSocket("g-ready-rearm", "host", "host-socket");
        groupManager.addSocket("g-ready-rearm", "guest", "guest-socket");

        const waiting = groupManager.setTrack("g-ready-rearm", "host", 1, true);
        expect(waiting.waiting).toBe(true);
        expect(waiting.snapshot.syncState).toBe("waiting");
        expect(waiting.snapshot.readyDeadlineMs).toEqual(expect.any(Number));

        callbacks.onPlayAt.mockClear();
        groupManager.applyExternalSnapshot(waiting.snapshot);

        await jest.advanceTimersByTimeAsync(8_000);

        expect(callbacks.onPlayAt).toHaveBeenCalledTimes(1);
        expect(groupManager.snapshotById("g-ready-rearm")?.syncState).toBe(
            "playing"
        );
        expect(groupManager.snapshotById("g-ready-rearm")?.readyDeadlineMs).toBeNull();
    });

    it("hydrates external snapshots for unknown groups and clears ready-gate state for non-waiting sync", () => {
        groupManager.setCallbacks(createCallbacks());
        const clearReadyGateStateSpy = jest.spyOn(
            groupManager as any,
            "clearReadyGateState",
        );
        groupManager.create("g-external-new", {
            name: "External New",
            joinCode: "EXT",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1"), track("2")],
            currentIndex: 1,
            createdAt: new Date(),
        });
        const baseSnapshot = groupManager.snapshotById("g-external-new");
        expect(baseSnapshot).toBeDefined();
        groupManager.remove("g-external-new");

        groupManager.applyExternalSnapshot({
            ...(baseSnapshot as GroupSnapshot),
            syncState: "playing",
            readyDeadlineMs: Date.now() + 2_000,
        });

        const hydrated = groupManager.snapshotById("g-external-new");
        expect(hydrated).toBeDefined();
        expect(hydrated?.syncState).toBe("playing");
        expect(hydrated?.readyDeadlineMs).toBeNull();
        expect(clearReadyGateStateSpy).toHaveBeenCalled();
        clearReadyGateStateSpy.mockRestore();
    });

    it("force-plays immediately when an external waiting snapshot has an expired deadline", () => {
        const callbacks = createCallbacks();
        groupManager.setCallbacks(callbacks);
        groupManager.create("g-ready-expired", {
            name: "Ready Expired",
            joinCode: "RDEXP",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1"), track("2")],
            createdAt: new Date(),
        });
        groupManager.addMember("g-ready-expired", "guest", "Guest");
        groupManager.addSocket("g-ready-expired", "host", "host-socket");
        groupManager.addSocket("g-ready-expired", "guest", "guest-socket");

        const baseSnapshot = groupManager.snapshotById("g-ready-expired");
        expect(baseSnapshot).toBeDefined();

        callbacks.onPlayAt.mockClear();
        groupManager.applyExternalSnapshot({
            ...baseSnapshot!,
            syncState: "waiting",
            readyDeadlineMs: Date.now() - 1_000,
            playback: {
                ...baseSnapshot!.playback,
                isPlaying: false,
                stateVersion: baseSnapshot!.playback.stateVersion + 1,
                serverTime: baseSnapshot!.playback.serverTime + 1_000,
            },
        });

        expect(callbacks.onPlayAt).toHaveBeenCalledTimes(1);
        expect(groupManager.snapshotById("g-ready-expired")?.syncState).toBe(
            "playing"
        );
        expect(groupManager.snapshotById("g-ready-expired")?.readyDeadlineMs).toBeNull();
    });

    it("keeps ready-gate timers referenced when timer handles expose ref/unref", () => {
        const callbacks = createCallbacks();
        groupManager.setCallbacks(callbacks);
        groupManager.create("g-ref-timer", {
            name: "Ref Timer",
            joinCode: "RFT",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1"), track("2")],
            createdAt: new Date(),
        });
        groupManager.addMember("g-ref-timer", "guest", "Guest");
        groupManager.addSocket("g-ref-timer", "host", "host-socket");
        groupManager.addSocket("g-ref-timer", "guest", "guest-socket");

        const refSpy = jest.fn();
        const unrefSpy = jest.fn();
        const setTimeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((
                _handler: (...args: any[]) => void,
            ) =>
                ({
                    ref: refSpy,
                    unref: unrefSpy,
                }) as unknown as NodeJS.Timeout) as typeof setTimeout);
        const clearTimeoutSpy = jest
            .spyOn(global, "clearTimeout")
            .mockImplementation((() => undefined) as typeof clearTimeout);

        const waiting = groupManager.setTrack("g-ref-timer", "host", 1, true);

        expect(waiting.waiting).toBe(true);
        expect(refSpy).toHaveBeenCalledTimes(1);
        expect(unrefSpy).not.toHaveBeenCalled();

        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
    });

    it("handles timer handles without ref/unref and does not force-play non-waiting groups", () => {
        const callbacks = createCallbacks();
        groupManager.setCallbacks(callbacks);
        groupManager.create("g-no-unref", {
            name: "No Unref",
            joinCode: "NUR",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1")],
            createdAt: new Date(),
        });

        const group = groupManager.get("g-no-unref");
        expect(group).toBeDefined();
        if (!group) {
            return;
        }

        let scheduledCallback: (() => void) | null = null;
        const setTimeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((
                handler: (...args: any[]) => void,
            ) => {
                scheduledCallback = () => handler();
                return 1 as unknown as NodeJS.Timeout;
            }) as typeof setTimeout);
        const clearTimeoutSpy = jest
            .spyOn(global, "clearTimeout")
            .mockImplementation((() => undefined) as typeof clearTimeout);

        group.syncState = "playing";
        (groupManager as any).armReadyGateTimer(group, Date.now());
        expect(typeof scheduledCallback).toBe("function");
        if (scheduledCallback) {
            (scheduledCallback as () => void)();
        }

        expect(callbacks.onPlayAt).not.toHaveBeenCalled();

        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
    });

    it("defaults waiting snapshots without a deadline to a new ready-gate timeout window", () => {
        const callbacks = createCallbacks();
        groupManager.setCallbacks(callbacks);
        groupManager.create("g-ready-default-deadline", {
            name: "Ready Default Deadline",
            joinCode: "RDD",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1"), track("2")],
            createdAt: new Date(),
        });
        groupManager.addMember("g-ready-default-deadline", "guest", "Guest");
        groupManager.addSocket("g-ready-default-deadline", "host", "host-socket");
        groupManager.addSocket("g-ready-default-deadline", "guest", "guest-socket");

        const before = groupManager.snapshotById("g-ready-default-deadline");
        expect(before).toBeDefined();

        const now = Date.now();
        groupManager.applyExternalSnapshot({
            ...before!,
            syncState: "waiting",
            readyDeadlineMs: null,
            playback: {
                ...before!.playback,
                stateVersion: before!.playback.stateVersion + 1,
                serverTime: before!.playback.serverTime + 1_000,
                isPlaying: false,
            },
        });

        const after = groupManager.snapshotById("g-ready-default-deadline");
        expect(after?.syncState).toBe("waiting");
        expect(after?.readyDeadlineMs).toEqual(expect.any(Number));
        expect((after?.readyDeadlineMs ?? 0) - now).toBeGreaterThanOrEqual(7_900);
        expect((after?.readyDeadlineMs ?? 0) - now).toBeLessThanOrEqual(8_100);
    });

    it("preserves existing waiting deadline when stale external playback snapshots are ignored", () => {
        const callbacks = createCallbacks();
        groupManager.setCallbacks(callbacks);
        groupManager.create("g-ready-preserve-deadline", {
            name: "Ready Preserve Deadline",
            joinCode: "RPD",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1"), track("2")],
            createdAt: new Date(),
        });
        groupManager.addMember("g-ready-preserve-deadline", "guest", "Guest");
        groupManager.addSocket("g-ready-preserve-deadline", "host", "host-socket");
        groupManager.addSocket("g-ready-preserve-deadline", "guest", "guest-socket");

        const waiting = groupManager.setTrack(
            "g-ready-preserve-deadline",
            "host",
            1,
            true
        );
        const existingDeadline = waiting.snapshot.readyDeadlineMs;
        expect(existingDeadline).toEqual(expect.any(Number));

        groupManager.applyExternalSnapshot({
            ...waiting.snapshot,
            syncState: "playing",
            playback: {
                ...waiting.snapshot.playback,
                stateVersion: waiting.snapshot.playback.stateVersion,
                serverTime: waiting.snapshot.playback.serverTime - 1_000,
            },
        });

        const after = groupManager.snapshotById("g-ready-preserve-deadline");
        expect(after?.syncState).toBe("waiting");
        expect(after?.readyDeadlineMs).toBe(existingDeadline);
    });

    it("recomputes waiting deadline when stale external snapshots keep waiting state but local deadline is missing", () => {
        const callbacks = createCallbacks();
        groupManager.setCallbacks(callbacks);
        groupManager.create("g-ready-recompute-deadline", {
            name: "Ready Recompute Deadline",
            joinCode: "RRD",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("1"), track("2")],
            createdAt: new Date(),
        });
        groupManager.addMember("g-ready-recompute-deadline", "guest", "Guest");
        groupManager.addSocket("g-ready-recompute-deadline", "host", "host-socket");
        groupManager.addSocket("g-ready-recompute-deadline", "guest", "guest-socket");

        const waiting = groupManager.setTrack(
            "g-ready-recompute-deadline",
            "host",
            1,
            true
        );
        const localGroup = groupManager.get("g-ready-recompute-deadline");
        expect(localGroup).toBeDefined();
        localGroup!.readyDeadlineMs = null;

        const now = Date.now();
        groupManager.applyExternalSnapshot({
            ...waiting.snapshot,
            syncState: "playing",
            playback: {
                ...waiting.snapshot.playback,
                stateVersion: waiting.snapshot.playback.stateVersion,
                serverTime: waiting.snapshot.playback.serverTime - 1_000,
            },
        });

        const after = groupManager.snapshotById("g-ready-recompute-deadline");
        expect(after?.syncState).toBe("waiting");
        expect(after?.readyDeadlineMs).toEqual(expect.any(Number));
        expect((after?.readyDeadlineMs ?? 0) - now).toBeGreaterThanOrEqual(7_900);
        expect((after?.readyDeadlineMs ?? 0) - now).toBeLessThanOrEqual(8_100);
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

    it("inserts tracks after the current track via insert-next action", () => {
        const callbacks = createCallbacks();
        groupManager.setCallbacks(callbacks);
        groupManager.create("g-insert", {
            name: "Insert",
            joinCode: "INS",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track("A"), track("B"), track("C")],
            createdAt: new Date(),
        });

        // currentIndex defaults to 0 (track A), so insert-next should place after A
        const delta = groupManager.modifyQueue("g-insert", "host", {
            action: "insert-next",
            items: [track("X")],
        });
        expect(delta.queue.map((t) => t.id)).toEqual(["A", "X", "B", "C"]);

        // Advance to track X (index 1), then insert-next should place after X
        groupManager.modifyQueue("g-insert", "host", {
            action: "insert-next",
            items: [track("Y")],
        });
        // currentIndex is still 0, so Y goes after index 0 (after A), before X
        expect(
            groupManager.get("g-insert")?.playback.queue.map((t) => t.id)
        ).toEqual(["A", "Y", "X", "B", "C"]);
    });

    it("initializes queue when insert-next is used on an empty queue", () => {
        groupManager.create("g-insert-empty", {
            name: "InsertEmpty",
            joinCode: "INE",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [],
            createdAt: new Date(),
        });

        const delta = groupManager.modifyQueue("g-insert-empty", "host", {
            action: "insert-next",
            items: [track("1")],
        });
        expect(delta.queue.length).toBe(1);
        expect(delta.currentIndex).toBe(0);
        expect(groupManager.get("g-insert-empty")?.syncState).toBe("paused");
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
