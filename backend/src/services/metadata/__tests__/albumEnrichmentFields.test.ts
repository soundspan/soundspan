const log = {
    debug: jest.fn(),
    error: jest.fn(),
};

jest.mock("../../../utils/logger", () => ({
    logger: { child: jest.fn(() => log) },
}));

const prisma = {
    album: {
        findUnique: jest.fn(),
        update: jest.fn(),
    },
};

jest.mock("../../../utils/db", () => ({ prisma }));

const musicBrainzService = {
    getReleaseGroups: jest.fn(),
    getReleaseGroup: jest.fn(),
    getRelease: jest.fn(),
};

jest.mock("../../musicbrainz", () => ({ musicBrainzService }));

const lastFmService = {
    getAlbumInfo: jest.fn(),
};

jest.mock("../../lastfm", () => ({ lastFmService }));

const resolveAlbumCover = jest.fn();

jest.mock("../albumCoverResolver", () => ({ resolveAlbumCover }));

const downloadAndStoreImage = jest.fn();
const isNativePath = jest.fn();

jest.mock("../../imageStorage", () => ({
    downloadAndStoreImage,
    isNativePath,
}));

import {
    applyAlbumEnrichmentFields,
    enrichAlbumFields,
    resolveAlbumEnrichmentFields,
} from "../albumEnrichmentFields";

const ARTIST_MBID = "11111111-1111-4111-8111-111111111111";
const RELEASE_GROUP_MBID = "22222222-2222-4222-8222-222222222222";
const RELEASE_MBID = "33333333-3333-4333-8333-333333333333";

