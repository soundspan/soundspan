/** Provider identity used by mapping, persistence, and API contracts. */
export type MappingProvider = "tidal" | "youtube";

/** Provider identity used by playback and streaming contracts. */
export type StreamingProvider = "tidal" | "ytmusic";

/** Canonical internal identity for a remote playback provider. */
export type RemoteProvider = MappingProvider;

function assertNever(value: never): never {
    throw new Error(`Unsupported remote provider: ${String(value)}`);
}

/** Translate a mapping/API provider into its streaming spelling. */
export function toStreamingProvider(
    provider: MappingProvider,
): StreamingProvider {
    switch (provider) {
        case "tidal":
            return "tidal";
        case "youtube":
            return "ytmusic";
        default:
            return assertNever(provider);
    }
}

/** Translate a streaming provider into its mapping/API spelling. */
export function toMappingProvider(
    provider: StreamingProvider,
): MappingProvider {
    switch (provider) {
        case "tidal":
            return "tidal";
        case "ytmusic":
            return "youtube";
        default:
            return assertNever(provider);
    }
}
