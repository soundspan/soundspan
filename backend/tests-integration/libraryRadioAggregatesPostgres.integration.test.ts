import type { Client } from "pg";
import {
    buildDecadeAggregateQuery,
    buildGenreAggregateQuery,
} from "../src/services/libraryRadioCache";
import { getDecadeFromYear, getEffectiveYear } from "../src/utils/dateFilters";
import { prisma } from "../src/utils/db";
import {
    TRACK_BROWSE_WHERE,
    TRACK_VISIBLE_WHERE,
} from "../src/utils/librarySorting";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    integrationDatabaseUrl && databaseName ? describe : describe.skip;
const TRACK_COUNTS = [16, 15, 14] as const;

async function seedTracks(albumId: string, count: number): Promise<void> {
    await prisma.track.createMany({
        data: Array.from({ length: count }, (_, index) => ({
            id: `${albumId}-track-${index + 1}`,
            albumId,
            title: `${albumId} track ${index + 1}`,
            trackNo: index + 1,
            duration: 180,
            fileModified: new Date("2026-08-25T00:00:00.000Z"),
            fileSize: 1_000,
        })),
    });
}

async function seedFixture(): Promise<void> {
    await prisma.artist.createMany({
        data: [
            {
                id: "aggregate-source",
                mbid: "aggregate-source-mbid",
                name: "Aggregate Source",
                genres: ["Rock", "Radiohead"],
            },
            {
                id: "aggregate-blocker",
                mbid: "aggregate-blocker-mbid",
                name: "Different Display Name",
                normalizedName: "radiohead",
            },
        ],
    });
    await prisma.album.createMany({
        data: [
            {
                id: "aggregate-nineties",
                rgMbid: "aggregate-nineties-mbid",
                artistId: "aggregate-source",
                title: "Nineties",
                primaryType: "Album",
                year: 2022,
                originalYear: 1995,
            },
            {
                id: "aggregate-override",
                rgMbid: "aggregate-override-mbid",
                artistId: "aggregate-source",
                title: "Override",
                primaryType: "Album",
                year: 2011,
                originalYear: 1988,
                displayYear: 2004,
            },
            {
                id: "aggregate-under-minimum",
                rgMbid: "aggregate-under-minimum-mbid",
                artistId: "aggregate-source",
                title: "Under Minimum",
                primaryType: "Album",
                year: 1977,
            },
        ],
    });
    await seedTracks("aggregate-nineties", TRACK_COUNTS[0]);
    await seedTracks("aggregate-override", TRACK_COUNTS[1]);
    await seedTracks("aggregate-under-minimum", TRACK_COUNTS[2]);
}

async function computeLegacyDecades(): Promise<
    { decade: number; count: number }[]
> {
    const albums = await prisma.album.findMany({
        select: {
            year: true,
            originalYear: true,
            displayYear: true,
            _count: {
                select: {
                    tracks: {
                        where: {
                            ...TRACK_VISIBLE_WHERE,
                            ...TRACK_BROWSE_WHERE,
                        },
                    },
                },
            },
        },
    });
    const counts = new Map<number, number>();
    for (const album of albums) {
        const year = getEffectiveYear(album);
        if (year === null) continue;
        const decade = getDecadeFromYear(year);
        counts.set(decade, (counts.get(decade) ?? 0) + album._count.tracks);
    }
    return [...counts.entries()]
        .map(([decade, count]) => ({ decade, count }))
        .filter(({ count }) => count >= 15)
        .sort((left, right) => right.decade - left.decade);
}

describeWithPostgres("library radio aggregate PostgreSQL behavior", () => {
    let admin: Client | undefined;

    beforeAll(async () => {
        if (!integrationDatabaseUrl || !databaseName) {
            throw new Error("PostgreSQL integration environment is missing");
        }
        admin = await createScaleDatabase(integrationDatabaseUrl, databaseName);
        await applyScaleMigrations(process.env.DATABASE_URL!);
        await seedFixture();
    });

    afterAll(async () => {
        await prisma.$disconnect();
        if (admin && databaseName) await dropScaleDatabase(admin, databaseName);
    });

    it("matches the previous effective-year JavaScript aggregation", async () => {
        const rows = await prisma.$queryRaw<
            { decade: number; track_count: bigint }[]
        >(buildDecadeAggregateQuery());
        const sqlDecades = rows.map((row) => ({
            decade: row.decade,
            count: Number(row.track_count),
        }));

        await expect(computeLegacyDecades()).resolves.toEqual(sqlDecades);
        expect(sqlDecades).toEqual([
            { decade: 2000, count: 15 },
            { decade: 1990, count: 16 },
        ]);
        expect(sqlDecades).not.toContainEqual({ decade: 1970, count: 14 });
    });

    it("counts genres while blocking artist-name tags inside SQL", async () => {
        const rows = await prisma.$queryRaw<
            { genre: string; track_count: bigint }[]
        >(buildGenreAggregateQuery());

        expect(
            rows.map((row) => ({
                genre: row.genre,
                count: Number(row.track_count),
            })),
        ).toEqual([{ genre: "rock", count: 45 }]);
    });
});
