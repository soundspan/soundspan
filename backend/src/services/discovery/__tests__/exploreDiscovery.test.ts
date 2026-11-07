jest.mock("../../../utils/db", () => ({
    prisma: {
        play: { findMany: jest.fn() },
        likedTrack: { findMany: jest.fn() },
        likedRemoteTrack: { findMany: jest.fn() },
        artist: { findMany: jest.fn() },
        ownedAlbum: { findMany: jest.fn() },
        track: { findMany: jest.fn() },
    },
}));

jest.mock("../../../utils/redis", () => ({
    redisClient: { get: jest.fn(), setEx: jest.fn() },
}));

jest.mock("../../../utils/logger", () => {
    const scoped = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    };
    return { logger: { ...scoped, child: () => scoped } };
});

jest.mock("../../lastfm", () => ({
    lastFmService: {
        getSimilarArtists: jest.fn(),
        getTopChartTracks: jest.fn(),
        getTopChartTags: jest.fn(),
        getTopArtistsByTag: jest.fn(),
        resolveArtistImage: jest.fn(),
        getBestImage: jest.fn(),
    },
}));

jest.mock("../../musicbrainz", () => ({
    musicBrainzService: {
        searchRecentReleaseGroupsByArtists: jest.fn(),
    },
}));

import { prisma } from "../../../utils/db";
import { redisClient } from "../../../utils/redis";
import { lastFmService } from "../../lastfm";
import { musicBrainzService } from "../../musicbrainz";
import {
    aggregateTasteSeeds,
    getExploreDiscovery,
    pickSeedTags,
} from "../exploreDiscovery";

const mocks = {
    plays: prisma.play.findMany as jest.Mock,
    likes: prisma.likedTrack.findMany as jest.Mock,
    remoteLikes: prisma.likedRemoteTrack.findMany as jest.Mock,
    artists: prisma.artist.findMany as jest.Mock,
    ownedAlbums: prisma.ownedAlbum.findMany as jest.Mock,
    tracks: prisma.track.findMany as jest.Mock,
    redisGet: redisClient.get as jest.Mock,
    redisSetEx: redisClient.setEx as jest.Mock,
    similar: lastFmService.getSimilarArtists as jest.Mock,
    chartTracks: lastFmService.getTopChartTracks as jest.Mock,
    chartTags: lastFmService.getTopChartTags as jest.Mock,
    tagArtists: lastFmService.getTopArtistsByTag as jest.Mock,
    image: lastFmService.resolveArtistImage as jest.Mock,
    bestImage: lastFmService.getBestImage as jest.Mock,
    releases:
        musicBrainzService.searchRecentReleaseGroupsByArtists as jest.Mock,
};

const RADIOHEAD_MBID = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const PORTISHEAD_MBID = "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11";
const NEW_RG_MBID = "6b9a9e04-abd7-4666-86ba-bb220ef4c3b2";
const OWNED_RG_MBID = "189002e7-3285-4e2e-92a3-7f6c30d407a2";
const NOW = new Date("2026-11-05T12:00:00Z");

function libraryArtist(name: string, mbid: string, genres: string[]) {
    return { name, mbid, genres, userGenres: null };
}

function playOf(artist: ReturnType<typeof libraryArtist>) {
    return {
        track: { album: { artist } },
        trackTidal: null,
        trackYtMusic: null,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSetEx.mockResolvedValue("OK");
    mocks.plays.mockResolvedValue([]);
    mocks.likes.mockResolvedValue([]);
    mocks.remoteLikes.mockResolvedValue([]);
    mocks.artists.mockResolvedValue([]);
    mocks.ownedAlbums.mockResolvedValue([]);
    mocks.tracks.mockResolvedValue([]);
    mocks.similar.mockResolvedValue([]);
    mocks.chartTracks.mockResolvedValue([]);
    mocks.chartTags.mockResolvedValue([]);
    mocks.tagArtists.mockResolvedValue([]);
    mocks.image.mockImplementation(async (name: string) => `img:${name}`);
    mocks.bestImage.mockReturnValue(null);
    mocks.releases.mockResolvedValue([]);
});

