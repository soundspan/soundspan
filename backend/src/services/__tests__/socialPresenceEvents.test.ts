import type {
    SocialPresenceUpdatedEvent,
    SocialPresenceUpdateReason,
} from "../socialPresenceEvents";

const warn = jest.fn();

type SocialPresenceEventsModule = typeof import("../socialPresenceEvents");

function loadSocialPresenceEvents(): SocialPresenceEventsModule {
    jest.resetModules();
    warn.mockReset();

    jest.doMock("../../utils/logger", () => ({
        logger: {
            warn,
        },
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("../socialPresenceEvents") as SocialPresenceEventsModule;
}

function createEvent(
    overrides: Partial<SocialPresenceUpdatedEvent> = {}
): SocialPresenceUpdatedEvent {
    return {
        userId: "user-1",
        reason: "heartbeat",
        timestampMs: 1_713_456_789_000,
        deviceId: "device-1",
        ...overrides,
    };
}

describe("socialPresenceEvents", () => {
    afterEach(() => {
        jest.clearAllMocks();
        jest.resetModules();
    });

    it("supports all declared social presence update reasons in event payloads", () => {
        const reasons: SocialPresenceUpdateReason[] = [
            "heartbeat",
            "playback-state",
            "playback-state-cleared",
        ];
        const events: SocialPresenceUpdatedEvent[] = reasons.map(
            (reason, index) =>
                createEvent({
                    userId: `user-${index + 1}`,
                    reason,
                    timestampMs: index + 1,
                    deviceId: index === 2 ? undefined : `device-${index + 1}`,
                })
        );

        expect(events.map((event) => event.reason)).toEqual(reasons);
        expect(events[0]).toEqual(
            expect.objectContaining({
                userId: "user-1",
                deviceId: "device-1",
            })
        );
        expect(events[2].deviceId).toBeUndefined();
    });

    it("adds subscribed listeners so published events reach them", () => {
        const { subscribeSocialPresenceUpdates, publishSocialPresenceUpdate } =
            loadSocialPresenceEvents();
        const listener = jest.fn();
        const event = createEvent();

        subscribeSocialPresenceUpdates(listener);
        publishSocialPresenceUpdate(event);

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith(event);
    });

    it("returns an unsubscribe function", () => {
        const { subscribeSocialPresenceUpdates } = loadSocialPresenceEvents();
        const listener = jest.fn();

        const unsubscribe = subscribeSocialPresenceUpdates(listener);

        expect(unsubscribe).toEqual(expect.any(Function));
    });

    it("calls all registered listeners when publishing an event", () => {
        const { subscribeSocialPresenceUpdates, publishSocialPresenceUpdate } =
            loadSocialPresenceEvents();
        const firstListener = jest.fn();
        const secondListener = jest.fn();
        const event = createEvent({ reason: "playback-state" });

        subscribeSocialPresenceUpdates(firstListener);
        subscribeSocialPresenceUpdates(secondListener);
        publishSocialPresenceUpdate(event);

        expect(firstListener).toHaveBeenCalledTimes(1);
        expect(secondListener).toHaveBeenCalledTimes(1);
    });

    it("passes the published event object to each listener", () => {
        const { subscribeSocialPresenceUpdates, publishSocialPresenceUpdate } =
            loadSocialPresenceEvents();
        const firstListener = jest.fn();
        const secondListener = jest.fn();
        const event = createEvent({ reason: "playback-state-cleared" });

        subscribeSocialPresenceUpdates(firstListener);
        subscribeSocialPresenceUpdates(secondListener);
        publishSocialPresenceUpdate(event);

        expect(firstListener).toHaveBeenCalledWith(event);
        expect(secondListener).toHaveBeenCalledWith(event);
    });

    it("catches listener errors, logs them, and continues notifying other listeners", () => {
        const { subscribeSocialPresenceUpdates, publishSocialPresenceUpdate } =
            loadSocialPresenceEvents();
        const error = new Error("listener failed");
        const failingListener = jest.fn(() => {
            throw error;
        });
        const healthyListener = jest.fn();
        const event = createEvent();

        subscribeSocialPresenceUpdates(failingListener);
        subscribeSocialPresenceUpdates(healthyListener);

        expect(() => publishSocialPresenceUpdate(event)).not.toThrow();

        expect(failingListener).toHaveBeenCalledWith(event);
        expect(healthyListener).toHaveBeenCalledWith(event);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
            "[Social] Presence update listener failed:",
            error
        );
    });

    it("delivers events to multiple listeners across publishes", () => {
        const { subscribeSocialPresenceUpdates, publishSocialPresenceUpdate } =
            loadSocialPresenceEvents();
        const listeners = [jest.fn(), jest.fn(), jest.fn()];
        const firstEvent = createEvent();
        const secondEvent = createEvent({
            userId: "user-2",
            reason: "playback-state",
            timestampMs: 2,
        });

        listeners.forEach((listener) => {
            subscribeSocialPresenceUpdates(listener);
        });

        publishSocialPresenceUpdate(firstEvent);
        publishSocialPresenceUpdate(secondEvent);

        listeners.forEach((listener) => {
            expect(listener).toHaveBeenNthCalledWith(1, firstEvent);
            expect(listener).toHaveBeenNthCalledWith(2, secondEvent);
        });
    });

    it("does not notify unsubscribed listeners", () => {
        const { subscribeSocialPresenceUpdates, publishSocialPresenceUpdate } =
            loadSocialPresenceEvents();
        const unsubscribedListener = jest.fn();
        const activeListener = jest.fn();
        const event = createEvent();

        const unsubscribe = subscribeSocialPresenceUpdates(unsubscribedListener);
        subscribeSocialPresenceUpdates(activeListener);

        unsubscribe();
        publishSocialPresenceUpdate(event);

        expect(unsubscribedListener).not.toHaveBeenCalled();
        expect(activeListener).toHaveBeenCalledTimes(1);
        expect(activeListener).toHaveBeenCalledWith(event);
    });

    it("publishes gracefully when there are no listeners", () => {
        const { publishSocialPresenceUpdate } = loadSocialPresenceEvents();

        expect(() => publishSocialPresenceUpdate(createEvent())).not.toThrow();
        expect(warn).not.toHaveBeenCalled();
    });
});
