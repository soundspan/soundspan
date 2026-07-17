"use client";

/**
 * QueuePanel — glass panel showing the play queue while on the vibe map, with
 * drag-to-reorder for upcoming tracks. Shares the mode panels' slot
 * (VIBE_PANEL_CLASS: right side on desktop, bottom sheet below sm) and the
 * exact reorder mechanic /queue's Next Up list uses: reorderDnd.ts's pure
 * drop math (resolveDropPosition/resolveDropTargetIndex) via native HTML5
 * drag-and-drop (draggable + onDragStart/onDragOver/onDrop — same as /queue,
 * so touch gets whatever level of support native DnD gives there: none).
 * Reorder and removal are NOT reimplemented here: `onReorder` is meant to be
 * `moveQueueItem` verbatim (the Listen-Together guard + shuffle-index
 * remapping already live there) and `onRemove` is `removeFromQueue` verbatim.
 *
 * Data model matches /queue: `queue`/`currentIndex` are meant to come
 * straight from useAudioState (never the 250ms playback clock — this only
 * needs to re-render on enqueue/advance, which is exactly when those two
 * values change). The current track/episode is shown pinned and
 * non-draggable; only items after currentIndex ("upcoming") are listed and
 * reorderable — history before currentIndex is intentionally omitted, this is
 * a "what's next" glance, not a full queue browser (that's /queue).
 *
 * Rows are a lean local layout rather than VibeTrackRow: VibeTrackRow always
 * renders a calibrated similarity percent (it requires a `distance` prop),
 * which has no meaning for a queue position — forcing a fake distance would
 * paint a bogus match percentage on every row.
 */

import { useRef, useState } from "react";
import { GripVertical, Music, X } from "lucide-react";
import {
    resolveDropPosition,
    resolveDropTargetIndex,
    type DropPosition,
} from "@/components/track/reorderDnd";
import { isEpisodeQueueItem, type QueueItem } from "@/lib/queue-item";
import {
    VIBE_PANEL_CLASS,
    VIBE_PANEL_STYLE,
    PANEL_CLOSE_CLASS,
} from "./TravelPanel";

export interface QueuePanelProps {
    /** Full mixed-media queue (tracks + podcast episodes) — same shape as
     *  useAudioState().queue / app/queue/page.tsx. */
    queue: QueueItem[];
    currentIndex: number;
    onClose: () => void;
    /** moveQueueItem, reused verbatim (Listen-Together guard + shuffle
     *  remapping already live there — do not reimplement). */
    onReorder: (fromIndex: number, toIndex: number) => void;
    /** removeFromQueue, reused verbatim. Omit to render no remove affordance. */
    onRemove?: (index: number) => void;
    /** True during a Listen Together session: the shared queue is
     *  server-owned, so a local reorder would desync — mirrors /queue by
     *  hiding the drag handle entirely rather than offering a drag that
     *  silently no-ops. */
    reorderDisabled?: boolean;
}

function queueItemTitle(item: QueueItem): string {
    return isEpisodeQueueItem(item)
        ? item.title
        : (item.displayTitle ?? item.title);
}

function queueItemSubtitle(item: QueueItem): string {
    return isEpisodeQueueItem(item) ? item.podcastTitle : (item.artist?.name ?? "");
}

/**
 * Translates a drop within the panel's upcoming-rows list (indices relative
 * to the first upcoming row, i.e. row 0 === queue[currentIndex + 1]) into the
 * absolute index pair `moveQueueItem` expects — the same `currentIndex + 1 +
 * idx` offset app/queue/page.tsx's buildRowDropProps applies inline. Pulled
 * out as a pure, exported helper: renderToStaticMarkup component tests can't
 * simulate real DOM drag events, so this is where the index math itself gets
 * unit-tested.
 */
export function resolveQueueDropIndices(
    currentIndex: number,
    fromIdx: number,
    overIdx: number,
    position: DropPosition
): { from: number; to: number } {
    const toIdx = resolveDropTargetIndex(fromIdx, overIdx, position);
    return {
        from: currentIndex + 1 + fromIdx,
        to: currentIndex + 1 + toIdx,
    };
}

