import type { Prisma } from "@prisma/client";
import { Registry } from "prom-client";
import { Client } from "pg";
import { createLoudnessMetrics } from "../src/metrics/loudnessMetrics";
import { countEmbeddedLocalTracks } from "../src/services/trackEmbeddings";
import { loadVibeEmbeddingCoverage } from "../src/services/vibeEmbeddingCoverage";
import { invalidateActiveSpaceCache } from "../src/services/embeddingSpaces";
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

const ARTIST_COUNT = 1_000;
const ALBUM_COUNT = 8_000;
const ACTIVE_TRACK_COUNT = 100_000;
const REMOVED_TRACK_COUNT = 20_000;
const TRACK_COUNT = ACTIVE_TRACK_COUNT + REMOVED_TRACK_COUNT;
const EMBEDDING_COUNT = 50_000;
const MEASURED_LOUDNESS_COUNT = 10_000;
const FAILED_VIBE_COUNT = 25_000;
const CREATE_BATCH_SIZE = 2_000;
const SWEEP_PAGE_SIZE = 2_000;
const DATABASE_BUDGET_MS = 10_000;
const EMBEDDING_COUNT_BUDGET_MS = 5_000;
const ACTIVE_SPACE_ID = "space_clap_music_audioset_v1";
const OLD_REMOVAL = new Date("2025-01-01T00:00:00.000Z");
const PURGE_CUTOFF = new Date("2026-01-01T00:00:00.000Z");
const VECTOR = `[1,${Array(511).fill(0).join(",")}]`;

function numberedId(prefix: string, index: number): string {
    return `${prefix}${String(index).padStart(6, "0")}`;
}

async function withinBudget<T>(
    label: string,
    budgetMs: number,
    operation: () => Promise<T>,
): Promise<T> {
    const startedAt = performance.now();
    const result = await operation();
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs > budgetMs) {
        throw new Error(
            `${label} exceeded ${budgetMs}ms wall-clock budget (${elapsedMs.toFixed(1)}ms)`,
        );
    }
    return result;
}

async function seedArtists(): Promise<void> {
    const artists: Prisma.ArtistCreateManyInput[] = Array.from(
        { length: ARTIST_COUNT },
        (_unused, index) => ({
            id: numberedId("scale-artist-", index),
            mbid: numberedId("scale-artist-mbid-", index),
            name: `Scale Artist ${index}`,
            normalizedName: `scale artist ${index}`,
        }),
    );
    await prisma.artist.createMany({ data: artists });
}

async function seedAlbums(): Promise<void> {
    for (let start = 0; start < ALBUM_COUNT; start += CREATE_BATCH_SIZE) {
        const end = Math.min(start + CREATE_BATCH_SIZE, ALBUM_COUNT);
        const albums: Prisma.AlbumCreateManyInput[] = [];
        for (let index = start; index < end; index += 1) {
            albums.push({
                id: numberedId("scale-album-", index),
                rgMbid: numberedId("scale-album-mbid-", index),
                artistId: numberedId("scale-artist-", Math.floor(index / 8)),
                title: `Scale Album ${index}`,
                primaryType: "Album",
            });
        }
        await prisma.album.createMany({ data: albums });
    }
}

async function purgeOnePredicateBoundPage(): Promise<number> {
    const candidates = await prisma.track.findMany({
        where: { origin: "LOCAL", removedAt: { lt: PURGE_CUTOFF } },
        orderBy: { id: "asc" },
        take: 101,
        select: { id: true },
    });
    expect(candidates).toHaveLength(101);
    const batch = candidates.slice(0, 100);
    const protectedId = batch[0].id;
    await prisma.track.update({
        where: { id: protectedId },
        data: { removedAt: null },
    });
    const result = await prisma.$transaction(async (transaction) =>
        transaction.track.deleteMany({
            where: {
                id: { in: batch.map((track) => track.id) },
                origin: "LOCAL",
                removedAt: { lt: PURGE_CUTOFF },
            },
        }),
    );
    expect(
        await prisma.track.findUnique({
            where: { id: protectedId },
            select: { id: true },
        }),
    ).toEqual({ id: protectedId });
    return result.count;
}

function vibeStatus(index: number): string {
    if (index < EMBEDDING_COUNT) return "completed";
    if (index < EMBEDDING_COUNT + FAILED_VIBE_COUNT) return "failed";
    return "pending";
}

