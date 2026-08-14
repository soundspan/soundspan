import {
    buildM3UMatchIndex,
    buildTrackMatchIndex,
    matchM3UEntryAgainstLibrary,
    matchTrackAgainstIndex,
    matchTrackAgainstLibrary,
    normalizeAlbumForMatching,
    normalizeApostrophes,
    normalizeString,
    normalizeTrackTitle,
    stringSimilarity,
    stripTrackSuffix,
    type LocalTrackCandidate,
} from "../trackMatching";
import type { M3UEntry } from "../../services/m3uParser";

function makeCandidate(
    overrides: Partial<LocalTrackCandidate>,
): LocalTrackCandidate {
    return {
        id: overrides.id ?? "candidate-1",
        title: overrides.title ?? "Track",
        duration: overrides.duration ?? 180,
        albumTitle: overrides.albumTitle ?? "Album",
        artistName: overrides.artistName ?? "Artist",
        filePath: overrides.filePath,
    };
}

describe("trackMatching utilities", () => {
    describe("normalization helpers", () => {
        it("normalizes apostrophes and fullwidth text", () => {
            expect(normalizeApostrophes("Ｉt’s ＯＫ")).toBe("It's OK");
        });

        it("normalizes case, accents, punctuation, and whitespace", () => {
            expect(normalizeString("  Café,   Déjà Vu!  ")).toBe(
                "cafe deja vu",
            );
        });

        it("strips release suffixes and normalizes track titles", () => {
            expect(
                normalizeTrackTitle("Song Name - 2011 Remastered Version"),
            ).toBe("song name");
        });

        it("normalizes album names for matching", () => {
            expect(
                normalizeAlbumForMatching(" Album Name (Deluxe Edition) "),
            ).toBe("Album Name");
        });

        it("removes live/bracket suffix patterns from raw titles", () => {
            expect(
                stripTrackSuffix(
                    "Track Name (Live at Wembley 1986) [Remastered]",
                ),
            ).toBe("Track Name");
        });
    });

    describe("stringSimilarity", () => {
        it("returns 100 for exact normalized matches", () => {
            expect(stringSimilarity("Beyoncé", "beyonce")).toBe(100);
        });

        it("uses containment ratio when one side contains the other", () => {
            expect(stringSimilarity("hello world", "hello")).toBe(45);
        });

        it("falls back to word-set similarity when strings are not substrings", () => {
            expect(stringSimilarity("red blue green", "red green yellow")).toBe(
                50,
            );
        });
    });

    describe("matchTrackAgainstLibrary", () => {
        it("reuses a prebuilt index across exact and fuzzy matches", () => {
            const candidates: LocalTrackCandidate[] = [
                makeCandidate({
                    id: "exact-index-hit",
                    artistName: "Beyonce",
                    title: "Halo",
                    albumTitle: "I Am... Sasha Fierce",
                }),
                makeCandidate({
                    id: "fuzzy-index-hit",
                    artistName: "Echoes",
                    title: "Neon Light",
                    albumTitle: "Singles",
                }),
            ];
            const index = buildTrackMatchIndex(candidates);

            expect(
                matchTrackAgainstIndex(
                    {
                        artist: "Beyoncé",
                        title: "Halo",
                        album: "I Am... Sasha Fierce",
                    },
                    index,
                ),
            ).toEqual({
                trackId: "exact-index-hit",
                matchType: "exact",
                matchConfidence: 100,
            });
            expect(
                matchTrackAgainstIndex(
                    { artist: "The Echoes", title: "Neon Lights" },
                    index,
                ),
            ).toEqual({
                trackId: "fuzzy-index-hit",
                matchType: "fuzzy",
                matchConfidence: 79,
            });
        });

        it("returns null when no candidates are available", () => {
            expect(
                matchTrackAgainstLibrary(
                    { artist: "Artist", title: "Track", album: "Album" },
                    [],
                ),
            ).toBeNull();
        });

        it("prefers exact artist+album+title matches (strategy 1)", () => {
            const candidates: LocalTrackCandidate[] = [
                makeCandidate({
                    id: "exact-1",
                    artistName: "Beyonce",
                    title: "Halo",
                    albumTitle: "I Am... Sasha Fierce",
                }),
            ];

            expect(
                matchTrackAgainstLibrary(
                    {
                        artist: "Beyoncé",
                        title: "Halo",
                        album: "I Am... Sasha Fierce",
                    },
                    candidates,
                ),
            ).toEqual({
                trackId: "exact-1",
                matchType: "exact",
                matchConfidence: 100,
            });
        });

        it("matches album variants with include-based album normalization (strategy 2)", () => {
            const candidates: LocalTrackCandidate[] = [
                makeCandidate({
                    id: "exact-2",
                    artistName: "Queen",
                    title: "Bohemian Rhapsody",
                    albumTitle: "The Greatest Hits Collection",
                }),
            ];

            expect(
                matchTrackAgainstLibrary(
                    {
                        artist: "Queen",
                        title: "Bohemian Rhapsody",
                        album: "Greatest Hits",
                    },
                    candidates,
                ),
            ).toEqual({
                trackId: "exact-2",
                matchType: "exact",
                matchConfidence: 95,
            });
        });

        it("falls back to artist+title matching when album does not match (strategy 3)", () => {
            const candidates: LocalTrackCandidate[] = [
                makeCandidate({
                    id: "exact-3",
                    artistName: "Queen",
                    title: "Bohemian Rhapsody",
                    albumTitle: "Jazz",
                }),
            ];

            expect(
                matchTrackAgainstLibrary(
                    {
                        artist: "Queen",
                        title: "Bohemian Rhapsody",
                        album: "A Night at the Opera",
                    },
                    candidates,
                ),
            ).toEqual({
                trackId: "exact-3",
                matchType: "exact",
                matchConfidence: 85,
            });
        });

        it("does not treat empty normalized albums as include-matches in strategy 2", () => {
            const candidates: LocalTrackCandidate[] = [
                makeCandidate({
                    id: "exact-4",
                    artistName: "Artist",
                    title: "Song",
                    albumTitle: "[]",
                }),
            ];

            expect(
                matchTrackAgainstLibrary(
                    {
                        artist: "Artist",
                        title: "Song",
                        album: "()",
                    },
                    candidates,
                ),
            ).toEqual({
                trackId: "exact-4",
                matchType: "exact",
                matchConfidence: 85,
            });
        });

        it("uses fuzzy weighted matching when exact strategies fail (strategy 4)", () => {
            const candidates: LocalTrackCandidate[] = [
                makeCandidate({
                    id: "fuzzy-hit",
                    artistName: "Echoes",
                    title: "Neon Light",
                    albumTitle: "Singles",
                }),
                makeCandidate({
                    id: "fuzzy-miss",
                    artistName: "Unrelated Artist",
                    title: "Different Song",
                    albumTitle: "Compilation",
                }),
            ];

            expect(
                matchTrackAgainstLibrary(
                    { artist: "The Echoes", title: "Neon Lights" },
                    candidates,
                ),
            ).toEqual({
                trackId: "fuzzy-hit",
                matchType: "fuzzy",
                matchConfidence: 79,
            });
        });

        it("returns null when no candidate reaches the fuzzy threshold", () => {
            const candidates: LocalTrackCandidate[] = [
                makeCandidate({
                    id: "low-score",
                    artistName: "Alpha",
                    title: "Beta",
                }),
            ];

            expect(
                matchTrackAgainstLibrary(
                    {
                        artist: "Completely Different",
                        title: "Nothing Similar",
                    },
                    candidates,
                ),
            ).toBeNull();
        });
    });

    describe("matchM3UEntryAgainstLibrary", () => {
        it("matches by normalized file path before metadata tiers", () => {
            const entry: M3UEntry = {
                filePath: "C:/Music/Artist/Album/01 - Track.flac",
                artist: "Wrong Artist",
                title: "Wrong Title",
                durationSeconds: 240,
            };
            const candidates: LocalTrackCandidate[] = [
                makeCandidate({
                    id: "path-hit",
                    filePath: "Artist/Album/01 - Track.flac",
                    artistName: "Actual Artist",
                    title: "Actual Title",
                }),
            ];

            expect(
                matchM3UEntryAgainstLibrary(
                    entry,
                    buildM3UMatchIndex(candidates),
                ),
            ).toEqual({
                trackId: "path-hit",
                matchType: "path",
                matchConfidence: 100,
            });
        });

        it("matches when the library path is longer than the entry path", () => {
            const entry: M3UEntry = {
                filePath: "Artist/Album/02 - Deep Cut.flac",
                artist: null,
                title: null,
                durationSeconds: null,
            };
            const candidates: LocalTrackCandidate[] = [
                makeCandidate({
                    id: "suffix-hit",
                    filePath: "/srv/music/Artist/Album/02 - Deep Cut.flac",
                }),
            ];

            expect(
                matchM3UEntryAgainstLibrary(
                    entry,
                    buildM3UMatchIndex(candidates),
                ),
            ).toEqual({
                trackId: "suffix-hit",
                matchType: "path",
                matchConfidence: 100,
            });
        });

        it("falls back to filename matching when the file path does not map directly", () => {
            const entry: M3UEntry = {
                filePath: "D:/Exports/Mixes/Filename Winner.mp3",
                artist: null,
                title: null,
                durationSeconds: null,
            };
            const candidates: LocalTrackCandidate[] = [
                makeCandidate({
                    id: "filename-hit",
                    filePath: "Library/Artist/Filename Winner.mp3",
                }),
            ];

            expect(
                matchM3UEntryAgainstLibrary(
                    entry,
                    buildM3UMatchIndex(candidates),
                ),
            ).toEqual({
                trackId: "filename-hit",
                matchType: "filename",
                matchConfidence: 98,
            });
        });

        it("resolves filename ties to the candidate first in (filePath, id) order", () => {
            const entry: M3UEntry = {
                filePath: "X:/Somewhere/Duplicate Song.mp3",
                artist: null,
                title: null,
                durationSeconds: null,
            };
            const candidates: LocalTrackCandidate[] = [
                makeCandidate({
                    id: "later",
                    filePath: "Library/Z Artist/Duplicate Song.mp3",
                }),
                makeCandidate({
                    id: "earlier",
                    filePath: "Library/A Artist/Duplicate Song.mp3",
                }),
            ];

            expect(
                matchM3UEntryAgainstLibrary(
                    entry,
                    buildM3UMatchIndex(candidates),
                ),
            ).toEqual({
                trackId: "earlier",
                matchType: "filename",
                matchConfidence: 98,
            });
        });

        it("falls back to exact metadata matching when path tiers miss", () => {
            const entry: M3UEntry = {
                filePath: "Missing/Path/No Match Here.flac",
                artist: "The Metadata Band",
                title: "Exact Song - 2011 Remastered Version",
                durationSeconds: 200,
            };
            const candidates: LocalTrackCandidate[] = [
                makeCandidate({
                    id: "metadata-hit",
                    filePath: "Library/The Metadata Band/Exact Song.flac",
                    artistName: "The Metadata Band",
                    title: "Exact Song",
                }),
            ];

            expect(
                matchM3UEntryAgainstLibrary(
                    entry,
                    buildM3UMatchIndex(candidates),
                ),
            ).toEqual({
                trackId: "metadata-hit",
                matchType: "exact",
                matchConfidence: 100,
            });
        });

        it("falls back to fuzzy metadata matching as the last tier", () => {
            const entry: M3UEntry = {
                filePath: "Missing/Path/Nowhere.flac",
                artist: "Fuzzy Artist",
                title: "Fuzzy Song Title Extended",
                durationSeconds: 200,
            };
            const candidates: LocalTrackCandidate[] = [
                makeCandidate({
                    id: "fuzzy-hit",
                    filePath: "Library/Fuzzy Artist/Fuzzy Song Title.flac",
                    artistName: "Fuzzy Artist",
                    title: "Fuzzy Song Title",
                }),
            ];

            const result = matchM3UEntryAgainstLibrary(
                entry,
                buildM3UMatchIndex(candidates),
            );
            expect(result).not.toBeNull();
            expect(result?.trackId).toBe("fuzzy-hit");
            expect(result?.matchType).toBe("fuzzy");
            expect(result?.matchConfidence).toBeGreaterThanOrEqual(70);
        });

        it("returns null when the index has no candidates", () => {
            const entry: M3UEntry = {
                filePath: "Anything.mp3",
                artist: "Artist",
                title: "Title",
                durationSeconds: null,
            };

            expect(
                matchM3UEntryAgainstLibrary(entry, buildM3UMatchIndex([])),
            ).toBeNull();
        });

        it("matches many entries against one prebuilt index", () => {
            const candidates: LocalTrackCandidate[] = [
                makeCandidate({
                    id: "a",
                    filePath: "Library/One/Alpha.mp3",
                }),
                makeCandidate({
                    id: "b",
                    filePath: "Library/Two/Beta.mp3",
                }),
            ];
            const index = buildM3UMatchIndex(candidates);
            const entries: M3UEntry[] = [
                {
                    filePath: "C:/Alpha.mp3",
                    artist: null,
                    title: null,
                    durationSeconds: null,
                },
                {
                    filePath: "C:/Beta.mp3",
                    artist: null,
                    title: null,
                    durationSeconds: null,
                },
            ];

            const results = entries.map((e) =>
                matchM3UEntryAgainstLibrary(e, index),
            );
            expect(results.map((r) => r?.trackId)).toEqual(["a", "b"]);
        });
    });
});
