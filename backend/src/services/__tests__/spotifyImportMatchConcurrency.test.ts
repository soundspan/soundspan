// Behavior test for F13 (Spotify import half): the matchTrack loop in
// buildPreviewFromTracklist is now bounded-concurrency (PQueue) instead of a
// plain serial `for` loop. The one hard invariant that must survive
// concurrency is ORDER: matchedTracks must stay in exact input order, and the
// unmatchedByAlbum grouping (which drives albumsToDownload order downstream)
// must match what the serial loop would have produced.
//
// p-queue ships ESM-only, so (like spotifyImportRuntime.test.ts) this suite
// mocks "p-queue" with an immediate-invoke stub -- Jest's default CJS
// transform cannot load the real module. That stub still calls every queued
// task essentially back-to-back (add() invokes fn() synchronously, so all
// six matchTrack() calls are in flight before any of their mocked DB reads
// resolve), so it does NOT collapse the concurrency being tested here: the
// per-track DB delays below (assigned in REVERSE of input order, via real
// setTimeout) still produce genuine out-of-order resolution among the six
// in-flight matchTrack() calls. A naive "collect results as they complete"
// implementation would scramble the output; a correct
// Promise.all(tracks.map(...)) implementation is immune to this -- array
// position is preserved regardless of resolution order. Mocking otherwise
// stays at the DB boundary (prisma.track.findFirst/findMany) -- matchTrack
// and buildPreviewFromTracklist run for real.

