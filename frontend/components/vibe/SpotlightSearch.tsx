"use client";

/** Combined local track finder and remote semantic vibe search. */

import {
    useCallback, useEffect, useMemo, useRef, useState,
    type Dispatch, type FormEvent, type KeyboardEvent, type SetStateAction,
} from "react";
import { Loader2, Search, X } from "lucide-react";
import { api } from "@/lib/api";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { searchMapTracks } from "./mapSearch";
import type { MapTrack } from "./types";
import { getMoodColor } from "./types";

export interface SpotlightSearchProps {
    tracks: readonly MapTrack[];
    onResults: (matchedIds: Set<string>, query: string) => void;
    onClear: () => void;
    onLocate: (id: string) => void;
    className?: string;
}

const WARM_UP_MS = 3000;
const MIN_QUERY = 2;
const LOCAL_MATCH_LIMIT = 8;
type DropdownRow = { kind: "match"; track: MapTrack } | { kind: "vibe" };

interface RemoteSearch {
    loading: boolean;
    warming: boolean;
    error: string | null;
    run: (event?: FormEvent) => Promise<void>;
    reset: () => void;
}

function useRemoteSearch(
    query: string,
    onResults: SpotlightSearchProps["onResults"],
    onClear: SpotlightSearchProps["onClear"]
): RemoteSearch {
    const [loading, setLoading] = useState(false);
    const [warming, setWarming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const tokenRef = useRef(0);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const stopWarm = useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
        setWarming(false);
    }, []);
    const reset = useCallback(() => {
        tokenRef.current++;
        setLoading(false);
        setError(null);
        stopWarm();
    }, [stopWarm]);
    const run = useCallback(async (event?: FormEvent) => {
        event?.preventDefault();
        const value = query.trim();
        if (value.length < MIN_QUERY) {
            onClear();
            return;
        }
        const token = ++tokenRef.current;
        setLoading(true);
        setError(null);
        timerRef.current = setTimeout(() => setWarming(true), WARM_UP_MS);
        try {
            const response = await api.vibeSearch(value);
            if (token === tokenRef.current) {
                onResults(new Set(response.tracks.map((track) => track.id)), value);
            }
        } catch {
            if (token === tokenRef.current) setError("Search failed — try again");
        } finally {
            if (token === tokenRef.current) {
                setLoading(false);
                stopWarm();
            }
        }
    }, [query, onResults, onClear, stopWarm]);
    useEffect(() => () => stopWarm(), [stopWarm]);
    return { loading, warming, error, run, reset };
}

function useDropdownRows(tracks: readonly MapTrack[], query: string): DropdownRow[] {
    return useMemo(() => {
        if (query.trim().length === 0) return [];
        const matches = searchMapTracks(tracks, query, LOCAL_MATCH_LIMIT);
        return [...matches.map((track): DropdownRow => ({ kind: "match", track })),
            { kind: "vibe" }];
    }, [tracks, query]);
}

interface DropdownController {
    focused: boolean;
    show: boolean;
    activeIndex: number;
    setFocused: Dispatch<SetStateAction<boolean>>;
    change: (value: string) => void;
    keyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
    clear: () => void;
    pick: (index: number) => void;
}

function handleNavigationKey(
    event: KeyboardEvent<HTMLInputElement>,
    rows: readonly DropdownRow[],
    current: number,
    setCurrent: Dispatch<SetStateAction<number>>
): boolean {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    setCurrent((current + delta + rows.length) % rows.length);
    return true;
}

function useDropdownController(args: {
    query: string;
    setQuery: Dispatch<SetStateAction<string>>;
    rows: readonly DropdownRow[];
    onLocate: (id: string) => void;
    remote: RemoteSearch;
    onClear: () => void;
    collapse: () => void;
}): DropdownController {
    const [focused, setFocused] = useState(false);
    const [active, setActive] = useState(0);
    const [suppressed, setSuppressed] = useState(false);
    const show = focused && !suppressed && args.rows.length > 0;
    const activeIndex = Math.min(active, args.rows.length - 1);
    const clear = useCallback(() => {
        args.setQuery("");
        setActive(0);
        setSuppressed(false);
        args.remote.reset();
        args.onClear();
    }, [args]);
    const pick = useCallback((index: number) => {
        const row = args.rows[index];
        if (!row) return;
        setSuppressed(true);
        if (row.kind === "match") {
            args.remote.reset();
            args.onLocate(row.track.id);
        }
        else void args.remote.run();
    }, [args]);
    const change = useCallback((value: string) => {
        args.remote.reset();
        args.setQuery(value);
        setActive(0);
        setSuppressed(false);
    }, [args]);
    const keyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
        if (show && handleNavigationKey(event, args.rows, activeIndex, setActive)) return;
        if (event.key === "Enter" && show) {
            event.preventDefault();
            pick(activeIndex);
            return;
        }
        if (event.key !== "Escape") return;
        if (args.query.trim().length > 0) event.stopPropagation();
        clear();
        args.collapse();
    }, [show, args, activeIndex, pick, clear]);
    return { focused, show, activeIndex, setFocused, change, keyDown, clear, pick };
}

