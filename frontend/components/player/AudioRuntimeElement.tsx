"use client";

import { AudioPlaybackOrchestrator } from "@/components/player/AudioPlaybackOrchestrator";

/**
 * Runtime audio host. Engine selection is delegated to the runtime engine
 * factory consumed by AudioPlaybackOrchestrator.
 */
export function AudioRuntimeElement() {
    return <AudioPlaybackOrchestrator />;
}
