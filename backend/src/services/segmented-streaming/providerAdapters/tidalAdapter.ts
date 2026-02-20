import { prisma } from "../../../utils/db";
import { decrypt } from "../../../utils/encryption";
import { tidalStreamingService } from "../../tidalStreaming";
import {
    segmentedManifestService,
    type LocalDashAsset,
    type SegmentedManifestQuality,
} from "../manifestService";
import { SegmentedProviderAdapterError } from "./adapterError";

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
        const normalizedTrackId = normalizeTidalTrackId(input.tidalTrackId);

        const userSettings = await prisma.userSettings.findUnique({
            where: { userId: input.userId },
            select: {
                tidalOAuthJson: true,
                tidalStreamingQuality: true,
            },
        });

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

        const restored = await tidalStreamingService.restoreOAuth(
            input.userId,
            oauthJson,
        );
        if (!restored) {
            throw new SegmentedProviderAdapterError(
                "TIDAL authentication could not be restored",
                401,
                "TIDAL_AUTH_RESTORE_FAILED",
            );
        }

        try {
            await tidalStreamingService.getStreamInfo(
                input.userId,
                normalizedTrackId,
                preferredQuality,
            );
        } catch (error) {
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

        const asset = await segmentedManifestService.getOrCreateLocalDashAsset({
            trackId: `tidal:${normalizedTrackId}`,
            sourcePath: sourceUrl,
            sourceModified: new Date(0),
            quality: input.quality,
            cacheIdentity: `tidal:${normalizedTrackId}:${preferredQuality}`,
        });

        return {
            providerTrackId: String(normalizedTrackId),
            asset,
        };
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
