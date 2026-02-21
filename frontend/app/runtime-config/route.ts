import { NextResponse } from "next/server";

const VALID_STREAMING_ENGINE_MODES = new Set([
    "videojs",
    "howler-rollback",
]);
const VALID_SEGMENTED_VHS_PROFILES = new Set(["balanced", "legacy"]);
const SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MIN_MS = 1500;
const SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MAX_MS = 15000;

const normalizeStreamingEngineMode = (value: string | undefined): string | null => {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) {
        return null;
    }
    return VALID_STREAMING_ENGINE_MODES.has(normalized) ? normalized : null;
};

const normalizeSegmentedStartupFallbackTimeoutMs = (
    value: string | undefined,
): number | null => {
    const parsed = Number.parseInt(value?.trim() ?? "", 10);
    if (!Number.isFinite(parsed)) {
        return null;
    }

    return Math.min(
        SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MAX_MS,
        Math.max(SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MIN_MS, parsed),
    );
};

const normalizeSegmentedVhsProfile = (value: string | undefined): string | null => {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) {
        return null;
    }
    return VALID_SEGMENTED_VHS_PROFILES.has(normalized) ? normalized : null;
};

export const dynamic = "force-dynamic";

export function GET() {
    const mode = normalizeStreamingEngineMode(process.env.STREAMING_ENGINE_MODE);
    const modeJson = mode ? JSON.stringify(mode) : "null";
    const segmentedVhsProfile = normalizeSegmentedVhsProfile(
        process.env.SEGMENTED_VHS_PROFILE,
    );
    const segmentedVhsProfileJson = segmentedVhsProfile
        ? JSON.stringify(segmentedVhsProfile)
        : "null";
    const segmentedStartupFallbackTimeoutMs =
        normalizeSegmentedStartupFallbackTimeoutMs(
            process.env.SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS,
        );
    const segmentedStartupFallbackTimeoutJson =
        segmentedStartupFallbackTimeoutMs !== null
            ? String(segmentedStartupFallbackTimeoutMs)
            : "null";

    const payload = `window.__SOUNDSPAN_RUNTIME_CONFIG__ = Object.assign(
  {},
  window.__SOUNDSPAN_RUNTIME_CONFIG__ || {},
  {
    STREAMING_ENGINE_MODE: ${modeJson},
    SEGMENTED_VHS_PROFILE: ${segmentedVhsProfileJson},
    SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS: ${segmentedStartupFallbackTimeoutJson},
  },
);
`;

    return new NextResponse(payload, {
        headers: {
            "content-type": "application/javascript; charset=utf-8",
            "cache-control": "no-store, max-age=0",
        },
    });
}
