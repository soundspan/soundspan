describe("listen together publication state-store behavior", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadCallbacks() {
        const listenTogetherStateStore = {
            setSnapshot: jest.fn(async () => "accepted"),
            deleteSnapshot: jest.fn(async () => "accepted"),
            claimFence: jest.fn(async () => "accepted"),
        };
        const listenTogetherClusterSync = {
            publishSnapshot: jest.fn(async () => undefined),
            publishMembership: jest.fn(async () => undefined),
            publishEnded: jest.fn(async () => undefined),
        };
        const logger = {
            child: jest.fn(() => ({
                debug: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            })),
        };

        jest.doMock("../config", () => ({
            config: {
                listenTogether: { publicationDeadlineMs: 25 },
            },
        }));
        jest.doMock("../services/listenTogetherStateStore", () => ({
            listenTogetherStateStore,
        }));
        jest.doMock("../services/listenTogetherClusterSync", () => ({
            listenTogetherClusterSync,
        }));
        jest.doMock("../utils/logger", () => ({ logger }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const callbacks = require("../services/listenTogetherCallbacks");
        return {
            callbacks,
            listenTogetherStateStore,
            listenTogetherClusterSync,
        };
    }

    it("sets the snapshot before publishing and broadcasting it", async () => {
        const {
            callbacks,
            listenTogetherStateStore,
            listenTogetherClusterSync,
        } = loadCallbacks();
        const emitSnapshot = jest.fn();
        const emitPayload = jest.fn();
        callbacks.configureGroupPublicationBroadcaster({
            emitSnapshot,
            emitEnded: jest.fn(),
            emitMemberJoined: jest.fn(),
            emitMemberLeft: jest.fn(),
            emitMemberPresence: jest.fn(),
            revokeSockets: jest.fn(),
        });
        const snapshot = {
            id: "group-1",
            playback: { stateVersion: 4 },
            members: [],
        };

        await callbacks.enqueueGroupSnapshotPublication(
            "group-1",
            snapshot,
            undefined,
            undefined,
            [],
            undefined,
            emitPayload,
        );

        expect(listenTogetherStateStore.setSnapshot).toHaveBeenCalledWith(
            "group-1",
            { ...snapshot, membershipVersion: 0 },
            0,
        );
        expect(
            listenTogetherStateStore.setSnapshot.mock.invocationCallOrder[0],
        ).toBeLessThan(emitPayload.mock.invocationCallOrder[0]);
        expect(emitPayload.mock.invocationCallOrder[0]).toBeLessThan(
            listenTogetherClusterSync.publishSnapshot.mock
                .invocationCallOrder[0],
        );
        expect(emitSnapshot).toHaveBeenCalledWith("group-1", {
            ...snapshot,
            membershipVersion: 0,
        });
    });

    it("halts downstream publication without retry after a stale fence", async () => {
        const {
            callbacks,
            listenTogetherStateStore,
            listenTogetherClusterSync,
        } = loadCallbacks();
        const emitSnapshot = jest.fn();
        const emitPayload = jest.fn();
        listenTogetherStateStore.setSnapshot.mockResolvedValueOnce("stale");
        callbacks.configureGroupPublicationBroadcaster({
            emitSnapshot,
            emitEnded: jest.fn(),
            emitMemberJoined: jest.fn(),
            emitMemberLeft: jest.fn(),
            emitMemberPresence: jest.fn(),
            revokeSockets: jest.fn(),
        });

        await expect(
            callbacks.enqueueGroupSnapshotPublication(
                "group-1",
                { id: "group-1", playback: {}, members: [] },
                undefined,
                undefined,
                [],
                { fencingToken: 3, isFenced: () => false },
                emitPayload,
            ),
        ).rejects.toMatchObject({ code: "CONFLICT" });

        expect(listenTogetherStateStore.setSnapshot).toHaveBeenCalledTimes(1);
        expect(
            listenTogetherClusterSync.publishSnapshot,
        ).not.toHaveBeenCalled();
        expect(emitSnapshot).not.toHaveBeenCalled();
        expect(emitPayload).not.toHaveBeenCalled();
    });

    it("retries a transient state-store failure at the failed stage", async () => {
        const {
            callbacks,
            listenTogetherStateStore,
            listenTogetherClusterSync,
        } = loadCallbacks();
        listenTogetherStateStore.setSnapshot
            .mockRejectedValueOnce(new Error("redis unavailable"))
            .mockResolvedValueOnce("accepted");

        await callbacks.enqueueGroupSnapshotPublication("group-1", {
            id: "group-1",
            playback: {},
            members: [],
        });

        expect(listenTogetherStateStore.setSnapshot).toHaveBeenCalledTimes(2);
        expect(listenTogetherClusterSync.publishSnapshot).toHaveBeenCalledTimes(
            1,
        );
    });

    it("classifies failure after an accepted write as non-retryable", async () => {
        const { callbacks, listenTogetherClusterSync } = loadCallbacks();
        listenTogetherClusterSync.publishSnapshot.mockRejectedValue(
            new Error("cluster publication down"),
        );

        await expect(
            callbacks.enqueueGroupSnapshotPublication("group-1", {
                id: "group-1",
                playback: { stateVersion: 7 },
                members: [],
            }),
        ).rejects.toMatchObject({
            code: "CONFLICT",
            retryable: false,
        });
    });

    it("treats an unsettled guarded write as indeterminate", async () => {
        jest.useFakeTimers();
        const {
            callbacks,
            listenTogetherStateStore,
            listenTogetherClusterSync,
        } = loadCallbacks();
        listenTogetherStateStore.setSnapshot.mockImplementation(
            async () => new Promise(() => undefined),
        );

        const publication = callbacks.enqueueGroupSnapshotPublication(
            "group-1",
            { id: "group-1", playback: {}, members: [] },
        );
        const rejection = expect(publication).rejects.toMatchObject({
            code: "CONFLICT",
            retryable: false,
        });
        await jest.advanceTimersByTimeAsync(100);
        await rejection;

        expect(listenTogetherStateStore.setSnapshot).toHaveBeenCalledTimes(2);
        expect(
            listenTogetherClusterSync.publishSnapshot,
        ).not.toHaveBeenCalled();
        jest.useRealTimers();
    });

    it("deletes the snapshot before publishing and broadcasting an end", async () => {
        const {
            callbacks,
            listenTogetherStateStore,
            listenTogetherClusterSync,
        } = loadCallbacks();
        const emitEnded = jest.fn();
        callbacks.configureGroupPublicationBroadcaster({
            emitSnapshot: jest.fn(),
            emitEnded,
            emitMemberJoined: jest.fn(),
            emitMemberLeft: jest.fn(),
            emitMemberPresence: jest.fn(),
            revokeSockets: jest.fn(),
        });

        await callbacks.enqueueGroupEndedPublication(
            "group-1",
            "Host ended the group",
        );

        expect(listenTogetherStateStore.deleteSnapshot).toHaveBeenCalledWith(
            "group-1",
            0,
        );
        expect(
            listenTogetherStateStore.deleteSnapshot.mock.invocationCallOrder[0],
        ).toBeLessThan(
            listenTogetherClusterSync.publishEnded.mock.invocationCallOrder[0],
        );
        expect(emitEnded).toHaveBeenCalledWith(
            "group-1",
            "Host ended the group",
        );
    });

    it("revalidates the fence before every irreversible publication stage", async () => {
        const { callbacks, listenTogetherStateStore } = loadCallbacks();
        const emitMemberLeft = jest.fn();
        callbacks.configureGroupPublicationBroadcaster({
            emitSnapshot: jest.fn(),
            emitEnded: jest.fn(),
            emitMemberJoined: jest.fn(),
            emitMemberLeft,
            emitMemberPresence: jest.fn(),
            revokeSockets: jest.fn(),
        });
        const fence = {
            fencingToken: 7,
            isFenced: jest
                .fn()
                .mockReturnValueOnce(false)
                .mockReturnValue(true),
            assertCurrent: jest.fn(async () => undefined),
        };

        await expect(
            callbacks.enqueueGroupMembershipPublication(
                "group-1",
                {
                    type: "left",
                    member: { userId: "member-1", username: "Member" },
                },
                undefined,
                [],
                fence,
            ),
        ).rejects.toMatchObject({ code: "CONFLICT" });

        expect(listenTogetherStateStore.claimFence).toHaveBeenCalledTimes(1);
        expect(fence.isFenced).toHaveBeenCalledTimes(2);
        expect(emitMemberLeft).not.toHaveBeenCalled();
    });

    it("adds fencing order metadata to membership and revocation fanout", async () => {
        const { callbacks } = loadCallbacks();
        const emitMemberJoined = jest.fn();
        const revokeSockets = jest.fn();
        callbacks.configureGroupPublicationBroadcaster({
            emitSnapshot: jest.fn(),
            emitEnded: jest.fn(),
            emitMemberJoined,
            emitMemberLeft: jest.fn(),
            emitMemberPresence: jest.fn(),
            revokeSockets,
        });

        await callbacks.enqueueGroupMembershipPublication(
            "group-1",
            {
                type: "joined",
                member: { userId: "member-1", username: "Member" },
            },
            undefined,
            ["socket-1"],
            {
                fencingToken: 9,
                isFenced: () => false,
                assertCurrent: async () => undefined,
            },
        );

        const metadata = { membershipVersion: 9 };
        expect(emitMemberJoined).toHaveBeenCalledWith(
            "group-1",
            { userId: "member-1", username: "Member" },
            metadata,
        );
        expect(revokeSockets).toHaveBeenCalledWith(
            "group-1",
            ["socket-1"],
            metadata,
        );
    });
});
