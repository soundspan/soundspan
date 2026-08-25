"use client";

import { createContext, useContext, type SetStateAction } from "react";
import type { PlayerMode } from "./audio-state-context";

/**
 * Volume and player-chrome state, split from the main audio state context so
 * a volume drag or player-mode switch re-renders only the components that
 * show those controls — not every queue/track state consumer (GH #785).
 *
 * The state itself lives in AudioStateProvider (persistence and cross-device
 * sync need it there); this module only owns the context identity and hook.
 */
export interface AudioVolumeModeContextType {
    volume: number;
    isMuted: boolean;
    playerMode: PlayerMode;
    previousPlayerMode: PlayerMode;
    setVolume: (volume: SetStateAction<number>) => void;
    setIsMuted: (muted: SetStateAction<boolean>) => void;
    setPlayerMode: (mode: SetStateAction<PlayerMode>) => void;
    setPreviousPlayerMode: (mode: SetStateAction<PlayerMode>) => void;
}

export const AudioVolumeModeContext = createContext<
    AudioVolumeModeContextType | undefined
>(undefined);

/** Reads volume/mute and player-mode state without the wide state context. */
export function useAudioVolumeMode(): AudioVolumeModeContextType {
    const context = useContext(AudioVolumeModeContext);
    if (!context) {
        throw new Error(
            "useAudioVolumeMode must be used within AudioStateProvider",
        );
    }
    return context;
}