async function seedTracks(): Promise<void> {
    for (let start = 0; start < TRACK_COUNT; start += CREATE_BATCH_SIZE) {
        const end = Math.min(start + CREATE_BATCH_SIZE, TRACK_COUNT);
        const tracks: Prisma.TrackCreateManyInput[] = [];
        for (let index = start; index < end; index += 1) {
            const active = index < ACTIVE_TRACK_COUNT;
            tracks.push({
                id: numberedId("scale-track-", index),
                albumId: numberedId("scale-album-", Math.floor(index / 15)),
                title: `Scale Track ${index}`,
                trackNo: (index % 15) + 1,
                duration: 240,
                filePath: `/scale/${numberedId("track-", index)}.flac`,
                fileModified: new Date("2026-01-01T00:00:00.000Z"),
                fileSize: 10_000_000,
                origin: "LOCAL",
                analysisStatus: "completed",
                loudnessLufs:
                    active && index < MEASURED_LOUDNESS_COUNT ? -23 : null,
                removedAt: active ? null : OLD_REMOVAL,
                vibeAnalysisStatus: vibeStatus(index),
            });
        }
        await prisma.track.createMany({ data: tracks });
    }
}

async function seedLibraryHealth(): Promise<void> {
    for (
        let start = ACTIVE_TRACK_COUNT;
        start < TRACK_COUNT;
        start += CREATE_BATCH_SIZE
    ) {
        const end = Math.min(start + CREATE_BATCH_SIZE, TRACK_COUNT);
        const records: Prisma.LibraryHealthRecordCreateManyInput[] = [];
        for (let index = start; index < end; index += 1) {
            records.push({
                id: numberedId("scale-health-", index),
                trackId: numberedId("scale-track-", index),
                status: "MISSING_FROM_DISK",
                filePath: `/scale/${numberedId("track-", index)}.flac`,
            });
        }
        await prisma.libraryHealthRecord.createMany({ data: records });
    }
}

async function seedEmbeddings(database: Client): Promise<void> {
    for (let start = 0; start < EMBEDDING_COUNT; start += CREATE_BATCH_SIZE) {
        const end = Math.min(start + CREATE_BATCH_SIZE, EMBEDDING_COUNT) - 1;
        await database.query(
            `INSERT INTO track_embeddings (track_id, space_id, embedding)
             SELECT 'scale-track-' || lpad(value::text, 6, '0'), $1, $2::vector
             FROM generate_series($3::int, $4::int) AS value`,
            [ACTIVE_SPACE_ID, VECTOR, start, end],
        );
    }
    await database.query(
        "UPDATE embedding_spaces SET had_vectors = TRUE WHERE id = $1",
        [ACTIVE_SPACE_ID],
    );
    await database.query(
        'ANALYZE "Artist"; ANALYZE "Album"; ANALYZE "Track"; ANALYZE "LibraryHealthRecord"; ANALYZE track_embeddings;',
    );
}

async function sweepLoudnessBackfillIds(): Promise<Set<string>> {
    const seen = new Set<string>();
    let cursor: string | undefined;
    const maxPages = Math.ceil(ACTIVE_TRACK_COUNT / SWEEP_PAGE_SIZE) + 1;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const page = await prisma.track.findMany({
            where: {
                origin: "LOCAL",
                removedAt: null,
                analysisStatus: "completed",
                loudnessLufs: null,
                ...(cursor ? { id: { gt: cursor } } : {}),
            },
            orderBy: { id: "asc" },
            take: SWEEP_PAGE_SIZE,
            select: { id: true },
        });
        if (page.length === 0) return seen;
        expect(page[0].id > (cursor ?? "")).toBe(true);
        for (const row of page) seen.add(row.id);
        cursor = page[page.length - 1].id;
    }
    throw new Error("Loudness keyset sweep exceeded its fixed page bound");
}

async function sweepAudioHashBackfillIds(): Promise<Set<string>> {
    const seen = new Set<string>();
    let cursor: string | undefined;
    const maxPages = Math.ceil(ACTIVE_TRACK_COUNT / SWEEP_PAGE_SIZE) + 1;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const page = await prisma.track.findMany({
            where: {
                audioHash: null,
                filePath: { not: null },
                origin: "LOCAL",
                removedAt: null,
                ...(cursor ? { id: { gt: cursor } } : {}),
            },
            orderBy: { id: "asc" },
            take: SWEEP_PAGE_SIZE,
            select: { id: true },
        });
        if (page.length === 0) return seen;
        expect(page[0].id > (cursor ?? "")).toBe(true);
        for (const row of page) seen.add(row.id);
        cursor = page[page.length - 1].id;
    }
    throw new Error("Audio-hash keyset sweep exceeded its fixed page bound");
}

