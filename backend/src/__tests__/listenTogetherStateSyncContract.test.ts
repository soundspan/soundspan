import {
    groupManager,
    type ManagerCallbacks,
    type SyncQueueItem,
} from "../services/listenTogetherManager";

const track: SyncQueueItem = {
    id: "track-1",
    title: "Track 1",
    duration: 180,
    artist: { id: "artist-1", name: "Artist 1" },
    album: { id: "album-1", title: "Album 1", coverArt: null },
};

const callbacks: ManagerCallbacks = {
    onGroupState: jest.fn(),
    onPlaybackDelta: jest.fn(),
    onQueueDelta: jest.fn(),
    onWaiting: jest.fn(),
    onPlayAt: jest.fn(),
    onMemberJoined: jest.fn(),
    onMemberPresence: jest.fn(),
    onMemberLeft: jest.fn(),
    onGroupEnded: jest.fn(),
};

describe("listen together state sync contract", () => {
    afterEach(() => {
        for (const groupId of groupManager.allGroupIds()) {
            groupManager.remove(groupId);
        }
        jest.restoreAllMocks();
    });

    it("adopts external membership while preserving only locally connected omissions", () => {
        groupManager.setCallbacks(callbacks);
        groupManager.create("group-sync", {
            name: "Sync Group",
            joinCode: "SYNC01",
            groupType: "host-follower",
            visibility: "private",
            hostUserId: "host",
            hostUsername: "Host",
            queue: [track],
            createdAt: new Date("2026-08-20T12:00:00.000Z"),
        });
        groupManager.addMember("group-sync", "connected", "Connected");
        groupManager.addMember("group-sync", "socketless", "Socketless");
        groupManager.addSocket("group-sync", "connected", "socket-1");

        const incoming = groupManager.snapshotById("group-sync")!;
        incoming.hostUserId = "connected";
        incoming.members = incoming.members.filter(
            (member) => member.userId === "host",
        );
        groupManager.applyExternalSnapshot(incoming);

        const group = groupManager.get("group-sync")!;
        expect(group.members.has("connected")).toBe(true);
        expect(group.members.has("socketless")).toBe(false);
        expect(group.hostUserId).toBe("connected");
        expect(
            Array.from(group.members.values()).filter(
                (member) => member.isHost,
            ),
        ).toHaveLength(1);
    });
});
