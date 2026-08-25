"use client";

import { useCallback } from "react";
import { clampAudioVolume } from "@/lib/audio-volume";
import type { PlayerMode } from "./audio-state-context";
import type { AudioVolumeModeContextType } from "./audio-volume-mode-context";

/**
 * Volume and player-chrome control callbacks for AudioControlsProvider.
 * Extracted so the provider stays under its size baseline and so these
 * callbacks depend only on the small volume/mode context — a volume drag
 * or mode switch never recreates the queue/track callbacks (GH #785).
 */
export function useVolumeModeControls(volumeMode: AudioVolumeModeContextType) {
    const {
        playerMode,
        previousPlayerMode,
        setPlayerMode,
        setPreviousPlayerMode,
        setVolume: setVolumeState,
        setIsMuted,
    } = volumeMode;

    const setPlayerModeWithHistory = useCallback(
        (mode: PlayerMode) => {
            setPreviousPlayerMode(playerMode);
            setPlayerMode(mode);
        },
        [playerMode, setPlayerMode, setPreviousPlayerMode],
    );

    const returnToPreviousMode = useCallback(() => {
        // Closing overlay should restore the platform-appropriate compact mode.
        // Mobile/tablet => mini, desktop => full.
        const deviceDefaultMode: PlayerMode =
            typeof window !== "undefined" &&
            window.matchMedia("(max-width: 1024px)").matches
                ? "mini"
                : "full";
        const targetMode =
            playerMode === "overlay" ? deviceDefaultMode : previousPlayerMode;
        const temp = playerMode;
        setPlayerMode(targetMode);
        setPreviousPlayerMode(temp);
    }, [playerMode, previousPlayerMode, setPlayerMode, setPreviousPlayerMode]);

    const setVolumeControl = useCallback(
        (newVolume: number) => {
            const clampedVolume = clampAudioVolume(newVolume);
            setVolumeState(clampedVolume);
            if (clampedVolume > 0) {
                setIsMuted(false);
            }
        },
        [setVolumeState, setIsMuted],
    );

    const toggleMute = useCallback(() => {
        setIsMuted((prev) => !prev);
    }, [setIsMuted]);

    return {
        setPlayerModeWithHistory,
        returnToPreviousMode,
        setVolumeControl,
        toggleMute,
    };
}
