import type { Client } from "pg";
import { prisma } from "../src/utils/db";
import {
    loadScanReconcileCandidates,
    reconcileDownloadJobsWithScan,
    SCAN_RECONCILE_ACTIVE_JOB_LIMIT,
    SCAN_RECONCILE_CANDIDATE_LIMIT,
} from "../src/workers/processors/scanReconcileQuery";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    integrationDatabaseUrl && databaseName ? describe : describe.skip;

const USER_ID = "scan-reconcile-user";
const FIXED_TIME = new Date("2026-08-25T12:00:00.000Z");

async function seedAlbum(
    id: string,
    artistName: string,
    title: string,
    hasTracks = true,
): Promise<void> {
    const artistId = `${id}-artist`;
    await prisma.artist.create({
        data: { id: artistId, mbid: `${artistId}-mbid`, name: artistName },
    });
    await prisma.album.create({
        data: {
            id,
            rgMbid: `${id}-mbid`,
            artistId,
            title,
            primaryType: "Album",
            updatedAt: FIXED_TIME,
        },
    });
    if (hasTracks) {
        await prisma.track.create({
            data: {
                id: `${id}-track`,
                albumId: id,
                title: `${title} Track`,
                trackNo: 1,
                duration: 180,
                fileModified: FIXED_TIME,
                fileSize: 1_000,
            },
        });
    }
}

async function seedJob(
    id: string,
    artistName: string,
    albumTitle: string,
    createdAt = FIXED_TIME,
): Promise<void> {
    await prisma.downloadJob.create({
        data: {
            id,
            userId: USER_ID,
            subject: albumTitle,
            type: "album",
            targetMbid: `${id}-target`,
            status: "pending",
            metadata: { artistName, albumTitle },
            createdAt,
        },
    });
}

describeWithPostgres("scan reconciliation PostgreSQL behavior", () => {
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
        await prisma.user.create({
            data: { id: USER_ID, username: "scan-reconcile-user" },
        });
    });

    afterEach(async () => {
        await prisma.downloadJob.deleteMany({ where: { userId: USER_ID } });
        await prisma.track.deleteMany({});
        await prisma.album.deleteMany({});
        await prisma.artist.deleteMany({});
    });

    afterAll(async () => {
        await prisma.$disconnect();
        if (admin && databaseName) {
            await dropScaleDatabase(admin, databaseName);
        }
    });

    it("preserves exact, fuzzy, no-track, and unmatched outcomes", async () => {
        await seedAlbum("exact-album", "The National", "Boxer Deluxe");
        await seedAlbum(
            "fuzzy-album",
            "The Beatles",
            "Abbey Road (Remastered)",
        );
        await seedAlbum(
            "no-track-album",
            "Silent Artist",
            "Silent Album",
            false,
        );
        await seedJob("exact-job", "The National", "Boxer");
        await seedJob("fuzzy-job", "Beatles", "Abbey Road");
        await seedJob("no-track-job", "Silent Artist", "Silent Album");
        await seedJob("unmatched-job", "Missing Artist", "Missing Album");

        await expect(reconcileDownloadJobsWithScan()).resolves.toBe(2);

        const jobs = await prisma.downloadJob.findMany({
            orderBy: { id: "asc" },
            select: { id: true, status: true },
        });
        expect(jobs).toEqual([
            { id: "exact-job", status: "completed" },
            { id: "fuzzy-job", status: "completed" },
            { id: "no-track-job", status: "pending" },
            { id: "unmatched-job", status: "pending" },
        ]);
    });

    it("treats percent, underscore, and backslash in artist prefixes literally", async () => {
        await seedAlbum("literal-album", "%_\\ab Artist", "Literal Album");
        await seedAlbum("wildcard-decoy", "XYzab Artist", "Decoy Album");
        await seedJob("literal-job", "%_\\ab Artist", "Literal Album");

        const candidates = await loadScanReconcileCandidates(["%_\\ab"]);
        expect(candidates.map((candidate) => candidate.id)).toEqual([
            "literal-album",
        ]);

        await expect(reconcileDownloadJobsWithScan()).resolves.toBe(1);
        await expect(
            prisma.downloadJob.findUniqueOrThrow({
                where: { id: "literal-job" },
                select: { status: true },
            }),
        ).resolves.toEqual({ status: "completed" });
    });

    it("caps candidates and defers jobs beyond the oldest active-job window", async () => {
        await prisma.artist.create({
            data: {
                id: "common-artist",
                mbid: "common-artist-mbid",
                name: "Common Artist",
            },
        });
        const albums = Array.from(
            { length: SCAN_RECONCILE_CANDIDATE_LIMIT + 1 },
            (_unused, index) => ({
                id: `common-album-${index.toString().padStart(4, "0")}`,
                rgMbid: `common-album-mbid-${index}`,
                artistId: "common-artist",
                title: `Common Album ${index}`,
                primaryType: "Album",
                updatedAt: FIXED_TIME,
            }),
        );
        await prisma.album.createMany({ data: albums });
        const candidates = await loadScanReconcileCandidates(["commo"]);
        expect(candidates).toHaveLength(SCAN_RECONCILE_CANDIDATE_LIMIT);
        expect(candidates.at(-1)?.id).toBe("common-album-0999");

        await prisma.downloadJob.createMany({
            data: Array.from(
                { length: SCAN_RECONCILE_ACTIVE_JOB_LIMIT },
                (_unused, index) => ({
                    id: `old-job-${index.toString().padStart(3, "0")}`,
                    userId: USER_ID,
                    subject: `Missing Album ${index}`,
                    type: "album",
                    targetMbid: `old-target-${index}`,
                    status: "pending",
                    metadata: {
                        artistName: "Missing Artist",
                        albumTitle: `Missing Album ${index}`,
                    },
                    createdAt: new Date("2026-08-24T12:00:00.000Z"),
                }),
            ),
        });
        await seedJob(
            "newest-matching-job",
            "Common Artist",
            "Common Album 0",
            new Date("2026-08-26T12:00:00.000Z"),
        );

        await expect(reconcileDownloadJobsWithScan()).resolves.toBe(0);
        await expect(
            prisma.downloadJob.findUniqueOrThrow({
                where: { id: "newest-matching-job" },
                select: { status: true },
            }),
        ).resolves.toEqual({ status: "pending" });
    });
});