describe("album enrichment fields", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.album.findUnique.mockResolvedValue(null);
        prisma.album.update.mockResolvedValue({});
        musicBrainzService.getReleaseGroups.mockResolvedValue([]);
        musicBrainzService.getReleaseGroup.mockResolvedValue(null);
        musicBrainzService.getRelease.mockResolvedValue(null);
        lastFmService.getAlbumInfo.mockResolvedValue(null);
        resolveAlbumCover.mockResolvedValue(null);
        downloadAndStoreImage.mockResolvedValue(null);
        isNativePath.mockReturnValue(false);
    });

    it("resolves a missing release-group MBID, year, label, and five Last.fm genres", async () => {
        musicBrainzService.getReleaseGroups.mockResolvedValueOnce([
            {
                id: RELEASE_GROUP_MBID,
                title: "Album One!",
                "primary-type": "Album",
                "first-release-date": "2001-02-03",
            },
        ]);
        musicBrainzService.getReleaseGroup.mockResolvedValueOnce({
            releases: [{ id: RELEASE_MBID }],
        });
        musicBrainzService.getRelease.mockResolvedValueOnce({
            "label-info": [{ label: { name: "Label One" } }],
        });
        lastFmService.getAlbumInfo.mockResolvedValueOnce({
            tags: {
                tag: [
                    { name: "one" },
                    { name: "two" },
                    { name: "three" },
                    { name: "four" },
                    { name: "five" },
                    { name: "six" },
                ],
            },
            tracks: { track: [{}, {}] },
        });
        resolveAlbumCover.mockResolvedValueOnce({
            url: "https://images.example/album.jpg",
            source: "coverartarchive",
        });

        const result = await resolveAlbumEnrichmentFields({
            id: "album-1",
            title: "Album One",
            rgMbid: null,
            artist: { name: "Artist One", mbid: ARTIST_MBID },
        });

        expect(result).toEqual({
            rgMbid: RELEASE_GROUP_MBID,
            albumType: "Album",
            releaseDate: new Date("2001-02-03"),
            label: "Label One",
            tags: ["one", "two", "three", "four", "five", "six"],
            genres: ["one", "two", "three", "four", "five"],
            trackCount: 2,
            coverUrl: "https://images.example/album.jpg",
            confidence: 1,
        });
    });

    it("extracts the first release date and label for an existing MusicBrainz release group", async () => {
        musicBrainzService.getReleaseGroup.mockResolvedValueOnce({
            "first-release-date": "1994-09-19",
            releases: [{ id: RELEASE_MBID }],
        });
        musicBrainzService.getRelease.mockResolvedValueOnce({
            "label-info": [{ label: { name: "Existing Label" } }],
        });

        const result = await resolveAlbumEnrichmentFields({
            id: "album-2",
            title: "Existing Album",
            rgMbid: RELEASE_GROUP_MBID,
            artist: { name: "Artist Two", mbid: ARTIST_MBID },
        });

        expect(musicBrainzService.getReleaseGroups).not.toHaveBeenCalled();
        expect(result.releaseDate).toEqual(new Date("1994-09-19"));
        expect(result.label).toBe("Existing Label");
    });

    it("does not send remote or federation identifiers to MusicBrainz", async () => {
        for (const rgMbid of ["remote:album-1", "federation:peer:album-1"]) {
            await resolveAlbumEnrichmentFields({
                id: rgMbid,
                title: "Remote Album",
                rgMbid,
                artist: { name: "Remote Artist", mbid: ARTIST_MBID },
            });
        }

        expect(musicBrainzService.getReleaseGroups).not.toHaveBeenCalled();
        expect(musicBrainzService.getReleaseGroup).not.toHaveBeenCalled();
        expect(musicBrainzService.getRelease).not.toHaveBeenCalled();
    });

    it("tolerates missing and failing providers", async () => {
        musicBrainzService.getReleaseGroups.mockRejectedValueOnce(
            new Error("musicbrainz unavailable"),
        );
        lastFmService.getAlbumInfo.mockRejectedValueOnce(
            new Error("lastfm unavailable"),
        );
        resolveAlbumCover.mockRejectedValueOnce(
            new Error("covers unavailable"),
        );

        await expect(
            resolveAlbumEnrichmentFields({
                id: "album-3",
                title: "Album Three",
                rgMbid: null,
                artist: { name: "Artist Three", mbid: ARTIST_MBID },
            }),
        ).resolves.toEqual({ confidence: 0 });
    });

    it("loads admin enrichment and applies year, label, genres, and localized cover", async () => {
        prisma.album.findUnique.mockResolvedValueOnce({
            id: "album-4",
            title: "Album Four",
            rgMbid: RELEASE_GROUP_MBID,
            artist: { name: "Artist Four", mbid: ARTIST_MBID },
        });
        musicBrainzService.getReleaseGroup.mockResolvedValueOnce({
            "first-release-date": "1988-04-05",
            releases: [{ id: RELEASE_MBID }],
        });
        musicBrainzService.getRelease.mockResolvedValueOnce({
            "label-info": [{ label: { name: "Label Four" } }],
        });
        lastFmService.getAlbumInfo.mockResolvedValueOnce({
            tags: { tag: [{ name: "jazz" }] },
        });
        resolveAlbumCover.mockResolvedValueOnce({
            url: "https://images.example/four.jpg",
            source: "deezer",
        });
        downloadAndStoreImage.mockResolvedValueOnce("/images/album-4.jpg");

        const data = await enrichAlbumFields("album-4");
        await applyAlbumEnrichmentFields("album-4", data);

        expect(prisma.album.update).toHaveBeenCalledWith({
            where: { id: "album-4" },
            data: {
                coverUrl: "/images/album-4.jpg",
                originalYear: 1988,
                year: 1988,
                label: "Label Four",
                genres: ["jazz"],
            },
        });
    });

    it("persists a year-only MusicBrainz date without local-time rollover", async () => {
        await applyAlbumEnrichmentFields("album-year", {
            releaseDate: new Date("2001"),
            confidence: 0.5,
        });

        expect(prisma.album.update).toHaveBeenCalledWith({
            where: { id: "album-year" },
            data: { originalYear: 2001, year: 2001 },
        });
    });
});
