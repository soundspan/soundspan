import {
    awaitArtistCatalog,
    type LidarrCatalogClock,
} from "../lidarrArtistCatalog";
import { selectAlbumInCatalog } from "../lidarrAlbumSelection";

class FakeCatalogClock implements LidarrCatalogClock {
    readonly delays: number[] = [];
    private pending: Array<() => void> = [];

    sleep(delayMs: number): Promise<void> {
        this.delays.push(delayMs);
        return new Promise((resolve) => this.pending.push(resolve));
    }

    async advance(): Promise<void> {
        const resolve = this.pending.shift();
        if (!resolve) throw new Error("No catalog delay is pending");
        resolve();
        await Promise.resolve();
        await Promise.resolve();
    }
}

const artist = {
    id: 17,
    artistName: "Björk",
    foreignArtistId: "artist-mbid",
    monitored: true,
};

const album = {
    id: 23,
    title: "Debut",
    foreignAlbumId: "album-mbid",
    artistId: artist.id,
    monitored: false,
};

describe("awaitArtistCatalog", () => {
    it("polls a newly added artist on the injected clock", async () => {
        const clock = new FakeCatalogClock();
        const client = {
            get: jest
                .fn()
                .mockResolvedValueOnce({ data: [] })
                .mockResolvedValueOnce({ data: [] })
                .mockResolvedValueOnce({ data: [album] }),
            post: jest.fn(),
        };

        const resultPromise = awaitArtistCatalog({
            client,
            artist,
            justAddedArtist: true,
            clock,
        });
        await Promise.resolve();

        expect(clock.delays).toEqual([3_000]);
        await clock.advance();
        expect(clock.delays).toEqual([3_000, 3_000]);
        await clock.advance();

        await expect(resultPromise).resolves.toEqual([album]);
        expect(client.get).toHaveBeenCalledTimes(3);
    });

    it("stops after twenty bounded polls when the catalog stays empty", async () => {
        const clock = new FakeCatalogClock();
        const client = {
            get: jest.fn().mockResolvedValue({ data: [] }),
            post: jest.fn(),
        };

        const resultPromise = awaitArtistCatalog({
            client,
            artist,
            justAddedArtist: true,
            clock,
        });
        await Promise.resolve();

        for (let attempt = 0; attempt < 20; attempt += 1) {
            await clock.advance();
        }

        await expect(resultPromise).resolves.toEqual([]);
        expect(clock.delays).toEqual(Array(20).fill(3_000));
        expect(client.get).toHaveBeenCalledTimes(21);
    });

    it("refreshes an existing empty catalog on the injected clock", async () => {
        const clock = new FakeCatalogClock();
        const client = {
            get: jest
                .fn()
                .mockResolvedValueOnce({ data: [] })
                .mockResolvedValueOnce({ data: [album] }),
            post: jest.fn().mockResolvedValue({ data: { id: 9 } }),
        };

        const resultPromise = awaitArtistCatalog({
            client,
            artist,
            justAddedArtist: false,
            clock,
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(client.post).toHaveBeenCalledWith("/api/v1/command", {
            name: "RefreshArtist",
            artistId: artist.id,
        });
        expect(clock.delays).toEqual([5_000]);
        await clock.advance();

        await expect(resultPromise).resolves.toEqual([album]);
    });
});

describe("selectAlbumInCatalog", () => {
    const albums = [
        album,
        {
            ...album,
            id: 24,
            title: "Álbum & Friends (2019 Remaster)",
            foreignAlbumId: "edition-mbid",
        },
        {
            ...album,
            id: 25,
            title: "A Funk Odyssey",
            foreignAlbumId: "other-mbid",
        },
    ];

    it("prefers an exact release-group MBID", () => {
        expect(
            selectAlbumInCatalog(albums, "edition-mbid", "wrong title"),
        ).toEqual(albums[1]);
    });

    it("uses canonical normalization and edition stripping", () => {
        expect(
            selectAlbumInCatalog(
                albums,
                "missing-mbid",
                "Album and Friends [Deluxe Edition]",
            ),
        ).toEqual(albums[1]);
    });

    it("accepts a contained title only at the existing sixty-percent threshold", () => {
        expect(
            selectAlbumInCatalog(
                [{ ...album, title: "The Album Plus" }],
                "missing-mbid",
                "The Album",
            ),
        ).toEqual({ ...album, title: "The Album Plus" });
    });

    it("rejects unrelated albums that share only incidental words", () => {
        expect(
            selectAlbumInCatalog(
                albums,
                "missing-mbid",
                "A Trip To The Mystery Planet",
            ),
        ).toBeNull();
    });
});
