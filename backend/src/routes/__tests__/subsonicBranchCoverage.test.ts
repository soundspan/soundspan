import type { Request, Response } from "express";
import fs from "node:fs";

const mockGetStreamFilePath = jest.fn();
const mockStreamFileWithRangeSupport = jest.fn();
const mockDestroyStreamingService = jest.fn();

jest.mock("../../middleware/subsonicAuth", () => ({
	requireSubsonicAuth: (_req: Request, _res: Response, next: () => void) =>
		next(),
	subsonicRateLimiter: (_req: Request, _res: Response, next: () => void) =>
		next(),
}));

jest.mock("../../utils/subsonicResponse", () => ({
	getResponseFormat: jest.fn(() => "json"),
	sendSubsonicError: jest.fn(),
	sendSubsonicSuccess: jest.fn(),
	SubsonicErrorCode: {
		GENERIC: 0,
		MISSING_PARAMETER: 10,
		NOT_AUTHORIZED: 50,
		NOT_FOUND: 70,
	},
}));

jest.mock("../../utils/db", () => ({
	prisma: {
		artist: { findMany: jest.fn(), findFirst: jest.fn() },
		genre: { findMany: jest.fn() },
		album: { findMany: jest.fn(), findFirst: jest.fn() },
		track: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
		playlist: {
			findMany: jest.fn(),
			findFirst: jest.fn(),
			create: jest.fn(),
			update: jest.fn(),
			delete: jest.fn(),
		},
		playlistItem: {
			findMany: jest.fn(),
			deleteMany: jest.fn(),
			createMany: jest.fn(),
			aggregate: jest.fn(),
			update: jest.fn(),
		},
		play: { groupBy: jest.fn(), createMany: jest.fn() },
		playbackState: {
			findMany: jest.fn(),
			findUnique: jest.fn(),
			upsert: jest.fn(),
		},
		bookmark: { findMany: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
		likedTrack: {
			findMany: jest.fn(),
			createMany: jest.fn(),
			deleteMany: jest.fn(),
		},
		user: { findUnique: jest.fn() },
		$transaction: jest.fn(),
	},
}));

jest.mock("../../workers/queues", () => ({
	scanQueue: {
		getActive: jest.fn(),
		getWaiting: jest.fn(),
		getDelayed: jest.fn(),
		add: jest.fn(),
	},
}));

jest.mock("../../services/audioStreaming", () => ({
	AudioStreamingService: jest.fn().mockImplementation(() => ({
		getStreamFilePath: mockGetStreamFilePath,
		streamFileWithRangeSupport: mockStreamFileWithRangeSupport,
		destroy: mockDestroyStreamingService,
	})),
}));

jest.mock("../../services/lyrics", () => ({
	getLyrics: jest.fn(),
}));

jest.mock("../../config", () => ({
	config: {
		music: {
			musicPath: "/music",
			transcodeCachePath: "/var/soundspan/transcode",
			transcodeCacheMaxGb: 2,
		},
	},
}));

import { getLyrics } from "../../services/lyrics";
import { prisma } from "../../utils/db";
import {
	getResponseFormat,
	sendSubsonicError,
	sendSubsonicSuccess,
} from "../../utils/subsonicResponse";
import {
	handleCreateBookmark,
	handleCreatePlaylist,
	handleDeleteBookmark,
	handleDownload,
	handleGetAlbum,
	handleGetAlbumInfo2,
	handleGetAlbumList2,
	handleGetArtist,
	handleGetArtistInfo2,
	handleGetBookmarks,
	handleGetCoverArt,
	handleGetGenres,
	handleGetIndexes,
	handleGetLyricsBySongId,
	handleGetMusicDirectory,
	handleGetNowPlaying,
	handleGetRandomSongs,
	handleGetSimilarSongs2,
	handleGetSong,
	handleGetSongsByGenre,
	handleGetStarred,
	handleGetStarred2,
	handleGetTopSongs,
	handlePing,
	handleSavePlayQueue,
	handleScrobble,
	handleSetRating,
	handleStar,
	handleStream,
	handleTokenInfo,
	handleUnstar,
	handleUpdatePlaylist,
} from "../subsonic";

function buildReq(query: Record<string, unknown>): Request {
	return {
		query,
		user: {
			id: "user-1",
			username: "alice",
			role: "user",
		},
	} as unknown as Request;
}

function buildRes(): Response {
	const res: Partial<Response> = {
		setHeader: jest.fn(),
		status: jest.fn(),
		send: jest.fn(),
		headersSent: false,
	};
	(res.status as jest.Mock).mockReturnValue(res);
	return res as Response;
}

describe("subsonic branch coverage focused handlers", () => {
	const mockSendSuccess = sendSubsonicSuccess as jest.Mock;
	const mockSendError = sendSubsonicError as jest.Mock;
	const mockGetResponseFormat = getResponseFormat as jest.Mock;

	const mockPlayGroupBy = prisma.play.groupBy as jest.Mock;
	const mockPlayCreateMany = prisma.play.createMany as jest.Mock;
	const mockGenreFindMany = (
		prisma as unknown as { genre: { findMany: jest.Mock } }
	).genre.findMany;
	const mockAlbumFindMany = prisma.album.findMany as jest.Mock;
	const mockAlbumFindFirst = prisma.album.findFirst as jest.Mock;
	const mockArtistFindFirst = prisma.artist.findFirst as jest.Mock;
	const mockTrackFindMany = prisma.track.findMany as jest.Mock;
	const mockTrackFindFirst = prisma.track.findFirst as jest.Mock;
	const mockTrackFindUnique = prisma.track.findUnique as jest.Mock;
	const mockPlaybackStateFindMany = prisma.playbackState.findMany as jest.Mock;
	const mockPlaylistFindFirst = prisma.playlist.findFirst as jest.Mock;
	const mockPlaylistUpdate = prisma.playlist.update as jest.Mock;
	const mockPlaylistItemFindMany = prisma.playlistItem.findMany as jest.Mock;
	const mockPlaylistItemDeleteMany = prisma.playlistItem
		.deleteMany as jest.Mock;
	const mockBookmarkFindMany = prisma.bookmark.findMany as jest.Mock;
	const mockBookmarkDeleteMany = prisma.bookmark.deleteMany as jest.Mock;
	const mockBookmarkUpsert = prisma.bookmark.upsert as jest.Mock;
	const mockGetLyrics = getLyrics as jest.Mock;

	const originalFetch = global.fetch;

	beforeEach(() => {
		jest.clearAllMocks();
		mockGetResponseFormat.mockReturnValue("json");
		mockPlayGroupBy.mockResolvedValue([]);
		mockPlayCreateMany.mockResolvedValue({ count: 0 });
		mockAlbumFindMany.mockResolvedValue([]);
		mockAlbumFindFirst.mockResolvedValue(null);
		mockArtistFindFirst.mockResolvedValue(null);
		mockGenreFindMany.mockResolvedValue([]);
		mockTrackFindMany.mockResolvedValue([]);
		mockTrackFindFirst.mockResolvedValue(null);
		mockTrackFindUnique.mockResolvedValue({ id: "track-1" });
		mockPlaybackStateFindMany.mockResolvedValue([]);
		mockPlaylistFindFirst.mockResolvedValue({ id: "playlist-1" });
		mockPlaylistUpdate.mockResolvedValue({ id: "playlist-1" });
		mockPlaylistItemFindMany.mockResolvedValue([]);
		mockPlaylistItemDeleteMany.mockResolvedValue({ count: 0 });
		mockBookmarkFindMany.mockResolvedValue([]);
		mockBookmarkDeleteMany.mockResolvedValue({ count: 0 });
		mockBookmarkUpsert.mockResolvedValue({});
		mockGetLyrics.mockResolvedValue({ syncedLyrics: null, plainLyrics: null });
		mockGetStreamFilePath.mockReset();
		mockStreamFileWithRangeSupport.mockReset();
		mockDestroyStreamingService.mockReset();
		global.fetch = jest.fn() as unknown as typeof fetch;
	});

	afterAll(() => {
		global.fetch = originalFetch;
	});

	it("returns ping with xml format and callback", () => {
		mockGetResponseFormat.mockReturnValue("xml");

		handlePing(buildReq({ callback: "cbFn" }), buildRes());

		expect(mockSendSuccess).toHaveBeenCalledWith(
			expect.anything(),
			{ ping: {} },
			"xml",
			"cbFn",
		);
	});

	it("uses token auth type when t is present", () => {
		handleTokenInfo(buildReq({ t: "abcdef" }), buildRes());

		expect(mockSendSuccess).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				tokenInfo: expect.objectContaining({ authType: "token" }),
			}),
			"json",
			undefined,
		);
	});

	it("returns empty albumList2 for starred type without querying albums", async () => {
		await handleGetAlbumList2(
			buildReq({ type: "starred", size: "50", offset: "5" }),
			buildRes(),
		);

		expect(mockAlbumFindMany).not.toHaveBeenCalled();
		expect(mockSendSuccess).toHaveBeenCalledWith(
			expect.anything(),
			{ albumList2: { album: [] } },
			"json",
			undefined,
		);
	});

	it("sorts recent album list branch using lastPlayed timestamps", async () => {
		mockPlayGroupBy.mockResolvedValue([
			{
				trackId: "track-1",
				_count: { _all: 2 },
				_max: { playedAt: new Date("2026-03-01T00:00:00.000Z") },
			},
			{
				trackId: "track-2",
				_count: { _all: 8 },
				_max: { playedAt: new Date("2026-02-01T00:00:00.000Z") },
			},
		]);
		mockTrackFindMany.mockResolvedValueOnce([
			{ id: "track-1", albumId: "album-1" },
			{ id: "track-2", albumId: "album-2" },
		]);
		mockAlbumFindMany.mockResolvedValueOnce([
			{
				id: "album-1",
				title: "Recent One",
				year: 2026,
				coverUrl: null,
				genres: [],
				userGenres: [],
				artist: { id: "artist-1", name: "Artist One" },
				tracks: [{ duration: 10 }],
			},
			{
				id: "album-2",
				title: "Older Popular",
				year: 2025,
				coverUrl: null,
				genres: [],
				userGenres: [],
				artist: { id: "artist-2", name: "Artist Two" },
				tracks: [{ duration: 11 }],
			},
		]);

		await handleGetAlbumList2(
			buildReq({ type: "recent", size: "2", offset: "0" }),
			buildRes(),
		);

		const payload = mockSendSuccess.mock.calls[0][1] as {
			albumList2: { album: Array<{ id: string }> };
		};
		expect(payload.albumList2.album.map((a) => a.id)).toEqual([
			"al-album-1",
			"al-album-2",
		]);
	});

	it("skips deleteMany in updatePlaylist when remove indices are invalid", async () => {
		await handleUpdatePlaylist(
			buildReq({
				playlistId: "pl-playlist-1",
				songIndexToRemove: ["-1", "abc", "1.2"],
				name: "Rename Only",
			}),
			buildRes(),
		);

		expect(mockPlaylistUpdate).toHaveBeenCalled();
		expect(mockPlaylistItemDeleteMany).not.toHaveBeenCalled();
		expect(mockSendSuccess).toHaveBeenCalled();
	});

	it("skips scrobble writes when all submissions are false-like", async () => {
		mockTrackFindMany.mockResolvedValue([{ id: "track-1" }, { id: "track-2" }]);

		await handleScrobble(
			buildReq({
				id: ["tr-track-1", "tr-track-2"],
				submission: ["false", "0"],
				time: ["1700000000", "1700000100"],
			}),
			buildRes(),
		);

		expect(mockPlayCreateMany).not.toHaveBeenCalled();
		expect(mockSendSuccess).toHaveBeenCalledWith(
			expect.anything(),
			{},
			"json",
			undefined,
		);
	});

	it("uses current time when scrobble timestamp is invalid", async () => {
		mockTrackFindMany.mockResolvedValue([{ id: "track-1" }]);

		await handleScrobble(
			buildReq({
				id: ["tr-track-1"],
				time: ["-1"],
			}),
			buildRes(),
		);

		const arg = mockPlayCreateMany.mock.calls[0][0] as {
			data: Array<{ playedAt: Date }>;
		};
		expect(arg.data[0].playedAt).toBeInstanceOf(Date);
		expect(arg.data[0].playedAt.getTime()).toBeGreaterThan(Date.now() - 10_000);
	});

	it("returns nowPlaying with empty entries when tracks are missing", async () => {
		mockPlaybackStateFindMany.mockResolvedValue([
			{ trackId: "track-unknown", updatedAt: new Date(), deviceId: "web" },
			{ trackId: null, updatedAt: new Date(), deviceId: "mobile" },
		]);
		mockTrackFindMany.mockResolvedValue([]);

		await handleGetNowPlaying(buildReq({}), buildRes());

		expect(mockSendSuccess).toHaveBeenCalledWith(
			expect.anything(),
			{ nowPlaying: { entry: [] } },
			"json",
			undefined,
		);
	});

	it("returns not-found for cover art when playlist has no covered items", async () => {
		mockPlaylistFindFirst.mockResolvedValue({
			items: [{ track: { album: { coverUrl: null } } }],
		});

		await handleGetCoverArt(buildReq({ id: "pl-playlist-1" }), buildRes());

		expect(mockSendError).toHaveBeenCalledWith(
			expect.anything(),
			70,
			"Cover art not found",
			"json",
			undefined,
		);
	});

	it("streams using original quality branch when format requests raw", async () => {
		mockTrackFindFirst.mockResolvedValue({
			id: "track-1",
			filePath: "Artist/Album/song.flac",
			fileModified: new Date("2026-01-01T00:00:00.000Z"),
		});
		jest.spyOn(fs, "existsSync").mockReturnValue(true);
		mockGetStreamFilePath.mockResolvedValue({
			filePath: "/music/Artist/Album/song.flac",
			mimeType: "audio/flac",
		});

		const req = buildReq({ id: "tr-track-1", format: "raw" });
		const res = buildRes();
		await handleStream(req, res);

		expect(mockGetStreamFilePath).toHaveBeenCalledTimes(1);
		expect(mockGetStreamFilePath.mock.calls[0][1]).toBe("original");
		expect(mockStreamFileWithRangeSupport).toHaveBeenCalled();
		expect(mockDestroyStreamingService).toHaveBeenCalled();
	});

	it("does not send subsonic error when stream fails after headers sent", async () => {
		mockTrackFindFirst.mockResolvedValue({
			id: "track-1",
			filePath: "Artist/Album/song.mp3",
			fileModified: new Date("2026-01-01T00:00:00.000Z"),
		});
		jest.spyOn(fs, "existsSync").mockReturnValue(true);
		mockGetStreamFilePath.mockResolvedValue({
			filePath: "/music/Artist/Album/song.mp3",
			mimeType: "audio/mpeg",
		});
		mockStreamFileWithRangeSupport.mockImplementation(
			async (_req: Request, res: Response) => {
				(res as Response & { headersSent: boolean }).headersSent = true;
				throw new Error("socket closed");
			},
		);

		await handleStream(buildReq({ id: "tr-track-1" }), buildRes());

		expect(mockSendError).not.toHaveBeenCalled();
		expect(mockDestroyStreamingService).toHaveBeenCalled();
	});

	it("returns generic error for bookmark creation on invalid negative position", async () => {
		await handleCreateBookmark(
			buildReq({ id: "tr-track-1", position: "-5" }),
			buildRes(),
		);

		expect(mockSendError).toHaveBeenCalledWith(
			expect.anything(),
			0,
			"Invalid bookmark position",
			"json",
			undefined,
		);
		expect(mockBookmarkUpsert).not.toHaveBeenCalled();
	});

	it("returns generic error for bookmark creation on invalid non-numeric position", async () => {
		await handleCreateBookmark(
			buildReq({ id: "tr-track-1", position: "abc" }),
			buildRes(),
		);

		expect(mockSendError).toHaveBeenCalledWith(
			expect.anything(),
			0,
			"Invalid bookmark position",
			"json",
			undefined,
		);
		expect(mockBookmarkUpsert).not.toHaveBeenCalled();
	});

	it("covers missing-id and not-found branches for core entity handlers", async () => {
		await handleGetArtist(buildReq({}), buildRes());
		await handleGetAlbum(buildReq({}), buildRes());
		await handleGetMusicDirectory(buildReq({}), buildRes());
		await handleGetArtistInfo2(buildReq({}), buildRes());
		await handleGetAlbumInfo2(buildReq({}), buildRes());
		await handleGetTopSongs(buildReq({ artist: "   " }), buildRes());

		expect(mockSendError).toHaveBeenCalled();
	});

	it("returns not-found for getAlbum when parsed album does not exist", async () => {
		mockAlbumFindFirst.mockResolvedValue(null);

		await handleGetAlbum(buildReq({ id: "al-missing" }), buildRes());

		expect(mockSendError).toHaveBeenCalledWith(
			expect.anything(),
			70,
			"Album not found",
			"json",
			undefined,
		);
	});

	it("covers album-list random/newest/alphabetical/byGenre-invalid/catch branches", async () => {
		mockAlbumFindMany
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([]);
		mockPlayGroupBy.mockRejectedValueOnce(new Error("boom"));

		await handleGetAlbumList2(
			buildReq({ type: "random", size: "1", offset: "0" }),
			buildRes(),
		);
		await handleGetAlbumList2(buildReq({ type: "newest" }), buildRes());
		await handleGetAlbumList2(
			buildReq({ type: "alphabeticalByArtist" }),
			buildRes(),
		);
		await handleGetAlbumList2(
			buildReq({ type: "byGenre", genre: "   " }),
			buildRes(),
		);
		await handleGetAlbumList2(buildReq({ type: "highest" }), buildRes());

		expect(mockSendError).toHaveBeenCalledWith(
			expect.anything(),
			10,
			"Required parameter 'genre' is missing",
			"json",
			undefined,
		);
		expect(mockSendError).toHaveBeenCalledWith(
			expect.anything(),
			0,
			"Failed to fetch album list",
			"json",
			undefined,
		);
	});

	it("covers getIndexes/getGenres/getSongsByGenre/getRandomSongs generic error branches", async () => {
		mockArtistFindFirst.mockRejectedValueOnce(new Error("unused"));
		(prisma.artist.findMany as jest.Mock).mockRejectedValueOnce(
			new Error("idx down"),
		);
		await handleGetIndexes(buildReq({}), buildRes());

		mockGenreFindMany.mockRejectedValueOnce(new Error("genre down"));
		await handleGetGenres(buildReq({}), buildRes());

		mockTrackFindMany.mockRejectedValueOnce(new Error("songs by genre down"));
		await handleGetSongsByGenre(buildReq({ genre: "rock" }), buildRes());

		mockTrackFindMany.mockRejectedValueOnce(new Error("random songs down"));
		await handleGetRandomSongs(buildReq({ size: "10" }), buildRes());

		expect(mockSendError).toHaveBeenCalled();
	});

	it("covers bookmark load/delete failure branches", async () => {
		mockBookmarkFindMany.mockRejectedValueOnce(new Error("bookmark read fail"));
		await handleGetBookmarks(buildReq({}), buildRes());

		await handleDeleteBookmark(buildReq({}), buildRes());
		await handleDeleteBookmark(buildReq({ id: "al-not-track" }), buildRes());

		mockBookmarkDeleteMany.mockRejectedValueOnce(
			new Error("bookmark delete fail"),
		);
		await handleDeleteBookmark(buildReq({ id: "tr-track-1" }), buildRes());

		expect(mockSendError).toHaveBeenCalled();
	});

	it("covers bookmark create missing-id / malformed-id / persistence error branches", async () => {
		await handleCreateBookmark(buildReq({}), buildRes());
		await handleCreateBookmark(
			buildReq({ id: "al-not-track", position: "1000" }),
			buildRes(),
		);

		mockTrackFindUnique.mockResolvedValueOnce({ id: "track-1" });
		mockBookmarkUpsert.mockRejectedValueOnce(new Error("bookmark write fail"));
		await handleCreateBookmark(
			buildReq({ id: "tr-track-1", position: "1000" }),
			buildRes(),
		);

		expect(mockSendError).toHaveBeenCalled();
	});

	it("covers download and lyrics-by-song-id failure branches", async () => {
		await handleDownload(buildReq({}), buildRes());
		await handleDownload(buildReq({ id: "al-not-track" }), buildRes());

		mockTrackFindFirst.mockResolvedValueOnce({
			filePath: "Artist/Album/song.mp3",
		});
		jest.spyOn(fs, "existsSync").mockReturnValue(false);
		await handleDownload(buildReq({ id: "tr-track-1" }), buildRes());

		mockTrackFindFirst.mockRejectedValueOnce(new Error("download fail"));
		await handleDownload(buildReq({ id: "tr-track-1" }), buildRes());

		await handleGetLyricsBySongId(buildReq({}), buildRes());
		await handleGetLyricsBySongId(buildReq({ id: "al-not-track" }), buildRes());
		mockTrackFindFirst.mockResolvedValueOnce(null);
		await handleGetLyricsBySongId(buildReq({ id: "tr-track-1" }), buildRes());
		mockTrackFindFirst.mockRejectedValueOnce(new Error("lyrics fail"));
		await handleGetLyricsBySongId(buildReq({ id: "tr-track-1" }), buildRes());

		expect(mockSendError).toHaveBeenCalled();
	});

	it("covers setRating missing-rating and malformed-id branches", async () => {
		await handleSetRating(buildReq({ id: "tr-track-1" }), buildRes());
		await handleSetRating(
			buildReq({ id: "al-not-track", rating: "3" }),
			buildRes(),
		);

		expect(mockSendError).toHaveBeenCalled();
	});

	it("covers star/unstar invalid-id and not-found existence branches", async () => {
		await handleStar(buildReq({ id: ["ar-artist-1"] }), buildRes());
		await handleUnstar(buildReq({ albumId: ["ar-artist-1"] }), buildRes());

		mockTrackFindMany.mockResolvedValue([]);
		await handleUnstar(buildReq({ id: ["tr-track-1"] }), buildRes());

		mockTrackFindMany.mockResolvedValue([{ id: "track-1" }]);
		mockAlbumFindMany.mockResolvedValue([]);
		await handleUnstar(
			buildReq({ id: ["tr-track-1"], albumId: ["al-album-1"] }),
			buildRes(),
		);

		mockAlbumFindMany.mockResolvedValue([{ id: "album-1" }]);
		(prisma.artist.findMany as jest.Mock).mockResolvedValue([]);
		await handleUnstar(
			buildReq({ albumId: ["al-album-1"], artistId: ["ar-artist-1"] }),
			buildRes(),
		);

		expect(mockSendError).toHaveBeenCalled();
	});

	it("covers createPlaylist and updatePlaylist malformed song-id parsing branches", async () => {
		await handleCreatePlaylist(
			buildReq({ name: "Bad", songId: ["ar-artist-1"] }),
			buildRes(),
		);

		await handleUpdatePlaylist(
			buildReq({ playlistId: "pl-playlist-1", songIdToAdd: ["ar-artist-1"] }),
			buildRes(),
		);

		expect(mockSendError).toHaveBeenCalledWith(
			expect.anything(),
			70,
			"Song not found",
			"json",
			undefined,
		);
	});

	it("covers getSong fallback content-type and suffix branches", async () => {
		mockTrackFindFirst.mockResolvedValueOnce({
			id: "track-1",
			title: "Untyped",
			trackNo: 1,
			discNo: 1,
			duration: 10,
			fileSize: 100,
			mime: null,
			filePath: "no-extension",
			album: {
				id: "album-1",
				title: "A",
				year: null,
				coverUrl: null,
				genres: [123, " ", "rock"],
				userGenres: ["", "indie"],
				artist: { id: "artist-1", name: "Artist" },
			},
		});

		await handleGetSong(buildReq({ id: "tr-track-1" }), buildRes());

		expect(mockSendSuccess).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				song: expect.objectContaining({
					contentType: "audio/mpeg",
					genre: "indie",
				}),
			}),
			"json",
			undefined,
		);
	});

	it("covers lyrics line parsing skip branches for empty/invalid synced lines", async () => {
		mockTrackFindFirst.mockResolvedValueOnce({
			title: "Song",
			album: { artist: { name: "Artist" } },
		});
		mockGetLyrics.mockResolvedValueOnce({
			syncedLyrics: "\ninvalid\n[00:01.00] one",
			plainLyrics: null,
		});

		await handleGetLyricsBySongId(buildReq({ id: "tr-track-1" }), buildRes());

		expect(mockSendSuccess).toHaveBeenCalled();
	});

	it("covers similarSongs2 missing-id and malformed-id early returns", async () => {
		await handleGetSimilarSongs2(buildReq({}), buildRes());
		await handleGetSimilarSongs2(buildReq({ id: "ar-artist-1" }), buildRes());

		expect(mockSendError).toHaveBeenCalled();
	});

	it("covers cover-art resize failure fallback path", async () => {
		mockAlbumFindFirst.mockResolvedValueOnce({
			coverUrl: "https://cdn.soundspan.test/covers/bad-bytes.jpg",
		});
		(global.fetch as unknown as jest.Mock).mockResolvedValueOnce({
			ok: true,
			status: 200,
			arrayBuffer: jest.fn().mockResolvedValue(Buffer.from("not-an-image")),
			headers: { get: jest.fn().mockReturnValue("image/jpeg") },
		});

		const res = buildRes();
		await handleGetCoverArt(buildReq({ id: "al-album-1", size: "64" }), res);

		expect(res.status).toHaveBeenCalledWith(200);
	});

	it("covers stream malformed-id parseEntityId early return branch", async () => {
		await handleStream(buildReq({ id: "al-album-1" }), buildRes());
		expect(mockSendError).toHaveBeenCalled();
	});

	it("covers savePlayQueue parse nan current/position branches", async () => {
		mockTrackFindMany
			.mockResolvedValueOnce([{ id: "track-1" }])
			.mockResolvedValueOnce([
				{
					id: "track-1",
					title: "Song",
					duration: 1,
					album: {
						id: "album-1",
						title: "Album",
						coverUrl: null,
						genres: [],
						userGenres: [],
						artist: { id: "artist-1", name: "Artist" },
					},
				},
			]);

		await handleSavePlayQueue(
			buildReq({ id: ["tr-track-1"], current: "nan", position: "nan" }),
			buildRes(),
		);

		expect(prisma.playbackState.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({ currentIndex: 0, currentTime: 0 }),
			}),
		);
	});

	it("covers dedupe branches in star/unstar id parsing helpers", async () => {
		mockTrackFindMany
			.mockResolvedValueOnce([{ id: "track-1" }])
			.mockResolvedValueOnce([{ id: "track-1" }]);

		await handleStar(
			buildReq({ id: ["tr-track-1", "tr-track-1"] }),
			buildRes(),
		);
		await handleUnstar(
			buildReq({ id: ["tr-track-1", "tr-track-1"] }),
			buildRes(),
		);

		expect(mockSendSuccess).toHaveBeenCalled();
	});

	it("covers getStarred/getStarred2 catch branches", async () => {
		(prisma.likedTrack.findMany as jest.Mock).mockRejectedValueOnce(
			new Error("starred fail"),
		);
		await handleGetStarred(buildReq({}), buildRes());

		(prisma.likedTrack.findMany as jest.Mock).mockRejectedValueOnce(
			new Error("starred2 fail"),
		);
		await handleGetStarred2(buildReq({}), buildRes());

		expect(mockSendError).toHaveBeenCalledWith(
			expect.anything(),
			0,
			expect.stringMatching(/Failed to fetch starred tracks/),
			"json",
			undefined,
		);
	});
});
