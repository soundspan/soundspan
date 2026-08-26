import {
    ALBUM_FOLDER_COHERENCE_FLOOR,
    ALBUM_FOLDER_COMPLETENESS_FLOOR,
    bitrateConsistency,
    compilationPenaltyAvoidance,
    folderNameSimilarity,
    formatConsistency,
    groupFolderCandidates,
    isAlbumShapedBatch,
    scoreFolderCandidate,
    selectAlbumFolder,
    type AlbumCandidateFile,
} from "../albumCoherence";

const MB = 1024 * 1024;

function file(overrides: Partial<AlbumCandidateFile> = {}): AlbumCandidateFile {
    return {
        username: "peer-a",
        fullPath: "Music/Artist/Album (2001)/01 - Opening.flac",
        filename: "01 - Opening.flac",
        size: 25 * MB,
        bitRate: 1_000,
        slots: true,
        speed: 1_500_000,
        ...overrides,
    };
}

describe("Soulseek album coherence", () => {
    it("groups audio results by username and normalized parent folder", () => {
        const groups = groupFolderCandidates([
            file(),
            file({
                fullPath: "Music\\Artist\\Album (2001)\\02 - Middle.flac",
                filename: "02 - Middle.flac",
            }),
            file({
                username: "peer-b",
                fullPath: "Music/Artist/Album (2001)/01 - Opening.flac",
            }),
            file({ fullPath: "orphan.flac" }),
        ]);

        expect(groups).toHaveLength(2);
        expect(groups[0]).toMatchObject({
            username: "peer-a",
            folderPath: "Music/Artist/Album (2001)",
            folderName: "Album (2001)",
        });
        expect(groups[0].files).toHaveLength(2);
        expect(groups[1].username).toBe("peer-b");
    });

    it("returns no groups or selection for empty results", () => {
        expect(groupFolderCandidates([])).toEqual([]);
        expect(
            selectAlbumFolder([], {
                artist: "Artist",
                album: "Album",
                requestedSearchCount: 10,
            }),
        ).toEqual({ candidateCount: 0, best: null, selected: null });
    });

    it("scores complete, matching, consistent folders above both floors", () => {
        const files = Array.from({ length: 10 }, (_, index) =>
            file({
                fullPath: `Music/Artist/Artist - Album (2001)/${String(index + 1).padStart(2, "0")} - Track.flac`,
                filename: `${String(index + 1).padStart(2, "0")} - Track.flac`,
                bitRate: 1_000 + index,
            }),
        );
        const [candidate] = groupFolderCandidates(files);
        const score = scoreFolderCandidate(candidate, {
            artist: "Artist",
            album: "Album",
            year: 2001,
            requestedSearchCount: 10,
        });

        expect(score.components.completeness).toBe(1);
        expect(score.components.folderName).toBe(1);
        expect(score.components.format).toBe(1);
        expect(score.components.bitrate).toBeGreaterThan(0.99);
        expect(score.components.penaltyAvoidance).toBe(1);
        expect(score.peerSignalScore).toBe(0.55);
        expect(score.components.completeness).toBeGreaterThanOrEqual(
            ALBUM_FOLDER_COMPLETENESS_FLOOR,
        );
        expect(score.coherenceScore).toBeGreaterThanOrEqual(
            ALBUM_FOLDER_COHERENCE_FLOOR,
        );
    });

    it("scores partial and mixed-format folders below a coherent folder", () => {
        const partial = [
            file(),
            file({
                fullPath: "Music/Artist/Album (2001)/02 - Track.mp3",
                filename: "02 - Track.mp3",
                bitRate: 128,
            }),
        ];

        expect(formatConsistency(partial)).toBe(0.5);
        expect(bitrateConsistency(partial)).toBeLessThan(0.7);
        const selection = selectAlbumFolder(partial, {
            artist: "Artist",
            album: "Album",
            year: 2001,
            requestedSearchCount: 4,
        });
        expect(selection.selected).toBeNull();
    });

    it("selects a perfect folder without an available peer slot", () => {
        const files = Array.from({ length: 10 }, (_, index) =>
            file({
                fullPath: `Music/Artist/Artist - Album (2001)/${index + 1}.flac`,
                filename: `${index + 1}.flac`,
                slots: false,
                speed: 10,
            }),
        );

        expect(
            selectAlbumFolder(files, {
                artist: "Artist",
                album: "Album",
                year: 2001,
                requestedSearchCount: 10,
            }).selected,
        ).toMatchObject({ username: "peer-a", peerSignalScore: 0 });
    });

    it("rejects a fast slotted folder with only seven of ten searches", () => {
        const files = Array.from({ length: 7 }, (_, index) =>
            file({
                fullPath: `Music/Artist/Artist - Album (2001)/${index + 1}.flac`,
                filename: `${index + 1}.flac`,
            }),
        );

        const decision = selectAlbumFolder(files, {
            artist: "Artist",
            album: "Album",
            year: 2001,
            requestedSearchCount: 10,
        });

        expect(decision.best?.components.completeness).toBe(0.7);
        expect(decision.best?.compositeScore).toBeGreaterThan(1.4);
        expect(decision.selected).toBeNull();
    });

    it("counts one search with several folder files as one covered search", () => {
        const files = Array.from({ length: 3 }, (_, index) =>
            file({
                fullPath: `Music/Artist/Artist - Album (2001)/${index + 1}.flac`,
                filename: `${index + 1}.flac`,
                searchIndex: 0,
            }),
        );

        const decision = selectAlbumFolder(files, {
            artist: "Artist",
            album: "Album",
            year: 2001,
            requestedSearchCount: 3,
        });

        expect(decision.best?.components.completeness).toBeCloseTo(1 / 3);
        expect(decision.selected).toBeNull();
    });

    it("ranks two eligible folders by composite score", () => {
        const files = ["slow-peer", "fast-peer"].flatMap((username) =>
            Array.from({ length: 9 }, (_, index) =>
                file({
                    username,
                    fullPath: `Music/Artist/Artist - Album (2001)/${index + 1}.flac`,
                    filename: `${index + 1}.flac`,
                    slots: username === "fast-peer",
                    speed: username === "fast-peer" ? 1_500_000 : 10,
                }),
            ),
        );

        const decision = selectAlbumFolder(files, {
            artist: "Artist",
            album: "Album",
            year: 2001,
            requestedSearchCount: 10,
        });

        expect(decision.selected).toMatchObject({ username: "fast-peer" });
        expect(decision.selected?.components.completeness).toBe(0.9);
    });

    it("discounts bitrate consistency by known-value coverage", () => {
        const missing = Array.from({ length: 10 }, (_, index) =>
            file({ fullPath: `Music/Album/${index}.flac`, bitRate: undefined }),
        );
        const sparse = missing.map((item, index) =>
            index === 0 ? { ...item, bitRate: 1_000 } : item,
        );

        expect(bitrateConsistency(missing)).toBe(0);
        expect(bitrateConsistency(sparse)).toBeCloseTo(0.1);
    });

    it.each([
        ["VBR spread", [160, 192, 224, 256, 320]],
        ["FLAC dispersion", [700, 850, 1_000, 1_200, 1_400]],
    ])("retains useful consistency for %s", (_label, bitrates) => {
        const files = bitrates.map((bitRate, index) =>
            file({ fullPath: `Music/Album/${index}.flac`, bitRate }),
        );

        expect(bitrateConsistency(files)).toBeGreaterThan(0.85);
    });

    it("penalizes compilation-looking folder names", () => {
        expect(compilationPenaltyAvoidance("Various Artists - Hits")).toBe(0);
        expect(compilationPenaltyAvoidance("VA - Summer Sampler")).toBe(0);
        expect(compilationPenaltyAvoidance("Artist - Unknown Pleasures")).toBe(
            1,
        );
    });

    it("normalizes folder names for deterministic target similarity", () => {
        expect(
            folderNameSimilarity(
                "Beyoncé - Renaissance (2022)",
                "Beyonce",
                "Renaissance",
                2022,
            ),
        ).toBe(1);
        expect(
            folderNameSimilarity(
                "Unrelated Collection",
                "Beyonce",
                "Renaissance",
                2022,
            ),
        ).toBe(0);
    });

    it.each(["Artist-Album", "Artist–Album", "Artist.Album"])(
        "tokenizes punctuation in compact folder name %s",
        (folderName) => {
            expect(folderNameSimilarity(folderName, "Artist", "Album")).toBe(1);
        },
    );

    it("never selects a folder for one-track albums", () => {
        const candidates = groupFolderCandidates([file()]);
        expect(
            selectAlbumFolder(candidates, {
                artist: "Artist",
                album: "Album",
                year: 2001,
                requestedSearchCount: 1,
            }),
        ).toEqual({
            candidateCount: 1,
            best: expect.objectContaining({ username: "peer-a" }),
            selected: null,
        });
        expect(
            isAlbumShapedBatch([
                { artist: "Artist", album: "Album" },
                { artist: "Artist", album: "Album" },
            ]),
        ).toBe(true);
        expect(isAlbumShapedBatch([{ artist: "Artist", album: "Album" }])).toBe(
            false,
        );
    });
});
test("punctuated artists tokenize identically on both sides", () => {
    const exact = folderNameSimilarity(
        "AC/DC - Back in Black",
        "AC/DC",
        "Back in Black",
    );
    const lessSpecific = folderNameSimilarity(
        "Back in Black",
        "AC/DC",
        "Back in Black",
    );
    expect(exact).toBeGreaterThan(lessSpecific);
    expect(exact).toBe(1);
});
