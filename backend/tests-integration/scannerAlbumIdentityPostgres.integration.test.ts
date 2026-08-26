import type { Client } from "pg";
import { resolveScannerAlbum } from "../src/services/musicScannerIdentity";
import { deduplicateScannerAlbums } from "../src/services/scannerAlbumDedup";
import { prisma } from "../src/utils/db";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    integrationDatabaseUrl && databaseName ? describe : describe.skip;
const FIXED_TIME = new Date("2026-08-25T12:00:00.000Z");

async function seedArtist(id: string): Promise<void> {
    await prisma.artist.create({
        data: { id, mbid: `${id}-mbid`, name: id, normalizedName: id },
    });
}

async function seedAlbum(input: {
    artistId: string;
    hasUserOverrides?: boolean;
    id: string;
    location?: "LIBRARY" | "DISCOVER";
    rgMbid: string;
    title: string;
}): Promise<void> {
    await prisma.album.create({
        data: { ...input, primaryType: "Album" },
    });
}

async function seedTrack(
    id: string,
    albumId: string,
    filePath: string | null,
    options: {
        duration?: number;
        loudnessLufs?: number | null;
        origin?: "LOCAL" | "FEDERATED";
        removedAt?: Date | null;
        truePeakDb?: number | null;
    } = {},
): Promise<void> {
    await prisma.track.create({
        data: {
            id,
            albumId,
            title: id,
            trackNo: 1,
            duration: options.duration ?? 180,
            filePath,
            fileModified: FIXED_TIME,
            fileSize: 1_000,
            origin: options.origin ?? "LOCAL",
            removedAt: options.removedAt ?? null,
            loudnessLufs: options.loudnessLufs ?? null,
            truePeakDb: options.truePeakDb ?? null,
        },
    });
}

