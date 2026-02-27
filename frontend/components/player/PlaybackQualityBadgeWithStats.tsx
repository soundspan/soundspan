"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { X } from "lucide-react";
import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useIsMobile } from "@/hooks/useMediaQuery";
import {
    useStreamBitrate,
    friendlyCodecName,
    formatSampleRateKHz,
    isLikelyLosslessTidal,
    estimateTidalLossyBitrateKbps,
    type PlaybackQualityBadge as PlaybackQualityBadgeValue,
} from "@/hooks/useStreamBitrate";
import { PlaybackQualityBadge } from "./PlaybackQualityBadge";

type BadgeSize = "mini" | "full";

interface PlaybackQualityBadgeWithStatsProps {
    badge: PlaybackQualityBadgeValue;
    size: BadgeSize;
}

const VARIANT_ACCENT: Record<PlaybackQualityBadgeValue["variant"], string> = {
    tidal: "text-[#00BFFF]",
    youtube: "text-red-400",
    local: "text-emerald-400",
};

const SERVICE_LABELS: Record<PlaybackQualityBadgeValue["variant"], string> = {
    tidal: "TIDAL",
    youtube: "YouTube Music",
    local: "Local Library",
};

function StatRow({
    label,
    value,
}: {
    label: string;
    value: string | number | null | undefined | boolean;
}) {
    if (value === null || value === undefined) return null;
    const display = typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
    return (
        <div className="flex items-baseline justify-between gap-3">
            <span className="text-gray-400 text-xs whitespace-nowrap">{label}</span>
            <span className="text-white text-xs font-medium text-right truncate">
                {display}
            </span>
        </div>
    );
}

export function PlaybackQualityBadgeWithStats({
    badge,
    size,
}: PlaybackQualityBadgeWithStatsProps) {
    const [isOpen, setIsOpen] = useState(false);
    const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const isMobile = useIsMobile();

    const { currentTrack, playbackType } = useAudioState();
    const { streamProfile } = useAudioPlayback();
    const { tidalQuality, localQuality, bitrate, codec } = useStreamBitrate();

    const clearCloseTimeout = useCallback(() => {
        if (closeTimeoutRef.current) {
            clearTimeout(closeTimeoutRef.current);
            closeTimeoutRef.current = null;
        }
    }, []);

    const handleMouseEnter = useCallback(() => {
        if (isMobile) return;
        clearCloseTimeout();
        setIsOpen(true);
    }, [isMobile, clearCloseTimeout]);

    const handleMouseLeave = useCallback(() => {
        if (isMobile) return;
        clearCloseTimeout();
        closeTimeoutRef.current = setTimeout(() => {
            setIsOpen(false);
        }, 150);
    }, [isMobile, clearCloseTimeout]);

    const handleClick = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            if (isMobile) {
                setIsOpen((prev) => !prev);
            }
        },
        [isMobile],
    );

    const handleClose = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        setIsOpen(false);
    }, []);

    // Close on outside click (mobile)
    useEffect(() => {
        if (!isOpen || !isMobile) return;
        const handleOutsideClick = (e: MouseEvent) => {
            if (
                containerRef.current &&
                !containerRef.current.contains(e.target as Node)
            ) {
                setIsOpen(false);
            }
        };
        document.addEventListener("mousedown", handleOutsideClick);
        return () => document.removeEventListener("mousedown", handleOutsideClick);
    }, [isOpen, isMobile]);

    // Cleanup timeout on unmount
    useEffect(() => {
        return () => clearCloseTimeout();
    }, [clearCloseTimeout]);

    // Build stat rows based on stream source
    const rows: { label: string; value: string | number | boolean | null | undefined }[] = [];
    const variant = badge.variant;

    rows.push({ label: "Service", value: SERVICE_LABELS[variant] });

    if (variant === "local" && currentTrack?.filePath) {
        const parts = currentTrack.filePath.split(/[/\\]/);
        rows.push({ label: "File", value: parts[parts.length - 1] });
    }

    if (variant === "tidal" && tidalQuality) {
        rows.push({
            label: "Codec",
            value: friendlyCodecName(tidalQuality.codec).toUpperCase(),
        });
        rows.push({ label: "Quality", value: tidalQuality.quality });
        const tidalBitrate = isLikelyLosslessTidal(tidalQuality)
            ? null
            : estimateTidalLossyBitrateKbps(tidalQuality.quality);
        rows.push({
            label: "Bitrate",
            value: tidalBitrate ? `${tidalBitrate} kbps` : null,
        });
        rows.push({
            label: "Bit Depth",
            value: tidalQuality.bitDepth ? `${tidalQuality.bitDepth}-bit` : null,
        });
        rows.push({
            label: "Sample Rate",
            value: formatSampleRateKHz(tidalQuality.sampleRate),
        });
        rows.push({
            label: "Lossless",
            value: isLikelyLosslessTidal(tidalQuality),
        });
    } else if (variant === "youtube") {
        rows.push({
            label: "Codec",
            value: codec ? friendlyCodecName(codec).toUpperCase() : null,
        });
        rows.push({
            label: "Bitrate",
            value: bitrate && bitrate > 0 ? `${bitrate} kbps` : null,
        });
    } else if (variant === "local" && localQuality) {
        rows.push({
            label: "Codec",
            value: friendlyCodecName(localQuality.codec).toUpperCase(),
        });
        rows.push({
            label: "Bitrate",
            value:
                localQuality.bitrate && localQuality.bitrate > 0
                    ? `${localQuality.bitrate} kbps`
                    : null,
        });
        rows.push({
            label: "Bit Depth",
            value: localQuality.bitDepth ? `${localQuality.bitDepth}-bit` : null,
        });
        rows.push({
            label: "Sample Rate",
            value: formatSampleRateKHz(localQuality.sampleRate),
        });
        rows.push({ label: "Lossless", value: localQuality.lossless });
    }

    // Delivery mode (local only, when stream profile available)
    if (
        variant === "local" &&
        streamProfile?.sourceType === "local" &&
        streamProfile.mode
    ) {
        rows.push({
            label: "Delivery",
            value: streamProfile.mode === "direct" ? "Direct" : "DASH",
        });
    }

    const filteredRows = rows.filter(
        (r) => r.value !== null && r.value !== undefined,
    );

    return (
        <div
            ref={containerRef}
            className="relative inline-flex"
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
        >
            <div onClick={handleClick} className="cursor-pointer">
                <PlaybackQualityBadge badge={badge} size={size} />
            </div>

            {/* Stats popup */}
            <div
                className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 bg-[#1a1a1a] border border-white/10 rounded-lg shadow-2xl shadow-black/50 p-3 backdrop-blur-xl z-[10002] transition-all duration-200 ${
                    isOpen
                        ? "opacity-100 scale-100 pointer-events-auto"
                        : "opacity-0 scale-95 pointer-events-none"
                }`}
            >
                {/* Pointer arrow */}
                <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-[#1a1a1a] border-r border-b border-white/10 rotate-45" />

                {/* Title */}
                <div className="flex items-center justify-between mb-2">
                    <h3
                        className={`font-bold text-xs ${VARIANT_ACCENT[variant]}`}
                    >
                        Stream Info
                    </h3>
                    {isMobile && (
                        <button
                            onClick={handleClose}
                            className="text-gray-400 hover:text-white transition-colors p-0.5"
                            aria-label="Close stream info"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>

                {/* Stat rows */}
                <div className="space-y-1.5">
                    {filteredRows.map((row) => (
                        <StatRow
                            key={row.label}
                            label={row.label}
                            value={row.value}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}
