"use client";

import { useCallback } from "react";
import { useAudio } from "@/lib/audio-context";
import { useAudioState } from "@/lib/audio-state-context";
import { useToast } from "@/lib/toast-context";
import { api } from "@/lib/api";
import type { Audiobook } from "../types";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

export function useAudiobookActions(
  audiobookId: string,
  audiobook: Audiobook | null,
  refetch: () => void
) {
  const {
    currentAudiobook,
    playbackType,
    isPlaying,
    pause,
    resume,
    playAudiobook,
    currentTime,
    updateCurrentTime,
    seek,
  } = useAudio();
  const { setCurrentAudiobook, setPlaybackType } = useAudioState();
  const { toast } = useToast();

  const isThisBookPlaying =
    currentAudiobook?.id === audiobookId && playbackType === "audiobook";

  const handlePlayPause = useCallback(() => {
    if (!audiobook) return;

    // If no audiobook playing, or a DIFFERENT audiobook is playing, start this one
    if (!currentAudiobook || currentAudiobook.id !== audiobookId) {
      playAudiobook(audiobook);
    } else if (isPlaying) {
      // Same audiobook is playing - pause it
      pause();
    } else {
      // Same audiobook is paused - resume it
      resume();
    }
  }, [audiobook, audiobookId, currentAudiobook, isPlaying, pause, resume, playAudiobook]);

  const handleMarkAsCompleted = useCallback(async () => {
    if (!audiobook) return;

    try {
      const isCurrentlyPlaying =
        currentAudiobook?.id === audiobookId && playbackType === "audiobook";

      if (isCurrentlyPlaying && isPlaying) {
        pause();
      }

      await api.updateAudiobookProgress(
        audiobookId,
        audiobook.duration || 0,
        audiobook.duration || 0,
        true
      );

      if (currentAudiobook?.id === audiobookId) {
        const finalDuration = audiobook.duration || currentAudiobook.duration || 0;
        setCurrentAudiobook({
          ...currentAudiobook,
          progress: {
            currentTime: finalDuration,
            progress: finalDuration > 0 ? 100 : 0,
            isFinished: true,
            lastPlayedAt: new Date(),
          },
        });
      }

      toast.success("Marked as completed");
      refetch();
    } catch (error) {
      sharedFrontendLogger.error("Failed to mark as completed:", error);
      toast.error("Failed to mark as completed");
    }
  }, [
    audiobook,
    audiobookId,
    currentAudiobook,
    playbackType,
    isPlaying,
    pause,
    setCurrentAudiobook,
    toast,
    refetch,
  ]);

  const handleResetProgress = useCallback(async () => {
    try {
      const isCurrentlyPlaying =
        currentAudiobook?.id === audiobookId && playbackType === "audiobook";

      if (isCurrentlyPlaying && isPlaying) {
        pause();
      }

      await api.deleteAudiobookProgress(audiobookId);

      if (currentAudiobook?.id === audiobookId) {
        setCurrentAudiobook(null);
        setPlaybackType(null);
        updateCurrentTime(0);
      }

      toast.success("Progress reset");
      refetch();
    } catch (error) {
      sharedFrontendLogger.error("Failed to reset progress:", error);
      toast.error("Failed to reset progress");
    }
  }, [
    audiobookId,
    currentAudiobook,
    playbackType,
    isPlaying,
    pause,
    setCurrentAudiobook,
    setPlaybackType,
    updateCurrentTime,
    toast,
    refetch,
  ]);

  const seekToChapter = useCallback(
    (startTime: number) => {
      if (!audiobook) return;

      // If this book is not currently loaded, start playback first
      if (!isThisBookPlaying) {
        playAudiobook(audiobook);
      }

      // Perform an actual player seek so audio jumps to the chapter
      seek(startTime);
    },
    [audiobook, isThisBookPlaying, playAudiobook, seek]
  );

  return {
    isThisBookPlaying,
    isPlaying,
    currentTime,
    handlePlayPause,
    handleMarkAsCompleted,
    handleResetProgress,
    seekToChapter,
  };
}
