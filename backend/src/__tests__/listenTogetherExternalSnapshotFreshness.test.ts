import {
    groupManager,
    type GroupSnapshot,
    type SyncQueueItem,
} from "../services/listenTogetherManager";

function buildTrack(id: string, title: string): SyncQueueItem {
    return {
        id,
        title,
        duration: 180,
        artist: { id: "artist-1", name: "Artist" },
        album: { id: "album-1", title: "Album", coverArt: null },
    };
}

describe("listen together external snapshot freshness", () => {
    const createdGroupIds: string[] = [];

    afterEach(() => {
        for (const groupId of createdGroupIds.splice(0, createdGroupIds.length)) {
            groupManager.remove(groupId);
        }
    });

    it("does not let stale playback snapshots overwrite newer local playback", () => {
        const groupId = `lt-fresh-${Date.now()}-stale`;
        createdGroupIds.push(groupId);

        const hostUserId = "host-user";
        const hostUsername = "Host";

        groupManager.create(groupId, {
            name: "Group",
            joinCode: "ABC123",
            groupType: "host-follower",
            visibility: "public",
            hostUserId,
            hostUsername,
            queue: [buildTrack("track-local", "Local Track")],
            currentIndex: 0,
            currentTimeMs: 15_000,
            isPlaying: true,
            createdAt: new Date(),
        });

        // Advance local playback state version.
        groupManager.pause(groupId, hostUserId);
        const localBefore = groupManager.get(groupId);
        expect(localBefore).toBeDefined();
        const localVersion = localBefore!.playback.stateVersion;

        const staleSnapshot: GroupSnapshot = {
            id: groupId,
            name: "Group",
            joinCode: "ABC123",
            groupType: "host-follower",
            visibility: "public",
            isActive: true,
            hostUserId,
            syncState: "paused",
            playback: {
                queue: [buildTrack("track-stale", "Stale Track")],
                currentIndex: 0,
                isPlaying: false,
                positionMs: 0,
                serverTime: Date.now() - 10_000,
                stateVersion: Math.max(0, localVersion - 1),
                trackId: "track-stale",
            },
            members: [
                {
                    userId: hostUserId,
                    username: hostUsername,
                    isHost: true,
                    joinedAt: new Date().toISOString(),
                    isConnected: true,
                },
                {
                    userId: "new-member",
                    username: "New Member",
                    isHost: false,
                    joinedAt: new Date().toISOString(),
                    isConnected: false,
                },
            ],
        };

        groupManager.applyExternalSnapshot(staleSnapshot);

        const localAfter = groupManager.get(groupId);
        expect(localAfter).toBeDefined();
        expect(localAfter!.playback.stateVersion).toBe(localVersion);
        expect(localAfter!.playback.queue[0]?.id).toBe("track-local");
        // Non-playback state should still update from external snapshot.
        expect(localAfter!.members.has("new-member")).toBe(true);
    });

    it("applies fresher playback snapshots", () => {
        const groupId = `lt-fresh-${Date.now()}-fresh`;
        createdGroupIds.push(groupId);

        const hostUserId = "host-user";
        const hostUsername = "Host";

        groupManager.create(groupId, {
            name: "Group",
            joinCode: "XYZ789",
            groupType: "host-follower",
            visibility: "public",
            hostUserId,
            hostUsername,
            queue: [buildTrack("track-local", "Local Track")],
            currentIndex: 0,
            currentTimeMs: 1_000,
            isPlaying: false,
            createdAt: new Date(),
        });

        const freshSnapshot: GroupSnapshot = {
            id: groupId,
            name: "Group",
            joinCode: "XYZ789",
            groupType: "host-follower",
            visibility: "public",
            isActive: true,
            hostUserId,
            syncState: "playing",
            playback: {
                queue: [buildTrack("track-fresh", "Fresh Track")],
                currentIndex: 0,
                isPlaying: true,
                positionMs: 9_000,
                serverTime: Date.now(),
                stateVersion: 9,
                trackId: "track-fresh",
            },
            members: [
                {
                    userId: hostUserId,
                    username: hostUsername,
                    isHost: true,
                    joinedAt: new Date().toISOString(),
                    isConnected: true,
                },
            ],
        };

        groupManager.applyExternalSnapshot(freshSnapshot);

        const group = groupManager.get(groupId);
        expect(group).toBeDefined();
        expect(group!.playback.stateVersion).toBe(9);
        expect(group!.playback.queue[0]?.id).toBe("track-fresh");
        expect(group!.playback.isPlaying).toBe(true);
        expect(group!.syncState).toBe("playing");
    });
});

