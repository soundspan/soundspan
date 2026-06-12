#!/usr/bin/env ts-node
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface CliOptions {
    dryRun: boolean;
    batchSize: number;
}

interface LegacyRemoteLikedRow {
    userId: string;
    provider: string;
    externalId: string;
    title: string;
    artist: string;
    album: string | null;
    thumbnailUrl: string | null;
    duration: number | null;
    likedAt: Date;
}

function parseCliArgs(argv: string[]): CliOptions {
    const dryRun = argv.includes("--dry-run");
    const batchArg = argv.find((arg) => arg.startsWith("--batch-size="));
    const parsedBatch = batchArg
        ? Number.parseInt(batchArg.split("=")[1] || "", 10)
        : 100;
    const batchSize =
        Number.isFinite(parsedBatch) && parsedBatch > 0
            ? parsedBatch
            : 100;

    return { dryRun, batchSize };
}

async function runMigration(options: CliOptions): Promise<void> {
    let processed = 0;
    let migrated = 0;
    let skipped = 0;
    let offset = 0;

    console.log(
        `[migrate-remote-liked] starting (dryRun=${options.dryRun}, batchSize=${options.batchSize})`
    );

    const tablePresence = await prisma.$queryRaw<
        Array<{ present: boolean }>
    >`SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'RemoteLikedTrack'
    ) AS present`;
    if (!tablePresence[0]?.present) {
        console.log(
            "[migrate-remote-liked] RemoteLikedTrack table not present; nothing to migrate"
        );
        return;
    }

    while (true) {
        const batch = await prisma.$queryRawUnsafe<LegacyRemoteLikedRow[]>(
            `
                SELECT
                    "userId",
                    "provider",
                    "externalId",
                    "title",
                    "artist",
                    "album",
                    "thumbnailUrl",
                    "duration",
                    "likedAt"
                FROM "RemoteLikedTrack"
                ORDER BY "likedAt" ASC, "userId" ASC, "provider" ASC, "externalId" ASC
                OFFSET $1
                LIMIT $2
            `,
            offset,
            options.batchSize
        );

        if (batch.length === 0) break;

        for (const legacyRow of batch) {
            processed += 1;

            if (legacyRow.provider === "tidal") {
                const tidalId = Number.parseInt(legacyRow.externalId, 10);
                if (!Number.isFinite(tidalId) || tidalId <= 0) {
                    skipped += 1;
                    console.warn(
                        `[migrate-remote-liked] skipping invalid tidal external id: ${legacyRow.externalId}`
                    );
                    continue;
                }

                if (options.dryRun) {
                    migrated += 1;
                    continue;
                }

                const trackTidal = await prisma.trackTidal.upsert({
                    where: { tidalId },
                    update: {
                        title: legacyRow.title,
                        artist: legacyRow.artist,
                        album: legacyRow.album ?? "Unknown",
                        duration: legacyRow.duration ?? 180,
                    },
                    create: {
                        tidalId,
                        title: legacyRow.title,
                        artist: legacyRow.artist,
                        album: legacyRow.album ?? "Unknown",
                        duration: legacyRow.duration ?? 180,
                    },
                    select: { id: true },
                });

                await prisma.likedRemoteTrack.upsert({
                    where: {
                        userId_trackTidalId: {
                            userId: legacyRow.userId,
                            trackTidalId: trackTidal.id,
                        },
                    },
                    update: {
                        likedAt: legacyRow.likedAt,
                    },
                    create: {
                        userId: legacyRow.userId,
                        trackTidalId: trackTidal.id,
                        likedAt: legacyRow.likedAt,
                    },
                });

                migrated += 1;
                continue;
            }

            if (legacyRow.provider === "youtube") {
                if (options.dryRun) {
                    migrated += 1;
                    continue;
                }

                const videoId = legacyRow.externalId.trim();
                if (!videoId) {
                    skipped += 1;
                    console.warn(
                        "[migrate-remote-liked] skipping empty youtube external id"
                    );
                    continue;
                }

                const trackYtMusic = await prisma.trackYtMusic.upsert({
                    where: { videoId },
                    update: {
                        title: legacyRow.title,
                        artist: legacyRow.artist,
                        album: legacyRow.album ?? "Unknown",
                        duration: legacyRow.duration ?? 180,
                        thumbnailUrl: legacyRow.thumbnailUrl ?? undefined,
                    },
                    create: {
                        videoId,
                        title: legacyRow.title,
                        artist: legacyRow.artist,
                        album: legacyRow.album ?? "Unknown",
                        duration: legacyRow.duration ?? 180,
                        thumbnailUrl: legacyRow.thumbnailUrl ?? undefined,
                    },
                    select: { id: true },
                });

                await prisma.likedRemoteTrack.upsert({
                    where: {
                        userId_trackYtMusicId: {
                            userId: legacyRow.userId,
                            trackYtMusicId: trackYtMusic.id,
                        },
                    },
                    update: {
                        likedAt: legacyRow.likedAt,
                    },
                    create: {
                        userId: legacyRow.userId,
                        trackYtMusicId: trackYtMusic.id,
                        likedAt: legacyRow.likedAt,
                    },
                });

                migrated += 1;
                continue;
            }

            skipped += 1;
            console.warn(
                `[migrate-remote-liked] skipping unsupported provider: ${legacyRow.provider}`
            );
        }

        offset += batch.length;
        console.log(
            `[migrate-remote-liked] progress processed=${processed} migrated=${migrated} skipped=${skipped}`
        );
    }

    console.log(
        `[migrate-remote-liked] complete processed=${processed} migrated=${migrated} skipped=${skipped}`
    );
}

const options = parseCliArgs(process.argv.slice(2));

runMigration(options)
    .catch((error) => {
        console.error("[migrate-remote-liked] failed", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
