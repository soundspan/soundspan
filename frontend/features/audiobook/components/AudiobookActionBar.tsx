"use client";

import { Play, Pause, RotateCcw, CheckCircle, Loader2 } from "lucide-react";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import type { Audiobook } from "../types";

interface AudiobookActionBarProps {
  audiobook: Audiobook;
  isThisBookPlaying?: boolean;
  isPlaying?: boolean;
  currentTime?: number;
  onPlayPause?: () => void;
  onResetProgress: () => void;
  onMarkAsCompleted: () => void;
  formatTime?: (seconds: number) => string;
}

export function AudiobookActionBar({
  audiobook,
  isThisBookPlaying = false,
  isPlaying = false,
  currentTime = 0,
  onPlayPause,
  onResetProgress,
  onMarkAsCompleted,
  formatTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`,
}: AudiobookActionBarProps) {
  const { showSpinner, triggerPlayFeedback } = usePlayButtonFeedback();
  const hasProgress = audiobook.progress && audiobook.progress.progress > 0;
  const isFinished = audiobook.progress?.isFinished;
  const showingPause = isThisBookPlaying && isPlaying;
  const handlePlayPauseClick = () => {
    if (!onPlayPause) return;
    triggerPlayFeedback();
    onPlayPause();
  };

  return (
    <div className="flex items-center gap-4">
      {/* Play/Pause Button - Yellow like other pages */}
      {onPlayPause && (
        <button
          onClick={handlePlayPauseClick}
          className="w-14 h-14 rounded-full bg-[#60a5fa] hover:bg-[#93c5fd] hover:scale-105 transition-all flex items-center justify-center shadow-lg"
          title={showingPause ? "Pause" : (hasProgress && !isFinished ? "Resume" : "Play")}
        >
          {showSpinner ? (
            <Loader2 className="w-6 h-6 text-black animate-spin" />
          ) : showingPause ? (
            <Pause className="w-6 h-6 text-black" />
          ) : (
            <Play className="w-6 h-6 text-black ml-1" fill="black" />
          )}
        </button>
      )}

      {/* Progress indicator - compact inline */}
      {hasProgress && !isFinished && (
        <div className="hidden sm:flex items-center gap-3">
          <div className="text-sm">
            <span className="text-white/60">
              {formatTime(isThisBookPlaying ? currentTime : audiobook.progress.currentTime)}
            </span>
            <span className="text-white/40 mx-1">/</span>
            <span className="text-white/60">{formatTime(audiobook.duration)}</span>
          </div>
          <div className="w-24 h-1 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-[#3b82f6] rounded-full transition-all"
              style={{
                width: `${isThisBookPlaying ? (currentTime / audiobook.duration) * 100 : audiobook.progress.progress}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Action buttons - right side */}
      <div className="flex items-center gap-2">
        {hasProgress && !isFinished && (
          <>
            <button
              onClick={onResetProgress}
              className="p-2.5 rounded-full text-white/60 hover:text-white hover:bg-white/10 transition-all"
              title="Reset progress"
            >
              <RotateCcw className="w-5 h-5" />
            </button>
            <button
              onClick={onMarkAsCompleted}
              className="p-2.5 rounded-full text-green-400/80 hover:text-green-400 hover:bg-green-500/10 transition-all"
              title="Mark as completed"
            >
              <CheckCircle className="w-5 h-5" />
            </button>
          </>
        )}
        
        {isFinished && (
          <button
            onClick={onResetProgress}
            className="px-4 py-2 rounded-full text-sm font-medium bg-white/5 text-white/70 hover:bg-white/10 hover:text-white transition-all flex items-center gap-2"
            title="Listen again"
          >
            <RotateCcw className="w-4 h-4" />
            <span>Listen Again</span>
          </button>
        )}
      </div>
    </div>
  );
}
