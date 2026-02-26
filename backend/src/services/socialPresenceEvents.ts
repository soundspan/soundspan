import { logger } from "../utils/logger";

export type SocialPresenceUpdateReason =
    | "heartbeat"
    | "playback-state"
    | "playback-state-cleared";

export interface SocialPresenceUpdatedEvent {
    userId: string;
    reason: SocialPresenceUpdateReason;
    timestampMs: number;
    deviceId?: string;
}

type SocialPresenceListener = (event: SocialPresenceUpdatedEvent) => void;

const listeners = new Set<SocialPresenceListener>();

export function subscribeSocialPresenceUpdates(
    listener: SocialPresenceListener
): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function publishSocialPresenceUpdate(
    event: SocialPresenceUpdatedEvent
): void {
    listeners.forEach((listener) => {
        try {
            listener(event);
        } catch (error) {
            logger.warn(
                "[Social] Presence update listener failed:",
                error
            );
        }
    });
}

