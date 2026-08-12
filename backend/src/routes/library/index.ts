import { Router } from "express";
import { requireAuthOrToken } from "../../middleware/auth";
import { apiLimiter } from "../../middleware/rateLimiter";
import { maintenanceRouter } from "./maintenance";
import {
    artistsListRouter,
    artistsDetailRouter,
    artistsDeletionRouter,
} from "./artists";
import { artistCountsRouter } from "./artistCounts";
import { imageBackfillRouter } from "./imageBackfill";
import { metadataBackfillRouter } from "./metadataBackfill";
import {
    albumsBrowseRouter,
    albumsPreferenceRouter,
    albumsDeletionRouter,
} from "./albums";
import {
    tracksBrowseRouter,
    tracksStreamRouter,
    tracksPreferenceReadRouter,
    tracksPreferenceWriteRouter,
    tracksDetailRouter,
    tracksDeletionRouter,
} from "./tracks";
import { coverArtRouter } from "./coverArt";
import { remoteTracksRouter } from "./remoteTracks";
import { radioRouter } from "./radio";

const router = Router();

// All routes require auth (session or API key)
router.use(requireAuthOrToken);

// Apply API rate limiter to routes that need it
// Skip rate limiting for high-traffic endpoints (cover-art, streaming)
router.use((req, res, next) => {
    // Skip rate limiting for cover-art endpoint (handled by imageLimiter separately)
    if (req.path.startsWith("/cover-art")) {
        return next();
    }
    // Skip rate limiting for streaming endpoints - audio must not be interrupted
    if (req.path.includes("/stream")) {
        return next();
    }
    // Apply API rate limiter to all other routes
    return apiLimiter(req, res, next);
});

router.use(maintenanceRouter);
router.use(artistsListRouter);
router.use(artistCountsRouter);
router.use(imageBackfillRouter);
router.use(metadataBackfillRouter);
router.use(artistsDetailRouter);
router.use(albumsBrowseRouter);
router.use(tracksBrowseRouter);
router.use(coverArtRouter);
router.use(tracksStreamRouter);
router.use(tracksPreferenceReadRouter);
router.use(albumsPreferenceRouter);
router.use(tracksPreferenceWriteRouter);
router.use(remoteTracksRouter);
router.use(tracksDetailRouter);
router.use(tracksDeletionRouter);
router.use(albumsDeletionRouter);
router.use(artistsDeletionRouter);
router.use(radioRouter);

export default router;
