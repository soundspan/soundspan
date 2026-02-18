type JsonRecord = Record<string, unknown>;

const baseUrl =
    process.env.SOUNDSPAN_BASE_URL ??
    process.env.SOUNDSPAN_BASE_URL ??
    "http://127.0.0.1:3006";
const subsonicUser = process.env.SMOKE_SUBSONIC_USER;
const subsonicPassword = process.env.SMOKE_SUBSONIC_PASSWORD;
const subsonicVersion = process.env.SMOKE_SUBSONIC_VERSION ?? "1.16.1";
const responseFormat = "json";
const smokeMode = process.env.SMOKE_MODE ?? "matrix";
const requireTracks = process.env.SMOKE_REQUIRE_TRACKS === "true";
const enableFixtures = process.env.SMOKE_ENABLE_FIXTURES === "true";
const cleanupFixtures = process.env.SMOKE_FIXTURE_CLEANUP !== "false";

type TrackContext = {
    id: string;
    albumId: string;
    artistId: string;
    artistName: string;
    title: string;
};

type FixtureHandle = {
    track: TrackContext;
    cleanup: () => Promise<void>;
};

function assertCondition(condition: unknown, message: string): void {
    if (!condition) {
        throw new Error(message);
    }
}

function asRecord(value: unknown): JsonRecord | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    return value as JsonRecord;
}

function asString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function readArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function readArrayLength(value: unknown): number {
    return readArray(value).length;
}

async function createTrackFixture(): Promise<FixtureHandle> {
    assertCondition(
        process.env.DATABASE_URL,
        "DATABASE_URL is required to create smoke fixtures",
    );

    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

    try {
        const artist = await prisma.artist.create({
            data: {
                mbid: `smoke-artist-${suffix}`,
                name: `Smoke Artist ${suffix}`,
                normalizedName: `smoke artist ${suffix}`,
                summary: "Temporary smoke-test fixture artist",
            },
        });

        const album = await prisma.album.create({
            data: {
                rgMbid: `smoke-album-${suffix}`,
                artistId: artist.id,
                title: `Smoke Album ${suffix}`,
                primaryType: "Album",
                location: "LIBRARY",
            },
        });

        const track = await prisma.track.create({
            data: {
                albumId: album.id,
                title: `Smoke Track ${suffix}`,
                trackNo: 1,
                discNo: 1,
                duration: 5,
                mime: "audio/mpeg",
                filePath: `smoke-fixtures/${suffix}.mp3`,
                fileModified: new Date(),
                fileSize: 64,
            },
        });

        await prisma.$disconnect();

        return {
            track: {
                id: `tr-${track.id}`,
                albumId: `al-${album.id}`,
                artistId: `ar-${artist.id}`,
                artistName: artist.name,
                title: track.title,
            },
            cleanup: async () => {
                const cleanupPrisma = new PrismaClient();
                try {
                    await cleanupPrisma.track.deleteMany({
                        where: { id: track.id },
                    });
                    await cleanupPrisma.album.deleteMany({
                        where: { id: album.id },
                    });
                    await cleanupPrisma.artist.deleteMany({
                        where: { id: artist.id },
                    });
                } finally {
                    await cleanupPrisma.$disconnect();
                }
            },
        };
    } catch (error) {
        await prisma.$disconnect();
        throw error;
    }
}

async function fetchJson(path: string, params?: URLSearchParams): Promise<JsonRecord> {
    const url = new URL(path, baseUrl);
    if (params) {
        url.search = params.toString();
    }

    const response = await fetch(url.toString());
    const body = (await response.json()) as JsonRecord;

    assertCondition(
        response.ok,
        `HTTP ${response.status} for ${url.pathname}: ${JSON.stringify(body)}`,
    );

    return body;
}

async function fetchRaw(
    path: string,
    params?: URLSearchParams,
    headers?: Record<string, string>,
): Promise<Response> {
    const url = new URL(path, baseUrl);
    if (params) {
        url.search = params.toString();
    }

    return fetch(url.toString(), { headers });
}

function buildSubsonicParams(clientId: string): URLSearchParams {
    assertCondition(subsonicUser, "SMOKE_SUBSONIC_USER is required for Subsonic smoke checks");
    assertCondition(
        subsonicPassword,
        "SMOKE_SUBSONIC_PASSWORD is required for Subsonic smoke checks",
    );

    const params = new URLSearchParams();
    params.set("u", subsonicUser);
    params.set("p", subsonicPassword);
    params.set("v", subsonicVersion);
    params.set("c", clientId);
    params.set("f", responseFormat);
    return params;
}

