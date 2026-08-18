import fs from "fs";
import type { Request, Response } from "express";

const mockGetStreamFilePath = jest.fn();
const mockStreamFileWithRangeSupport = jest.fn();
const mockDestroyStreamingService = jest.fn();
const mockLookup = jest.fn();
const mockProxyFederatedTrackStream = jest.fn();
const mockProxyFederatedCover = jest.fn();
const mockSubsonicLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
mockSubsonicLogger.child.mockReturnValue(mockSubsonicLogger);
const mockAudioStreamingService = jest.fn().mockImplementation(() => ({
    getStreamFilePath: mockGetStreamFilePath,
    streamFileWithRangeSupport: mockStreamFileWithRangeSupport,
    destroy: mockDestroyStreamingService,
}));

jest.mock("dns/promises", () => ({
    lookup: (...args: unknown[]) => mockLookup(...args),
}));

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
        MISSING_PARAMETER: 10,
        NOT_FOUND: 70,
        GENERIC: 0,
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        track: {
            findFirst: jest.fn(),
        },
        album: {
            findFirst: jest.fn(),
        },
        artist: {
            findFirst: jest.fn(),
        },
        playlist: {
            findFirst: jest.fn(),
        },
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
    AudioStreamingService: mockAudioStreamingService,
}));

jest.mock("../../services/lyrics", () => ({
    getLyrics: jest.fn(),
}));
jest.mock("../../services/federationStreamProxy", () => ({
    proxyFederatedTrackStream: mockProxyFederatedTrackStream,
}));
jest.mock("../../services/federationCoverProxy", () => ({
    proxyFederatedCover: mockProxyFederatedCover,
}));
jest.mock("../../utils/logger", () => ({ logger: mockSubsonicLogger }));

jest.mock("../../config", () => ({
    config: {
        music: {
            musicPath: "/music",
            transcodeCachePath: "/var/soundspan/transcode",
            transcodeCacheMaxGb: 2,
        },
    },
}));

import { prisma } from "../../utils/db";
import {
    sendSubsonicError,
    sendSubsonicSuccess,
    SubsonicErrorCode,
} from "../../utils/subsonicResponse";
import { AudioStreamingService } from "../../services/audioStreaming";
import { handleGetCoverArt, handleStream } from "../subsonic";

function buildReq(query: Record<string, unknown>): Request {
    return {
        query,
        headers: {},
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
        end: jest.fn(),
        headersSent: false,
        writableEnded: false,
    };
    (res.status as jest.Mock).mockReturnValue(res);
    return res as Response;
}

const mockTrackFindFirst = prisma.track.findFirst as jest.Mock;
const mockAlbumFindFirst = prisma.album.findFirst as jest.Mock;
const mockArtistFindFirst = prisma.artist.findFirst as jest.Mock;
const mockPlaylistFindFirst = prisma.playlist.findFirst as jest.Mock;
const mockSendError = sendSubsonicError as jest.Mock;
const mockSendSuccess = sendSubsonicSuccess as jest.Mock;
const mockAudioServiceConstructor = AudioStreamingService as jest.Mock;

const mockFetch = jest.fn();
let originalFetch: typeof fetch | undefined;

beforeAll(() => {
    originalFetch = global.fetch;
    (global as unknown as { fetch: typeof fetch }).fetch =
        mockFetch as unknown as typeof fetch;
});

afterAll(() => {
    if (originalFetch) {
        global.fetch = originalFetch;
    } else {
        delete (global as unknown as { fetch?: typeof fetch }).fetch;
    }
});