function CollapsedSearch({ expand, inputRef, className }: {
    expand: () => void;
    inputRef: React.RefObject<HTMLInputElement | null>;
    className?: string;
}) {
    const open = () => {
        expand();
        requestAnimationFrame(() => inputRef.current?.focus());
    };
    return (
        <div className={className ?? "pointer-events-auto"}>
            <button type="button" onClick={open} title="Spotlight a vibe"
                aria-label="Spotlight a vibe" aria-expanded={false}
                className="pointer-events-auto flex items-center justify-center w-10 h-10 rounded-full bg-black/60 backdrop-blur-md border border-white/10 shadow-lg text-gray-200 hover:bg-black/70 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60">
                <Search className="w-5 h-5" />
            </button>
        </div>
    );
}

function DropdownOption({ row, index, active, pick }: {
    row: DropdownRow;
    index: number;
    active: boolean;
    pick: (index: number) => void;
}) {
    const optionId = `spotlight-option-${index}`;
    if (row.kind === "vibe") {
        return (
            <li id={optionId} role="option" aria-selected={active}>
                <button type="button" onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pick(index)}
                    className={`w-full text-left px-3 py-2 text-sm text-indigo-300 transition-colors ${active ? "bg-white/10" : "hover:bg-white/5"}`}>
                    Search this as a vibe →
                </button>
            </li>
        );
    }
    return (
        <li id={optionId} role="option" aria-selected={active}>
            <button type="button" onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(index)} aria-label={`${row.track.title} by ${row.track.artist}`}
                className={`w-full flex items-center gap-2 text-left px-3 py-2 transition-colors ${active ? "bg-white/10" : "hover:bg-white/5"}`}>
                <span className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: getMoodColor(row.track.dominantMood) }} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                    <span className="block text-sm text-white truncate">{row.track.title}</span>
                    <span className="block text-xs text-gray-400 truncate">{row.track.artist}</span>
                </span>
            </button>
        </li>
    );
}

function SearchDropdown({ rows, controller }: {
    rows: readonly DropdownRow[];
    controller: DropdownController;
}) {
    if (!controller.show) return null;
    return (
        <ul id="spotlight-listbox" role="listbox" aria-label="Track and artist matches"
            className="mt-1.5 w-[min(80vw,320px)] max-h-80 overflow-y-auto rounded-xl bg-black/60 backdrop-blur-md border border-white/10 shadow-lg py-1">
            {rows.map((row, index) => (
                <DropdownOption key={row.kind === "vibe" ? "vibe" : row.track.id}
                    row={row} index={index} active={index === controller.activeIndex}
                    pick={controller.pick} />
            ))}
        </ul>
    );
}

function SearchForm({ query, inputRef, className, remote, rows, controller }: {
    query: string;
    inputRef: React.RefObject<HTMLInputElement | null>;
    className?: string;
    remote: RemoteSearch;
    rows: readonly DropdownRow[];
    controller: DropdownController;
}) {
    return (
        <form onSubmit={remote.run} className={className ?? "pointer-events-auto"}>
            <div className="pointer-events-auto relative flex items-center w-[min(80vw,320px)] h-10 rounded-full bg-black/60 backdrop-blur-md border border-white/10 shadow-lg focus-within:border-white/20 transition-colors">
                <Search className="pointer-events-none absolute left-3 w-4 h-4 text-gray-400" />
                <input ref={inputRef} type="text" value={query}
                    onChange={(event) => controller.change(event.target.value)}
                    onFocus={() => controller.setFocused(true)} onBlur={() => controller.setFocused(false)}
                    onKeyDown={controller.keyDown} placeholder="Search tracks, artists, or a vibe…"
                    aria-label="Spotlight a vibe" role="combobox" aria-autocomplete="list"
                    aria-expanded={controller.show} aria-controls="spotlight-listbox"
                    aria-activedescendant={controller.show ? `spotlight-option-${controller.activeIndex}` : undefined}
                    className="w-full h-full bg-transparent pl-9 pr-9 rounded-full text-sm text-white placeholder:text-gray-400 focus:outline-none" />
                {(query || remote.loading) && (
                    <button type="button" onClick={controller.clear} title="Clear (Esc)"
                        aria-label="Clear spotlight"
                        className="absolute right-2 flex items-center justify-center w-7 h-7 rounded-full text-gray-400 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60">
                        {remote.loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
                    </button>
                )}
            </div>
            {remote.warming && <p className="mt-1 px-3 text-xs text-gray-400">warming up the model…</p>}
            {remote.error && <p className="mt-1 px-3 text-xs text-red-400">{remote.error}</p>}
            <SearchDropdown rows={rows} controller={controller} />
        </form>
    );
}

/** Render the responsive search pill and its keyboard-accessible result list. */
export function SpotlightSearch(props: SpotlightSearchProps) {
    const [query, setQuery] = useState("");
    const [expanded, setExpanded] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const isSmall = useMediaQuery("(max-width: 639px)");
    const remote = useRemoteSearch(query, props.onResults, props.onClear);
    const rows = useDropdownRows(props.tracks, query);
    const controller = useDropdownController({
        query, setQuery, rows, onLocate: props.onLocate, remote,
        onClear: props.onClear, collapse: () => isSmall && setExpanded(false),
    });
    if (isSmall && !expanded) {
        return <CollapsedSearch expand={() => setExpanded(true)} inputRef={inputRef}
            className={props.className} />;
    }
    return <SearchForm query={query} inputRef={inputRef} className={props.className}
        remote={remote} rows={rows} controller={controller} />;
}