export function QueuePanel({
    queue,
    currentIndex,
    onClose,
    onReorder,
    onRemove,
    reorderDisabled,
}: QueuePanelProps) {
    const current = queue[currentIndex] ?? null;
    const upcoming = queue.slice(currentIndex + 1);

    const dragFromIdxRef = useRef<number | null>(null);
    const [dragFromIdx, setDragFromIdx] = useState<number | null>(null);
    const [dragOver, setDragOver] = useState<{
        idx: number;
        position: DropPosition;
    } | null>(null);

    const clearDragState = () => {
        dragFromIdxRef.current = null;
        setDragFromIdx(null);
        setDragOver(null);
    };

    return (
        <div
            className={VIBE_PANEL_CLASS}
            style={VIBE_PANEL_STYLE}
            data-vibe-panel="queue"
        >
            <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-semibold text-white">Queue</span>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close queue"
                    title="Close queue (Esc)"
                    className={PANEL_CLOSE_CLASS}
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            {current && (
                <div className="flex items-center gap-2 px-2 py-1.5 mb-1.5 rounded-lg bg-indigo-500/10 border border-indigo-400/20">
                    <Music className="w-3.5 h-3.5 text-indigo-300 shrink-0" />
                    <span className="flex-1 min-w-0">
                        <span className="block truncate text-[13px] text-white">
                            {queueItemTitle(current)}
                        </span>
                        <span className="block truncate text-xs text-gray-400">
                            {queueItemSubtitle(current)}
                        </span>
                    </span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-indigo-300">
                        Now playing
                    </span>
                </div>
            )}

            {upcoming.length === 0 ? (
                <p className="text-xs text-gray-400 py-2">
                    Nothing queued — sweep some dots or play a journey.
                </p>
            ) : (
                <ul className="flex flex-col">
                    {upcoming.map((item, idx) => {
                        const absoluteIndex = currentIndex + 1 + idx;
                        const title = queueItemTitle(item);
                        const overPosition =
                            dragOver && dragOver.idx === idx && dragFromIdx !== idx
                                ? dragOver.position
                                : null;
                        return (
                            <li
                                key={`${item.id}-${absoluteIndex}`}
                                className={
                                    dragFromIdx === idx
                                        ? "relative opacity-50"
                                        : "relative"
                                }
                                onDragOver={(e) => {
                                    if (dragFromIdxRef.current === null) return;
                                    e.preventDefault();
                                    e.dataTransfer.dropEffect = "move";
                                    const rect =
                                        e.currentTarget.getBoundingClientRect();
                                    setDragOver({
                                        idx,
                                        position: resolveDropPosition(
                                            e.clientY - rect.top,
                                            rect.height
                                        ),
                                    });
                                }}
                                onDragLeave={(e) => {
                                    if (
                                        e.currentTarget.contains(
                                            e.relatedTarget as Node
                                        )
                                    )
                                        return;
                                    setDragOver((cur) =>
                                        cur?.idx === idx ? null : cur
                                    );
                                }}
                                onDrop={(e) => {
                                    const fromIdx = dragFromIdxRef.current;
                                    if (fromIdx === null) return;
                                    e.preventDefault();
                                    const rect =
                                        e.currentTarget.getBoundingClientRect();
                                    const position = resolveDropPosition(
                                        e.clientY - rect.top,
                                        rect.height
                                    );
                                    const { from, to } = resolveQueueDropIndices(
                                        currentIndex,
                                        fromIdx,
                                        idx,
                                        position
                                    );
                                    clearDragState();
                                    if (to !== from) onReorder(from, to);
                                }}
                            >
                                {overPosition && (
                                    <div
                                        className={`pointer-events-none absolute left-0 right-0 h-0.5 rounded bg-indigo-400 z-10 ${
                                            overPosition === "before"
                                                ? "top-0"
                                                : "bottom-0"
                                        }`}
                                    />
                                )}
                                <div className="group flex items-center gap-1.5 px-1 py-1.5 rounded-lg hover:bg-white/5">
                                    {!reorderDisabled && (
                                        <button
                                            type="button"
                                            draggable
                                            onClick={(e) => e.stopPropagation()}
                                            onDragStart={(e) => {
                                                dragFromIdxRef.current = idx;
                                                setDragFromIdx(idx);
                                                e.dataTransfer.effectAllowed =
                                                    "move";
                                                e.dataTransfer.setData(
                                                    "text/plain",
                                                    String(idx)
                                                );
                                            }}
                                            onDragEnd={clearDragState}
                                            aria-label={`Drag to reorder ${title}`}
                                            title="Drag to reorder"
                                            className="shrink-0 w-6 h-6 grid place-items-center rounded text-gray-500 hover:text-white cursor-grab active:cursor-grabbing"
                                        >
                                            <GripVertical className="w-4 h-4" />
                                        </button>
                                    )}
                                    <span className="flex-1 min-w-0">
                                        <span className="block truncate text-[13px] text-white">
                                            {title}
                                        </span>
                                        <span className="block truncate text-xs text-gray-400">
                                            {queueItemSubtitle(item)}
                                        </span>
                                    </span>
                                    {onRemove && (
                                        <button
                                            type="button"
                                            onClick={() => onRemove(absoluteIndex)}
                                            aria-label={`Remove ${title} from queue`}
                                            title="Remove from queue"
                                            className="shrink-0 w-7 h-7 grid place-items-center rounded-lg text-gray-500 hover:text-red-400 hover:bg-white/10 transition-colors"
                                        >
                                            <X className="w-3.5 h-3.5" />
                                        </button>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
