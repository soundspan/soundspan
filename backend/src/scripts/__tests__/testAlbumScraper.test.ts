describe("testAlbumScraper script", () => {
    const originalArgv = process.argv;

    const flushScriptTasks = async (): Promise<void> => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));
    };

    async function importScriptEntrypoint(): Promise<void> {
        jest.isolateModules(() => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require("../testAlbumScraper");
        });

        await flushScriptTasks();
    }

    function setupAlbumScraperScript({
        playlistId,
        playlist,
        playlistError,
        exitImpl,
    }: {
        playlistId?: string;
        playlist?: Record<string, unknown> | null;
        playlistError?: Error;
        exitImpl?: (code?: number) => never | void;
    } = {}) {
        const getPlaylist = playlistError
            ? jest.fn().mockRejectedValue(playlistError)
            : jest.fn().mockResolvedValue(playlist ?? null);

        jest.doMock("../../services/spotify", () => ({
            spotifyService: {
                getPlaylist,
            },
        }));

        process.argv = [originalArgv[0] ?? "node", originalArgv[1] ?? "script"];
        if (playlistId !== undefined) {
            process.argv[2] = playlistId;
        }

        const logSpy = jest
            .spyOn(console, "log")
            .mockImplementation(() => undefined);
        const errorSpy = jest
            .spyOn(console, "error")
            .mockImplementation(() => undefined);
        const exitSpy = jest
            .spyOn(process, "exit")
            .mockImplementation((exitImpl || (() => undefined)) as never);

        return {
            getPlaylist,
            logSpy,
            errorSpy,
            exitSpy,
        };
    }

    function loggedText(spy: jest.SpyInstance): string {
        return spy.mock.calls.map((call) => String(call[0])).join("\n");
    }

    afterEach(() => {
        process.argv = originalArgv;
        jest.restoreAllMocks();
        jest.resetModules();
        jest.clearAllMocks();
    });

    it("uses default playlist id and reports success when all tracks have known albums", async () => {
        const { getPlaylist, logSpy, exitSpy } = setupAlbumScraperScript({
            playlist: {
                name: "Daily Mix",
                owner: "soundspan-user",
                trackCount: 2,
                tracks: [
                    {
                        title: "Track One",
                        artist: "Artist One",
                        album: "Album One",
                        spotifyId: "sp-track-1",
                        albumId: "sp-album-1",
                    },
                    {
                        title: "Track Two",
                        artist: "Artist Two",
                        album: "Album Two",
                        spotifyId: "sp-track-2",
                        albumId: "sp-album-2",
                    },
                ],
            },
        });

        await importScriptEntrypoint();

        expect(getPlaylist).toHaveBeenCalledWith("37i9dQZF1DXcBWIGoYBM5M");
        expect(loggedText(logSpy)).toContain(
            "SUCCESS: All tracks have album data resolved"
        );
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it("exits when playlist lookup returns no playlist payload", async () => {
        let exitCalls = 0;
        const { getPlaylist, errorSpy, exitSpy } = setupAlbumScraperScript({
            playlistId: "missing-playlist",
            playlist: null,
            exitImpl: (code?: number) => {
                exitCalls += 1;
                if (exitCalls === 1) {
                    throw new Error(`process.exit:${code}`);
                }
                return undefined;
            },
        });

        await importScriptEntrypoint();

        expect(getPlaylist).toHaveBeenCalledWith("missing-playlist");
        expect(errorSpy).toHaveBeenCalledWith("FAILED: Could not fetch playlist");
        expect(exitSpy).toHaveBeenNthCalledWith(1, 1);
        expect(exitSpy).toHaveBeenNthCalledWith(2, 1);
        expect(loggedText(errorSpy)).toContain("Test script error:");
    });

    it("logs service errors and exits with non-zero status", async () => {
        const failure = new Error("spotify unavailable");
        const { getPlaylist, errorSpy, exitSpy } = setupAlbumScraperScript({
            playlistId: "playlist-with-service-error",
            playlistError: failure,
        });

        await importScriptEntrypoint();

        expect(getPlaylist).toHaveBeenCalledWith("playlist-with-service-error");
        expect(errorSpy).toHaveBeenCalledWith("Test script error:", failure);
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("reports partial success when unknown album tracks stay below ten percent", async () => {
        const tracks = [
            {
                title: "Unknown Song",
                artist: "Artist U",
                album: "Unknown Album",
                spotifyId: "sp-unk-1",
                albumId: null,
            },
            ...Array.from({ length: 19 }, (_v, i) => ({
                title: `Known Song ${i + 1}`,
                artist: `Artist ${i + 1}`,
                album: `Album ${i + 1}`,
                spotifyId: `sp-known-${i + 1}`,
                albumId: `alb-${i + 1}`,
            })),
        ];

        const { logSpy, exitSpy } = setupAlbumScraperScript({
            playlistId: "partial-success-playlist",
            playlist: {
                name: "Partial Coverage Mix",
                owner: "soundspan-user",
                trackCount: tracks.length,
                tracks,
            },
        });

        await importScriptEntrypoint();

        const output = loggedText(logSpy);
        expect(output).toContain(
            "PARTIAL SUCCESS: 1 tracks (5.0%) still have unknown albums"
        );
        expect(output).toContain('1. "Unknown Song" by Artist U');
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it("reports warning and prints overflow count when many tracks have unknown albums", async () => {
        const unknownTracks = Array.from({ length: 11 }, (_v, i) => ({
            title: `Unknown Song ${i + 1}`,
            artist: `Unknown Artist ${i + 1}`,
            album: "Unknown Album",
            spotifyId: `sp-unk-${i + 1}`,
            albumId: null,
        }));
        const knownTrack = {
            title: "Known Song",
            artist: "Known Artist",
            album: "Known Album",
            spotifyId: "sp-known-final",
            albumId: "alb-known-final",
        };

        const { logSpy, exitSpy } = setupAlbumScraperScript({
            playlistId: "warning-playlist",
            playlist: {
                name: "Warning Coverage Mix",
                owner: "soundspan-user",
                trackCount: 12,
                tracks: [...unknownTracks, knownTrack],
            },
        });

        await importScriptEntrypoint();

        const output = loggedText(logSpy);
        expect(output).toContain("... and 1 more");
        expect(output).toContain(
            "WARNING: 11 tracks (91.7%) have unknown albums - scraper may need updating"
        );
        expect(output).toContain("--- Sample Tracks with Known Albums (first 5) ---");
        expect(exitSpy).not.toHaveBeenCalled();
    });
});