beforeEach(() => {
    jest.clearAllMocks();
    mockGetStreamFilePath.mockReset();
    mockStreamFileWithRangeSupport.mockReset();
    mockDestroyStreamingService.mockReset();
    mockAudioServiceConstructor.mockClear();
    mockTrackFindFirst.mockReset();
    mockAlbumFindFirst.mockReset();
    mockArtistFindFirst.mockReset();
    mockPlaylistFindFirst.mockReset();
    mockFetch.mockReset();
    mockLookup.mockReset();
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    mockProxyFederatedTrackStream.mockResolvedValue(undefined);
    mockProxyFederatedCover.mockResolvedValue(true);
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe("handleStream", () => {
    it("proxies a federated Range request to its active peer", async () => {
        const track = {
            id: "federated-track",
            origin: "FEDERATED",
            remoteId: "remote-track",
            mime: "audio/flac",
            filePath: null,
            fileModified: new Date("2026-08-15T12:00:00Z"),
            federationPeer: {
                id: "peer-1",
                baseUrl: "https://peer.example",
                outboundToken: "v2:encrypted-token",
                outboundStatus: "ACTIVE",
            },
        };
        mockTrackFindFirst.mockResolvedValue(track);
        const req = buildReq({ id: "tr-federated-track" });
        req.headers.range = "bytes=10-20";
        const res = buildRes();

        await handleStream(req, res);

        expect(mockProxyFederatedTrackStream).toHaveBeenCalledWith({
            req,
            res,
            peer: track.federationPeer,
            remoteId: "remote-track",
            trackId: "federated-track",
            sourceModified: track.fileModified,
            sourceMime: "audio/flac",
            quality: "original",
        });
        expect(mockAudioServiceConstructor).not.toHaveBeenCalled();
    });

    it("logs a normalized warning when an active federated proxy fails", async () => {
        const failure = new Error("transient peer failure");
        mockTrackFindFirst.mockResolvedValue({
            id: "federated-track",
            origin: "FEDERATED",
            remoteId: "remote-track",
            mime: "audio/flac",
            filePath: null,
            fileModified: new Date("2026-08-15T12:00:00Z"),
            federationPeer: {
                id: "peer-1",
                baseUrl: "https://peer.example",
                outboundToken: "v2:encrypted-token",
                outboundStatus: "ACTIVE",
            },
        });
        mockProxyFederatedTrackStream.mockRejectedValueOnce(failure);

        await handleStream(buildReq({ id: "tr-federated-track" }), buildRes());

        expect(mockSubsonicLogger.warn).toHaveBeenCalledWith(
            "Federated stream proxy failed",
            { error: failure },
        );
        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            SubsonicErrorCode.GENERIC,
            "Federation peer is offline",
            "json",
            undefined,
        );
    });

    it("ends a failed federated stream after headers without writing an error body", async () => {
        mockTrackFindFirst.mockResolvedValue({
            id: "federated-track",
            origin: "FEDERATED",
            remoteId: "remote-track",
            mime: "audio/flac",
            filePath: null,
            fileModified: new Date("2026-08-15T12:00:00Z"),
            federationPeer: {
                id: "peer-1",
                baseUrl: "https://peer.example",
                outboundToken: "v2:encrypted-token",
                outboundStatus: "ACTIVE",
            },
        });
        mockProxyFederatedTrackStream.mockRejectedValueOnce(
            new Error("mid-stream failure"),
        );
        const res = buildRes();
        (res as Response & { headersSent: boolean }).headersSent = true;

        await handleStream(buildReq({ id: "tr-federated-track" }), res);

        expect(res.end).toHaveBeenCalledTimes(1);
        expect(mockSendError).not.toHaveBeenCalled();
        expect(mockSubsonicLogger.warn).toHaveBeenCalledTimes(1);
    });

    it("maps an offline federated peer to a Subsonic generic error", async () => {
        mockTrackFindFirst.mockResolvedValue({
            id: "federated-track",
            origin: "FEDERATED",
            remoteId: "remote-track",
            mime: "audio/flac",
            filePath: null,
            fileModified: new Date("2026-08-15T12:00:00Z"),
            federationPeer: {
                id: "peer-1",
                baseUrl: "https://peer.example",
                outboundToken: "v2:encrypted-token",
                outboundStatus: "OFFLINE",
            },
        });

        await handleStream(buildReq({ id: "tr-federated-track" }), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            SubsonicErrorCode.GENERIC,
            "Federation peer is offline",
            "json",
            undefined,
        );
        expect(mockProxyFederatedTrackStream).not.toHaveBeenCalled();
    });

    it("returns not found instead of streaming a removed library track", async () => {
        mockTrackFindFirst.mockImplementationOnce(
            async ({ where }: { where: { removedAt?: null } }) =>
                where.removedAt === null
                    ? null
                    : {
                          id: "removed-track",
                          filePath: "Artist/Removed.flac",
                          fileModified: new Date("2024-01-01T00:00:00Z"),
                      },
        );

        await handleStream(buildReq({ id: "tr-removed-track" }), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            SubsonicErrorCode.NOT_FOUND,
            "Song not found",
            "json",
            undefined,
        );
        expect(mockAudioServiceConstructor).not.toHaveBeenCalled();
    });

    it("returns not found for malformed stream ids", async () => {
        const res = buildRes();

        await handleStream(
            buildReq({
                id: "bad-id",
            }),
            res,
        );

        expect(mockTrackFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    id: "bad-id",
                    removedAt: null,
                    AND: expect.any(Array),
                    album: {
                        location: { in: ["LIBRARY", "FEDERATED"] },
                    },
                }),
            }),
        );
        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            SubsonicErrorCode.NOT_FOUND,
            "Song not found",
            "json",
            undefined,
        );
    });

    it("returns not found when the resolved file path is missing", async () => {
        mockTrackFindFirst.mockResolvedValue({
            id: "track-1",
            filePath: "Artist/Track.flac",
            fileModified: new Date("2024-01-01T00:00:00Z"),
        });
        const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);

        await handleStream(
            buildReq({
                id: "tr-track-1",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            SubsonicErrorCode.NOT_FOUND,
            "File not found",
            "json",
            undefined,
        );
        expect(mockAudioServiceConstructor).not.toHaveBeenCalled();
        existsSpy.mockRestore();
    });

    it("falls back to original quality when FFmpeg is not available", async () => {
        mockTrackFindFirst.mockResolvedValue({
            id: "track-1",
            filePath: "Artist/Track.flac",
            fileModified: new Date("2024-02-02T00:00:00Z"),
        });
        jest.spyOn(fs, "existsSync").mockReturnValue(true);
        mockGetStreamFilePath
            .mockRejectedValueOnce({ code: "FFMPEG_NOT_FOUND" })
            .mockResolvedValueOnce({
                filePath: "/music/Artist/Track.flac",
                mimeType: "audio/flac",
            });
        mockStreamFileWithRangeSupport.mockResolvedValue(undefined);

        const req = buildReq({
            id: "tr-track-1",
            maxBitRate: "128",
        });
        const res = buildRes();

        await handleStream(req, res);

        expect(mockGetStreamFilePath).toHaveBeenNthCalledWith(
            1,
            "track-1",
            "low",
            expect.any(Date),
            expect.stringContaining("/music"),
        );
        expect(mockGetStreamFilePath).toHaveBeenNthCalledWith(
            2,
            "track-1",
            "original",
            expect.any(Date),
            expect.stringContaining("/music"),
        );
        expect(mockStreamFileWithRangeSupport).toHaveBeenCalledWith(
            req,
            res,
            "/music/Artist/Track.flac",
            "audio/flac",
        );
        expect(mockDestroyStreamingService).toHaveBeenCalled();
        expect(mockSendError).not.toHaveBeenCalled();
    });

    it("returns missing-parameter when stream id is omitted", async () => {
        await handleStream(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'id' is missing",
            "json",
            undefined,
        );
    });

    it("returns generic error when stream quality resolution fails", async () => {
        mockTrackFindFirst.mockResolvedValue({
            id: "track-1",
            filePath: "Artist/Track.flac",
            fileModified: new Date("2024-03-03T00:00:00Z"),
        });
        jest.spyOn(fs, "existsSync").mockReturnValue(true);
        mockGetStreamFilePath.mockRejectedValue(new Error("transcode failure"));

        const req = buildReq({
            id: "tr-track-1",
            maxBitRate: "192",
        });
        const res = buildRes();

        await handleStream(req, res);

        expect(mockAudioServiceConstructor).toHaveBeenCalledTimes(1);
        expect(mockGetStreamFilePath).toHaveBeenCalledTimes(1);
        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            SubsonicErrorCode.GENERIC,
            "Failed to stream",
            "json",
            undefined,
        );
        expect(mockDestroyStreamingService).toHaveBeenCalled();
        expect(mockStreamFileWithRangeSupport).not.toHaveBeenCalled();
    });

    it("returns generic error when stream lookup fails", async () => {
        mockTrackFindFirst.mockRejectedValue(new Error("db down"));

        await handleStream(
            buildReq({
                id: "tr-track-1",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            SubsonicErrorCode.GENERIC,
            "Failed to stream",
            "json",
            undefined,
        );
        expect(mockStreamFileWithRangeSupport).not.toHaveBeenCalled();
    });
});