function getSubsonicEnvelope(payload: JsonRecord): JsonRecord {
    const response = asRecord(payload["subsonic-response"]);
    assertCondition(response, "Missing subsonic-response envelope");
    return response;
}

async function callSubsonicJson(
    endpoint: string,
    clientId: string,
    extraParams?: Record<string, string | number>,
): Promise<JsonRecord> {
    const params = buildSubsonicParams(clientId);
    if (extraParams) {
        for (const [key, value] of Object.entries(extraParams)) {
            params.set(key, String(value));
        }
    }

    return getSubsonicEnvelope(await fetchJson(`/rest/${endpoint}`, params));
}

function ensureOk(envelope: JsonRecord, label: string): void {
    assertCondition(
        envelope.status === "ok",
        `${label} failed: ${JSON.stringify(envelope)}`,
    );
}

function buildTrackContext(searchEnvelope: JsonRecord): TrackContext | null {
    const searchResult3 = asRecord(searchEnvelope.searchResult3);
    const songs = readArray(searchResult3?.song);
    if (songs.length === 0) {
        return null;
    }

    const firstSong = asRecord(songs[0]);
    if (!firstSong) {
        return null;
    }

    const id = asString(firstSong.id);
    const albumId = asString(firstSong.albumId);
    const artistId = asString(firstSong.artistId);
    const artistName = asString(firstSong.artist);
    const title = asString(firstSong.title);

    if (!id || !albumId || !artistId || !artistName || !title) {
        return null;
    }

    return {
        id,
        albumId,
        artistId,
        artistName,
        title,
    };
}

async function runHealthCheck(): Promise<void> {
    const payload = await fetchJson("/health");
    assertCondition(payload.status === "ok", `Unexpected /health payload: ${JSON.stringify(payload)}`);
    console.log("smoke: health check passed");
}

async function runSubsonicMatrix(): Promise<{ track: TrackContext | null; username: string }> {
    const ping = await callSubsonicJson("ping.view", "symfonium");
    ensureOk(ping, "ping.view");

    const userPayload = await callSubsonicJson("getUser.view", "symfonium", {
        username: subsonicUser!,
    });
    ensureOk(userPayload, "getUser.view");
    const user = asRecord(userPayload.user);
    const username = asString(user?.username) ?? subsonicUser!;
    assertCondition(username.length > 0, "getUser.view did not return username");

    const tokenInfo = await callSubsonicJson("tokenInfo.view", "symfonium");
    ensureOk(tokenInfo, "tokenInfo.view");
    const tokenInfoPayload = asRecord(tokenInfo.tokenInfo);
    assertCondition(
        asString(tokenInfoPayload?.authType) === "password",
        `Expected password authType, got ${JSON.stringify(tokenInfo)}`,
    );

    const extensions = await callSubsonicJson("getOpenSubsonicExtensions.view", "symfonium");
    ensureOk(extensions, "getOpenSubsonicExtensions.view");

    const license = await callSubsonicJson("getLicense.view", "symfonium");
    ensureOk(license, "getLicense.view");

    const folders = await callSubsonicJson("getMusicFolders.view", "symfonium");
    ensureOk(folders, "getMusicFolders.view");
    assertCondition(
        readArrayLength(asRecord(folders.musicFolders)?.musicFolder) >= 1,
        "Expected at least one music folder",
    );

    const indexes = await callSubsonicJson("getIndexes.view", "ultrasonic");
    ensureOk(indexes, "getIndexes.view");
    const indexPayload = asRecord(indexes.indexes);
    assertCondition(indexPayload, "Missing indexes payload");
    const indexGroups = readArrayLength(indexPayload.index);
    const lastModified = indexPayload.lastModified;
    assertCondition(typeof lastModified === "number", "Missing indexes.lastModified");

    const indexesIfModified = await callSubsonicJson("getIndexes.view", "ultrasonic", {
        ifModifiedSince: String(lastModified),
    });
    ensureOk(indexesIfModified, "getIndexes.view ifModifiedSince");
    assertCondition(
        readArrayLength(asRecord(indexesIfModified.indexes)?.index) === 0,
        "Expected empty indexes for current ifModifiedSince",
    );

    const indexesBadFolder = await callSubsonicJson("getIndexes.view", "ultrasonic", {
        musicFolderId: "99",
    });
    ensureOk(indexesBadFolder, "getIndexes.view musicFolderId");
    assertCondition(
        readArrayLength(asRecord(indexesBadFolder.indexes)?.index) === 0,
        "Expected empty indexes for unsupported musicFolderId",
    );

    const artistsBadFolder = await callSubsonicJson("getArtists.view", "amperfy", {
        musicFolderId: "99",
    });
    ensureOk(artistsBadFolder, "getArtists.view musicFolderId");
    assertCondition(
        readArrayLength(asRecord(artistsBadFolder.artists)?.index) === 0,
        "Expected empty getArtists for unsupported musicFolderId",
    );

    const search3 = await callSubsonicJson("search3.view", "symfonium", {
        query: "\"\"",
        artistCount: 0,
        albumCount: 0,
        songCount: 0,
    });
    ensureOk(search3, "search3.view full-sync");

    const search3Payload = asRecord(search3.searchResult3);
    const search3SongCount = readArrayLength(search3Payload?.song);
    assertCondition(
        readArrayLength(search3Payload?.artist) > 0 ||
            readArrayLength(search3Payload?.album) > 0 ||
            search3SongCount > 0 ||
            indexGroups === 0,
        "search3 full-sync returned empty payload unexpectedly",
    );

    const search2 = await callSubsonicJson("search2.view", "dsub", {
        query: "\"\"",
        artistCount: 0,
        albumCount: 0,
        songCount: 0,
    });
    ensureOk(search2, "search2.view full-sync");

    const search2BadFolder = await callSubsonicJson("search2.view", "dsub", {
        query: "artist",
        musicFolderId: "99",
    });
    ensureOk(search2BadFolder, "search2.view musicFolderId");
    const search2BadFolderPayload = asRecord(search2BadFolder.searchResult2);
    assertCondition(
        readArrayLength(search2BadFolderPayload?.artist) === 0 &&
            readArrayLength(search2BadFolderPayload?.album) === 0 &&
            readArrayLength(search2BadFolderPayload?.song) === 0,
        "Expected empty search2 payload for unsupported musicFolderId",
    );

    console.log("smoke: subsonic matrix passed");

    return {
        track: search3SongCount > 0 ? buildTrackContext(search3) : null,
        username,
    };
}

