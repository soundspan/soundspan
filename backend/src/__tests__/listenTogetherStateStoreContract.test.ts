describe("listen together publication state-store behavior", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadCallbacks() {
        const listenTogetherStateStore = {
            setSnapshot: jest.fn(async () => undefined),
            deleteSnapshot: jest.fn(async () => undefined),
        };
        const listenTogetherClusterSync = {
            publishSnapshot: jest.fn(async () => undefined),
            publishMembership: jest.fn(async () => undefined),
            publishEnded: jest.fn(async () => undefined),
        };
        const logger = {
            child: jest.fn(() => ({
                warn: jest.fn(),
                error: jest.fn(),
            })),
        };

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

        await callbacks.enqueueGroupSnapshotPublication("group-1", snapshot);

        expect(listenTogetherStateStore.setSnapshot).toHaveBeenCalledWith(
            "group-1",
            snapshot,
        );
        expect(
            listenTogetherStateStore.setSnapshot.mock.invocationCallOrder[0],
        ).toBeLessThan(
            listenTogetherClusterSync.publishSnapshot.mock
                .invocationCallOrder[0],
        );
        expect(emitSnapshot).toHaveBeenCalledWith("group-1", snapshot);
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
});
