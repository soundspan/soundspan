import {
    segmentedSegmentService,
    type EnsureLocalDashSegmentsInput,
    type LocalDashSegmentAsset,
} from "./segmentService";

export type SegmentedManifestQuality = "original" | "high" | "medium" | "low";

export interface LocalDashAssetRequest extends EnsureLocalDashSegmentsInput {}

export interface LocalDashAsset extends LocalDashSegmentAsset {}

class SegmentedManifestService {
    async getOrCreateLocalDashAsset(
        request: LocalDashAssetRequest,
    ): Promise<LocalDashAsset> {
        return segmentedSegmentService.ensureLocalDashSegments(request);
    }
}

export const segmentedManifestService = new SegmentedManifestService();
