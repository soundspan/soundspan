import {
    canExportFederationEmbeddings,
    decideFederationEmbeddingPage,
    type FederationEmbeddingSpaceIdentity,
} from "../federationEmbeddingSpace";

const tuple: FederationEmbeddingSpaceIdentity = {
    family: "clap-music-audioset",
    checkpointHash: "checkpoint-hash",
    dim: 512,
    preprocessingHash:
        "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
};
const canonicalSpace = {
    id: "space_clap_music_audioset_v1",
    ...tuple,
    preprocessing: {},
};

describe("federation embedding-space decision", () => {
    it("exports legacy-compatible teacher vectors without negotiation", () => {
        expect(canExportFederationEmbeddings(false, canonicalSpace)).toBe(true);
    });

    it("requires negotiation after the active space changes", () => {
        const studentSpace = { id: "space_dclap_student_v1" };
        expect(canExportFederationEmbeddings(false, studentSpace)).toBe(false);
        expect(canExportFederationEmbeddings(true, studentSpace)).toBe(true);
    });

    it("stores a vector page only when every tuple field matches", () => {
        expect(decideFederationEmbeddingPage(tuple, canonicalSpace)).toBe(
            "stored",
        );

        for (const remote of [
            { ...tuple, family: "other-family" },
            { ...tuple, checkpointHash: "other-checkpoint" },
            { ...tuple, dim: 768 },
            { ...tuple, preprocessingHash: "other-preprocessing" },
        ]) {
            expect(decideFederationEmbeddingPage(remote, canonicalSpace)).toBe(
                "skipped_mismatch",
            );
        }
    });

    it("accepts a 2.3 tuple without preprocessingHash when the original fields match", () => {
        const { preprocessingHash: _omitted, ...legacyTuple } = tuple;
        expect(decideFederationEmbeddingPage(legacyTuple, canonicalSpace)).toBe(
            "stored",
        );
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
