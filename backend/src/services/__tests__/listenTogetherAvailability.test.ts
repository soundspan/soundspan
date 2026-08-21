import {
    captureAvailabilityIdentity,
    matchesAvailabilityIdentity,
} from "../listenTogetherAvailability";
import type { GroupSnapshot } from "../listenTogetherManager";

function snapshot(
    queueId: string,
    currentIndex: number,
    stateVersion: number,
): GroupSnapshot {
    return {
        id: "group-1",
        name: "Group",
        joinCode: "ABC123",
        groupType: "host-follower",
        visibility: "private",
        isActive: true,
        hostUserId: "host",
        syncState: "waiting",
        playback: {
            queue: [
                {
                    id: queueId,
                    title: queueId,
                    duration: 10,
                    artist: { id: "artist", name: "Artist" },
                    album: { id: "album", title: "Album", coverArt: null },
                },
            ],
            currentIndex,
            isPlaying: false,
            positionMs: 0,
            serverTime: 1,
            stateVersion,
            trackId: queueId,
        },
        members: [],
    };
}

describe("listen together availability identity", () => {
    it("matches an unchanged queue, index, and state version", () => {
        const original = snapshot("track-a", 0, 4);
        const capture = captureAvailabilityIdentity(original);

        expect(
            matchesAvailabilityIdentity(snapshot("track-a", 0, 4), capture),
        ).toBe(true);
    });

    it.each([
        snapshot("track-b", 0, 4),
        snapshot("track-a", 1, 4),
        snapshot("track-a", 0, 5),
    ])("rejects a changed queue boundary", (current) => {
        const capture = captureAvailabilityIdentity(snapshot("track-a", 0, 4));

        expect(matchesAvailabilityIdentity(current, capture)).toBe(false);
    });
});