describeWithPostgres("scanner album identity PostgreSQL behavior", () => {
    let admin: Client | undefined;

    beforeAll(async () => {
        if (!integrationDatabaseUrl || !databaseName) {
            throw new Error("PostgreSQL integration environment is missing");
        }
        admin = await createScaleDatabase(integrationDatabaseUrl, databaseName);
        const runtimeDatabaseUrl = process.env.DATABASE_URL;
        if (!runtimeDatabaseUrl) {
            throw new Error("Integration database URL was not initialized");
        }
        await applyScaleMigrations(runtimeDatabaseUrl);
    });

    afterEach(async () => {
        await prisma.ownedAlbum.deleteMany({});
        await prisma.trackTidal.deleteMany({});
        await prisma.trackYtMusic.deleteMany({});
        await prisma.track.deleteMany({});
        await prisma.album.deleteMany({});
        await prisma.artist.deleteMany({});
    });

    afterAll(async () => {
        await prisma.$disconnect();
        if (admin && databaseName) await dropScaleDatabase(admin, databaseName);
    });

    it("reuses a same-artist album whose untagged title differs only by case", async () => {
        await seedArtist("beastie-boys");
        await seedAlbum({
            id: "some-old-bullshit",
            artistId: "beastie-boys",
            rgMbid: "real-some-old-bullshit",
            title: "Some Old Bullshit",
        });
        await seedTrack(
            "existing-track",
            "some-old-bullshit",
            "Beastie Boys/Some Old Bullshit/01.flac",
        );

        const resolved = await resolveScannerAlbum({
            albumPromotions: new Map(),
            albumTitle: "some old bullshit",
            artistId: "beastie-boys",
            isDiscoveryAlbum: false,
            year: 1994,
        });

        expect(resolved.album.id).toBe("some-old-bullshit");
        await expect(
            prisma.album.count({ where: { artistId: "beastie-boys" } }),
        ).resolves.toBe(1);
    });

    it("keeps standard and deluxe editions distinct", async () => {
        await seedArtist("drake");
        await seedAlbum({
            id: "take-care",
            artistId: "drake",
            rgMbid: "real-take-care",
            title: "Take Care",
        });

        const resolved = await resolveScannerAlbum({
            albumPromotions: new Map(),
            albumTitle: "Take Care (Deluxe)",
            artistId: "drake",
            isDiscoveryAlbum: false,
            year: 2011,
        });

        expect(resolved.album.id).not.toBe("take-care");
        await expect(
            prisma.album.findMany({
                where: { artistId: "drake" },
                orderBy: { title: "asc" },
                select: { title: true },
            }),
        ).resolves.toEqual([
            { title: "Take Care" },
            { title: "Take Care (Deluxe)" },
        ]);
    });

    it("reparents all track and catalog references with canonical ownership", async () => {
        await seedArtist("merge-artist");
        await seedAlbum({
            id: "album-keeper",
            artistId: "merge-artist",
            rgMbid: "real-keeper",
            title: "Café & Rain",
        });
        await seedAlbum({
            id: "album-loser",
            artistId: "merge-artist",
            rgMbid: "temp-loser",
            title: "Cafe and Rain",
        });
        await seedTrack(
            "keeper-track",
            "album-keeper",
            "Merge Artist/Cafe and Rain/01.flac",
            { duration: 100, loudnessLufs: -20, truePeakDb: -3 },
        );
        await seedTrack(
            "loser-track",
            "album-loser",
            "Merge Artist/Cafe and Rain/02.flac",
            { duration: 100, loudnessLufs: -10, truePeakDb: -1 },
        );
        await seedTrack(
            "loser-removed-track",
            "album-loser",
            "Merge Artist/Old Path/03.flac",
            { removedAt: FIXED_TIME },
        );
        await prisma.trackTidal.create({
            data: {
                tidalId: 828001,
                title: "Remote Track",
                artist: "Merge Artist",
                album: "Cafe and Rain",
                duration: 180,
                albumId: "album-loser",
            },
        });
        await prisma.ownedAlbum.createMany({
            data: [
                {
                    artistId: "merge-artist",
                    rgMbid: "real-keeper",
                    source: "enrichment",
                },
                {
                    artistId: "merge-artist",
                    rgMbid: "temp-loser",
                    source: "discovery_liked",
                },
            ],
        });

        await expect(deduplicateScannerAlbums()).resolves.toEqual(
            expect.objectContaining({
                groupsFound: 1,
                merged: 1,
                affectedArtistIds: ["merge-artist"],
                skippedNoDirOverlap: 0,
                skippedBothReal: 0,
            }),
        );
        await expect(
            prisma.track.findUniqueOrThrow({
                where: { id: "loser-track" },
                select: { albumId: true },
            }),
        ).resolves.toEqual({ albumId: "album-keeper" });
        await expect(
            prisma.album.findUniqueOrThrow({
                where: { id: "album-keeper" },
                select: {
                    albumLoudnessLufs: true,
                    albumTruePeakDb: true,
                },
            }),
        ).resolves.toEqual({
            albumLoudnessLufs: expect.closeTo(-12.59637310505756, 10),
            albumTruePeakDb: -1,
        });
        await expect(
            prisma.album.findUniqueOrThrow({
                where: { id: "album-loser" },
                select: { _count: { select: { tracks: true } } },
            }),
        ).resolves.toEqual({ _count: { tracks: 0 } });
        await expect(
            prisma.trackTidal.findUniqueOrThrow({
                where: { tidalId: 828001 },
                select: { albumId: true },
            }),
        ).resolves.toEqual({ albumId: "album-keeper" });
        await expect(
            prisma.ownedAlbum.findMany({
                where: { artistId: "merge-artist" },
                select: { rgMbid: true, source: true },
            }),
        ).resolves.toEqual([
            { rgMbid: "real-keeper", source: "discovery_liked" },
        ]);
    });

    it("ignores soft-removed paths when checking directory evidence", async () => {
        await seedArtist("stale-guard-artist");
        await seedAlbum({
            id: "stale-guard-keeper",
            artistId: "stale-guard-artist",
            rgMbid: "real-stale-guard",
            title: "Some Album",
        });
        await seedAlbum({
            id: "stale-guard-loser",
            artistId: "stale-guard-artist",
            rgMbid: "temp-stale-guard",
            title: "some album",
        });
        await seedTrack(
            "keeper-active-other-dir",
            "stale-guard-keeper",
            "Artist/Other Edition/01.flac",
        );
        await seedTrack(
            "keeper-removed-same-dir",
            "stale-guard-keeper",
            "Artist/Target Edition/old.flac",
            { removedAt: FIXED_TIME },
        );
        await seedTrack(
            "loser-active-target-dir",
            "stale-guard-loser",
            "Artist/Target Edition/01.flac",
        );

        const result = await deduplicateScannerAlbums();

        expect(result).toEqual(
            expect.objectContaining({ merged: 0, skippedNoDirOverlap: 1 }),
        );
    });

    it("merges temporary rows when every active local directory matches", async () => {
        await seedArtist("temporary-artist");
        await seedAlbum({
            id: "temporary-keeper",
            artistId: "temporary-artist",
            rgMbid: "temp-a",
            title: "Temporary Album",
        });
        await seedAlbum({
            id: "temporary-loser",
            artistId: "temporary-artist",
            rgMbid: "temp-b",
            title: "temporary album",
        });
        await seedTrack(
            "temporary-keeper-track",
            "temporary-keeper",
            "Artist/Temporary Album/01.flac",
        );
        await seedTrack(
            "temporary-loser-track",
            "temporary-loser",
            "Artist/Temporary Album/02.flac",
        );

        const result = await deduplicateScannerAlbums();

        expect(result.merged).toBe(1);
        await expect(
            prisma.track.findUniqueOrThrow({
                where: { id: "temporary-loser-track" },
                select: { albumId: true },
            }),
        ).resolves.toEqual({ albumId: "temporary-keeper" });
    });

    it("promotes a DISCOVER real keeper before absorbing a LIBRARY loser", async () => {
        await seedArtist("promotion-artist");
        await seedAlbum({
            id: "promotion-keeper",
            artistId: "promotion-artist",
            location: "DISCOVER",
            rgMbid: "real-promotion",
            title: "Promotion Album",
        });
        await seedAlbum({
            id: "promotion-loser",
            artistId: "promotion-artist",
            location: "LIBRARY",
            rgMbid: "temp-promotion",
            title: "promotion album",
        });
        await seedTrack(
            "promotion-keeper-track",
            "promotion-keeper",
            "Artist/Promotion Album/01.flac",
        );
        await seedTrack(
            "promotion-loser-track",
            "promotion-loser",
            "Artist/Promotion Album/02.flac",
        );
        await prisma.ownedAlbum.create({
            data: {
                artistId: "promotion-artist",
                rgMbid: "temp-promotion",
                source: "native_scan",
            },
        });

        const result = await deduplicateScannerAlbums();

        expect(result.merged).toBe(1);
        await expect(
            prisma.album.findUniqueOrThrow({
                where: { id: "promotion-keeper" },
                select: { location: true },
            }),
        ).resolves.toEqual({ location: "LIBRARY" });
        await expect(
            prisma.ownedAlbum.findMany({
                where: { artistId: "promotion-artist" },
                select: { rgMbid: true, source: true },
            }),
        ).resolves.toEqual([
            { rgMbid: "real-promotion", source: "native_scan" },
        ]);
    });

    it("skips a group when an active local loser track has no path", async () => {
        await seedArtist("null-path-artist");
        await seedAlbum({
            id: "null-path-keeper",
            artistId: "null-path-artist",
            rgMbid: "real-null-path",
            title: "Null Path Album",
        });
        await seedAlbum({
            id: "null-path-loser",
            artistId: "null-path-artist",
            rgMbid: "temp-null-path",
            title: "null path album",
        });
        await seedTrack(
            "null-path-keeper-track",
            "null-path-keeper",
            "Artist/Null Path Album/01.flac",
        );
        await seedTrack(
            "null-path-loser-track",
            "null-path-loser",
            "Artist/Null Path Album/02.flac",
        );
        await seedTrack("null-path-loser-missing", "null-path-loser", null);

        const result = await deduplicateScannerAlbums();

        expect(result).toEqual(
            expect.objectContaining({
                merged: 0,
                skippedNullActiveLocalPath: 1,
            }),
        );
    });

    it("skips a group when the loser has user overrides", async () => {
        await seedArtist("override-artist");
        await seedAlbum({
            id: "override-keeper",
            artistId: "override-artist",
            rgMbid: "real-override",
            title: "Override Album",
        });
        await seedAlbum({
            id: "override-loser",
            artistId: "override-artist",
            hasUserOverrides: true,
            rgMbid: "temp-override",
            title: "override album",
        });
        await seedTrack(
            "override-keeper-track",
            "override-keeper",
            "Artist/Override Album/01.flac",
        );
        await seedTrack(
            "override-loser-track",
            "override-loser",
            "Artist/Override Album/02.flac",
        );

        const result = await deduplicateScannerAlbums();

        expect(result).toEqual(
            expect.objectContaining({ merged: 0, skippedUserOverrides: 1 }),
        );
    });

    it("skips normalized duplicates stored in different directories", async () => {
        await seedArtist("guarded-artist");
        await seedAlbum({
            id: "guarded-keeper",
            artistId: "guarded-artist",
            rgMbid: "real-guarded",
            title: "Some Album",
        });
        await seedAlbum({
            id: "guarded-loser",
            artistId: "guarded-artist",
            rgMbid: "temp-guarded",
            title: "some album",
        });
        await seedTrack(
            "guarded-track-a",
            "guarded-keeper",
            "Artist/Edition A/01.flac",
        );
        await seedTrack(
            "guarded-track-b",
            "guarded-loser",
            "Artist/Edition A/02.flac",
        );
        await seedTrack(
            "guarded-track-c",
            "guarded-loser",
            "Artist/Edition B/03.flac",
        );

        await expect(deduplicateScannerAlbums()).resolves.toEqual(
            expect.objectContaining({
                groupsFound: 1,
                merged: 0,
                skippedNoDirOverlap: 1,
                skippedBothReal: 0,
            }),
        );
        await expect(
            prisma.track.findUniqueOrThrow({
                where: { id: "guarded-track-b" },
                select: { albumId: true },
            }),
        ).resolves.toEqual({ albumId: "guarded-loser" });
    });
});
