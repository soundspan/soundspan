import {
    toMappingProvider,
    toStreamingProvider,
    type MappingProvider,
    type StreamingProvider,
} from "../types";

const MAPPING_PROVIDERS = [
    "tidal",
    "youtube",
] as const satisfies readonly MappingProvider[];
const STREAMING_PROVIDERS = [
    "tidal",
    "ytmusic",
] as const satisfies readonly StreamingProvider[];

function proveMappingProviderExhaustive(provider: MappingProvider): void {
    switch (provider) {
        case "tidal":
        case "youtube":
            return;
        default: {
            const exhaustive: never = provider;
            return exhaustive;
        }
    }
}

function proveStreamingProviderExhaustive(provider: StreamingProvider): void {
    switch (provider) {
        case "tidal":
        case "ytmusic":
            return;
        default: {
            const exhaustive: never = provider;
            return exhaustive;
        }
    }
}

describe("remote provider translators", () => {
    it.each([
        ["tidal", "tidal"],
        ["youtube", "ytmusic"],
    ] as const)(
        "translates mapping provider %s to %s",
        (mapping, streaming) => {
            proveMappingProviderExhaustive(mapping);
            expect(toStreamingProvider(mapping)).toBe(streaming);
        },
    );

    it.each([
        ["tidal", "tidal"],
        ["ytmusic", "youtube"],
    ] as const)(
        "translates streaming provider %s to %s",
        (streaming, mapping) => {
            proveStreamingProviderExhaustive(streaming);
            expect(toMappingProvider(streaming)).toBe(mapping);
        },
    );

    it("keeps the compile-time provider lists exhaustive", () => {
        expect(MAPPING_PROVIDERS).toHaveLength(2);
        expect(STREAMING_PROVIDERS).toHaveLength(2);
    });
});
