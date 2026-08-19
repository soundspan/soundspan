"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

interface InsightPanelProps {
    title: string;
    subtitle: string;
    isTruncated?: boolean;
    isLoading?: boolean;
    error?: string | null;
    /** Called the first time the panel is expanded (lazy drill-down fetch). */
    onFirstExpand?: () => void;
    /** Called by the Retry control rendered beside a load error. */
    onRetry?: () => void;
    children: ReactNode;
}

/** Collapsible card shared by every Library Insights drill-down panel. */
export function InsightPanel({
    title,
    subtitle,
    isTruncated = false,
    isLoading = false,
    error = null,
    onFirstExpand,
    onRetry,
    children,
}: Readonly<InsightPanelProps>) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [hasExpanded, setHasExpanded] = useState(false);
    const Chevron = isExpanded ? ChevronDown : ChevronRight;

    const toggle = () => {
        const next = !isExpanded;
        setIsExpanded(next);
        if (next && !hasExpanded) {
            setHasExpanded(true);
            onFirstExpand?.();
        }
    };

    return (
        <div className="bg-white/5 rounded-lg border border-white/10">
            <button
                type="button"
                onClick={toggle}
                className="w-full flex items-center justify-between gap-3 p-4 text-left"
                aria-expanded={isExpanded}
            >
                <div>
                    <div className="text-sm font-medium text-white">
                        {title}
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">
                        {subtitle}
                        {isTruncated && (
                            <span className="ml-2 text-amber-400">
                                (large library: counts are sampled)
                            </span>
                        )}
                    </div>
                </div>
                <Chevron className="w-4 h-4 text-gray-400 shrink-0" />
            </button>
            {isExpanded && (
                <div className="px-4 pb-4">
                    {isLoading && (
                        <div className="flex items-center gap-2 py-2 text-sm text-gray-300">
                            <Loader2 className="w-4 h-4 animate-spin text-brand" />
                            Loading…
                        </div>
                    )}
                    {error && (
                        <div className="py-2 text-sm text-red-400 flex items-center gap-3">
                            <span>{error}</span>
                            {onRetry && (
                                <button
                                    type="button"
                                    onClick={onRetry}
                                    className="px-2 py-1 text-xs rounded-full border border-white/10 text-gray-300 hover:text-white"
                                >
                                    Retry
                                </button>
                            )}
                        </div>
                    )}
                    {!error && children}
                </div>
            )}
        </div>
    );
}
