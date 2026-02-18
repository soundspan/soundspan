#!/usr/bin/env ts-node
/**
 * Backfill Script: Populate discNo for existing tracks
 *
 * After adding the discNo column (defaults to 1), existing multi-disc
 * albums still have discNo=1 for all tracks. The scanner only updates
 * files whose mtime has changed, so a normal rescan won't fix them.
 *
 * This script reads disc metadata from every audio file that currently
 * has discNo=1 and updates the database where the actual disc number
 * differs.
 *
 * Usage:
 *   npx ts-node scripts/backfill-disc-number.ts [--dry-run]
 *
 * Options:
 *   --dry-run    Show what would be updated without making changes
 */

import { PrismaClient } from "@prisma/client";
import { parseFile } from "music-metadata";
import * as path from "path";

const prisma = new PrismaClient();

// Music path — must match the container/server config
const MUSIC_PATH = process.env.MUSIC_PATH || "/music";

async function backfillDiscNumber(dryRun: boolean = false) {
    console.log("=== Backfill discNo Script ===\n");
    console.log(
        `Mode: ${dryRun ? "DRY RUN (no changes)" : "LIVE (will update database)"}\n`
    );
    console.log(`Music path: ${MUSIC_PATH}\n`);

    try {
        // Find all tracks that still have the default discNo = 1
        const tracks = await prisma.track.findMany({
            where: { discNo: 1 },
            select: {
                id: true,
                filePath: true,
                title: true,
                trackNo: true,
                album: {
                    select: {
                        title: true,
                        artist: { select: { name: true } },
                    },
                },
            },
        });

        console.log(`Found ${tracks.length} tracks with discNo=1 to check\n`);

        let updated = 0;
        let errors = 0;
        let skipped = 0;

        for (const track of tracks) {
            try {
                const absolutePath = path.join(MUSIC_PATH, track.filePath);
                const metadata = await parseFile(absolutePath);
                const discNo = metadata.common.disk?.no;

                if (discNo && discNo !== 1) {
                    if (dryRun) {
                        console.log(
                            `  Would update: ${track.album.artist?.name} - ${track.album.title} / ` +
                            `Track ${track.trackNo} "${track.title}" → Disc ${discNo}`
                        );
                    } else {
                        await prisma.track.update({
                            where: { id: track.id },
                            data: { discNo },
                        });
                    }
                    updated++;
                } else {
                    skipped++;
                }
            } catch (err: any) {
                // File might not exist on this machine (e.g. running outside container)
                errors++;
                if (errors <= 5) {
                    console.warn(
                        `  ⚠ Could not read "${track.filePath}": ${err.message}`
                    );
                }
            }
        }

        console.log(`\n=== Results ===`);
        console.log(`  Updated:  ${updated} tracks with actual disc numbers`);
        console.log(`  Skipped:  ${skipped} tracks (already disc 1 or no disc metadata)`);
        console.log(`  Errors:   ${errors} tracks (file not readable)`);

        if (dryRun && updated > 0) {
            console.log(`\nRun without --dry-run to apply these changes.`);
        }

        // Mark backfill as done so the scanner doesn't force re-process all files
        if (!dryRun) {
            await prisma.systemSettings.updateMany({
                data: { discNoBackfillDone: true },
            });
            console.log(`\n✓ Marked discNoBackfillDone in SystemSettings`);
        }
    } catch (err) {
        console.error("Backfill failed:", err);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

// Parse CLI args
const dryRun = process.argv.includes("--dry-run");
backfillDiscNumber(dryRun);
