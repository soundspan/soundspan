"use client";

/**
 * SpotlightSearch — the top-center floating glass pill over the vibe map.
 *
 * Two search modes share one input:
 *  - LOCAL finder: as the user types, `searchMapTracks` (mapSearch.ts) ranks
 *    in-memory title/artist matches and shows them in a dropdown (up to 8).
 *    Picking one (click, or Enter while it's the highlighted row) flies the
 *    camera to that dot via `onLocate` — no network call.
 *  - VIBE search: the dropdown's LAST row is always "Search this as a vibe →"
 *    and calls `api.vibeSearch` on submit, exactly like before. It's what
 *    Enter picks when there are zero local matches, or when the user
 *    explicitly selects/clicks that row.
 *
 * The dropdown is a real listbox (`role="combobox"`/`role="listbox"`,
 * `aria-activedescendant`) so ArrowUp/ArrowDown + Enter work without a mouse.
 * Dropdown rows use `onMouseDown={preventDefault}` so clicking one never
 * blurs the input first (which would otherwise close the dropdown before the
 * click's own event fires).
 *
 * Search can take up to ~30s when the CLAP model is cold, so a subtle
 * "warming up the model…" hint appears after 3s of loading.
 *
 * Below `sm` the pill collapses to a single 40px magnifier button that expands
 * it on demand (keeping the viz uncluttered on phones). All existing search
 * behaviour (submit, staleness token, Esc stopPropagation rules) is
 * unchanged.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { api } from "@/lib/api";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { searchMapTracks } from "./mapSearch";
import type { MapTrack } from "./types";
import { getMoodColor } from "./types";

export interface SpotlightSearchProps {
    /** Every on-map track, searched locally as the user types. */
    tracks: readonly MapTrack[];
    /** Called with the matched track ids (and the query) on a successful search. */
    onResults: (matchedIds: Set<string>, query: string) => void;
    /** Called when the input is cleared (✕ / Esc / empty submit). */
    onClear: () => void;
    /** Called with a track id when the user picks a local match. */
    onLocate: (id: string) => void;
    className?: string;
}

const WARM_UP_MS = 3000;
const MIN_QUERY = 2;
const LOCAL_MATCH_LIMIT = 8;

/** One dropdown row: a local track/artist match, or the trailing vibe-search row. */
type DropdownRow = { kind: "match"; track: MapTrack } | { kind: "vibe" };

export function SpotlightSearch({
    tracks,
    onResults,
    onClear,
    onLocate,
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

    // --- Local track/artist dropdown ---------------------------------------
    const [focused, setFocused] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);
    // Suppressed right after a pick, so the dropdown doesn't reopen over a
    // just-made selection until the user edits the query again.
    const [suppressDropdown, setSuppressDropdown] = useState(false);

    const trimmedQuery = query.trim();
    const matches = useMemo(
        () =>
            trimmedQuery.length > 0
                ? searchMapTracks(tracks, query, LOCAL_MATCH_LIMIT)
                : [],
        [tracks, query, trimmedQuery]
    );
    const rows: DropdownRow[] = useMemo(
        () =>
            trimmedQuery.length > 0
                ? [
                      ...matches.map(
                          (track): DropdownRow => ({ kind: "match", track })
                      ),
                      { kind: "vibe" },
                  ]
                : [],
        [matches, trimmedQuery]
    );
    const showDropdown = focused && !suppressDropdown && rows.length > 0;
    const clampedActiveIndex = Math.min(activeIndex, rows.length - 1);

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
        setActiveIndex(0);
        setSuppressDropdown(false);
        stopWarm();
        onClear();
    }, [onClear, stopWarm]);

    /** Pick dropdown row `idx`: a match locates the dot, the vibe row submits. */
    const pick = useCallback(
        (idx: number) => {
            const row = rows[idx];
            if (!row) return;
            setSuppressDropdown(true);
            if (row.kind === "match") {
                onLocate(row.track.id);
            } else {
                void runSearch();
            }
        },
        [rows, onLocate, runSearch]
    );

    const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        setQuery(e.target.value);
        setActiveIndex(0);
        setSuppressDropdown(false);
    }, []);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "ArrowDown") {
                if (!showDropdown) return;
                e.preventDefault();
                setActiveIndex((i) => (i + 1) % rows.length);
                return;
            }
            if (e.key === "ArrowUp") {
                if (!showDropdown) return;
                e.preventDefault();
                setActiveIndex((i) => (i - 1 + rows.length) % rows.length);
                return;
            }
            if (e.key === "Enter") {
                if (showDropdown) {
                    e.preventDefault();
                    pick(clampedActiveIndex);
                }
                // Otherwise fall through to the form's onSubmit (runSearch) —
                // e.g. an empty/too-short query, unchanged from before.
                return;
            }
            if (e.key !== "Escape") return;
            // First Esc just clears the box (and swallows the event so it
            // doesn't bubble to VibeMap's window listener and tear down the
            // active mode); only a second Esc, with nothing left to clear, is
            // allowed to bubble and exit the mode.
            if (query.trim().length > 0) e.stopPropagation();
            clear();
            if (isSmall) setExpanded(false);
        },
        [showDropdown, rows.length, clampedActiveIndex, pick, query, clear, isSmall]
    );

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
                    onChange={handleChange}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    onKeyDown={handleKeyDown}
                    placeholder="Search tracks, artists, or a vibe…"
                    aria-label="Spotlight a vibe"
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={showDropdown}
                    aria-controls="spotlight-listbox"
                    aria-activedescendant={
                        showDropdown
                            ? `spotlight-option-${clampedActiveIndex}`
                            : undefined
                    }
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
            {showDropdown && (
                <ul
                    id="spotlight-listbox"
                    role="listbox"
                    aria-label="Track and artist matches"
                    className="mt-1.5 w-[min(80vw,320px)] max-h-80 overflow-y-auto rounded-xl bg-black/60 backdrop-blur-md border border-white/10 shadow-lg py-1"
                >
                    {rows.map((row, idx) => {
                        const active = idx === clampedActiveIndex;
                        const optionId = `spotlight-option-${idx}`;
                        if (row.kind === "vibe") {
                            return (
                                <li key="vibe" id={optionId} role="option" aria-selected={active}>
                                    <button
                                        type="button"
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() => pick(idx)}
                                        className={`w-full text-left px-3 py-2 text-sm text-indigo-300 transition-colors ${
                                            active ? "bg-white/10" : "hover:bg-white/5"
                                        }`}
                                    >
                                        Search this as a vibe →
                                    </button>
                                </li>
                            );
                        }
                        const { track } = row;
                        return (
                            <li key={track.id} id={optionId} role="option" aria-selected={active}>
                                <button
                                    type="button"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => pick(idx)}
                                    aria-label={`${track.title} by ${track.artist}`}
                                    className={`w-full flex items-center gap-2 text-left px-3 py-2 transition-colors ${
                                        active ? "bg-white/10" : "hover:bg-white/5"
                                    }`}
                                >
                                    <span
                                        className="w-2 h-2 rounded-full flex-shrink-0"
                                        style={{
                                            backgroundColor: getMoodColor(
                                                track.dominantMood
                                            ),
                                        }}
                                        aria-hidden="true"
                                    />
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-sm text-white truncate">
                                            {track.title}
                                        </span>
                                        <span className="block text-xs text-gray-400 truncate">
                                            {track.artist}
                                        </span>
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </form>
    );
}