describeWithPostgres("PostgreSQL production-volume query shapes", () => {
    let admin: Client;
    let database: Client;

    beforeAll(async () => {
        admin = await createScaleDatabase(
            integrationDatabaseUrl!,
            databaseName!,
        );
        await applyScaleMigrations(process.env.DATABASE_URL!);
        database = new Client({ connectionString: process.env.DATABASE_URL });
        await database.connect();
        await seedArtists();
        await seedAlbums();
        await seedTracks();
        await seedLibraryHealth();
        await seedEmbeddings(database);
    });

    afterAll(async () => {
        invalidateActiveSpaceCache();
        await prisma.$disconnect();
        await database?.end();
        if (admin && databaseName) {
            await dropScaleDatabase(admin, databaseName);
        }
    });

    it("advances the loudness keyset sweep across active volume", async () => {
        const loudnessIds = await withinBudget(
            "loudness backfill keyset sweep",
            DATABASE_BUDGET_MS,
            sweepLoudnessBackfillIds,
        );

        expect(loudnessIds.size).toBe(
            ACTIVE_TRACK_COUNT - MEASURED_LOUDNESS_COUNT,
        );
    });

    it("advances the audio-hash keyset sweep across active volume", async () => {
        const audioHashIds = await withinBudget(
            "audio-hash backfill keyset sweep",
            DATABASE_BUDGET_MS,
            sweepAudioHashBackfillIds,
        );

        expect(audioHashIds.size).toBe(ACTIVE_TRACK_COUNT);
    });

    it("returns Library Health list, total, and removed membership at volume", async () => {
        const [records, total] = await withinBudget(
            "Library Health list and count",
            DATABASE_BUDGET_MS,
            () =>
                Promise.all([
                    prisma.libraryHealthRecord.findMany({
                        include: {
                            track: {
                                select: {
                                    id: true,
                                    title: true,
                                    removedAt: true,
                                    album: {
                                        select: {
                                            title: true,
                                            artist: { select: { name: true } },
                                        },
                                    },
                                },
                            },
                        },
                        orderBy: { updatedAt: "desc" },
                    }),
                    prisma.libraryHealthRecord.count(),
                ]),
        );
        const removedLocalCount = await withinBudget(
            "Library Health removed-track count",
            DATABASE_BUDGET_MS,
            () =>
                prisma.track.count({
                    where: { origin: "LOCAL", removedAt: { not: null } },
                }),
        );
        const removed = records.filter(
            (record) =>
                record.status === "MISSING_FROM_DISK" &&
                record.track.removedAt !== null,
        );

        expect(total).toBe(REMOVED_TRACK_COUNT);
        expect(removedLocalCount).toBe(REMOVED_TRACK_COUNT);
        expect(removed).toHaveLength(REMOVED_TRACK_COUNT);
    });

    it("collects vibe and loudness coverage counts within bounded time", async () => {
        const vibeCoverage = await withinBudget(
            "vibe embedding coverage",
            DATABASE_BUDGET_MS,
            () => loadVibeEmbeddingCoverage(ACTIVE_SPACE_ID),
        );
        invalidateActiveSpaceCache();
        const embeddedLocal = await withinBudget(
            "local embedding count",
            EMBEDDING_COUNT_BUDGET_MS,
            countEmbeddedLocalTracks,
        );
        const registry = new Registry();
        createLoudnessMetrics(registry, prisma);
        const metrics = await withinBudget(
            "loudness coverage",
            DATABASE_BUDGET_MS,
            () => registry.metrics(),
        );
        registry.clear();

        expect(vibeCoverage).toEqual({
            embedded: EMBEDDING_COUNT,
            failed: FAILED_VIBE_COUNT,
            pending: ACTIVE_TRACK_COUNT - EMBEDDING_COUNT - FAILED_VIBE_COUNT,
        });
        expect(embeddedLocal).toBe(EMBEDDING_COUNT);
        expect(metrics).toContain(
            `soundspan_loudness_coverage{state="measured"} ${MEASURED_LOUDNESS_COUNT}`,
        );
        expect(metrics).toContain(
            `soundspan_loudness_coverage{state="unmeasured"} ${ACTIVE_TRACK_COUNT - MEASURED_LOUDNESS_COUNT}`,
        );
    });

    it("purges only a bounded page whose rows still match inside the transaction", async () => {
        const deleted = await withinBudget(
            "removed-track purge page",
            DATABASE_BUDGET_MS,
            purgeOnePredicateBoundPage,
        );

        expect(deleted).toBe(99);
        expect(
            await prisma.track.count({
                where: { removedAt: { lt: PURGE_CUTOFF } },
            }),
        ).toBe(REMOVED_TRACK_COUNT - 100);
    });
});
