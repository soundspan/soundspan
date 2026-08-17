import {
    acceptsFederationEmbeddingSpace,
    encodeFederationEmbeddingSpaceHeader,
    parseFederationEmbeddingSpaceHeader,
} from "../federationEmbeddingSpaceHeader";

describe("federationEmbeddingSpaceHeader codec", () => {
    const tuple = {
        family: "clap-music-audioset",
        checkpointHash: "abc123",
        dim: 512,
    };

    it("round-trips the tuple through the header value", () => {
        const encoded = encodeFederationEmbeddingSpaceHeader(tuple);
        expect(parseFederationEmbeddingSpaceHeader(encoded)).toEqual(tuple);
    });

    it("escapes non-ASCII to keep the header value Latin-1 safe", () => {
        const exotic = { ...tuple, family: "clap-音乐-audioset" };
        const encoded = encodeFederationEmbeddingSpaceHeader(exotic);

        // setHeader rejects characters above 0xFF; the encoded value must be
        // pure ASCII while still parsing back to the original tuple.
        expect(/^[\x20-\x7e]*$/.test(encoded)).toBe(true);
        expect(parseFederationEmbeddingSpaceHeader(encoded)).toEqual(exotic);
    });

    it("accepts only capability value 1", () => {
        expect(acceptsFederationEmbeddingSpace("1")).toBe(true);
        expect(acceptsFederationEmbeddingSpace("0")).toBe(false);
        expect(acceptsFederationEmbeddingSpace(["1"])).toBe(false);
        expect(acceptsFederationEmbeddingSpace(undefined)).toBe(false);
    });
});
