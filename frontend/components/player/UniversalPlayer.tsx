"use client";

import { useAudio } from "@/lib/audio-context";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { MiniPlayer } from "./MiniPlayer";
import { FullPlayer } from "./FullPlayer";
import { OverlayPlayer } from "./OverlayPlayer";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";

/**
 * UniversalPlayer - Manages player UI rendering based on mode and device
 * NOTE: The AudioElement is rendered by ConditionalAudioProvider, NOT here
 * This component only handles the UI (MiniPlayer, FullPlayer, OverlayPlayer)
 *
 * Mobile/Tablet behavior:
 * - Mini player by default
 * - Overlay opens only via explicit user action
 * - No full-width player on mobile
 */
export function UniversalPlayer() {
    const { playerMode, currentTrack, currentAudiobook, currentPodcast } =
        useAudio();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    const hasMedia = !!(currentTrack || currentAudiobook || currentPodcast);

    return (
        <>
            {/* Conditional UI rendering based on mode and device */}
            {/* Note: AudioElement is rendered by ConditionalAudioProvider */}
            {/* Always show player UI (like Spotify), even when no media is playing */}
            {isMobileOrTablet ? (
                <LayoutGroup id="mobile-player-artwork-transition">
                    <AnimatePresence initial={false} mode="sync">
                        {playerMode === "overlay" && hasMedia ? (
                            <motion.div
                                key="overlay-player"
                                initial={{ opacity: 0, y: 18, scale: 0.995 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, y: 52, scale: 0.992 }}
                                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                            >
                                <OverlayPlayer />
                            </motion.div>
                        ) : (
                            /* On mobile/tablet: only mini player (no full player) */
                            <motion.div
                                key="mini-player"
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: 20 }}
                                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                            >
                                <MiniPlayer />
                            </motion.div>
                        )}
                    </AnimatePresence>
                </LayoutGroup>
            ) : (
                /* Desktop: FullPlayer always visible, overlay layers on top */
                <>
                    <FullPlayer />
                    <AnimatePresence initial={false}>
                        {playerMode === "overlay" && hasMedia && (
                            <motion.div
                                key="desktop-overlay-player"
                                initial={{ opacity: 0, y: 18, scale: 0.995 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, y: 22, scale: 0.998 }}
                                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                            >
                                <OverlayPlayer />
                            </motion.div>
                        )}
                    </AnimatePresence>
                </>
            )}
        </>
    );
}
