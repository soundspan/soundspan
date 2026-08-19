"use client";

import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";

interface ExploreDegradedNoticeProps {
    onRetry: () => Promise<void>;
}

/** Dismissible warning shown when one or more Explore sections fail to load. */
export function ExploreDegradedNotice({
    onRetry,
}: Readonly<ExploreDegradedNoticeProps>) {
    const [isDismissed, setIsDismissed] = useState(false);

    if (isDismissed) {
        return null;
    }

    return (
        <div
            role="alert"
            className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200/80"
        >
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
            <span className="flex-1">
                Some sections failed to load —{" "}
                <button
                    type="button"
                    onClick={() => void onRetry()}
                    className="font-medium text-amber-200 underline underline-offset-2 hover:text-white"
                >
                    Retry
                </button>
            </span>
            <button
                type="button"
                onClick={() => setIsDismissed(true)}
                aria-label="Dismiss degraded results notice"
                className="rounded p-1 text-amber-200/70 hover:bg-white/10 hover:text-white"
            >
                <X className="h-4 w-4" />
            </button>
        </div>
    );
}
