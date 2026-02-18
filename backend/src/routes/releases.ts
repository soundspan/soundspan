import { logger } from "../utils/logger";

/**
 * Release Radar API
 *
 * Provides upcoming and recent releases from:
 * 1. Lidarr monitored artists (via calendar API)
 * 2. Similar artists from user's library (Last.fm similar artists)
 */

import { Router } from "express";
import { lidarrService } from "../services/lidarr";
import { prisma } from "../utils/db";
import {
    mapCalendarReleaseToRadarItem,
    ReleaseRadarItem,
    sortByReleaseDateAsc,
    sortByReleaseDateDesc,
} from "../services/releaseContracts";

const router = Router();

interface ReleaseRadarResponse {
    upcoming: ReleaseRadarItem[];
    recent: ReleaseRadarItem[];
    monitoredArtistCount: number;
    similarArtistCount: number;
}

/**
 * GET /releases/radar
 * 
 * Get upcoming and recent releases for the user's monitored artists
 * and their similar artists.
 */
router.get("/radar", async (req, res) => {
    try {
        const now = new Date();
        const daysBack = parseInt(req.query.daysBack as string) || 30;
        const daysAhead = parseInt(req.query.daysAhead as string) || 90;

        // Calculate date range
        const startDate = new Date(now);
        startDate.setDate(startDate.getDate() - daysBack);
        
        const endDate = new Date(now);
        endDate.setDate(endDate.getDate() + daysAhead);

        logger.debug(`[Releases] Fetching radar: ${daysBack} days back, ${daysAhead} days ahead`);

        // 1. Get releases from Lidarr calendar (monitored artists)
        const lidarrReleases = await lidarrService.getCalendar(startDate, endDate);
        
        // 2. Get monitored artists from Lidarr
        const monitoredArtists = await lidarrService.getMonitoredArtists();
        const monitoredMbids = new Set(monitoredArtists.map(a => a.mbid));

        // 3. Get similar artists from user's library that aren't monitored
        const similarArtists = await prisma.similarArtist.findMany({
            where: {
                // Source artist is in the library (has albums)
                fromArtist: {
                    albums: { some: {} }
                },
                // Target artist is NOT in library (no albums)
                toArtist: {
                    albums: { none: {} }
                }
            },
            select: {
                toArtist: {
                    select: {
                        id: true,
                        name: true,
                        mbid: true,
                    }
                },
                weight: true,
            },
            orderBy: { weight: 'desc' },
            take: 50, // Top 50 similar artists
        });

        // Filter out any that are already monitored in Lidarr
        const unmonitoredSimilar = similarArtists.filter(
            sa => sa.toArtist.mbid && !monitoredMbids.has(sa.toArtist.mbid)
        );

        logger.debug(`[Releases] Found ${lidarrReleases.length} Lidarr releases`);
        logger.debug(`[Releases] Found ${unmonitoredSimilar.length} unmonitored similar artists`);

        // 4. Get albums in library to check what user already has
        const libraryAlbums = await prisma.album.findMany({
            select: {
                rgMbid: true,
            }
        });
        const libraryAlbumMbids = new Set(libraryAlbums.map(a => a.rgMbid).filter(Boolean));

        // 5. Transform Lidarr releases
        const releases = lidarrReleases.map((release) =>
            mapCalendarReleaseToRadarItem(release, now, libraryAlbumMbids)
        );

        // 6. Split into upcoming and recent
        const upcoming = sortByReleaseDateAsc(
            releases.filter((release) => release.status === "upcoming")
        );

        const recent = sortByReleaseDateDesc(
            releases.filter((release) => release.status !== "upcoming")
        );

        const response: ReleaseRadarResponse = {
            upcoming,
            recent,
            monitoredArtistCount: monitoredArtists.length,
            similarArtistCount: unmonitoredSimilar.length,
        };

        res.json(response);
    } catch (error: any) {
        logger.error("[Releases] Radar error:", error.message);
        res.status(500).json({ error: "Failed to fetch release radar" });
    }
});

/**
 * GET /releases/upcoming
 * 
 * Get only upcoming releases (next X days)
 */
router.get("/upcoming", async (req, res) => {
    try {
        const daysAhead = parseInt(req.query.days as string) || 90;
        
        const now = new Date();
        const endDate = new Date(now);
        endDate.setDate(endDate.getDate() + daysAhead);

        const releases = await lidarrService.getCalendar(now, endDate);
        
        // Sort by release date (soonest first)
        const sorted = sortByReleaseDateAsc(releases);

        res.json({
            releases: sorted,
            count: sorted.length,
            daysAhead,
        });
    } catch (error: any) {
        logger.error("[Releases] Upcoming error:", error.message);
        res.status(500).json({ error: "Failed to fetch upcoming releases" });
    }
});

/**
 * GET /releases/recent
 * 
 * Get recently released albums (last X days) that user might want to download
 */
router.get("/recent", async (req, res) => {
    try {
        const daysBack = parseInt(req.query.days as string) || 30;
        
        const now = new Date();
        const startDate = new Date(now);
        startDate.setDate(startDate.getDate() - daysBack);

        const releases = await lidarrService.getCalendar(startDate, now);
        
        // Get library albums to mark what's already downloaded
        const libraryAlbums = await prisma.album.findMany({
            select: { rgMbid: true }
        });
        const libraryMbids = new Set(libraryAlbums.map(a => a.rgMbid).filter(Boolean));

        // Filter to releases not in library and sort (newest first)
        const notInLibrary = sortByReleaseDateDesc(
            releases.filter((release) =>
                !release.hasFile && !libraryMbids.has(release.albumMbid)
            )
        );

        res.json({
            releases: notInLibrary,
            count: notInLibrary.length,
            daysBack,
            inLibraryCount: releases.length - notInLibrary.length,
        });
    } catch (error: any) {
        logger.error("[Releases] Recent error:", error.message);
        res.status(500).json({ error: "Failed to fetch recent releases" });
    }
});

/**
 * POST /releases/download/:albumMbid
 * 
 * Download a release from the radar
 */
router.post("/download/:albumMbid", async (req, res) => {
    try {
        const { albumMbid } = req.params;
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({ error: "Authentication required" });
        }

        logger.debug(`[Releases] Download requested for album: ${albumMbid}`);

        // TODO: Implement downloadAlbum method on LidarrService
        // For now, return not implemented error
        res.status(501).json({
            error: "Download feature not yet implemented for release radar"
        });
    } catch (error: any) {
        logger.error("[Releases] Download error:", error.message);
        res.status(500).json({ error: "Failed to start download" });
    }
});

export default router;
