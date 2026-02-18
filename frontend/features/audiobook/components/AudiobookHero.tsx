"use client";

import { Book } from "lucide-react";
import Image from "next/image";
import { ReactNode } from "react";
import type { Audiobook } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";

interface AudiobookHeroProps {
  audiobook: Audiobook;
  heroImage: string | null;
  colors: ColorPalette | null;
  metadata: {
    narrator: string | null;
    genre: string | null;
    publishedYear: string | null;
    description: string | null;
  } | null;
  formatTime: (seconds: number) => string;
  children?: ReactNode;
}

export function AudiobookHero({
  audiobook,
  heroImage,
  colors,
  metadata,
  formatTime,
  children,
}: AudiobookHeroProps) {
  const progressPercent = audiobook.progress?.progress || 0;
  const isFinished = audiobook.progress?.isFinished;

  return (
    <div className="relative">
      {/* Background with VibrantJS gradient */}
      {heroImage ? (
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute inset-0 scale-110 blur-md opacity-50">
            <Image
              src={heroImage}
              alt={audiobook.title}
              fill
              sizes="100vw"
              className="object-cover"
              priority
              unoptimized
            />
          </div>
          <div
            className="absolute inset-0"
            style={{
              background: colors
                ? `linear-gradient(to bottom, ${colors.vibrant}30 0%, ${colors.darkVibrant}60 40%, ${colors.darkMuted}90 70%, #0a0a0a 100%)`
                : "linear-gradient(to bottom, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.7) 40%, #0a0a0a 100%)",
            }}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0a] via-transparent to-transparent" />
        </div>
      ) : (
        <div
          className="absolute inset-0"
          style={{
            background: colors
              ? `linear-gradient(to bottom, ${colors.vibrant}40 0%, ${colors.darkVibrant}80 50%, #0a0a0a 100%)`
              : "linear-gradient(to bottom, #3d2a1e 0%, #1a1a1a 50%, #0a0a0a 100%)",
          }}
        />
      )}

      {/* Compact Hero Content - Full Width */}
      <div className="relative px-4 md:px-8 pt-16 pb-6">
        <div className="flex items-end gap-6">
          {/* Cover Art - Square for audiobooks */}
          <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[#282828] rounded-lg shadow-2xl shrink-0 overflow-hidden relative">
            {heroImage ? (
              <Image
                src={heroImage}
                alt={audiobook.title}
                fill
                sizes="(max-width: 768px) 140px, 192px"
                className="object-cover"
                priority
                unoptimized
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <Book className="w-16 h-16 text-gray-600" />
              </div>
            )}
          </div>

          {/* Info - Bottom Aligned */}
          <div className="flex-1 min-w-0 pb-1">
            <p className="text-xs font-medium text-white/90 mb-1">
              Audiobook
            </p>
            <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2">
              {audiobook.title}
            </h1>
            
            {/* Metadata row */}
            <div className="flex flex-wrap items-center gap-1.5 text-sm text-white/70">
              <span className="font-semibold text-white">{audiobook.author}</span>
              {metadata?.narrator && (
                <>
                  <span className="mx-1">•</span>
                  <span>{metadata.narrator}</span>
                </>
              )}
              <span className="mx-1">•</span>
              <span>{formatTime(audiobook.duration)}</span>
              <span className="mx-1">•</span>
              <span className={isFinished ? "text-green-400" : "text-[#3b82f6]"}>
                {isFinished ? "Finished" : `${Math.round(progressPercent)}% complete`}
              </span>
            </div>

            {/* Series & Genre tags - compact */}
            {(audiobook.series || audiobook.genres?.length > 0) && (
              <div className="hidden md:flex flex-wrap gap-1.5 mt-3">
                {audiobook.series && (
                  <span className="px-2.5 py-0.5 bg-white/10 rounded-full text-xs text-white/80">
                    {audiobook.series.name} #{audiobook.series.sequence}
                  </span>
                )}
                {audiobook.genres?.slice(0, 3).map((genre: string) => (
                  <span
                    key={genre}
                    className="px-2.5 py-0.5 bg-white/10 rounded-full text-xs text-white/80"
                  >
                    {genre}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Action Bar - Full Width */}
      {children && (
        <div className="relative px-4 md:px-8 pb-4">
          {children}
        </div>
      )}
    </div>
  );
}
