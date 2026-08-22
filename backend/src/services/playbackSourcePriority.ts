/** Providers accepted by the persisted playback source-order setting. */
export const PLAYBACK_SOURCE_VALUES = [
    "library",
    "peers",
    "tidal",
    "ytmusic",
] as const;

/** One configurable tier in playback source selection. */
export type PlaybackSource = (typeof PLAYBACK_SOURCE_VALUES)[number];
/** A complete ordered permutation of playback source tiers. */
export type PlaybackSourceOrder = readonly PlaybackSource[];

/** Default playback order: owned library, online peers, TIDAL, then YT Music. */
export const DEFAULT_PLAYBACK_SOURCE_ORDER: PlaybackSourceOrder =
    PLAYBACK_SOURCE_VALUES;
/** Persisted string representation of the default playback order. */
export const DEFAULT_PLAYBACK_SOURCE_ORDER_VALUE =
    PLAYBACK_SOURCE_VALUES.join(",");
// Offline peers remain a last-resort identity at 100, below the lowest
// available provider tier (200), regardless of the configured order.
const UNAVAILABLE_SOURCE_PRIORITY = 100;

/** Parses a stored source order and safely restores the default on drift. */
export function parsePlaybackSourceOrder(value: unknown): PlaybackSourceOrder {
    if (typeof value !== "string") return DEFAULT_PLAYBACK_SOURCE_ORDER;
    const entries = value.split(",").map((entry) => entry.trim());
    if (entries.length !== PLAYBACK_SOURCE_VALUES.length) {
        return DEFAULT_PLAYBACK_SOURCE_ORDER;
    }
    const values = new Set(entries);
    const valid = PLAYBACK_SOURCE_VALUES.every((source) => values.has(source));
    return valid
        ? (entries as PlaybackSource[])
        : DEFAULT_PLAYBACK_SOURCE_ORDER;
}

/** Returns true only for a complete, duplicate-free provider permutation. */
export function isPlaybackSourceOrder(value: string): boolean {
    const parsed = parsePlaybackSourceOrder(value);
    return parsed.join(",") === value;
}

/** Ranks a candidate. Offline/unavailable sources always remain below providers. */
export function rankPlaybackSource(
    candidate: { source: PlaybackSource; available: boolean },
    order: PlaybackSourceOrder,
): number {
    if (!candidate.available) return UNAVAILABLE_SOURCE_PRIORITY;
    const index = order.indexOf(candidate.source);
    const normalizedIndex = index >= 0 ? index : order.length;
    return (order.length - normalizedIndex + 1) * 100;
}
