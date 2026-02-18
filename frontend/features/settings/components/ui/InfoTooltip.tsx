"use client";

import { Info } from "lucide-react";
import { useState } from "react";

interface InfoTooltipProps {
    text: string;
}

export function InfoTooltip({ text }: InfoTooltipProps) {
    const [showTooltip, setShowTooltip] = useState(false);

    return (
        <span className="relative inline-flex">
            <button
                type="button"
                onMouseEnter={() => setShowTooltip(true)}
                onMouseLeave={() => setShowTooltip(false)}
                onClick={() => setShowTooltip((current) => !current)}
                className="inline-flex items-center rounded p-0.5 text-gray-400 hover:text-white transition-colors"
                aria-label="More info"
                title="More info"
            >
                <Info className="h-3.5 w-3.5" />
            </button>
            {showTooltip && (
                <span className="absolute left-0 top-full z-30 mt-1 w-72 rounded-md border border-white/15 bg-[#141414] p-2 text-[11px] leading-relaxed text-gray-300 shadow-2xl">
                    {text}
                </span>
            )}
        </span>
    );
}
