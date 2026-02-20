import { prisma } from "../../../utils/db";
import { decrypt } from "../../../utils/encryption";
import { tidalStreamingService } from "../../tidalStreaming";
import {
    segmentedManifestService,
    type LocalDashAsset,
    type SegmentedManifestQuality,
} from "../manifestService";
import { SegmentedProviderAdapterError } from "./adapterError";
import {
    logSegmentedStreamingTrace,
    segmentedTraceDurationMs,
    toSegmentedTraceErrorFields,
} from "../trace";

const DEFAULT_TIDAL_STREAM_QUALITY = "HIGH";
const TIDAL_STREAM_QUALITY_VALUES = new Set([
    "LOW",
    "HIGH",
    "LOSSLESS",
    "HI_RES",
    "HI_RES_LOSSLESS",
]);

export interface CreateTidalSegmentedAssetInput {
    userId: string;
    tidalTrackId: number;
    quality: SegmentedManifestQuality;
}

export interface CreateTidalSegmentedAssetResult {
    providerTrackId: string;
    asset: LocalDashAsset;
}

class TidalSegmentedProviderAdapter {
    private readonly sidecarBaseUrl =
        process.env.TIDAL_SIDECAR_URL || "http://127.0.0.1:8585";

    async getOrCreateDashAsset(
        input: CreateTidalSegmentedAssetInput,
    ): Promise<CreateTidalSegmentedAssetResult> {
        const startedAtMs = Date.now();
        let phase = "user_settings";
        let userSettingsMs: number | undefined;
        let restoreOAuthMs: number | undefined;
        let streamInfoMs: number | undefined;
        let assetBuildMs: number | undefined;
        const normalizedTrackId = normalizeTidalTrackId(input.tidalTrackId);

        try {
            const userSettingsStartedAtMs = Date.now();
            const userSettings = await prisma.userSettings.findUnique({
                where: { userId: input.userId },
                select: {
                    tidalOAuthJson: true,
                    tidalStreamingQuality: true,
                },
            });
            userSettingsMs = segmentedTraceDurationMs(userSettingsStartedAtMs);

            if (!userSettings?.tidalOAuthJson) {
                throw new SegmentedProviderAdapterError(
                    "TIDAL authentication is required",
                    401,
                    "TIDAL_AUTH_REQUIRED",
                );
            }

            const preferredQuality = normalizeTidalStreamQuality(
                userSettings.tidalStreamingQuality,
            );
            const oauthJson = decodeStoredOAuth(userSettings.tidalOAuthJson);

            phase = "restore_oauth";
            const restoreOAuthStartedAtMs = Date.now();
            const restored = await tidalStreamingService.restoreOAuth(
                input.userId,
                oauthJson,
            );
            restoreOAuthMs = segmentedTraceDurationMs(restoreOAuthStartedAtMs);
            if (!restored) {
                throw new SegmentedProviderAdapterError(
                    "TIDAL authentication could not be restored",
                    401,
                    "TIDAL_AUTH_RESTORE_FAILED",
                );
            }

            phase = "stream_info";
            const streamInfoStartedAtMs = Date.now();
            try {
                await tidalStreamingService.getStreamInfo(
                    input.userId,
                    normalizedTrackId,
                    preferredQuality,
                );
                streamInfoMs = segmentedTraceDurationMs(streamInfoStartedAtMs);
            } catch (error) {
                streamInfoMs = segmentedTraceDurationMs(streamInfoStartedAtMs);
                const status = getResponseStatus(error);
                if (status === 401) {
                    throw new SegmentedProviderAdapterError(
                        "TIDAL authentication is required",
                        401,
                        "TIDAL_AUTH_REQUIRED",
                    );
                }

                if (status === 404) {
                    throw new SegmentedProviderAdapterError(
                        "TIDAL track was not found",
                        404,
                        "TIDAL_TRACK_NOT_FOUND",
                    );
                }

                throw new SegmentedProviderAdapterError(
                    "TIDAL stream metadata is unavailable",
                    502,
                    "TIDAL_STREAM_INFO_UNAVAILABLE",
                );
            }

            const sourceUrl = this.buildSidecarStreamUrl({
                userId: input.userId,
                tidalTrackId: normalizedTrackId,
                streamQuality: preferredQuality,
            });

            phase = "asset_build";
            const assetBuildStartedAtMs = Date.now();
            const asset = await segmentedManifestService.getOrCreateLocalDashAsset({
                trackId: `tidal:${normalizedTrackId}`,
                sourcePath: sourceUrl,
                sourceModified: new Date(0),
                quality: input.quality,
                cacheIdentity: `tidal:${normalizedTrackId}:${preferredQuality}`,
            });
            assetBuildMs = segmentedTraceDurationMs(assetBuildStartedAtMs);

            logSegmentedStreamingTrace("provider.tidal.asset_success", {
                trackId: String(normalizedTrackId),
                quality: input.quality,
                userSettingsMs,
                restoreOAuthMs,
                streamInfoMs,
                assetBuildMs,
                totalMs: segmentedTraceDurationMs(startedAtMs),
            });

            return {
                providerTrackId: String(normalizedTrackId),
                asset,
            };
        } catch (error) {
            logSegmentedStreamingTrace("provider.tidal.asset_error", {
                trackId: String(normalizedTrackId),
                quality: input.quality,
                phase,
                userSettingsMs,
                restoreOAuthMs,
                streamInfoMs,
                assetBuildMs,
                totalMs: segmentedTraceDurationMs(startedAtMs),
                ...toSegmentedTraceErrorFields(error),
            });
            throw error;
        }
    }

    private buildSidecarStreamUrl(params: {
        userId: string;
        tidalTrackId: number;
        streamQuality: string;
    }): string {
        const streamUrl = new URL(
            `/user/stream/${params.tidalTrackId}`,
            this.sidecarBaseUrl,
        );
        streamUrl.searchParams.set("user_id", params.userId);
        streamUrl.searchParams.set("quality", params.streamQuality);
        return streamUrl.toString();
    }
}

const decodeStoredOAuth = (storedValue: string): string => {
    try {
        return decrypt(storedValue);
    } catch {
        return storedValue;
    }
};

const normalizeTidalTrackId = (trackId: number): number => {
    if (!Number.isInteger(trackId) || trackId <= 0) {
        throw new SegmentedProviderAdapterError(
            "Invalid TIDAL track id",
            400,
            "INVALID_TIDAL_TRACK_ID",
        );
    }

    return trackId;
};

const normalizeTidalStreamQuality = (quality: string | null): string => {
    const normalized = quality?.trim().toUpperCase() ?? "";
    if (TIDAL_STREAM_QUALITY_VALUES.has(normalized)) {
        return normalized;
    }

    return DEFAULT_TIDAL_STREAM_QUALITY;
};

const getResponseStatus = (error: unknown): number | undefined => {
    if (!error || typeof error !== "object") {
        return undefined;
    }

    const maybeError = error as { response?: { status?: unknown } };
    return typeof maybeError.response?.status === "number"
        ? maybeError.response.status
        : undefined;
};

export const tidalSegmentedProviderAdapter = new TidalSegmentedProviderAdapter();
