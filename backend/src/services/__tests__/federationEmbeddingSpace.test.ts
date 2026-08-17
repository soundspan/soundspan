import {
    decideFederationEmbeddingPage,
    type FederationEmbeddingSpaceIdentity,
} from "../federationEmbeddingSpace";

const tuple: FederationEmbeddingSpaceIdentity = {
    family: "clap-music-audioset",
    checkpointHash: "checkpoint-hash",
    dim: 512,
};
const canonicalSpace = {
    id: "space_clap_music_audioset_v1",
    ...tuple,
};

describe("federation embedding-space decision", () => {
    it("stores a vector page only when every tuple field matches", () => {
        expect(decideFederationEmbeddingPage(tuple, canonicalSpace)).toBe(
            "stored",
        );

        for (const remote of [
            { ...tuple, family: "other-family" },
            { ...tuple, checkpointHash: "other-checkpoint" },
            { ...tuple, dim: 768 },
        ]) {
            expect(decideFederationEmbeddingPage(remote, canonicalSpace)).toBe(
                "skipped_mismatch",
            );
        }
    });

    it("treats a malformed parsed tuple as a mismatch", () => {
        expect(decideFederationEmbeddingPage(null, canonicalSpace)).toBe(
            "skipped_mismatch",
        );
    });

    it("accepts legacy omission only for the seeded canonical space id", () => {
        expect(decideFederationEmbeddingPage(undefined, canonicalSpace)).toBe(
            "stored",
        );
        expect(
            decideFederationEmbeddingPage(undefined, {
                ...canonicalSpace,
                id: "space-next",
            }),
        ).toBe("skipped_legacy_strict");
    });
});