describe("spotify import matchTrack concurrency", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    function setupMocks() {
        const musicBrainzService = {
            clearStaleRecordingCaches: jest.fn(async () => undefined),
            searchArtist: jest.fn(async () => []),
            getReleaseGroups: jest.fn(async () => []),
            searchRecording: jest.fn(async () => null),
        };
        const prisma = {
            $connect: jest.fn(async () => undefined),
            spotifyImportJob: {
                findMany: jest.fn(async () => []),
                findUnique: jest.fn(async () => null),
                upsert: jest.fn(async () => undefined),
            },
            playlistPendingTrack: {
                count: jest.fn(async () => 0),
                findMany: jest.fn(async () => []),
                createMany: jest.fn(async () => ({ count: 0 })),
                deleteMany: jest.fn(async () => ({ count: 0 })),
            },
            playlistItem: {
                findMany: jest.fn(async () => []),
                create: jest.fn(async () => undefined),
                aggregate: jest.fn(async () => ({ _max: { sort: null } })),
            },
            track: {
                findFirst: jest.fn(async () => null),
                // Strategy 3/4a/4b (artist+title / fuzzy) always resolve empty in
                // this fixture -- every track is decided by Strategy 1 alone.
                findMany: jest.fn(async () => []),
                findUnique: jest.fn(async () => null),
            },
            album: {
                findMany: jest.fn(async () => []),
            },
            artist: {
                findFirst: jest.fn(async () => null),
            },
            downloadJob: {
                findMany: jest.fn(async () => []),
                updateMany: jest.fn(async () => ({ count: 0 })),
            },
            playlist: {
                create: jest.fn(async () => ({ id: "playlist-new" })),
                findUnique: jest.fn(async () => null),
            },
        };

        jest.doMock("../../utils/db", () => ({ prisma }));
        jest.doMock("../../utils/redis", () => ({
            redisClient: {
                get: jest.fn(async () => null),
                setEx: jest.fn(async () => "OK"),
                duplicate: jest.fn(() => ({
                    get: jest.fn(async () => null),
                    setEx: jest.fn(async () => "OK"),
                    connect: jest.fn(async () => undefined),
                })),
            },
        }));
        jest.doMock("../../utils/logger", () => ({
            logger: {
                debug: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            },
        }));
        jest.doMock("../spotify", () => ({
            spotifyService: { getPlaylist: jest.fn(async () => null) },
        }));
        jest.doMock("../musicbrainz", () => ({ musicBrainzService }));
        jest.doMock("../deezer", () => ({
            deezerService: { getTrackPreview: jest.fn(async () => null) },
        }));
        jest.doMock("../../utils/playlistLogger", () => ({
            createPlaylistLogger: jest.fn(() => ({
                debug: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
                log: jest.fn(),
                logJobStart: jest.fn(),
                logJobFailed: jest.fn(),
                logAlbumDownloadStart: jest.fn(),
                logAlbumFailed: jest.fn(),
                logDownloadProgress: jest.fn(),
                logPlaylistCreationStart: jest.fn(),
                logTrackMatchingStart: jest.fn(),
                logTrackMatch: jest.fn(),
                logPlaylistCreated: jest.fn(),
                logJobComplete: jest.fn(),
            })),
            logPlaylistEvent: jest.fn(),
        }));
        jest.doMock("../notificationService", () => ({
            notificationService: {
                create: jest.fn(async () => undefined),
                notifyImportComplete: jest.fn(async () => undefined),
            },
        }));
        jest.doMock("../../utils/systemSettings", () => ({
            getSystemSettings: jest.fn(async () => ({})),
        }));
        // p-queue is ESM-only; Jest's default CJS transform can't load it, so
        // (like spotifyImportRuntime.test.ts) it's stubbed with an
        // immediate-invoke fake. See the file-header comment for why this
        // still exercises genuine out-of-order completion.
        jest.doMock("p-queue", () => {
            return jest.fn().mockImplementation(() => ({
                add: jest.fn(async (fn: () => Promise<unknown>) => fn()),
                onIdle: jest.fn(async () => undefined),
            }));
        });
        jest.doMock("../acquisitionService", () => ({
            acquisitionService: {
                acquireAlbum: jest.fn(async () => ({ success: true, source: "soulseek" })),
                acquireTracks: jest.fn(async () => []),
            },
        }));
        jest.doMock("../../workers/queues", () => ({
            scanQueue: { add: jest.fn(async () => ({ id: "scan-1" })) },
        }));
        jest.doMock("@prisma/client", () => ({
            Prisma: {
                PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
                    code = "P1001";
                },
                PrismaClientRustPanicError: class PrismaClientRustPanicError extends Error {},
                PrismaClientUnknownRequestError: class PrismaClientUnknownRequestError extends Error {},
            },
        }));

        return { prisma, musicBrainzService };
    }

    function makeTrack(overrides: Partial<Record<string, unknown>>) {
        return {
            spotifyId: "sp-default",
            title: "Default Title",
            artist: "Default Artist",
            artistId: "artist-default",
            album: "Default Album",
            albumId: "album-default",
            isrc: null,
            durationMs: 200000,
            trackNumber: 1,
            previewUrl: null,
            coverUrl: null,
            ...overrides,
        };
    }

    function delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    it("keeps matchedTracks in input order and unmatchedByAlbum grouping order stable when per-track DB reads resolve out of order under concurrency", async () => {
        const { prisma, musicBrainzService } = setupMocks();

        // 6 tracks, interleaving matched/unmatched, with two unmatched tracks
        // (T2, T4) sharing an album key to also pin grouping/accumulation order.
        const tracks = [
            makeTrack({ spotifyId: "sp-1", title: "Song One", artist: "Artist Solo One", album: "Album One" }), // matched
            makeTrack({ spotifyId: "sp-2", title: "Song Two", artist: "Artist Group", album: "Shared Album" }), // unmatched, key A
            makeTrack({ spotifyId: "sp-3", title: "Song Three", artist: "Artist Solo Three", album: "Album Three" }), // matched
            makeTrack({ spotifyId: "sp-4", title: "Song Four", artist: "Artist Group", album: "Shared Album" }), // unmatched, key A (2nd track)
            makeTrack({ spotifyId: "sp-5", title: "Song Five", artist: "Artist Other", album: "Other Album" }), // unmatched, key B
            makeTrack({ spotifyId: "sp-6", title: "Song Six", artist: "Artist Solo Six", album: "Album Six" }), // matched
        ];

        const localTrackByTitle: Record<string, unknown> = {
            "Song One": {
                id: "local-1",
                title: "Song One",
                albumId: "album-local-1",
                album: { title: "Album One", artist: { name: "Artist Solo One" } },
            },
            "Song Three": {
                id: "local-3",
                title: "Song Three",
                albumId: "album-local-3",
                album: { title: "Album Three", artist: { name: "Artist Solo Three" } },
            },
            "Song Six": {
                id: "local-6",
                title: "Song Six",
                albumId: "album-local-6",
                album: { title: "Album Six", artist: { name: "Artist Solo Six" } },
            },
        };

        // Artificial delays assigned in REVERSE of input order: track 1 (first
        // in input) resolves slowest, track 6 (last in input) resolves
        // instantly. Under real concurrency this produces genuine out-of-order
        // completion.
        const delayMsByTitle: Record<string, number> = {
            "Song One": 45,
            "Song Two": 36,
            "Song Three": 27,
            "Song Four": 18,
            "Song Five": 9,
            "Song Six": 0,
        };

        (prisma.track.findFirst as jest.Mock).mockImplementation(
            async (query: any) => {
                const title = query?.where?.title?.equals;
                await delay(delayMsByTitle[title] ?? 0);
                return localTrackByTitle[title] ?? null;
            }
        );
        (musicBrainzService.searchArtist as jest.Mock).mockResolvedValue([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");

        const preview = await (spotifyImportService as any).buildPreviewFromTracklist(
            tracks,
            {
                id: "playlist-concurrency",
                name: "Concurrency Fixture",
                description: null,
                owner: "owner-1",
                imageUrl: null,
                trackCount: tracks.length,
            },
            "Spotify"
        );

        // matchedTracks must be in exact input order, regardless of the
        // reversed DB-resolution order above.
        expect(preview.matchedTracks.map((m: any) => m.spotifyTrack.spotifyId)).toEqual([
            "sp-1",
            "sp-2",
            "sp-3",
            "sp-4",
            "sp-5",
            "sp-6",
        ]);
        expect(preview.matchedTracks.map((m: any) => m.matchType)).toEqual([
            "exact",
            "none",
            "exact",
            "none",
            "none",
            "exact",
        ]);
        expect(preview.summary.inLibrary).toBe(3);

        // unmatchedByAlbum grouping (surfaced via albumsToDownload) must reflect
        // the same Map insertion order the serial loop would have produced:
        // key A ("Artist Group"/"Shared Album") first-seen at sp-2 (input
        // position 2), key B ("Artist Other"/"Other Album") first-seen at sp-5
        // (input position 5) -- so key A precedes key B, and key A's grouped
        // tracks stay in [sp-2, sp-4] order even though sp-4 resolved its DB
        // read before sp-2 did.
        expect(
            preview.albumsToDownload.map((a: any) => `${a.artistName}|||${a.albumName}`)
        ).toEqual(["Artist Group|||Shared Album", "Artist Other|||Other Album"]);

        const sharedAlbumGroup = preview.albumsToDownload.find(
            (a: any) => a.artistName === "Artist Group"
        );
        expect(
            sharedAlbumGroup.tracksNeeded.map((t: any) => t.spotifyId)
        ).toEqual(["sp-2", "sp-4"]);
    });
});
