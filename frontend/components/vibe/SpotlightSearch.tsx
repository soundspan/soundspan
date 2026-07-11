"use client";

/**
 * SpotlightSearch — submit-triggered CLAP text search over the map.
 *
 * On submit it calls `api.vibeSearch`; the returned track ids are reported up
 * via `onResults` so the container can highlight (glow) matches and dim the
 * rest. ✕ / Esc clears. Search can take up to ~30s when the model is cold, so a
 * subtle "warming up the model…" hint appears after 3s of loading.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { api } from "@/lib/api";

export interface SpotlightSearchProps {
    /** Called with the matched track ids (and the query) on a successful search. */
    onResults: (matchedIds: Set<string>, query: string) => void;
    /** Called when the input is cleared (✕ / Esc / empty submit). */
    onClear: () => void;
    className?: string;
}

const WARM_UP_MS = 3000;
const MIN_QUERY = 2;

export function SpotlightSearch({
    onResults,
    onClear,
    className,
}: SpotlightSearchProps) {
    const [query, setQuery] = useState("");
    const [loading, setLoading] = useState(false);
    const [warming, setWarming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const warmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const stopWarm = useCallback(() => {
        if (warmTimer.current) {
            clearTimeout(warmTimer.current);
            warmTimer.current = null;
        }
        setWarming(false);
    }, []);

    const runSearch = useCallback(
        async (e?: React.FormEvent) => {
            e?.preventDefault();
            const q = query.trim();
            if (q.length < MIN_QUERY) {
                onClear();
                return;
            }
            setLoading(true);
            setError(null);
            warmTimer.current = setTimeout(() => setWarming(true), WARM_UP_MS);
            try {
                const res = await api.vibeSearch(q);
                onResults(new Set(res.tracks.map((t) => t.id)), q);
            } catch {
                setError("Search failed — try again");
            } finally {
                setLoading(false);
                stopWarm();
            }
        },
        [query, onResults, onClear, stopWarm]
    );

    const clear = useCallback(() => {
        setQuery("");
        setError(null);
        setLoading(false);
        stopWarm();
        onClear();
    }, [onClear, stopWarm]);

    useEffect(() => () => stopWarm(), [stopWarm]);

    return (
        <form onSubmit={runSearch} className={className ?? "relative"}>
            <div className="relative flex items-center">
                <Search className="pointer-events-none absolute left-2 w-3.5 h-3.5 text-gray-500" />
                <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Escape") clear();
                    }}
                    placeholder="Spotlight a vibe…"
                    aria-label="Spotlight a vibe"
                    className="w-full pl-7 pr-7 py-1.5 bg-white/5 border border-white/10 rounded text-xs text-white placeholder:text-gray-600 focus:outline-none focus:border-white/20 transition-colors"
                />
                {(query || loading) && (
                    <button
                        type="button"
                        onClick={clear}
                        title="Clear (Esc)"
                        aria-label="Clear spotlight"
                        className="absolute right-2 text-gray-500 hover:text-white transition-colors"
                    >
                        {loading ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                            <X className="w-3.5 h-3.5" />
                        )}
                    </button>
                )}
            </div>
            {warming && (
                <p className="mt-1 text-[10px] text-gray-500">
                    warming up the model…
                </p>
            )}
            {error && (
                <p className="mt-1 text-[10px] text-red-400">{error}</p>
            )}
        </form>
    );
}
