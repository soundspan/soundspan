describe("testPlaylistImport script", () => {
    const originalArgv = process.argv;

    const flushScriptTasks = async (): Promise<void> => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));
    };

    async function importScriptEntrypoint(): Promise<void> {
        jest.isolateModules(() => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require("../testPlaylistImport");
        });

        await flushScriptTasks();
    }

    function setupPlaylistImportScript({
        playlistUrl,
        preview,
        previewError,
        exitImpl,
    }: {
        playlistUrl?: string;
        preview?: Record<string, unknown>;
        previewError?: Error;
        exitImpl?: (code?: number) => never | void;
    } = {}) {
        const generatePreview = previewError
            ? jest.fn().mockRejectedValue(previewError)
            : jest.fn().mockResolvedValue(preview);

        jest.doMock("../../services/spotifyImport", () => ({
            spotifyImportService: {
                generatePreview,
            },
        }));

        process.argv = [originalArgv[0] ?? "node", originalArgv[1] ?? "script"];
        if (playlistUrl !== undefined) {
            process.argv[2] = playlistUrl;
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
            generatePreview,
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

    it("prints usage and exits when no playlist URL is provided", async () => {
        const { generatePreview, logSpy, errorSpy, exitSpy } =
            setupPlaylistImportScript({
                exitImpl: (code?: number) => {
                    throw new Error(`process.exit:${code}`);
                },
            });

        await importScriptEntrypoint();

        expect(generatePreview).not.toHaveBeenCalled();
        expect(loggedText(logSpy)).toContain(
            "Usage: npx ts-node src/scripts/testPlaylistImport.ts <spotify-playlist-url>"
        );
        expect(loggedText(logSpy)).toContain(
            "Example: npx ts-node src/scripts/testPlaylistImport.ts https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"
        );
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(loggedText(errorSpy)).toContain("process.exit:1");
    });

    it("prints import summary and success verdict when preview resolves", async () => {
        const playlistUrl =
            "https://open.spotify.com/playlist/37i9dQZF1DX0XUsuxWHRQd";
        const { generatePreview, logSpy, exitSpy } = setupPlaylistImportScript({
            playlistUrl,
            preview: {
                playlist: {
                    name: "Focus Playlist",
                },
                summary: {
                    total: 3,
                    inLibrary: 1,
                    downloadable: 2,
                    notFound: 0,
                },
                matchedTracks: [
                    {
                        spotifyTrack: {
                            title: "Song One",
                            artist: "Artist One",
                            album: "Known Album One",
                        },
                    },
                    {
                        spotifyTrack: {
                            title: "Song Two",
                            artist: "Artist Two",
                            album: "Known Album Two",
                        },
                    },
                ],
                albumsToDownload: [
                    {
                        artistName: "Artist One",
                        albumName: "Known Album One",
                        trackCount: 2,
                        albumMbid: "1234567890abcdef",
                    },
                ],
            },
        });

        await importScriptEntrypoint();

        expect(generatePreview).toHaveBeenCalledWith(playlistUrl);
        expect(loggedText(logSpy)).toContain("SUCCESS: All albums resolved!");
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it("logs import preview errors and exits with status code 1", async () => {
        const previewFailure = new Error("Preview generation failed");
        const { generatePreview, errorSpy, exitSpy } = setupPlaylistImportScript({
            playlistUrl: "https://open.spotify.com/playlist/failing-list",
            previewError: previewFailure,
        });

        await importScriptEntrypoint();

        expect(generatePreview).toHaveBeenCalledWith(
            "https://open.spotify.com/playlist/failing-list"
        );
        expect(errorSpy).toHaveBeenCalledWith("\nError:", previewFailure.message);
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("prints GOOD verdict when unknown-album rate is below five percent", async () => {
        const playlistUrl = "https://open.spotify.com/playlist/good-verdict";
        const matchedTracks = [
            ...Array.from({ length: 98 }, (_v, i) => ({
                spotifyTrack: {
                    title: `Known ${i + 1}`,
                    artist: `Artist ${i + 1}`,
                    album: `Album ${i + 1}`,
                },
            })),
            {
                spotifyTrack: {
                    title: "Unknown A",
                    artist: "Artist U1",
                    album: "Unknown Album",
                },
            },
            {
                spotifyTrack: {
                    title: "Unknown B",
                    artist: "Artist U2",
                    album: "Unknown Album",
                },
            },
        ];

        const { logSpy, exitSpy } = setupPlaylistImportScript({
            playlistUrl,
            preview: {
                playlist: { name: "Good Verdict Mix" },
                summary: {
                    total: 100,
                    inLibrary: 20,
                    downloadable: 80,
                    notFound: 0,
                },
                matchedTracks,
                albumsToDownload: [
                    {
                        artistName: "Artist 1",
                        albumName: "Album 1",
                        trackCount: 1,
                        albumMbid: "abcdef1234567890",
                    },
                ],
            },
        });

        await importScriptEntrypoint();

        expect(loggedText(logSpy)).toContain(
            "GOOD: Only 2.0% tracks have Unknown Album"
        );
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it("prints FAIR verdict and includes NO MBID album marker", async () => {
        const playlistUrl = "https://open.spotify.com/playlist/fair-verdict";
        const matchedTracks = [
            ...Array.from({ length: 18 }, (_v, i) => ({
                spotifyTrack: {
                    title: `Known ${i + 1}`,
                    artist: `Artist ${i + 1}`,
                    album: `Album ${i + 1}`,
                },
            })),
            {
                spotifyTrack: {
                    title: "Unknown A",
                    artist: "Artist U1",
                    album: "Unknown Album",
                },
            },
            {
                spotifyTrack: {
                    title: "Unknown B",
                    artist: "Artist U2",
                    album: "Unknown Album",
                },
            },
        ];

        const { logSpy, exitSpy } = setupPlaylistImportScript({
            playlistUrl,
            preview: {
                playlist: { name: "Fair Verdict Mix" },
                summary: {
                    total: 20,
                    inLibrary: 5,
                    downloadable: 15,
                    notFound: 0,
                },
                matchedTracks,
                albumsToDownload: [
                    {
                        artistName: "Artist 1",
                        albumName: "Album 1",
                        trackCount: 2,
                        albumMbid: null,
                    },
                ],
            },
        });

        await importScriptEntrypoint();

        const output = loggedText(logSpy);
        expect(output).toContain("FAIR: 10.0% tracks have Unknown Album");
        expect(output).toContain("NO MBID");
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it("prints NEEDS WORK verdict with overflow summaries for unknown tracks and albums", async () => {
        const playlistUrl = "https://open.spotify.com/playlist/needs-work";
        const unknownTracks = Array.from({ length: 12 }, (_v, i) => ({
            spotifyTrack: {
                title: `Unknown ${i + 1}`,
                artist: `Unknown Artist ${i + 1}`,
                album: "Unknown Album",
            },
        }));
        const knownTracks = Array.from({ length: 28 }, (_v, i) => ({
            spotifyTrack: {
                title: `Known ${i + 1}`,
                artist: `Known Artist ${i + 1}`,
                album: `Known Album ${i + 1}`,
            },
        }));
        const albumsToDownload = Array.from({ length: 11 }, (_v, i) => ({
            artistName: `Artist ${i + 1}`,
            albumName: `Album ${i + 1}`,
            trackCount: i + 1,
            albumMbid: i % 2 === 0 ? `mbid-${i + 1}-abcdef` : null,
        }));

        const { logSpy, exitSpy } = setupPlaylistImportScript({
            playlistUrl,
            preview: {
                playlist: { name: "Needs Work Mix" },
                summary: {
                    total: 40,
                    inLibrary: 10,
                    downloadable: 30,
                    notFound: 0,
                },
                matchedTracks: [...unknownTracks, ...knownTracks],
                albumsToDownload,
            },
        });

        await importScriptEntrypoint();

        const output = loggedText(logSpy);
        expect(output).toContain("Tracks still with Unknown Album:");
        expect(output).toContain("... and 2 more");
        expect(output).toContain("... and 1 more albums");
        expect(output).toContain("NEEDS WORK: 30.0% tracks have Unknown Album");
        expect(exitSpy).not.toHaveBeenCalled();
    });
});