describe("aggregateTasteSeeds", () => {
    it("merges plays and likes per artist and ranks by weight", () => {
        const seeds = aggregateTasteSeeds([
            { name: "Radiohead", mbid: RADIOHEAD_MBID, weight: 1 },
            { name: "Portishead", weight: 1 },
            { name: "radiohead", weight: 1, genres: ["Alternative"] },
            { name: "Portishead feat. Someone", mbid: "temp-1", weight: 3 },
            { name: "  ", weight: 5 },
        ]);

        expect(seeds.map((seed) => [seed.name, seed.weight])).toEqual([
            ["Portishead", 4],
            ["Radiohead", 2],
        ]);
        expect(seeds[1]).toMatchObject({
            mbid: RADIOHEAD_MBID,
            genres: ["alternative"],
        });
        expect(seeds[0].mbid).toBeUndefined();
    });
});

describe("pickSeedTags", () => {
    it("weights earlier genres of heavier seeds higher", () => {
        expect(
            pickSeedTags(
                [
                    {
                        key: "a",
                        name: "A",
                        genres: ["rock", "indie"],
                        weight: 4,
                    },
                    {
                        key: "b",
                        name: "B",
                        genres: ["trip-hop", "rock"],
                        weight: 1,
                    },
                ],
                2,
            ),
        ).toEqual(["rock", "indie"]);
    });
});

