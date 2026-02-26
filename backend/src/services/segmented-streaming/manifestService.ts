import {
    segmentedSegmentService,
    type EnsureLocalDashSegmentsInput,
    type LocalDashSegmentAsset,
    type SegmentedDashManifestProfile,
} from "./segmentService";

export type SegmentedManifestQuality = "original" | "high" | "medium" | "low";
export type SegmentedManifestProfile = SegmentedDashManifestProfile;

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
