const peerFindMany = jest.fn();
const peerFindFirst = jest.fn();
const trackFindMany = jest.fn();
const followUpsert = jest.fn();
const followDeleteMany = jest.fn();
const followFindMany = jest.fn();
const importPlaylist = jest.fn();
const createFederationClient = jest.fn();
const recordFetch = jest.fn();
const recordFollow = jest.fn();
const recordCopy = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: {
        federationPeer: {
            findMany: peerFindMany,
            findFirst: peerFindFirst,
        },
        track: { findMany: trackFindMany },
        federationPlaylistFollow: {
            upsert: followUpsert,
            deleteMany: followDeleteMany,
            findMany: followFindMany,
        },
    },
}));
jest.mock("../federationClient", () => ({
    ...jest.requireActual("../federationClient"),
    createFederationClient,
}));
jest.mock("../federationPeers", () => ({
    outboundClientOptions: jest.fn(() => ({ timeoutMs: 100 })),
}));
jest.mock("../playlistImportService", () => ({
    playlistImportService: { importPlaylist },
}));
jest.mock("../../metrics", () => ({
    recordFederationPlaylistFetch: recordFetch,
    recordFederationPlaylistFollow: recordFollow,
    recordFederationPlaylistCopy: recordCopy,
}));

import {
    browseFederationPeerPlaylists,
    copyFederationPeerPlaylist,
    followFederationPeerPlaylist,
    listFollowedFederationPeerPlaylists,
    resolveFederationPlaylistTracks,
    unfollowFederationPeerPlaylist,
} from "../federationPeerPlaylists";

const remoteTrack = (remoteTrackId: string) => ({
    remoteTrackId,
    title: `Title ${remoteTrackId}`,
    artist: "Artist",
    album: "Album",
    duration: 180,
});

const detail = {
    playlist: {
        remoteId: "remote-playlist",
        name: "Peer mix",
        owner: { displayName: "Alice" },
        updatedAt: "2026-08-22T12:00:00.000Z",
        tracks: [remoteTrack("remote-local"), remoteTrack("remote-peer")],
    },
};

const peer = {
    id: "peer-1",
    name: "Peer One",
    baseUrl: "https://peer.example",
    outboundToken: "encrypted",
};

const localTrackPayload = {
    id: "local-1",
    title: "Local Twin",
    duration: 181,
    trackNo: 1,
    loudnessLufs: null,
    truePeakDb: null,
    displayTitle: null,
    origin: "LOCAL",
    federationPeer: null,
    album: {
        id: "local-album-1",
        title: "Local Album",
        coverUrl: "native:albums/local-album-1.jpg",
        albumLoudnessLufs: null,
        albumTruePeakDb: null,
        artist: { id: "local-artist-1", name: "Local Artist", mbid: null },
    },
};

const federatedTrackPayload = {
    id: "federated-2",
    title: "Federated Track",
    duration: 182,
    trackNo: 2,
    loudnessLufs: -16.5,
    truePeakDb: -1.1,
    displayTitle: null,
    origin: "FEDERATED",
    federationPeer: {
        id: "peer-1",
        name: "Peer One",
        outboundStatus: "ACTIVE",
    },
    album: {
        id: "federated-album-1",
        title: "Federated Album",
        coverUrl: null,
        albumLoudnessLufs: -17,
        albumTruePeakDb: -0.9,
        artist: {
            id: "federated-artist-1",
            name: "Federated Artist",
            mbid: null,
        },
    },
};