async function runSubsonicFullEmulation(track: TrackContext | null, username: string): Promise<void> {
    const genres = await callSubsonicJson("getGenres.view", "symfonium");
    ensureOk(genres, "getGenres.view");

    const albumList2 = await callSubsonicJson("getAlbumList2.view", "symfonium", {
        type: "alphabeticalByName",
        size: 5,
        offset: 0,
    });
    ensureOk(albumList2, "getAlbumList2.view");

    const musicDirectoryRoot = await callSubsonicJson("getMusicDirectory.view", "symfonium", {
        id: 1,
    });
    ensureOk(musicDirectoryRoot, "getMusicDirectory.view root");

    const avatarResponse = await fetchRaw(
        "/rest/getAvatar.view",
        (() => {
            const params = buildSubsonicParams("symfonium");
            params.set("username", username);
            return params;
        })(),
    );
    assertCondition(avatarResponse.status === 200, "getAvatar.view did not return HTTP 200");

    const scanStart = await callSubsonicJson("startScan.view", "ultrasonic");
    ensureOk(scanStart, "startScan.view");
    const scanStatus = await callSubsonicJson("getScanStatus.view", "ultrasonic");
    ensureOk(scanStatus, "getScanStatus.view");

    const queueReadBaseline = await callSubsonicJson("getPlayQueue.view", "symfonium");
    ensureOk(queueReadBaseline, "getPlayQueue.view baseline");

    const queueByIndexReadBaseline = await callSubsonicJson("getPlayQueueByIndex.view", "substreamer", {
        index: 2,
    });
    ensureOk(queueByIndexReadBaseline, "getPlayQueueByIndex.view baseline");

    const emptyPlaylistName = `smoke-empty-playlist-${Date.now()}`;
    const createEmptyPlaylist = await callSubsonicJson("createPlaylist.view", "symfonium", {
        name: emptyPlaylistName,
    });
    ensureOk(createEmptyPlaylist, "createPlaylist.view (empty)");
    const playlistsAfterEmptyCreate = await callSubsonicJson("getPlaylists.view", "symfonium");
    ensureOk(playlistsAfterEmptyCreate, "getPlaylists.view after empty create");
    const emptyPlaylistId = readArray(asRecord(playlistsAfterEmptyCreate.playlists)?.playlist)
        .map((entry) => asRecord(entry))
        .find((entry) => asString(entry?.name) === emptyPlaylistName)?.id;
    assertCondition(
        emptyPlaylistId,
        "createPlaylist.view (empty) did not return playlist id",
    );

    const readEmptyPlaylist = await callSubsonicJson("getPlaylist.view", "symfonium", {
        id: emptyPlaylistId!,
    });
    ensureOk(readEmptyPlaylist, "getPlaylist.view (empty)");

    const deleteEmptyPlaylist = await callSubsonicJson("deletePlaylist.view", "symfonium", {
        id: emptyPlaylistId!,
    });
    ensureOk(deleteEmptyPlaylist, "deletePlaylist.view (empty)");

    const nowPlayingBaseline = await callSubsonicJson("getNowPlaying.view", "symfonium");
    ensureOk(nowPlayingBaseline, "getNowPlaying.view baseline");

    const starred = await callSubsonicJson("getStarred.view", "symfonium");
    ensureOk(starred, "getStarred.view");
    const starred2 = await callSubsonicJson("getStarred2.view", "symfonium");
    ensureOk(starred2, "getStarred2.view baseline");

    if (!track) {
        if (requireTracks) {
            throw new Error(
                "Track-dependent emulation required but no library songs were returned by search3",
            );
        }
        console.log("smoke: full emulation skipped track-dependent checks (library has no songs)");
        return;
    }

    const song = await callSubsonicJson("getSong.view", "symfonium", { id: track.id });
    ensureOk(song, "getSong.view");

    const album = await callSubsonicJson("getAlbum.view", "symfonium", { id: track.albumId });
    ensureOk(album, "getAlbum.view");
    const albumPayload = asRecord(album.album);

    const artist = await callSubsonicJson("getArtist.view", "symfonium", { id: track.artistId });
    ensureOk(artist, "getArtist.view");

    const artistInfo = await callSubsonicJson("getArtistInfo2.view", "symfonium", {
        id: track.artistId,
    });
    ensureOk(artistInfo, "getArtistInfo2.view");

    const albumInfo = await callSubsonicJson("getAlbumInfo2.view", "symfonium", {
        id: track.albumId,
    });
    ensureOk(albumInfo, "getAlbumInfo2.view");

    const topSongs = await callSubsonicJson("getTopSongs.view", "symfonium", {
        artist: track.artistName,
    });
    ensureOk(topSongs, "getTopSongs.view");

    const songByGenre = await callSubsonicJson("getSongsByGenre.view", "symfonium", {
        genre: "rock",
        count: 1,
        offset: 0,
    });
    ensureOk(songByGenre, "getSongsByGenre.view");

    const randomSongs = await callSubsonicJson("getRandomSongs.view", "symfonium", {
        size: 2,
    });
    ensureOk(randomSongs, "getRandomSongs.view");

    const searchLegacy = await callSubsonicJson("search.view", "dsub", {
        query: track.artistName,
        artistCount: 3,
        albumCount: 3,
        songCount: 3,
    });
    ensureOk(searchLegacy, "search.view");

    const lyricsBySong = await callSubsonicJson("getLyricsBySongId.view", "symfonium", {
        id: track.id,
    });
    ensureOk(lyricsBySong, "getLyricsBySongId.view");

    const lyricsLegacy = await callSubsonicJson("getLyrics.view", "dsub", {
        artist: track.artistName,
        title: track.title,
    });
    ensureOk(lyricsLegacy, "getLyrics.view");

    const ratingLike = await callSubsonicJson("setRating.view", "symfonium", {
        id: track.id,
        rating: 5,
    });
    ensureOk(ratingLike, "setRating.view like");

    const star = await callSubsonicJson("star.view", "symfonium", { id: track.id });
    ensureOk(star, "star.view");
    const starred2Track = await callSubsonicJson("getStarred2.view", "symfonium");
    ensureOk(starred2Track, "getStarred2.view track");

    const scrobble = await callSubsonicJson("scrobble.view", "symfonium", {
        id: track.id,
        submission: "false",
    });
    ensureOk(scrobble, "scrobble.view");

    const queueSave = await callSubsonicJson("savePlayQueue.view", "symfonium", {
        id: track.id,
        current: 0,
        position: 900,
    });
    ensureOk(queueSave, "savePlayQueue.view");
    const queueRead = await callSubsonicJson("getPlayQueue.view", "symfonium");
    ensureOk(queueRead, "getPlayQueue.view");

    const queueByIndexSave = await callSubsonicJson("savePlayQueueByIndex.view", "substreamer", {
        index: 2,
        id: track.id,
        current: 0,
        position: 1234,
    });
    ensureOk(queueByIndexSave, "savePlayQueueByIndex.view");
    const queueByIndexRead = await callSubsonicJson("getPlayQueueByIndex.view", "substreamer", {
        index: 2,
    });
    ensureOk(queueByIndexRead, "getPlayQueueByIndex.view");

    const playlistName = `smoke-playlist-${Date.now()}`;
    const createPlaylist = await callSubsonicJson("createPlaylist.view", "symfonium", {
        name: playlistName,
        songId: track.id,
    });
    ensureOk(createPlaylist, "createPlaylist.view");
    const playlistsAfterCreate = await callSubsonicJson("getPlaylists.view", "symfonium");
    ensureOk(playlistsAfterCreate, "getPlaylists.view after create");
    const playlistId = readArray(asRecord(playlistsAfterCreate.playlists)?.playlist)
        .map((entry) => asRecord(entry))
        .find((entry) => asString(entry?.name) === playlistName)?.id;
    assertCondition(playlistId, "createPlaylist.view did not return playlist id");

    const playlistRead = await callSubsonicJson("getPlaylist.view", "symfonium", {
        id: playlistId!,
    });
    ensureOk(playlistRead, "getPlaylist.view");

    const playlistUpdate = await callSubsonicJson("updatePlaylist.view", "symfonium", {
        playlistId: playlistId!,
        name: `${playlistName}-updated`,
    });
    ensureOk(playlistUpdate, "updatePlaylist.view");

    const playlists = await callSubsonicJson("getPlaylists.view", "symfonium");
    ensureOk(playlists, "getPlaylists.view");

    const playlistDelete = await callSubsonicJson("deletePlaylist.view", "symfonium", {
        id: playlistId!,
    });
    ensureOk(playlistDelete, "deletePlaylist.view");

    const unstar = await callSubsonicJson("unstar.view", "symfonium", { id: track.id });
    ensureOk(unstar, "unstar.view");

    const ratingReset = await callSubsonicJson("setRating.view", "symfonium", {
        id: track.id,
        rating: 0,
    });
    ensureOk(ratingReset, "setRating.view reset");

    const nowPlaying = await callSubsonicJson("getNowPlaying.view", "symfonium");
    ensureOk(nowPlaying, "getNowPlaying.view");

    const albumIdFromPayload = asString(albumPayload?.id);
    if (albumIdFromPayload) {
        const coverArtResponse = await fetchRaw(
            "/rest/getCoverArt.view",
            (() => {
                const params = buildSubsonicParams("symfonium");
                params.set("id", albumIdFromPayload);
                return params;
            })(),
        );
        assertCondition(
            coverArtResponse.status === 200 || coverArtResponse.status === 404,
            `getCoverArt.view unexpected HTTP ${coverArtResponse.status}`,
        );
    }

    const streamResponse = await fetchRaw(
        "/rest/stream.view",
        (() => {
            const params = buildSubsonicParams("symfonium");
            params.set("id", track.id);
            return params;
        })(),
        {
            Range: "bytes=0-15",
        },
    );
    assertCondition(
        streamResponse.status === 206 ||
            streamResponse.status === 200 ||
            streamResponse.status === 404,
        `stream.view unexpected HTTP ${streamResponse.status}`,
    );

    console.log("smoke: full subsonic emulation passed");
}

