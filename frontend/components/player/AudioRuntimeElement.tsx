"use client";

import { HowlerAudioElement } from "@/components/player/HowlerAudioElement";

/**
 * Runtime audio host. Engine selection is delegated to the runtime engine
 * factory consumed by HowlerAudioElement.
 */
export function AudioRuntimeElement() {
    return <HowlerAudioElement />;
}
