import { Router } from "express";
import { requireAuthOrToken } from "../../middleware/auth";
import {
    coverArtLimiter,
    libraryMetadataLimiter,
    streamingLimiter,
} from "../../middleware/rateLimiter";
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
import { radioPlaylistRouter } from "./radioPlaylists";

const router = Router();

router.use(
    ["/cover-art", "/album-cover", "/cover-art-colors"],
    coverArtLimiter,
);
router.use("/tracks/:trackId/stream", streamingLimiter);
router.use(libraryMetadataLimiter);

// All routes require auth (session or API key) after abuse controls run.
router.use(requireAuthOrToken);

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
router.use(radioPlaylistRouter);
router.use(radioRouter);

export default router;
