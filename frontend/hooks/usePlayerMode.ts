import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useAudio } from "@/lib/audio-context";

/**
 * Hook that promotes mini -> full when viewing the currently playing media page.
 * Overlay mode remains manual and is never auto-switched by this hook.
 */
export function usePlayerMode() {
    const pathname = usePathname();
    const { currentTrack, currentAudiobook, currentPodcast, playerMode, setPlayerMode } = useAudio();

    useEffect(() => {
        // Don't auto-switch if in overlay mode (user manually opened it)
        if (playerMode === "overlay") return;

        // Don't auto-switch if no media is playing
        if (!currentTrack && !currentAudiobook && !currentPodcast) return;

        // Determine if we're on the EXACT page where the current media is playing
        const isOnCurrentMediaPage =
            (currentTrack && pathname === `/album/${currentTrack.album?.id}`) ||
            (currentAudiobook && pathname === `/audiobooks/${currentAudiobook.id}`) ||
            (currentPodcast && pathname.includes(`/podcasts/${currentPodcast.id}`));

        // Auto-expand to full when on the current media page
        // But don't auto-minimize - let users keep it expanded if they want
        if (isOnCurrentMediaPage && playerMode === "mini") {
            setPlayerMode("full");
        }
    }, [
        pathname,
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playerMode,
        setPlayerMode,
    ]);
}
