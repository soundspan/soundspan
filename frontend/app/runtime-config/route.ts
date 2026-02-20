import { NextResponse } from "next/server";

const VALID_STREAMING_ENGINE_MODES = new Set([
    "videojs",
    "react-all-player",
    "howler-rollback",
]);

const normalizeStreamingEngineMode = (value: string | undefined): string | null => {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) {
        return null;
    }
    return VALID_STREAMING_ENGINE_MODES.has(normalized) ? normalized : null;
};

export const dynamic = "force-dynamic";

export function GET() {
    const mode = normalizeStreamingEngineMode(process.env.STREAMING_ENGINE_MODE);
    const modeJson = mode ? JSON.stringify(mode) : "null";

    const payload = `window.__SOUNDSPAN_RUNTIME_CONFIG__ = Object.assign(
  {},
  window.__SOUNDSPAN_RUNTIME_CONFIG__ || {},
  {
    STREAMING_ENGINE_MODE: ${modeJson},
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
