import { DiscoverWeeklyService } from "./generationService";
import { getTierFromSimilarity } from "./helpers";
import {
    createPrismaRetryProxy,
    isRetryableDiscoverWeeklyPrismaError,
} from "./state";

export { DiscoverWeeklyService };

/** Shared Discover Weekly service instance used by routes and workers. */
export const discoverWeeklyService = new DiscoverWeeklyService();

/** Stable test seams retained from the original service module. */
export const __discoverWeeklyTestables = {
    createPrismaRetryProxy,
    getTierFromSimilarity,
    isRetryableDiscoverWeeklyPrismaError,
};