describe("consumer federation peer playlists", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        peerFindFirst.mockResolvedValue(peer);
    });

    async function flushBoundedWork(): Promise<void> {
        for (let index = 0; index < 10; index += 1) {
            await Promise.resolve();
        }
    }

    it("resolves dedup-linked, materialized-only, and unknown remote tracks", async () => {
        trackFindMany
            .mockResolvedValueOnce([
                {
                    id: "federated-1",
                    remoteId: "remote-local",
                    dedupOfTrackId: "local-1",
                },
                {
                    id: "federated-2",
                    remoteId: "remote-peer",
                    dedupOfTrackId: null,
                },
            ])
            .mockResolvedValueOnce([localTrackPayload, federatedTrackPayload]);

        await expect(
            resolveFederationPlaylistTracks("peer-1", [
                remoteTrack("remote-local"),
                remoteTrack("remote-peer"),
                remoteTrack("missing"),
            ]),
        ).resolves.toEqual([
            expect.objectContaining({
                remoteTrackId: "remote-local",
                trackId: "local-1",
                resolution: "local",
                isResolvable: true,
                track: {
                    id: "local-1",
                    title: "Local Twin",
                    duration: 181,
                    trackNo: 1,
                    loudnessLufs: null,
                    truePeakDb: null,
                    artist: { id: "local-artist-1", name: "Local Artist" },
                    album: {
                        id: "local-album-1",
                        title: "Local Album",
                        coverArt: "native:albums/local-album-1.jpg",
                        albumLoudnessLufs: null,
                        albumTruePeakDb: null,
                        artist: {
                            id: "local-artist-1",
                            name: "Local Artist",
                        },
                    },
                    source: "local",
                    provider: {
                        tidalTrackId: null,
                        youtubeVideoId: null,
                    },
                    displayTitle: null,
                },
            }),
            expect.objectContaining({
                remoteTrackId: "remote-peer",
                trackId: "federated-2",
                resolution: "federated",
                isResolvable: true,
                track: {
                    id: "federated-2",
                    title: "Federated Track",
                    duration: 182,
                    trackNo: 2,
                    loudnessLufs: -16.5,
                    truePeakDb: -1.1,
                    artist: {
                        id: "federated-artist-1",
                        name: "Federated Artist",
                    },
                    album: {
                        id: "federated-album-1",
                        title: "Federated Album",
                        coverArt: null,
                        albumLoudnessLufs: -17,
                        albumTruePeakDb: -0.9,
                        artist: {
                            id: "federated-artist-1",
                            name: "Federated Artist",
                        },
                    },
                    source: "federated",
                    peer: { id: "peer-1", name: "Peer One", online: true },
                    provider: {
                        tidalTrackId: null,
                        youtubeVideoId: null,
                    },
                    streamSource: "peer",
                    displayTitle: null,
                },
            }),
            expect.objectContaining({
                remoteTrackId: "missing",
                trackId: null,
                resolution: "unresolvable",
                isResolvable: false,
                track: null,
                title: "Title missing",
                artist: "Artist",
                playback: expect.objectContaining({
                    isPlayable: false,
                    reason: "missing_provider_track",
                }),
            }),
        ]);
        expect(trackFindMany).toHaveBeenCalledTimes(2);
        expect(trackFindMany).toHaveBeenNthCalledWith(2, {
            where: {
                id: {
                    in: ["local-1", "federated-1", "federated-2"],
                },
                removedAt: null,
            },
            select: {
                id: true,
                title: true,
                duration: true,
                trackNo: true,
                loudnessLufs: true,
                truePeakDb: true,
                filePath: true,
                displayTitle: true,
                origin: true,
                federationPeer: {
                    select: { id: true, name: true, outboundStatus: true },
                },
                album: {
                    select: {
                        id: true,
                        title: true,
                        coverUrl: true,
                        albumLoudnessLufs: true,
                        albumTruePeakDb: true,
                        artist: {
                            select: { id: true, name: true, mbid: true },
                        },
                    },
                },
            },
        });
    });

    it("falls back to the federated payload when the local dedup target was removed", async () => {
        trackFindMany
            .mockResolvedValueOnce([
                {
                    id: "federated-2",
                    remoteId: "remote-peer",
                    dedupOfTrackId: "local-removed",
                },
            ])
            .mockResolvedValueOnce([federatedTrackPayload]);

        await expect(
            resolveFederationPlaylistTracks("peer-1", [
                remoteTrack("remote-peer"),
            ]),
        ).resolves.toEqual([
            expect.objectContaining({
                trackId: "federated-2",
                resolution: "federated",
                isResolvable: true,
                track: expect.objectContaining({
                    id: "federated-2",
                    source: "federated",
                }),
            }),
        ]);
        expect(trackFindMany).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                where: {
                    id: { in: ["local-removed", "federated-2"] },
                    removedAt: null,
                },
            }),
        );
    });

    it("marks a track unresolvable when both dedup and federated rows are gone", async () => {
        trackFindMany
            .mockResolvedValueOnce([
                {
                    id: "federated-2",
                    remoteId: "remote-peer",
                    dedupOfTrackId: "local-removed",
                },
            ])
            .mockResolvedValueOnce([]);

        await expect(
            resolveFederationPlaylistTracks("peer-1", [
                remoteTrack("remote-peer"),
            ]),
        ).resolves.toEqual([
            expect.objectContaining({
                trackId: null,
                resolution: "unresolvable",
                isResolvable: false,
                track: null,
            }),
        ]);
    });

    it("returns partial results and a timeout class while bounding fan-out at three", async () => {
        const releases: Array<() => void> = [];
        let active = 0;
        let maximum = 0;
        const clients = new Map<string, { getPlaylists: jest.Mock }>();
        for (let index = 1; index <= 4; index += 1) {
            const getPlaylists = jest.fn(
                () =>
                    new Promise((resolve, reject) => {
                        active += 1;
                        maximum = Math.max(maximum, active);
                        releases.push(() => {
                            active -= 1;
                            if (index === 2) {
                                const error = Object.assign(
                                    new Error("timed out"),
                                    { code: "ETIMEDOUT" },
                                );
                                reject(error);
                            } else {
                                resolve({ playlists: [], nextOffset: null });
                            }
                        });
                    }),
            );
            clients.set(`peer-${index}`, { getPlaylists });
        }
        peerFindMany.mockResolvedValueOnce(
            Array.from({ length: 4 }, (_, index) => ({
                ...peer,
                id: `peer-${index + 1}`,
                name: `Peer ${index + 1}`,
            })),
        );
        createFederationClient.mockImplementation((value: { id: string }) =>
            clients.get(value.id),
        );

        const browsing = browseFederationPeerPlaylists();
        await flushBoundedWork();
        expect(releases).toHaveLength(3);
        releases.shift()?.();
        await flushBoundedWork();
        expect(releases).toHaveLength(3);
        releases.splice(0).forEach((release) => release());

        const result = await browsing;
        expect(maximum).toBe(3);
        expect(peerFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    direction: { in: ["CONSUMER", "BOTH"] },
                    outboundStatus: "ACTIVE",
                    scopes: { has: "social:read" },
                }),
                take: 500,
            }),
        );
        expect(result.errors).toEqual([
            {
                peerId: "peer-2",
                peerName: "Peer 2",
                errorClass: "timeout",
            },
        ]);
        expect(recordFetch).toHaveBeenCalledWith("peer-2", "timeout");
    });

    it("follows idempotently through the unique user-peer-remote key", async () => {
        createFederationClient.mockReturnValue({
            getPlaylist: jest.fn().mockResolvedValue(detail),
        });
        followUpsert.mockResolvedValueOnce({ id: "follow-1" });

        await expect(
            followFederationPeerPlaylist("user-1", "peer-1", "remote-playlist"),
        ).resolves.toEqual({ followed: true, followId: "follow-1" });
        expect(followUpsert).toHaveBeenCalledWith({
            where: {
                userId_peerId_remoteId: {
                    userId: "user-1",
                    peerId: "peer-1",
                    remoteId: "remote-playlist",
                },
            },
            create: {
                userId: "user-1",
                peerId: "peer-1",
                remoteId: "remote-playlist",
                name: "Peer mix",
            },
            update: { name: "Peer mix" },
            select: { id: true },
        });

        followUpsert.mockResolvedValueOnce({ id: "follow-1" });
        await expect(
            followFederationPeerPlaylist("user-1", "peer-1", "remote-playlist"),
        ).resolves.toEqual({ followed: true, followId: "follow-1" });
        expect(followUpsert).toHaveBeenCalledTimes(2);
    });

    it("unfollows only the caller's matching row", async () => {
        followDeleteMany.mockResolvedValueOnce({ count: 1 });

        await expect(
            unfollowFederationPeerPlaylist(
                "user-1",
                "peer-1",
                "remote-playlist",
            ),
        ).resolves.toEqual({ followed: false });
        expect(followDeleteMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                peerId: "peer-1",
                remoteId: "remote-playlist",
            },
        });
    });

    it("surfaces an offline class for a followed playlist whose peer is inactive", async () => {
        followFindMany.mockResolvedValueOnce([
            {
                id: "follow-1",
                peerId: "peer-1",
                remoteId: "remote-playlist",
                name: "Name snapshot",
                createdAt: new Date("2026-08-22T12:00:00.000Z"),
                peer: {
                    ...peer,
                    outboundStatus: "OFFLINE",
                    scopes: ["social:read"],
                },
            },
        ]);

        await expect(
            listFollowedFederationPeerPlaylists("user-1"),
        ).resolves.toEqual({
            playlists: [
                expect.objectContaining({
                    id: "follow-1",
                    name: "Name snapshot",
                    playlist: null,
                    errorClass: "offline",
                }),
            ],
        });
        expect(createFederationClient).not.toHaveBeenCalled();
    });

    it("copies only resolvable tracks into a caller-owned normal playlist", async () => {
        createFederationClient.mockReturnValue({
            getPlaylist: jest.fn().mockResolvedValue(detail),
        });
        trackFindMany
            .mockResolvedValueOnce([
                {
                    id: "federated-1",
                    remoteId: "remote-local",
                    dedupOfTrackId: "local-1",
                },
            ])
            .mockResolvedValueOnce([localTrackPayload]);
        importPlaylist.mockResolvedValueOnce({ playlistId: "copy-1" });

        await expect(
            copyFederationPeerPlaylist("user-1", "peer-1", "remote-playlist"),
        ).resolves.toEqual({ playlistId: "copy-1", copied: 1, skipped: 1 });
        expect(importPlaylist).toHaveBeenCalledWith(
            "user-1",
            expect.objectContaining({
                playlistName: "Peer mix (from Peer One)",
                resolved: [expect.objectContaining({ trackId: "local-1" })],
            }),
        );
        expect(recordCopy).toHaveBeenCalledWith("peer-1", "success");
    });
});
