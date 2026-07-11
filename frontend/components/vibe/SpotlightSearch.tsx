"use client";

/**
 * SpotlightSearch — submit-triggered CLAP text search over the map, rendered as
 * a top-center floating glass pill.
 *
 * On submit it calls `api.vibeSearch`; the returned track ids are reported up
 * via `onResults` so the container can highlight (glow) matches and dim the
 * rest. ✕ / Esc clears. Search can take up to ~30s when the model is cold, so a
 * subtle "warming up the model…" hint appears after 3s of loading.
 *
 * Below `sm` the pill collapses to a single 40px magnifier button that expands
 * it on demand (keeping the viz uncluttered on phones). All search behaviour
 * (submit, staleness token, Esc stopPropagation rules) is unchanged.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { api } from "@/lib/api";
import { useMediaQuery } from "@/hooks/useMediaQuery";

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
    // Below sm the pill collapses to an icon; expand on tap.
    const [expanded, setExpanded] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const isSmall = useMediaQuery("(max-width: 639px)");
    const warmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Staleness token: bumped on clear() and on every new submit, so a search
    // that resolves after being superseded (cleared, or a newer query submitted)
    // can't land its results and re-dim the map.
    const searchToken = useRef(0);

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
            const token = ++searchToken.current;
            setLoading(true);
            setError(null);
            warmTimer.current = setTimeout(() => setWarming(true), WARM_UP_MS);
            try {
                const res = await api.vibeSearch(q);
                if (token !== searchToken.current) return; // superseded — drop it
                onResults(new Set(res.tracks.map((t) => t.id)), q);
            } catch {
                if (token === searchToken.current) setError("Search failed — try again");
            } finally {
                if (token === searchToken.current) {
                    setLoading(false);
                    stopWarm();
                }
            }
        },
        [query, onResults, onClear, stopWarm]
    );

    const clear = useCallback(() => {
        searchToken.current++;
        setQuery("");
        setError(null);
        setLoading(false);
        stopWarm();
        onClear();
    }, [onClear, stopWarm]);

    useEffect(() => () => stopWarm(), [stopWarm]);

    // Collapsed magnifier (small screens only). Expands the pill and focuses it.
    if (isSmall && !expanded) {
        return (
            <div className={className ?? "pointer-events-auto"}>
                <button
                    type="button"
                    onClick={() => {
                        setExpanded(true);
                        requestAnimationFrame(() => inputRef.current?.focus());
                    }}
                    title="Spotlight a vibe"
                    aria-label="Spotlight a vibe"
                    aria-expanded={false}
                    className="pointer-events-auto flex items-center justify-center w-10 h-10 rounded-full bg-black/60 backdrop-blur-md border border-white/10 shadow-lg text-gray-200 hover:bg-black/70 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
                >
                    <Search className="w-5 h-5" />
                </button>
            </div>
        );
    }

    return (
        <form
            onSubmit={runSearch}
            className={className ?? "pointer-events-auto"}
        >
            <div className="pointer-events-auto relative flex items-center w-[min(80vw,320px)] h-10 rounded-full bg-black/60 backdrop-blur-md border border-white/10 shadow-lg focus-within:border-white/20 transition-colors">
                <Search className="pointer-events-none absolute left-3 w-4 h-4 text-gray-400" />
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key !== "Escape") return;
                        // First Esc just clears the box (and swallows the event so
                        // it doesn't bubble to VibeMap's window listener and tear
                        // down the active mode); only a second Esc, with nothing
                        // left to clear, is allowed to bubble and exit the mode.
                        if (query.trim().length > 0) e.stopPropagation();
                        clear();
                        if (isSmall) setExpanded(false);
                    }}
                    placeholder="Spotlight a vibe…"
                    aria-label="Spotlight a vibe"
                    className="w-full h-full bg-transparent pl-9 pr-9 rounded-full text-sm text-white placeholder:text-gray-500 focus:outline-none"
                />
                {(query || loading) && (
                    <button
                        type="button"
                        onClick={clear}
                        title="Clear (Esc)"
                        aria-label="Clear spotlight"
                        className="absolute right-2 flex items-center justify-center w-7 h-7 rounded-full text-gray-400 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
                    >
                        {loading ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            <X className="w-4 h-4" />
                        )}
                    </button>
                )}
            </div>
            {warming && (
                <p className="mt-1 px-3 text-xs text-gray-400">
                    warming up the model…
                </p>
            )}
            {error && (
                <p className="mt-1 px-3 text-xs text-red-400">{error}</p>
            )}
        </form>
    );
}