async function main(): Promise<void> {
    await runHealthCheck();

    if (!subsonicUser || !subsonicPassword) {
        console.log(
            "smoke: skipping subsonic checks (set SMOKE_SUBSONIC_USER and SMOKE_SUBSONIC_PASSWORD to enable)",
        );
        return;
    }

    let fixtureHandle: FixtureHandle | null = null;
    try {
        const matrix = await runSubsonicMatrix();
        if (smokeMode === "full") {
            let track = matrix.track;

            if (!track && (enableFixtures || requireTracks)) {
                if (!enableFixtures) {
                    throw new Error(
                        "SMOKE_REQUIRE_TRACKS=true but no tracks found and SMOKE_ENABLE_FIXTURES is not enabled",
                    );
                }

                fixtureHandle = await createTrackFixture();
                track = fixtureHandle.track;
                console.log("smoke: created temporary track fixture for full emulation");
            }

            await runSubsonicFullEmulation(track, matrix.username);
        } else {
            console.log(`smoke: mode=${smokeMode} (set SMOKE_MODE=full for extended emulation)`);
        }
    } finally {
        if (fixtureHandle && cleanupFixtures) {
            await fixtureHandle.cleanup();
            console.log("smoke: cleaned up temporary track fixture");
        }
    }
}

main().catch((error) => {
    console.error("smoke: failed", error);
    process.exitCode = 1;
});