describe("handleGetCoverArt", () => {
    it("falls back to the owning peer for a federated album cover", async () => {
        const peer = {
            id: "peer-1",
            baseUrl: "https://peer.example",
            outboundToken: "v2:encrypted-token",
            outboundStatus: "ACTIVE",
        };
        mockAlbumFindFirst
            .mockResolvedValueOnce({ coverUrl: null })
            .mockResolvedValueOnce({
                remoteId: "remote-album",
                federationPeer: peer,
            });
        const req = buildReq({ id: "al-federated-album" });
        const res = buildRes();

        await handleGetCoverArt(req, res);

        expect(mockProxyFederatedCover).toHaveBeenCalledWith({
            req,
            res,
            peer,
            remoteId: "remote-album",
        });
        expect(mockSendError).not.toHaveBeenCalled();
    });

    it("returns early with subsonic error when cover id is missing", async () => {
        await handleGetCoverArt(buildReq({}), buildRes());

        expect(mockSendError).toHaveBeenCalled();
    });

    it("serves native cover art files and sets image headers", async () => {
        const nativeCoverPath = "/var/soundspan/covers/album/cover.png";
        mockAlbumFindFirst.mockResolvedValue({
            coverUrl: "native:album/cover.png",
        });
        jest.spyOn(fs, "existsSync").mockImplementation(
            (inputPath: fs.PathLike) => inputPath === nativeCoverPath,
        );
        jest.spyOn(fs, "readFileSync").mockReturnValue(
            Buffer.from("fake", "utf-8"),
        );

        const res = buildRes();

        await handleGetCoverArt(
            buildReq({
                id: "al-album-1",
            }),
            res,
        );

        expect(mockSendError).not.toHaveBeenCalled();
        expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
        expect(res.setHeader).toHaveBeenCalledWith(
            "Cache-Control",
            "public, max-age=86400",
        );
        expect(res.setHeader).toHaveBeenCalledWith("Accept-Ranges", "bytes");
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.send).toHaveBeenCalledWith(expect.any(Buffer));
    });

    it("serves native webp cover art with webp content type", async () => {
        const nativeCoverPath = "/var/soundspan/covers/album/cover.webp";
        mockAlbumFindFirst.mockResolvedValue({
            coverUrl: "native:album/cover.webp",
        });
        jest.spyOn(fs, "existsSync").mockImplementation(
            (inputPath: fs.PathLike) => inputPath === nativeCoverPath,
        );
        jest.spyOn(fs, "readFileSync").mockReturnValue(
            Buffer.from("fake-webp", "utf-8"),
        );

        const res = buildRes();

        await handleGetCoverArt(
            buildReq({
                id: "al-album-webp",
            }),
            res,
        );

        expect(res.setHeader).toHaveBeenCalledWith(
            "Content-Type",
            "image/webp",
        );
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it("returns not found when no cover art can be resolved", async () => {
        mockAlbumFindFirst.mockResolvedValue(null);

        await handleGetCoverArt(
            buildReq({
                id: "al-album-no-cover",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            SubsonicErrorCode.NOT_FOUND,
            "Cover art not found",
            "json",
            undefined,
        );
    });

    it("returns not found when remote cover art responds with 404", async () => {
        mockAlbumFindFirst.mockResolvedValue({
            coverUrl: "https://cdn.soundspan.test/covers/album.jpg",
        });
        mockFetch.mockResolvedValue({
            ok: false,
            status: 404,
            arrayBuffer: jest.fn(),
            headers: {
                get: jest.fn().mockReturnValue("image/jpeg"),
            },
        });

        await handleGetCoverArt(
            buildReq({
                id: "al-album-2",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            SubsonicErrorCode.NOT_FOUND,
            "Cover art not found",
            "json",
            undefined,
        );
    });

    it("rejects a cover host that resolves to a private address without fetching it", async () => {
        const coverUrl = "https://covers.attacker.test/metadata.jpg";
        mockAlbumFindFirst.mockResolvedValue({ coverUrl });
        mockLookup.mockResolvedValue([
            { address: "169.254.169.254", family: 4 },
        ]);

        await handleGetCoverArt(
            buildReq({ id: "al-private-dns-cover" }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            SubsonicErrorCode.NOT_FOUND,
            "Cover art not found",
            "json",
            undefined,
        );
        expect(mockFetch).not.toHaveBeenCalledWith(coverUrl, expect.anything());
    });

    it("does not follow a public cover redirect to a private address", async () => {
        const coverUrl = "https://covers.example.test/redirect.jpg";
        const privateUrl = "http://169.254.169.254/latest";
        mockAlbumFindFirst.mockResolvedValue({ coverUrl });
        mockFetch.mockResolvedValueOnce(
            new Response(null, {
                status: 302,
                headers: { location: privateUrl },
            }),
        );

        await handleGetCoverArt(
            buildReq({ id: "al-private-redirect-cover" }),
            buildRes(),
        );

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch).not.toHaveBeenCalledWith(
            privateUrl,
            expect.anything(),
        );
        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            SubsonicErrorCode.NOT_FOUND,
            "Cover art not found",
            "json",
            undefined,
        );
    });

    it("serves a public-resolving remote cover with its content type", async () => {
        const coverUrl = "https://covers.example.test/public.png";
        mockAlbumFindFirst.mockResolvedValue({ coverUrl });
        mockFetch.mockResolvedValueOnce(
            new Response("public-cover-bytes", {
                status: 200,
                headers: { "content-type": "image/png" },
            }),
        );
        const res = buildRes();

        await handleGetCoverArt(buildReq({ id: "al-public-cover" }), res);

        expect(mockLookup).toHaveBeenCalledWith("covers.example.test", {
            all: true,
        });
        expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
        expect(res.status).toHaveBeenCalledWith(200);
        expect(mockSendError).not.toHaveBeenCalled();
    });

    it("serves artist cover art through artist lookup", async () => {
        mockArtistFindFirst.mockResolvedValue({
            heroUrl: "https://cdn.soundspan.test/covers/artist.jpg",
        });
        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            arrayBuffer: jest
                .fn()
                .mockResolvedValue(Buffer.from("artist-cover")),
            headers: {
                get: jest.fn().mockReturnValue("image/jpeg"),
            },
        });
        const res = buildRes();

        await handleGetCoverArt(
            buildReq({
                id: "ar-artist-1",
            }),
            res,
        );

        expect(mockArtistFindFirst).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
        expect(mockSendError).not.toHaveBeenCalled();
    });

    it("serves cover art for track entities using the track album cover", async () => {
        mockTrackFindFirst.mockResolvedValue({
            album: {
                coverUrl: "https://cdn.soundspan.test/covers/track-album.jpg",
            },
        });
        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            arrayBuffer: jest
                .fn()
                .mockResolvedValue(Buffer.from("track-cover")),
            headers: {
                get: jest.fn().mockReturnValue("image/jpeg"),
            },
        });
        const res = buildRes();

        await handleGetCoverArt(
            buildReq({
                id: "tr-track-1",
            }),
            res,
        );

        expect(mockTrackFindFirst).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
        expect(mockSendError).not.toHaveBeenCalled();
    });

    it("serves playlist cover art from the first playlist item with a cover", async () => {
        mockPlaylistFindFirst.mockResolvedValue({
            items: [
                {
                    track: {
                        album: {
                            coverUrl: null,
                        },
                    },
                },
                {
                    track: {
                        album: {
                            coverUrl:
                                "https://cdn.soundspan.test/covers/playlist.jpg",
                        },
                    },
                },
            ],
        });
        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            arrayBuffer: jest
                .fn()
                .mockResolvedValue(Buffer.from("playlist-cover")),
            headers: {
                get: jest.fn().mockReturnValue("image/jpeg"),
            },
        });
        const res = buildRes();

        await handleGetCoverArt(
            buildReq({
                id: "pl-playlist-1",
            }),
            res,
        );

        expect(mockPlaylistFindFirst).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
        expect(mockSendError).not.toHaveBeenCalled();
    });

    it("falls back to generic entity lookup when id parsing fails", async () => {
        mockAlbumFindFirst.mockResolvedValue(null);
        mockArtistFindFirst.mockResolvedValue({
            heroUrl: "https://cdn.soundspan.test/covers/fallback-artist.jpg",
        });
        mockTrackFindFirst.mockResolvedValue(null);
        mockPlaylistFindFirst.mockResolvedValue(null);
        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            arrayBuffer: jest
                .fn()
                .mockResolvedValue(Buffer.from("fallback-cover")),
            headers: {
                get: jest.fn().mockReturnValue("image/jpeg"),
            },
        });
        const res = buildRes();

        await handleGetCoverArt(
            buildReq({
                id: " loose-entity-id ",
            }),
            res,
        );

        expect(mockAlbumFindFirst).toHaveBeenCalled();
        expect(mockArtistFindFirst).toHaveBeenCalled();
        expect(mockTrackFindFirst).toHaveBeenCalled();
        expect(mockPlaylistFindFirst).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it("returns not found when native cover path does not exist", async () => {
        mockAlbumFindFirst.mockResolvedValue({
            coverUrl: "native:album/missing.png",
        });
        jest.spyOn(fs, "existsSync").mockReturnValue(false);

        await handleGetCoverArt(
            buildReq({
                id: "al-album-missing",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            SubsonicErrorCode.NOT_FOUND,
            "Cover art not found",
            "json",
            undefined,
        );
    });

    it("returns not found when cover url is not public", async () => {
        mockAlbumFindFirst.mockResolvedValue({
            coverUrl: "file:///etc/passwd",
        });

        await handleGetCoverArt(
            buildReq({
                id: "al-album-private",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            SubsonicErrorCode.NOT_FOUND,
            "Cover art not found",
            "json",
            undefined,
        );
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each([
        "http://169.254.169.254/x",
        "http://127.0.0.2/x",
        "http://[fe80::1]/x",
    ])(
        "rejects blocked literal cover URL %s without fetching",
        async (coverUrl) => {
            mockAlbumFindFirst.mockResolvedValue({ coverUrl });

            await handleGetCoverArt(
                buildReq({ id: "al-blocked-literal-cover" }),
                buildRes(),
            );

            expect(mockSendError).toHaveBeenCalledWith(
                expect.anything(),
                SubsonicErrorCode.NOT_FOUND,
                "Cover art not found",
                "json",
                undefined,
            );
            expect(mockFetch).not.toHaveBeenCalled();
        },
    );

    it("returns generic error when remote cover art fetch fails with non-404", async () => {
        mockAlbumFindFirst.mockResolvedValue({
            coverUrl: "https://cdn.soundspan.test/covers/error.jpg",
        });
        mockFetch.mockResolvedValue({
            ok: false,
            status: 500,
            arrayBuffer: jest.fn(),
            headers: {
                get: jest.fn().mockReturnValue("image/jpeg"),
            },
        });

        await handleGetCoverArt(
            buildReq({
                id: "al-album-error",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            SubsonicErrorCode.GENERIC,
            "Failed to fetch cover art",
            "json",
            undefined,
        );
    });

    it("returns not found when native cover URL escapes configured cover root", async () => {
        mockAlbumFindFirst.mockResolvedValue({
            coverUrl: "native:../../outside/cover.png",
        });

        await handleGetCoverArt(
            buildReq({
                id: "al-album-escape",
            }),
            buildRes(),
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            SubsonicErrorCode.NOT_FOUND,
            "Cover art not found",
            "json",
            undefined,
        );
    });
});
