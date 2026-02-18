"use client";

import { cn } from "@/utils/cn";

interface EqBarsProps {
    className?: string;
}

/**
 * Bouncing EQ bar animation — three bars that bounce at different speeds.
 * Used in the sidebar to indicate active Listen Together sessions.
 */
export function EqBars({ className }: EqBarsProps) {
    return (
        <div className={cn("inline-flex items-end gap-0.5 h-3", className)}>
            <span className="h-2 w-0.5 animate-bounce rounded-full bg-[#60a5fa] [animation-delay:-0.2s] motion-reduce:animate-none" />
            <span className="h-2.5 w-0.5 animate-bounce rounded-full bg-[#60a5fa] motion-reduce:animate-none" />
            <span className="h-1.5 w-0.5 animate-bounce rounded-full bg-[#60a5fa] [animation-delay:-0.35s] motion-reduce:animate-none" />
        </div>
    );
}