describe("getExploreDiscovery", () => {
    it("serves a cached payload without touching providers", async () => {
        const cached = {
            personalized: true,
            similarArtists: [],
            newReleases: [],
            trendingTracks: [],
            tagShelves: [],
        };
        mocks.redisGet.mockResolvedValueOnce(JSON.stringify(cached));

        await expect(getExploreDiscovery("user-1", NOW)).resolves.toEqual(
            cached,
        );
        expect(mocks.plays).not.toHaveBeenCalled();
        expect(mocks.chartTracks).not.toHaveBeenCalled();
    });

    it("builds personalized shelves that exclude library content", async () => {
        const radiohead = libraryArtist("Radiohead", RADIOHEAD_MBID, [
            "alternative rock",
        ]);
        mocks.plays.mockResolvedValue([playOf(radiohead), playOf(radiohead)]);
        mocks.remoteLikes.mockResolvedValue([
            {
                trackTidal: { artist: "Portishead", artistEntity: null },
                trackYtMusic: null,
            },
        ]);
        mocks.artists.mockResolvedValue([
            { name: "Radiohead", mbid: RADIOHEAD_MBID },
            { name: "Muse", mbid: "temp-muse" },
        ]);
        mocks.similar.mockImplementation(async (_mbid: string, name: string) =>
            name === "Radiohead"
                ? [
                      { name: "Muse", match: 0.9 },
                      { name: "Thom Yorke", mbid: PORTISHEAD_MBID, match: 0.8 },
                      { name: "Portishead", match: 0.5 },
                  ]
                : [
                      { name: "Massive Attack", match: 1 },
                      { name: "Thom Yorke", match: 0.1 },
                  ],
        );
        mocks.releases.mockResolvedValue([
            {
                id: NEW_RG_MBID,
                title: "Fresh LP",
                "primary-type": "Album",
                "first-release-date": "2026-10-01",
                "artist-credit": [
                    { name: "Radiohead", artist: { id: RADIOHEAD_MBID } },
                ],
            },
            {
                id: OWNED_RG_MBID,
                title: "Owned EP",
                "first-release-date": "2026-10-20",
            },
            {
                id: "11111111-2222-3333-4444-555555555555",
                title: "Live Set",
                "secondary-types": ["Live"],
                "first-release-date": "2026-10-25",
            },
        ]);
        mocks.ownedAlbums.mockResolvedValue([{ rgMbid: OWNED_RG_MBID }]);
        mocks.chartTracks.mockResolvedValue([
            { name: "Hit", artist: { name: "Pop Star" }, listeners: "99" },
            { name: "Creep", artist: { name: "Radiohead" } },
        ]);
        mocks.tracks.mockResolvedValue([
            { title: "creep", album: { artist: { name: "Radiohead" } } },
        ]);
        mocks.tagArtists.mockResolvedValue([
            { name: "Radiohead" },
            { name: "Muse" },
            { name: "Elbow", image: [] },
        ]);

        const result = await getExploreDiscovery("user-1", NOW);

        expect(result.personalized).toBe(true);
        // The liked Portishead (weight 3) outranks two Radiohead plays.
        expect(result.similarArtists).toEqual([
            {
                name: "Massive Attack",
                because: "Portishead",
                image: "img:Massive Attack",
            },
            {
                name: "Thom Yorke",
                mbid: PORTISHEAD_MBID,
                because: "Radiohead",
                image: "img:Thom Yorke",
            },
        ]);
        expect(mocks.releases).toHaveBeenCalledWith(
            [RADIOHEAD_MBID],
            "2026-08-07",
            "2026-11-05",
            50,
        );
        expect(result.newReleases).toEqual([
            {
                rgMbid: NEW_RG_MBID,
                title: "Fresh LP",
                artistName: "Radiohead",
                artistMbid: RADIOHEAD_MBID,
                releaseDate: "2026-10-01",
                primaryType: "Album",
                coverUrl: `https://coverartarchive.org/release-group/${NEW_RG_MBID}/front-250`,
            },
        ]);
        expect(result.trendingTracks).toEqual([
            {
                type: "track",
                id: "lastfm:Pop Star:Hit",
                name: "Hit",
                artist: "Pop Star",
                image: undefined,
                listeners: 99,
            },
        ]);
        expect(mocks.tagArtists).toHaveBeenCalledWith("alternative rock", 40);
        expect(mocks.chartTags).not.toHaveBeenCalled();
        expect(result.tagShelves).toEqual([
            {
                tag: "alternative rock",
                artists: [{ name: "Elbow", image: "img:Elbow" }],
            },
        ]);
        expect(mocks.redisSetEx).toHaveBeenCalledWith(
            "explore:discovery:v1:user-1",
            1800,
            JSON.stringify(result),
        );
    });

    it("falls back to global popular content for a user without history", async () => {
        mocks.chartTags.mockResolvedValue([{ name: "Pop" }, { name: "Rock" }]);
        mocks.tagArtists.mockImplementation(async (tag: string) =>
            tag === "pop"
                ? [{ name: "Star" }]
                : [{ name: "Star" }, { name: "Band" }],
        );

        const result = await getExploreDiscovery("new-user", NOW);

        expect(result.personalized).toBe(false);
        expect(result.similarArtists).toEqual([]);
        expect(result.newReleases).toEqual([]);
        expect(mocks.similar).not.toHaveBeenCalled();
        expect(mocks.releases).not.toHaveBeenCalled();
        expect(result.tagShelves).toEqual([
            { tag: "pop", artists: [{ name: "Star", image: "img:Star" }] },
            { tag: "rock", artists: [{ name: "Band", image: "img:Band" }] },
        ]);
    });

    it("degrades a failing shelf to empty without failing the others", async () => {
        mocks.redisGet.mockRejectedValueOnce(new Error("redis down"));
        mocks.chartTracks.mockRejectedValue(new Error("lastfm down"));
        mocks.chartTags.mockResolvedValue([{ name: "jazz" }]);
        mocks.tagArtists.mockResolvedValue([{ name: "Quartet" }]);

        const result = await getExploreDiscovery("user-2", NOW);

        expect(result.trendingTracks).toEqual([]);
        expect(result.tagShelves).toHaveLength(1);
    });
});
