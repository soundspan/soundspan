import { Router } from "express";
import { requireAuthOrToken } from "../../middleware/auth";
import {
    apiLimiter,
    imageLimiter,
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
const metadataBeforeMediaRouter = Router();
const imageRouter = Router();
const streamingRouter = Router();
const metadataAfterMediaRouter = Router();

// All routes require auth (session or API key)
router.use(requireAuthOrToken);

metadataBeforeMediaRouter.use(apiLimiter);
metadataBeforeMediaRouter.use(maintenanceRouter);
metadataBeforeMediaRouter.use(artistsListRouter);
metadataBeforeMediaRouter.use(artistCountsRouter);
metadataBeforeMediaRouter.use(imageBackfillRouter);
metadataBeforeMediaRouter.use(metadataBackfillRouter);
metadataBeforeMediaRouter.use(artistsDetailRouter);
metadataBeforeMediaRouter.use(albumsBrowseRouter);
metadataBeforeMediaRouter.use(tracksBrowseRouter);

imageRouter.use(imageLimiter);
imageRouter.use(coverArtRouter);

streamingRouter.use(streamingLimiter);
streamingRouter.use(tracksStreamRouter);

metadataAfterMediaRouter.use(apiLimiter);
metadataAfterMediaRouter.use(tracksPreferenceReadRouter);
metadataAfterMediaRouter.use(albumsPreferenceRouter);
metadataAfterMediaRouter.use(tracksPreferenceWriteRouter);
metadataAfterMediaRouter.use(remoteTracksRouter);
metadataAfterMediaRouter.use(tracksDetailRouter);
metadataAfterMediaRouter.use(tracksDeletionRouter);
metadataAfterMediaRouter.use(albumsDeletionRouter);
metadataAfterMediaRouter.use(artistsDeletionRouter);
metadataAfterMediaRouter.use(radioPlaylistRouter);
metadataAfterMediaRouter.use(radioRouter);

router.use(metadataBeforeMediaRouter);
router.use(imageRouter);
router.use(streamingRouter);
router.use(metadataAfterMediaRouter);

export default router;
