import {
    downloadAlbumBatch,
    type AlbumBatchSearch,
    type AlbumFolderDownloadDependencies,
} from "../albumFolderDownload";

function matchedTrack(
    title: string,
    index: number,
    overrides: Record<string, unknown> = {},
): AlbumBatchSearch {
    const folderMatch = {
        username: "album-peer",
        filename: `${String(index).padStart(2, "0")} - ${title}.flac`,
        fullPath: `Music/Artist/Artist - Album (2001)/${String(index).padStart(2, "0")} - ${title}.flac`,
        size: 20_000_000,
        bitRate: 1_000,
        quality: "FLAC",
        score: 180,
        slots: true,
        speed: 1_500_000,
        ...overrides,
    };
    return {
        track: { artist: "Artist", title, album: "Album", year: 2001 },
        result: {
            found: true,
            bestMatch: folderMatch,
            allMatches: [folderMatch],
        },
    };
}

function dependencies(): AlbumFolderDownloadDependencies {
    return {
        downloadWithRetry: jest.fn().mockResolvedValue({
            success: true,
            filePath: "/music/download.flac",
        }),
        formatError: (track, result) =>
            `${track.artist} - ${track.title}: ${result.error || "Unknown error"}`,
        recordDecision: jest.fn(),
    };
}

describe("Soulseek album folder download orchestration", () => {
    it("selects one coherent peer folder for an album-shaped batch", async () => {
        const searches = [
            matchedTrack("Opening", 1),
            matchedTrack("Middle", 2),
            matchedTrack("Finale", 3),
        ];
        const deps = dependencies();

        const result = await downloadAlbumBatch(searches, 2, deps);

        expect(result).toEqual({
            successful: 3,
            failed: 0,
            files: [
                "/music/download.flac",
                "/music/download.flac",
                "/music/download.flac",
            ],
            errors: [],
        });
        expect(deps.recordDecision).toHaveBeenCalledWith(
            expect.objectContaining({
                outcome: "folder_selected",
                username: "album-peer",
                folderName: "Artist - Album (2001)",
                candidateCount: 1,
            }),
        );
        expect(
            (deps.recordDecision as jest.Mock).mock.calls[0][0],
        ).not.toHaveProperty("folderPath");
        expect(deps.downloadWithRetry).toHaveBeenCalledTimes(3);
    });

    it("does not treat several files from one search as album coverage", async () => {
        const first = matchedTrack("Opening", 1);
        first.result.allMatches.push(
            {
                ...first.result.allMatches[0],
                filename: "02 - Unrequested.flac",
                fullPath:
                    "Music/Artist/Artist - Album (2001)/02 - Unrequested.flac",
            },
            {
                ...first.result.allMatches[0],
                filename: "03 - Also Unrequested.flac",
                fullPath:
                    "Music/Artist/Artist - Album (2001)/03 - Also Unrequested.flac",
            },
        );
        const searches = [
            first,
            {
                track: { artist: "Artist", title: "Middle", album: "Album" },
                result: { found: false, bestMatch: null, allMatches: [] },
            },
            {
                track: { artist: "Artist", title: "Finale", album: "Album" },
                result: { found: false, bestMatch: null, allMatches: [] },
            },
        ] satisfies AlbumBatchSearch[];
        const deps = dependencies();

        await downloadAlbumBatch(searches, 2, deps);

        expect(deps.recordDecision).toHaveBeenCalledWith(
            expect.objectContaining({
                outcome: "per_track_fallback",
                coherenceScore: expect.any(Number),
            }),
        );
    });

    it("falls back to the unchanged per-track ordering below threshold", async () => {
        const searches = [
            matchedTrack("Opening", 1, { slots: false, speed: 10 }),
            {
                track: {
                    artist: "Artist",
                    title: "Missing",
                    album: "Album",
                    year: 2001,
                },
                result: { found: false, bestMatch: null, allMatches: [] },
            },
            {
                ...matchedTrack("Other", 3, {
                    username: "other-peer",
                    fullPath: "Music/Other/Loose/03 - Other.mp3",
                    filename: "03 - Other.mp3",
                    slots: false,
                    speed: 10,
                }),
            },
        ] satisfies AlbumBatchSearch[];
        const deps = dependencies();

        const result = await downloadAlbumBatch(searches, 2, deps);

        expect(deps.recordDecision).toHaveBeenCalledWith(
            expect.objectContaining({
                outcome: "per_track_fallback",
                coherenceScore: expect.any(Number),
            }),
        );
        expect(
            (deps.recordDecision as jest.Mock).mock.calls[0][0].coherenceScore,
        ).toBeGreaterThan(0);
        expect(result.failed).toBe(1);
        expect(result.errors).toEqual([
            "Artist - Missing: No match found on Soulseek",
        ]);
    });

    it("retries a failed folder track through the next per-track candidate", async () => {
        const searches = [
            matchedTrack("Opening", 1),
            matchedTrack("Middle", 2),
        ];
        const nextPeer = {
            ...searches[0].result.allMatches[0],
            username: "next-peer",
            fullPath: "Music/Elsewhere/01 - Opening.flac",
        };
        searches[0].result.allMatches.push(nextPeer);
        const deps = dependencies();
        (deps.downloadWithRetry as jest.Mock).mockImplementation(
            async (_track, matches) => {
                if (_track.title === "Opening") {
                    expect(
                        matches.map(
                            (match: { username: string }) => match.username,
                        ),
                    ).toEqual(["album-peer", "next-peer"]);
                }
                return {
                    success: true,
                    filePath: `/music/${_track.title}.flac`,
                };
            },
        );

        await expect(
            downloadAlbumBatch(searches, 1, deps),
        ).resolves.toMatchObject({
            successful: 2,
            failed: 0,
        });
    });

    it("does not enter the folder decision path for one track", async () => {
        const deps = dependencies();

        await downloadAlbumBatch([matchedTrack("Only", 1)], 1, deps);

        expect(deps.recordDecision).not.toHaveBeenCalled();
        expect(deps.downloadWithRetry).toHaveBeenCalledWith(
            expect.objectContaining({ title: "Only" }),
            expect.any(Array),
        );
    });
});
