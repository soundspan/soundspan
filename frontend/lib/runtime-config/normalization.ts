import type { StreamingEngineMode } from "../audio-engine/types";

const VALID_STREAMING_ENGINE_MODES = new Set<StreamingEngineMode>([
    "howler",
    "native",
]);

export type RuntimeConfigEnvironment = Record<string, string | undefined>;

const normalizeConfigString = (
    value: string | null | undefined,
): string | null => {
    const normalized = value?.trim().toLowerCase();
    return normalized || null;
};

export const normalizeStreamingEngineMode = (
    value: string | null | undefined,
): StreamingEngineMode | null => {
    const normalized = normalizeConfigString(value);
    if (!normalized) {
        return null;
    }

    return VALID_STREAMING_ENGINE_MODES.has(normalized as StreamingEngineMode)
        ? (normalized as StreamingEngineMode)
        : null;
};

export const buildRuntimeConfigPayload = (
    env: RuntimeConfigEnvironment,
): string => {
    const mode = normalizeStreamingEngineMode(env.STREAMING_ENGINE_MODE);
    const modeJson = mode ? JSON.stringify(mode) : "null";

    return `window.__SOUNDSPAN_RUNTIME_CONFIG__ = Object.assign(
  {},
  window.__SOUNDSPAN_RUNTIME_CONFIG__ || {},
  {
    STREAMING_ENGINE_MODE: ${modeJson},
  },
);
`;
};
