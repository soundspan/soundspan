import {
  DEFAULT_STREAMING_ENGINE_MODE,
  type StreamingEngineMode,
} from "@/lib/audio-engine/types";
import { normalizeStreamingEngineMode } from "../runtime-config/normalization";

const STREAMING_ENGINE_MODE_KEY = "STREAMING_ENGINE_MODE";
const SOUNDSPAN_RUNTIME_CONFIG_KEY = "__SOUNDSPAN_RUNTIME_CONFIG__";

const parseStreamingEngineModeInternal = (
  value: string | null | undefined,
): StreamingEngineMode => {
  return normalizeStreamingEngineMode(value) ?? DEFAULT_STREAMING_ENGINE_MODE;
};

const readRuntimeEngineMode = (): string | undefined => {
  if (typeof window === "undefined") {
    return undefined;
  }

  const runtimeConfig = (
    window as Window & {
      [SOUNDSPAN_RUNTIME_CONFIG_KEY]?: Record<string, unknown>;
    }
  )[SOUNDSPAN_RUNTIME_CONFIG_KEY];
  const runtimeValue = runtimeConfig?.[STREAMING_ENGINE_MODE_KEY];
  return typeof runtimeValue === "string" ? runtimeValue : undefined;
};

export const parseStreamingEngineMode = (
  value: string | null | undefined,
): StreamingEngineMode => parseStreamingEngineModeInternal(value);

export const resolveStreamingEngineMode = (
  value?: StreamingEngineMode | string,
): StreamingEngineMode => {
  return parseStreamingEngineModeInternal(value ?? readRuntimeEngineMode());
};

export const isHowlerModeEnabled = (
  value?: StreamingEngineMode | string,
): boolean => {
  return resolveStreamingEngineMode(value) === "howler";
};

/**
 * True only when the experimental Video.js segmented mode is active.
 * Segmented startup/prewarm/session paths must key on this instead of
 * `mode !== "howler"` — direct modes like "native" are not segmented,
 * and a bare audio element cannot play DASH manifests (GH #42).
 */
export const isSegmentedModeEnabled = (
  value?: StreamingEngineMode | string,
): boolean => {
  return resolveStreamingEngineMode(value) === "videojs";
};
